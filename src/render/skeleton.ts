/**
 * Straight skeleton (CGAL в WebAssembly, пакет straight-skeleton) для скатных крыш на контурах любой формы.
 *
 * Считается в Web Worker: на отдельных (вырожденных) контурах CGAL работает секундами, и в главном потоке
 * это замораживало карту. skeletonOf синхронный: отдаёт готовый скелет из кеша или 'pending' и ставит
 * контур в очередь; по готовности вызываются подписчики onSkeletons — слои пересобирают ждавшие здания.
 * Без Worker (node, тесты) — считаем в том же потоке, как раньше.
 * Посчитанные скелеты хранятся в IndexedDB и при следующей загрузке берутся оттуда, без воркера.
 */
import type { Pt } from './building-geometry';
import { recordMs } from '../perf';
import { buildStableSkeleton } from './skeleton-stabilize';

export interface Skeleton {
  /** x, y и «время» — расстояние до ближайшей стороны контура. */
  vertices: [number, number, number][];
  /** Грани: каждая опирается на одну сторону контура, вершины — индексы в vertices. */
  polygons: number[][];
}

type Builder = { init(): Promise<void>; buildFromPolygon(rings: number[][][]): Skeleton | null };

/** Сколько ждать один контур, прежде чем перезапустить воркер и оставить крышу плоской. */
const TIMEOUT_MS = 2000;
/** Сколько результатов помнить (ключ — координаты в локальной системе группы). */
const CACHE_SIZE = 20000;

const cache = new Map<string, Skeleton | null>();
const listeners = new Set<() => void>();

const signedArea = (r: Pt[]) => {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]);
  return a / 2; // > 0 — против часовой
};

function toRings(outer: Pt[], inners: Pt[][]): number[][][] {
  const orient = (r: Pt[], ccw: boolean) => {
    const ring = signedArea(r) > 0 === ccw ? r : [...r].reverse();
    return [...ring, ring[0]];
  };
  return [orient(outer, true), ...inners.map((r) => orient(r, false))];
}

const keyOf = (rings: number[][][]) => rings.map((r) => r.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ')).join('|');

function remember(key: string, s: Skeleton | null) {
  if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value!);
  cache.set(key, s);
}

/**
 * Подписка на «досчитались новые скелеты». Пересборка слитой геометрии тайла дорогая (сотни мс на плотный
 * тайл), поэтому уведомляем пачками: когда очередь опустела или не чаще раза в NOTIFY_MS.
 */
export function onSkeletons(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

const NOTIFY_MS = 1000;
let notifyTimer: ReturnType<typeof setTimeout> | undefined;
let lastNotify = 0;
function notify() {
  const fire = () => {
    notifyTimer = undefined;
    lastNotify = performance.now();
    for (const cb of listeners) cb();
  };
  if (!queue.length && !current && !lookupBusy) {
    // Всё посчитано — сразу (в следующем кадре), отменяя отложенное
    clearTimeout(notifyTimer);
    notifyTimer = undefined;
    requestAnimationFrame(fire);
    return;
  }
  if (notifyTimer) return;
  // Ещё читаем кеш, а воркер стоит: дождаться конца чтения (последняя пачка вызовет notify сама)
  if (lookupBusy && !queue.length && !current) return;
  notifyTimer = setTimeout(fire, Math.max(0, lastNotify + NOTIFY_MS - performance.now()));
}

// ---- Воркер с очередью и сторожевым таймером

interface Job { id: number; key: string; rings: number[][][]; stabilize: boolean; started?: number }
const queue: Job[] = [];
const queued = new Set<string>();
let worker: Worker | undefined;
/** Воркер загрузил WASM: до этого контур не засекаем — инициализация бывает дольше TIMEOUT_MS. */
let workerReady = false;
let current: Job | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let nextId = 1;
const useWorker = typeof Worker !== 'undefined';

function startWorker() {
  worker = new Worker(new URL('./skeleton-worker.ts', import.meta.url), { type: 'module' });
  workerReady = false;
  const spawned = performance.now();
  worker.onmessage = (e: MessageEvent<{ id: number; skeleton: Skeleton | null; broken?: boolean } | { ready: true }>) => {
    if ('ready' in e.data) {
      workerReady = true;
      recordMs('скелеты: запуск воркера (WASM)', performance.now() - spawned);
      // Контур ждал загрузки WASM — его время считаем с этого момента
      if (current) { current.started = performance.now(); armTimer(current); }
      return;
    }
    // WASM в воркере упал на вырожденном контуре — дальше он не считает: следующий контур возьмёт новый воркер
    if (e.data.broken) { worker?.terminate(); worker = undefined; }
    if (!current || e.data.id !== current.id) return;
    finish(current, e.data.skeleton);
  };
  worker.onerror = (e) => {
    console.warn('straight skeleton: ошибка воркера — сложные крыши будут плоскими:', e.message);
    if (current) finish(current, null);
  };
}

const size = (j: Job) => j.rings.reduce((n, r) => n + r.length, 0);

/**
 * Контуры, на которых CGAL не уложился в таймаут, — помним между перезагрузками: иначе при каждом
 * открытии страницы ждём их заново (и перезапускаем воркер с инициализацией WASM).
 */
// v2: в старый список попадали контуры, на которых не успевал загрузиться WASM, — сбрасываем
const FAILED_KEY = 'osm3d.skeleton.timeouts.v2';
const FAILED_MAX = 500;
const failed: string[] = (() => {
  try { return JSON.parse(localStorage.getItem(FAILED_KEY) ?? '[]') as string[]; } catch { return []; }
})();
const failedSet = new Set(failed);
/** Ключ контура длинный (тысячи символов) — храним хеш. */
function hashKey(key: string): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 ^ c, 2246822507);
  }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
}
function rememberTimeout(key: string) {
  key = hashKey(key);
  failedSet.add(key);
  failed.push(key);
  if (failed.length > FAILED_MAX) failed.splice(0, failed.length - FAILED_MAX);
  try { localStorage.setItem(FAILED_KEY, JSON.stringify(failed)); } catch { /* не критично */ }
}

// ---- Постоянный кеш скелетов (IndexedDB)

/**
 * Скелет зависит только от контура (в локальных координатах группы), поэтому его можно хранить между
 * перезагрузками: без кеша тёплая загрузка снова считает сотни крыш в воркере (десятки секунд) и каждый
 * раз пересобирает тайлы по мере готовности. Версию поднимать при изменении алгоритма (воркер,
 * skeleton-stabilize) — старые записи просто перестанут находиться и вытеснятся.
 */
const STORE_VERSION = 1;
const STORE_DB = 'osm-simple3d-skeletons';
const STORE = 'skeletons';
/** Сколько скелетов хранить; при превышении удаляются самые давние. */
const STORE_MAX = 50000;

interface StoredSkeleton { s: Skeleton; at: number }

let storeDb: Promise<IDBDatabase | undefined> | undefined;
function openStore(): Promise<IDBDatabase | undefined> {
  storeDb ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(STORE_DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE).createIndex('at', 'at');
      req.onsuccess = () => resolve(req.result);
      req.onerror = req.onblocked = () => resolve(undefined);
    } catch { resolve(undefined); }
  });
  return storeDb;
}
const storeKey = (key: string) => `${STORE_VERSION}:${hashKey(key)}`;

/** Контуры, которые ищутся в постоянном кеше (одной транзакцией за раз); не найденные уходят в воркер. */
let lookups: Job[] = [];
/** Чтение идёт или запланировано: новые контуры копятся до его конца — иначе сотни мелких чтений
 * (здания строятся порциями), и после каждого тайлы пересобираются. */
let lookupBusy = false;
/** За текущую серию чтений что-то нашлось — уведомить подписчиков, когда серия закончится. */
let lookupHits = false;
/** Сколько копить контуры перед чтением, мс: порции построения тайла успевают добавить свои. */
const LOOKUP_DELAY_MS = 50;

function scheduleLookup(job: Job) {
  lookups.push(job);
  if (lookupBusy) return;
  lookupBusy = true;
  setTimeout(() => void runLookups(), LOOKUP_DELAY_MS);
}

async function runLookups() {
  const batch = lookups;
  lookups = [];
  const t = performance.now();
  const db = await openStore();
  const found = new Map<string, Skeleton>();
  if (db) {
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(STORE, 'readonly');
        const st = tx.objectStore(STORE);
        for (const job of batch) {
          const r = st.get(storeKey(job.key));
          r.onsuccess = () => { const rec = r.result as StoredSkeleton | undefined; if (rec) found.set(job.key, rec.s); };
        }
        tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
      } catch { resolve(); }
    });
  }
  recordMs('скелеты: чтение из IndexedDB', performance.now() - t, `${found.size} из ${batch.length}`);
  for (const job of batch) {
    const s = found.get(job.key);
    if (s) { queued.delete(job.key); remember(job.key, s); } else queue.push(job);
  }
  // Пока читали, накопились новые контуры — следующее чтение; иначе чтение закончено
  lookupHits ||= found.size > 0;
  if (lookups.length) setTimeout(() => void runLookups(), LOOKUP_DELAY_MS);
  else lookupBusy = false;
  pumpWorker();
  if (lookupHits) notify();
  if (!lookupBusy) lookupHits = false;
}

let saves: [string, Skeleton][] = [];
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let savedSinceTrim = 0;

/** Записать посчитанный скелет (пачками, чтобы не открывать транзакцию на каждую крышу). */
function persist(key: string, s: Skeleton) {
  saves.push([storeKey(key), s]);
  saveTimer ??= setTimeout(() => void flushSaves(), 1000);
}

async function flushSaves() {
  const batch = saves;
  saves = [];
  saveTimer = undefined;
  const db = await openStore();
  if (!db || !batch.length) return;
  try {
    const tx = db.transaction(STORE, 'readwrite');
    const st = tx.objectStore(STORE);
    const at = Date.now();
    for (const [k, s] of batch) st.put({ s, at } satisfies StoredSkeleton, k);
    savedSinceTrim += batch.length;
    if (savedSinceTrim > 1000) { savedSinceTrim = 0; trimStore(st); }
  } catch { /* квота или закрытая база — не критично */ }
}

/** Удалить самые давние записи сверх STORE_MAX. */
function trimStore(st: IDBObjectStore) {
  const count = st.count();
  count.onsuccess = () => {
    let extra = count.result - STORE_MAX;
    if (extra <= 0) return;
    const cur = st.index('at').openCursor();
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c || extra-- <= 0) return;
      c.delete();
      c.continue();
    };
  };
}

function finish(job: Job, s: Skeleton | null) {
  clearTimeout(timer);
  current = undefined;
  if (job.started !== undefined) recordMs(s === null ? 'скелет крыши (воркер, без результата)' : 'скелет крыши (воркер)', performance.now() - job.started, `${size(job)} вершин`);
  queued.delete(job.key);
  remember(job.key, s);
  if (s) persist(job.key, s);
  pumpWorker();
  notify();
}

function pumpWorker() {
  if (current || !queue.length) return;
  if (!worker) startWorker();
  // Сначала простые контуры: тяжёлый (сотни вершин, может упереться в таймаут) не держит очередь —
  // иначе мелкие крыши за ним ждут секундами
  let best = 0;
  for (let i = 1; i < queue.length; i++) if (size(queue[i]) < size(queue[best])) best = i;
  current = queue.splice(best, 1)[0];
  current.started = performance.now();
  if (workerReady) armTimer(current);
  worker!.postMessage({ id: current.id, rings: current.rings, stabilize: current.stabilize });
}

function armTimer(job: Job) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    // Завис на этом контуре: убиваем воркер (WASM не прервать иначе), контур оставляем плоским
    console.warn(`straight skeleton: контур не посчитан за ${TIMEOUT_MS} мс (${job.rings[0].length - 1} вершин) — крыша будет плоской`);
    worker?.terminate();
    worker = undefined;
    rememberTimeout(job.key);
    finish(job, null);
  }, TIMEOUT_MS);
}

// ---- Синхронный режим (без Worker)

let builder: Builder | undefined;
/** Готовность синхронного режима — для тестов в node. */
export const skeletonReady: Promise<boolean> = useWorker
  ? Promise.resolve(true)
  : import('straight-skeleton').then(async (m) => {
      const b = (m as { SkeletonBuilder?: Builder }).SkeletonBuilder ?? (m as { default: { SkeletonBuilder: Builder } }).default.SkeletonBuilder;
      await b.init();
      builder = b;
      return true;
    }).catch(() => false);

/**
 * Скелет полигона (внешнее кольцо + дыры, без повторённой точки):
 * готовый скелет, null — посчитать не удалось, 'pending' — считается, крыша пока упрощённая.
 */
export function skeletonOf(outer: Pt[], inners: Pt[][], stabilize = false): Skeleton | null | 'pending' {
  const rings = toRings(outer, inners);
  const key = `${stabilize ? 'g:' : 's:'}${keyOf(rings)}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  if (!useWorker) {
    if (!builder) return null;
    let s: Skeleton | null = null;
    try { s = stabilize ? buildStableSkeleton(builder, rings) : builder.buildFromPolygon(rings); } catch { /* плоская */ }
    remember(key, s);
    return s;
  }
  if (failedSet.has(hashKey(key))) { remember(key, null); return null; }
  if (!queued.has(key)) {
    queued.add(key);
    // Сначала постоянный кеш: при тёплой загрузке почти все крыши находятся там, воркер не нужен
    scheduleLookup({ id: nextId++, key, rings, stabilize });
  }
  return 'pending';
}

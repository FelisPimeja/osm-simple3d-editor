/**
 * Straight skeleton (CGAL в WebAssembly, пакет straight-skeleton) для скатных крыш на контурах любой формы.
 *
 * Считается в Web Worker: на отдельных (вырожденных) контурах CGAL работает секундами, и в главном потоке
 * это замораживало карту. skeletonOf синхронный: отдаёт готовый скелет из кеша или 'pending' и ставит
 * контур в очередь; по готовности вызываются подписчики onSkeletons — слои пересобирают ждавшие здания.
 * Без Worker (node, тесты) — считаем в том же потоке, как раньше.
 */
import type { Pt } from './building-geometry';

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
  if (!queue.length && !current) {
    // Всё посчитано — сразу (в следующем кадре), отменяя отложенное
    clearTimeout(notifyTimer);
    notifyTimer = undefined;
    requestAnimationFrame(fire);
    return;
  }
  if (notifyTimer) return;
  notifyTimer = setTimeout(fire, Math.max(0, lastNotify + NOTIFY_MS - performance.now()));
}

// ---- Воркер с очередью и сторожевым таймером

interface Job { id: number; key: string; rings: number[][][] }
const queue: Job[] = [];
const queued = new Set<string>();
let worker: Worker | undefined;
let current: Job | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let nextId = 1;
const useWorker = typeof Worker !== 'undefined';

function startWorker() {
  worker = new Worker(new URL('./skeleton-worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<{ id: number; skeleton: Skeleton | null }>) => {
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
const FAILED_KEY = 'osm3d.skeleton.timeouts';
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

function finish(job: Job, s: Skeleton | null) {
  clearTimeout(timer);
  current = undefined;
  queued.delete(job.key);
  remember(job.key, s);
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
  const job = current;
  timer = setTimeout(() => {
    // Завис на этом контуре: убиваем воркер (WASM не прервать иначе), контур оставляем плоским
    console.warn(`straight skeleton: контур не посчитан за ${TIMEOUT_MS} мс (${job.rings[0].length - 1} вершин) — крыша будет плоской`);
    worker?.terminate();
    worker = undefined;
    rememberTimeout(job.key);
    finish(job, null);
  }, TIMEOUT_MS);
  worker!.postMessage({ id: job.id, rings: job.rings });
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
export function skeletonOf(outer: Pt[], inners: Pt[][]): Skeleton | null | 'pending' {
  const rings = toRings(outer, inners);
  const key = keyOf(rings);
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  if (!useWorker) {
    if (!builder) return null;
    let s: Skeleton | null = null;
    try { s = builder.buildFromPolygon(rings); } catch { /* плоская */ }
    remember(key, s);
    return s;
  }
  if (failedSet.has(hashKey(key))) { remember(key, null); return null; }
  if (!queued.has(key)) {
    queued.add(key);
    queue.push({ id: nextId++, key, rings });
    pumpWorker();
  }
  return 'pending';
}

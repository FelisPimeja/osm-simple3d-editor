import type { Map as MlMap } from 'maplibre-gl';
import { ApiError, fetchArea, type Bbox } from '../osm/api';
import { centroid, incompleteBuildingRelations, isBareOutlineTags, kindOf, markOutlinesWithParts, parseBuildings, type BuildingGroup, type Feature3D, type MemberWay, type Polygon } from '../osm/model';
import { RequestPool } from '../osm/request-pool';
import type { BuildingsLayer, RenderedFeature } from '../render/buildings-layer';
import { GRID_ZOOM } from '../tiles/tile-features';
import { TileStore, type TileVia } from './tile-store';
import { timed } from '../perf';

export const OVERPASS_TILE_ZOOM = GRID_ZOOM;
/** Сколько тайлов держать в кеше данных. */
const CACHE_SIZE = 48;
/** Сколько ближайших к центру тайлов загружать одновременно видимыми. */
const MAX_VISIBLE = 12;
/** Данные старше этого показываем из кеша, но перезапрашиваем в фоне. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Пауза перед повторной попыткой фонового обновления после ошибки. */
const REFRESH_RETRY_MS = 5 * 60 * 1000;
/** Сколько раз пробовать тайл, перезапрошенный кнопкой, прежде чем сдаться. */
const RELOAD_ATTEMPTS = 3;

type Entry =
  | { state: 'lookup' } // ищем в IndexedDB
  | { state: 'queued' } // в IndexedDB нет, ждёт свободного слота запроса к API
  | { state: 'loading'; abort: AbortController }
  | { state: 'ready'; features: Feature3D[]; groups: BuildingGroup[]; fetchedAt: number; via?: TileVia; refreshing?: AbortController; refreshAfter?: number }
  | { state: 'error'; retryAt: number; attempts: number };

/**
 * full — видимые тайлы грузятся (память → IndexedDB → OSM API);
 * cached — только то, что уже есть в кеше, без запросов к API (мелкие зумы);
 * off — слой выключен.
 */
export type OverpassMode = 'full' | 'cached' | 'off';

/** Откуда брать данные тайлов: /map OSM API сервера, куда идёт запись; у каждого сервера свой кеш. */
export interface TileSource { api: string; db: string }

/**
 * Подменяет тайловые здания данными OSM API по сетке тайлов z14.
 * Источники по порядку: память (LRU) → IndexedDB → OSM API (/map). Устаревшие тайлы показываются сразу,
 * а в фоне перезапрашиваются. Меши есть только у видимых тайлов.
 */
export class OverpassTiles {
  private readonly cache = new Map<string, Entry>(); // порядок вставки = LRU
  private wanted: string[] = [];
  pool = new RequestPool([]);
  store = new TileStore();
  private source?: TileSource;
  private pumpTimer?: ReturnType<typeof setTimeout>;
  /** Нарисованные здания по ключу OSM — для панели по клику. */
  private readonly rendered = new Map<string, RenderedFeature>();
  /** Какие контуры каждого показанного тайла скрыты из-за частей — чтобы перестраивать тайл, только если это изменилось. */
  private readonly hiddenOutlines = new Map<string, string>();
  /** Ключи тайлов в IndexedDB — для режима cached не нужно опрашивать базу по каждому тайлу экрана. */
  private stored = new Set<string>();
  /** Отношения type=building из загруженных тайлов и обратный индекс «член → группа». */
  private readonly groups = new Map<string, BuildingGroup>();
  private readonly memberGroup = new Map<string, string>();
  /** Тайлы, перезапрошенные кнопкой: до прихода ответа считаются загружающимися в индикаторе. */
  private readonly reloading = new Map<string, number>(); // ключ → число неудачных попыток
  /** Перезапрос не удался после всех попыток — в индикаторе это «ждут повтора». */
  private readonly reloadFailed = new Set<string>();
  mode: OverpassMode = 'off';

  /**
   * overlay — подмена объекта перед отрисовкой (несохранённые правки живут поверх данных тайлов
   * и переживают их перезагрузку).
   */
  constructor(
    private readonly map: MlMap, private readonly layer: BuildingsLayer, private readonly onChange: () => void,
    private readonly overlay: (f: Feature3D) => Feature3D = (f) => f,
  ) {
    this.loadStoredKeys();
  }

  private loadStoredKeys() {
    const store = this.store;
    void store.keys().then((keys) => {
      if (store !== this.store) return; // источник успели сменить
      for (const k of keys) this.stored.add(k);
      if (this.mode === 'cached') this.update();
    });
  }

  /** Сменить источник данных: всё загруженное сбрасывается, кеш — свой у каждого источника. */
  setSource(source: TileSource) {
    this.source = source;
    for (const e of this.cache.values()) {
      if (e.state === 'loading') e.abort.abort();
      if (e.state === 'ready') e.refreshing?.abort();
    }
    this.cache.clear();
    this.layer.clear();
    this.rendered.clear();
    this.hiddenOutlines.clear();
    this.groups.clear();
    this.memberGroup.clear();
    this.reloading.clear();
    this.reloadFailed.clear();
    this.stored = new Set();
    this.pool = new RequestPool([source.api]);
    this.store = new TileStore(source.db);
    this.loadStoredKeys();
    this.update();
  }

  get sourceLabel(): string {
    return 'OSM API';
  }

  /** Перерисовать объекты (после правки тегов): берётся версия из overlay. */
  refreshFeatures(keys: string[]) {
    for (const tile of this.layer.groupKeys()) {
      const e = this.cache.get(tile);
      if (e?.state !== 'ready') continue;
      for (const f of e.features) {
        if (!keys.includes(f.key)) continue;
        const cur = this.overlay(f);
        if (!cur.polygons.length) continue; // удалён — уберёт перерисовка тайла
        this.layer.setViewHidden(f.key, this.bareOutline(cur));
        const r = this.layer.updateFeature(tile, cur);
        if (r) this.rendered.set(f.key, r);
      }
    }
  }

  /** Все объекты загруженных тайлов (без повторов, с правками) — например, для поиска контура под частями. */
  allFeatures(): Feature3D[] {
    const out = new Map<string, Feature3D>();
    for (const e of this.cache.values()) {
      if (e.state === 'ready') for (const f of e.features) if (!out.has(f.key)) out.set(f.key, this.overlay(f));
    }
    return [...out.values()].filter((f) => f.polygons.length);
  }

  get enabled(): boolean {
    return this.mode !== 'off';
  }

  get(key: string): RenderedFeature | undefined {
    return this.rendered.get(key);
  }

  /** Объекты, которых ещё нет в данных (созданы в сессии: рассечение), — рисуются в тайле своего центра. */
  private extras: () => Feature3D[] = () => [];
  setExtras(fn: () => Feature3D[]) { this.extras = fn; }

  /** Перерисовать нарисованные тайлы (появился или исчез созданный объект). */
  rerender() {
    for (const key of this.layer.groupKeys()) if (this.cache.get(key)?.state === 'ready') this.show(key);
  }

  /**
   * Перерисовать только тайлы с этими объектами: где они лежат в данных (прежнее место) и где их центр
   * сейчас (с правками; созданные — только там). Быстрее полной пересборки всех видимых тайлов.
   */
  rerenderFeatures(keys: Iterable<string>) {
    const want = new Set(keys);
    const visible = new Set(this.layer.groupKeys());
    const tiles = new Set<string>();
    for (const [tile, e] of this.cache) {
      if (e.state === 'ready' && visible.has(tile) && e.features.some((f) => want.has(f.key))) tiles.add(tile);
    }
    const current = [...this.allFeatures(), ...this.extras()].filter((f) => want.has(f.key) && f.polygons.length);
    for (const f of current) {
      const [x, y] = centroid(f.polygons[0].outer);
      const [tx, ty] = lngLatToTile(x, y, OVERPASS_TILE_ZOOM);
      tiles.add(`${OVERPASS_TILE_ZOOM}/${tx}/${ty}`);
    }
    // Точечно: в каждом тайле — заменить или добавить свои (по центру) затронутые объекты и убрать ушедшие
    for (const t of tiles) {
      if (!visible.has(t) || this.cache.get(t)?.state !== 'ready') continue;
      const { features, hidden } = this.ownedFeatures(t);
      this.hiddenOutlines.set(t, hidden);
      const upsert = features.filter((f) => want.has(f.key));
      const mine = new Set(upsert.map((f) => f.key));
      for (const f of upsert) this.layer.setViewHidden(f.key, this.bareOutline(f));
      const remove = [...want].filter((k) => !mine.has(k));
      for (const r of this.layer.patchGroup(t, upsert, remove)) this.rendered.set(r.feature.key, r);
    }
    for (const k of want) if (!this.layer.hasFeature(k)) this.rendered.delete(k);
    this.onChange();
  }

  private readonly featureIndex = new WeakMap<Feature3D[], Map<string, Feature3D>>();

  /** Объект из загруженных данных, даже если ещё не нарисован (контур в соседнем тайле и т. п.). */
  findFeature(key: string): Feature3D | undefined {
    const r = this.rendered.get(key);
    if (r) return r.feature;
    for (const e of this.cache.values()) {
      if (e.state !== 'ready') continue;
      let idx = this.featureIndex.get(e.features);
      if (!idx) this.featureIndex.set(e.features, idx = new Map(e.features.map((f) => [f.key, f])));
      const f = idx.get(key);
      if (f) return this.overlay(f);
    }
  }

  /** Объекты, нарисованные сейчас. */
  renderedFeatures(): RenderedFeature[] {
    return [...this.rendered.values()].filter((r) => this.layer.hasFeature(r.feature.key));
  }

  /** Группа type=building, в которую входит объект (или сама группа по её ключу). */
  groupOf(key: string): BuildingGroup | undefined {
    return this.groups.get(this.memberGroup.get(key) ?? key);
  }

  private indexGroups(groups: BuildingGroup[]) {
    for (const g of groups) {
      this.groups.set(g.key, g);
      for (const m of g.members) {
        const cur = this.memberGroup.get(m);
        if (!cur || cur === g.key || !this.groups.has(cur)) this.memberGroup.set(m, g.key);
      }
    }
  }

  /** Ключи тайлов, чьи здания сейчас нарисованы нашим слоем. */
  displayed(): string[] {
    return this.layer.groupKeys();
  }

  status(): { ready: number; total: number; loading: number; waiting: number } {
    const count = (state: Entry['state']) => this.wanted.filter((k) => this.cache.get(k)?.state === state && !this.reloading.has(k)).length;
    const reloading = this.wanted.filter((k) => this.reloading.has(k)).length;
    const failed = this.wanted.filter((k) => this.reloadFailed.has(k) && !this.reloading.has(k)).length;
    return {
      ready: count('ready') - failed, total: this.wanted.length,
      loading: count('loading') + count('lookup') + count('queued') + reloading, waiting: count('error') + failed,
    };
  }

  /** Сводка о видимых тайлах для подсказки индикатора: откуда данные и насколько они старые. */
  freshness(): { overpass: number; api: number; unknown: number; oldest?: number } {
    const out: { overpass: number; api: number; unknown: number; oldest?: number } = { overpass: 0, api: 0, unknown: 0 };
    for (const k of this.wanted) {
      const e = this.cache.get(k);
      if (e?.state !== 'ready') continue;
      out[e.via ?? 'unknown']++;
      // fetchedAt = 0 — тайл помечен устаревшим (кнопкой или старый формат), возраст неизвестен
      if (e.fetchedAt && (out.oldest === undefined || e.fetchedAt < out.oldest)) out.oldest = e.fetchedAt;
    }
    return out;
  }

  /** Пересчитать нужные тайлы после движения карты. */
  update() {
    this.wanted = this.mode === 'full' ? this.visibleTiles() : this.mode === 'cached' ? this.cachedVisibleTiles() : [];
    const wanted = new Set(this.wanted);

    // И показанные, и ещё собирающиеся (их сборку removeGroup отменит)
    for (const key of new Set([...this.layer.groupKeys(), ...this.hiddenOutlines.keys()])) {
      if (wanted.has(key)) continue;
      this.layer.removeGroup(key);
      this.hiddenOutlines.delete(key);
    }
    for (const [key, e] of this.cache) {
      // Ушедшие из вида загрузки отменяем, чтобы не занимать слоты Overpass
      if (wanted.has(key)) continue;
      if (e.state === 'loading') { e.abort.abort(); this.cache.delete(key); }
      if (e.state === 'ready') e.refreshing?.abort();
      if (e.state === 'lookup' || e.state === 'queued') this.cache.delete(key);
    }
    for (const key of this.wanted) {
      const e = this.cache.get(key);
      if (e?.state === 'ready') {
        this.touch(key, e);
        if (!this.layer.hasGroup(key) && !this.hiddenOutlines.has(key)) this.show(key);
      }
    }
    this.pump();
    this.onChange();
  }

  private pump() {
    if (this.mode === 'cached') {
      // Без сети: только поиск в IndexedDB
      for (const key of this.wanted) if (!this.cache.has(key)) void this.lookup(key);
      return;
    }
    const refresh: string[] = [];
    for (const key of this.wanted) {
      const e = this.cache.get(key);
      if (!e) { void this.lookup(key); continue; }
      if (e.state === 'lookup' || e.state === 'loading') continue;
      if (e.state === 'ready') {
        if (this.isStale(e)) refresh.push(key);
        continue;
      }
      if (e.state === 'error' && Date.now() < e.retryAt) continue;
      if (!this.startLoad(key, e.state === 'error' ? e.attempts : 0)) return;
    }
    // Фоновое обновление устаревших — только когда новые тайлы уже разобраны по инстансам
    for (const key of refresh) if (!this.startLoad(key, 0)) return;
  }

  private isStale(e: Extract<Entry, { state: 'ready' }>): boolean {
    const now = Date.now();
    return !e.refreshing && now - e.fetchedAt > MAX_AGE_MS && now >= (e.refreshAfter ?? 0);
  }

  /** false — свободных инстансов нет. */
  private startLoad(key: string, attempts: number): boolean {
    const ep = this.pool.acquire();
    if (!ep) {
      // Все инстансы заняты или остывают — попробуем, когда какой-то освободится
      const wait = this.pool.nextAvailableIn();
      if (wait > 0) this.schedulePump(wait);
      return false;
    }
    void this.load(key, attempts, ep);
    return true;
  }

  private async lookup(key: string) {
    this.cache.set(key, { state: 'lookup' });
    const stored = await this.store.get(key);
    if (this.cache.get(key)?.state !== 'lookup') return; // за время поиска ушли с тайла
    if (stored) {
      this.cache.set(key, { state: 'ready', ...stored });
      this.evict();
      this.tileReady(key);
    } else if (this.mode === 'cached') {
      // Запись вытеснена или старого формата — в режиме cached такой тайл не нужен
      this.stored.delete(key);
      this.cache.delete(key);
    } else {
      // Нет в IndexedDB — сразу в очередь на Overpass (удалять запись нельзя: pump снова пошёл бы в IndexedDB)
      this.cache.set(key, { state: 'queued' });
    }
    this.pump();
    this.onChange();
  }

  private schedulePump(ms: number) {
    clearTimeout(this.pumpTimer);
    this.pumpTimer = setTimeout(() => this.update(), ms + 50);
  }

  private async load(key: string, attempts: number, ep: ReturnType<RequestPool['acquire']> & object) {
    const abort = new AbortController();
    const prev = this.cache.get(key);
    // Обновление устаревшего тайла: старые данные остаются на экране, пока не придут новые
    const refreshing = prev?.state === 'ready' ? prev : undefined;
    if (refreshing) refreshing.refreshing = abort;
    else this.cache.set(key, { state: 'loading', abort });
    let result: 'ok' | 'busy' | 'error' | 'aborted' = 'ok';
    try {
      if (!this.source) throw new Error('источник данных не задан');
      const elements = await fetchArea(tileBbox(key), incompleteBuildingRelations, ep.url, abort.signal);
      const via: TileVia = 'api';
      const { features, groups } = timed('тайлы: разбор ответа API', () => parseBuildings(elements), (r) => `${key}, ${r.features.length} зданий`);
      const fetchedAt = Date.now();
      this.cache.set(key, { state: 'ready', features, groups, fetchedAt, via });
      this.reloading.delete(key);
      this.reloadFailed.delete(key);
      void this.store.put(key, { features, groups, fetchedAt, via });
      this.stored.add(key);
      this.evict();
      this.tileReady(key);
    } catch (err) {
      if (abort.signal.aborted) {
        result = 'aborted';
        if (refreshing) refreshing.refreshing = undefined;
        return;
      }
      // Перегрузка или лимит сервера — повторим позже, сервер «остынет»
      const busy = err instanceof ApiError && [429, 503, 509].includes(err.status);
      result = busy ? 'busy' : 'error';
      console.warn(`OSM API ${key}${refreshing ? ' (обновление)' : ''}:`, (err as Error).message);
      if (refreshing) {
        refreshing.refreshing = undefined;
        const tries = this.reloading.get(key);
        if (tries !== undefined && tries + 1 < RELOAD_ATTEMPTS) {
          // Перезапрос по кнопке — повторяем вскоре (инстанс с ошибкой остынет, пойдёт другой)
          this.reloading.set(key, tries + 1);
          const delay = busy ? 1_000 : 2_000 * 2 ** tries;
          refreshing.refreshAfter = Date.now() + delay;
          this.schedulePump(delay);
          return;
        }
        if (tries !== undefined) this.reloadFailed.add(key);
        this.reloading.delete(key);
        // Данные есть — не мучаем сервер, попробуем обновить позже
        refreshing.refreshAfter = Date.now() + REFRESH_RETRY_MS;
        return;
      }
      // При перегрузке инстанса повтор сразу уйдёт на другой — пауза короткая;
      // при прочих ошибках — экспоненциальная
      const delay = busy ? 1_000 : Math.min(60_000, 2_000 * 2 ** attempts);
      this.cache.set(key, { state: 'error', retryAt: Date.now() + delay, attempts: attempts + 1 });
      this.schedulePump(delay);
    } finally {
      if (result === 'aborted') this.reloading.delete(key);
      this.pool.release(ep, result);
      this.pump();
      this.onChange();
    }
  }

  /**
   * Отправленные правки — сразу в данные тайлов (память и IndexedDB), без перезапроса Overpass:
   * иначе до фонового обновления тайла кеш показывал бы старые теги. fetchedAt не трогаем.
   */
  async applySaved(saved: Map<string, { version: number; tags: Record<string, string>; polygons?: Polygon[]; ways?: MemberWay[] }>, savedGroups: BuildingGroup[] = [],
    createdFeatures: Feature3D[] = [], deleted: string[] = []) {
    const gone = new Set(deleted);
    // Созданные пути (рассечение) — в тайл, где их центр; ниже patch обновит и их
    for (const f of createdFeatures) {
      const [x, y] = centroid(f.polygons[0].outer);
      const tile = [...this.cache].find(([k, e]) => {
        const [w, s, e2, n] = tileBbox(k);
        return e.state === 'ready' && x >= w && x < e2 && y > s && y <= n;
      });
      if (tile && tile[1].state === 'ready' && !tile[1].features.some((g) => g.key === f.key)) tile[1].features.push({ ...f, tags: { ...f.tags } });
    }
    // Группы (новые или с другим составом) кладём целиком в тайлы, где лежит хоть один их член
    const groupFor = (t: { features: Feature3D[] }) => savedGroups.filter((g) => t.features.some((f) => g.members.includes(f.key)));
    const patchGroups = (t: { features: Feature3D[]; groups: BuildingGroup[] }) => {
      const fresh = new Map(groupFor(t).map((g) => [g.key, g]));
      const out = t.groups.map((g) => {
        const s = saved.get(g.key);
        return fresh.get(g.key) ?? (s ? { ...g, version: s.version, tags: s.tags } : g);
      });
      for (const g of fresh.values()) if (!t.groups.some((x) => x.key === g.key)) out.push(g);
      return out;
    };
    const touched = (t: { features: Feature3D[]; groups: BuildingGroup[] }) =>
      t.features.some((f) => saved.has(f.key) || gone.has(f.key)) || t.groups.some((g) => saved.has(g.key)) || groupFor(t).length > 0;
    const patch = (features: Feature3D[]): Feature3D[] => {
      if (!features.some((f) => saved.has(f.key) || gone.has(f.key))) return features;
      const out: Feature3D[] = [];
      for (const f of features) {
        if (gone.has(f.key)) continue; // удалён в OSM
        const s = saved.get(f.key);
        if (!s) { out.push(f); continue; }
        const kind = kindOf(s.tags);
        if (kind) out.push({ ...f, kind, version: s.version, tags: s.tags, polygons: s.polygons ?? f.polygons, hasParts: false, ...(s.ways ? { ways: s.ways } : {}) });
      }
      markOutlinesWithParts(out);
      return out;
    };
    const inMemory = new Set<string>();
    for (const [key, e] of this.cache) {
      if (e.state !== 'ready') continue;
      inMemory.add(key);
      if (!touched(e)) continue;
      e.groups = patchGroups(e);
      e.features = patch(e.features);
      this.indexGroups(e.groups);
      void this.store.put(key, e);
      if (this.layer.groupKeys().includes(key)) this.show(key);
    }
    for (const key of this.stored) {
      if (inMemory.has(key)) continue;
      const stored = await this.store.get(key);
      if (stored && touched(stored)) {
        await this.store.put(key, { ...stored, groups: patchGroups(stored), features: patch(stored.features) });
      }
    }
  }

  /** Повторить сейчас тайлы, упавшие с ошибкой (не дожидаясь паузы перед повтором). */
  retryFailed() {
    for (const e of this.cache.values()) if (e.state === 'error') e.retryAt = 0;
    this.update();
    this.onChange();
  }

  /** Отладка: перезапросить видимые тайлы из Overpass (старые данные остаются на экране до прихода новых). */
  reloadVisible(): number {
    let n = 0;
    for (const key of this.wanted) {
      const e = this.cache.get(key);
      if (e?.state === 'ready') { e.fetchedAt = 0; e.refreshAfter = undefined; this.reloading.set(key, 0); this.reloadFailed.delete(key); n++; }
    }
    this.update();
    this.onChange();
    return n;
  }

  async clearStore() {
    await this.store.clear();
    this.stored.clear();
    // Данные в памяти считаем устаревшими — перезапросятся в фоне
    for (const e of this.cache.values()) if (e.state === 'ready') e.fetchedAt = 0;
    this.update();
  }

  /** Тайл получил данные: показать его и, если надо, перестроить соседей (их контуры могли «увидеть» части). */
  private tileReady(key: string) {
    const e = this.cache.get(key);
    if (e?.state === 'ready') this.indexGroups(e.groups);
    if (this.wanted.includes(key)) this.show(key);
    for (const n of neighbours(key)) {
      if (!this.hiddenOutlines.has(n)) continue;
      if (this.ownedFeatures(n).hidden !== this.hiddenOutlines.get(n)) this.show(n);
    }
  }

  /**
   * Здания, принадлежащие тайлу: Overpass отдаёт всё, что задевает bbox, поэтому здание на границе приходит
   * в обоих тайлах — рисуем его только в том, где его центр. Части ищем и в соседних тайлах:
   * иначе контур, чьи части лежат по ту сторону границы, рисуется поверх них.
   */
  private ownedFeatures(key: string): { features: Feature3D[]; hidden: string } {
    const own = this.cache.get(key);
    if (own?.state !== 'ready') return { features: [], hidden: '' };
    // Удалённые в сессии (overlay отдаёт их без геометрии) — не рисуем
    const ownFeatures = [...own.features.map(this.overlay), ...this.extras()].filter((f) => f.polygons.length);
    const union = new Map<string, Feature3D>();
    for (const f of ownFeatures) union.set(f.key, f); // свои объекты — первыми: их hasParts и пойдёт в рендер
    for (const n of neighbours(key)) {
      const e = this.cache.get(n);
      if (e?.state === 'ready') for (const f of e.features) if (!union.has(f.key)) { const o = this.overlay(f); if (o.polygons.length) union.set(f.key, o); }
    }
    // Пересчитываем только свои здания — части берём из всех девяти тайлов
    timed('overpass: части у контуров', () => markOutlinesWithParts([...union.values()], ownFeatures), () => `${key}, ${union.size} объектов`);
    const [w, s, e, n] = tileBbox(key);
    const features = ownFeatures.filter((f) => {
      const [x, y] = centroid(f.polygons[0].outer);
      return x >= w && x < e && y > s && y <= n;
    });
    const hidden = features.filter((f) => f.hasParts).map((f) => f.key).join(',');
    return { features, hidden };
  }

  /**
   * Контур (outline) отношения type=building без своей высоты и не являющийся частью: в режиме просмотра
   * его плоский след не нужен — здание целиком нарисовано частями.
   */
  private bareOutline(f: Feature3D): boolean {
    if (!isBareOutlineTags(f.tags)) return false;
    const g = this.groups.get(this.memberGroup.get(f.key) ?? '');
    return !!g && g.roles[g.members.indexOf(f.key)] === 'outline';
  }

  private show(key: string) {
    const { features, hidden } = timed('overpass: отбор зданий тайла', () => this.ownedFeatures(key), () => key);
    this.hiddenOutlines.set(key, hidden);
    // Голые контуры отношений: в данных и выборе остаются, но не рисуются
    this.layer.hideInView(features.filter((f) => this.bareOutline(f)).map((f) => f.key));
    const [w, s, e, n] = tileBbox(key);
    void this.layer.setGroupAsync(key, features, [(w + e) / 2, (s + n) / 2]).then((rendered) => {
      if (!rendered) return; // сборку отменили — тайл ушёл из вида или пересобирается заново
      for (const r of rendered) this.rendered.set(r.feature.key, r);
      this.onChange();
    });
  }

  private touch(key: string, e: Entry) {
    this.cache.delete(key);
    this.cache.set(key, e);
  }

  private evict() {
    for (const [key, e] of this.cache) {
      if (this.cache.size <= CACHE_SIZE) break;
      if (e.state === 'ready' && !this.wanted.includes(key)) this.cache.delete(key);
    }
  }

  /** Мелкие зумы: ближайшие к центру тайлы из кеша, попадающие в экран. */
  private cachedVisibleTiles(): string[] {
    const b = this.map.getBounds();
    const c = this.map.getCenter();
    const [cx, cy] = lngLatToTile(c.lng, c.lat, OVERPASS_TILE_ZOOM, false);
    const keys = new Set([...this.stored, ...[...this.cache].filter(([, e]) => e.state === 'ready').map(([k]) => k)]);
    return [...keys]
      .filter((k) => {
        const [w, s, e, n] = tileBbox(k);
        return e >= b.getWest() && w <= b.getEast() && n >= b.getSouth() && s <= b.getNorth();
      })
      .map((key) => {
        const [, x, y] = key.split('/').map(Number);
        return { key, d: Math.hypot(x + 0.5 - cx, y + 0.5 - cy) };
      })
      .sort((a, b) => a.d - b.d)
      .slice(0, MAX_VISIBLE)
      .map((t) => t.key);
  }

  private visibleTiles(): string[] {
    const z = OVERPASS_TILE_ZOOM;
    const b = this.map.getBounds();
    const [x0, y1] = lngLatToTile(b.getWest(), b.getSouth(), z);
    const [x1, y0] = lngLatToTile(b.getEast(), b.getNorth(), z);
    const c = this.map.getCenter();
    const [cx, cy] = lngLatToTile(c.lng, c.lat, z, false);
    const tiles: { key: string; d: number }[] = [];
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) tiles.push({ key: `${z}/${x}/${y}`, d: Math.hypot(x + 0.5 - cx, y + 0.5 - cy) });
    }
    // При сильном наклоне в bbox попадает горизонт — берём только ближайшие к центру
    return tiles.sort((a, b) => a.d - b.d).slice(0, MAX_VISIBLE).map((t) => t.key);
  }
}

function neighbours(key: string): string[] {
  const [z, x, y] = key.split('/').map(Number);
  const out: string[] = [];
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (dx || dy) out.push(`${z}/${x + dx}/${y + dy}`);
  return out;
}

function lngLatToTile(lng: number, lat: number, z: number, floor = true): [number, number] {
  const n = 2 ** z;
  const x = ((lng + 180) / 360) * n;
  const r = (Math.max(-85, Math.min(85, lat)) * Math.PI) / 180;
  const y = ((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * n;
  return floor ? [Math.floor(x), Math.floor(y)] : [x, y];
}

export function tileBbox(key: string): Bbox {
  const [z, x, y] = key.split('/').map(Number);
  const n = 2 ** z;
  const lon = (i: number) => (i / n) * 360 - 180;
  const lat = (j: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * j) / n))) * 180) / Math.PI;
  return [lon(x), lat(y + 1), lon(x + 1), lat(y)];
}

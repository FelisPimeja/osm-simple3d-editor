import type { Map as MlMap } from 'maplibre-gl';
import { server, SERVERS } from '../osm/servers';
import { fetchOverpassTile, overpassFree } from '../osm/overpass';
import { ApiError, completeRelations, fetchMapSplit, type Bbox, type OsmElement } from '../osm/api';
import { centroid, incompleteBuildingRelations, incompleteIndoorRelations, isBareOutlineTags, kindOf, markOutlinesWithParts, parseBuildings, type BuildingGroup, type Feature3D, type IndoorFeature, type MemberWay, type Polygon } from '../osm/model';
import { RequestPool } from '../osm/request-pool';
import type { BuildingsLayer, RenderedFeature } from '../render/buildings-layer';
import { GRID_ZOOM } from '../tiles/tile-features';
import { TileStore, type TileVia } from './tile-store';
import { timed } from '../perf';
import { josmLayer } from '../osm/josm';
import { incompleteWoodRelations, NO_TREES, parseTrees, type TreeData, type TreePoint, type WoodArea } from '../osm/trees';
import { scatterTreesAsync, TreeGroup } from '../render/trees';
import { TREE_STRIDE, TreeField } from '../render/tree-scatter';
import { parseRoads, type RoadWay } from '../osm/roads';

export const OVERPASS_TILE_ZOOM = GRID_ZOOM;
/** Сколько тайлов держать в кеше данных. */
const CACHE_SIZE = 48;
/** Сколько видимых тайлов показывать из готового кеша. */
const MAX_VISIBLE = 12;
/** Холодные тайлы грузим только рядом с камерой, даже если у горизонта видно полгорода. */
const API_RADIUS_METERS = 1500;
const MAX_NETWORK_VISIBLE = 4;
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
  | { state: 'ready'; features: Feature3D[]; groups: BuildingGroup[]; indoor: IndoorFeature[]; trees?: TreeData; roads?: RoadWay[]; fetchedAt: number; via?: TileVia; refreshing?: AbortController; refreshAfter?: number; partial?: boolean }
  | { state: 'error'; retryAt: number; attempts: number };

/**
 * full — видимый кеш показывается, API запрашивается только рядом с камерой;
 * cached — только то, что уже есть в кеше, без запросов к API (мелкие зумы);
 * off — слой выключен.
 */
export type OverpassMode = 'full' | 'cached' | 'off';

/** Откуда брать данные тайлов: /map OSM API сервера, куда идёт запись; у каждого сервера свой кеш. */
export interface TileSource { api: string; db: string; josm?: boolean }

/**
 * Подменяет тайловые здания данными OSM API по сетке тайлов z14.
 * Источники по порядку: память (LRU) → IndexedDB → OSM API (/map). Устаревшие тайлы показываются сразу,
 * а рядом с камерой перезапрашиваются в фоне. Меши есть только у видимых тайлов.
 */
/** Таймаут запроса четверти тайла к API: дольше — сервер считаем не отвечающим (повтор через 30 с). */
const REQUEST_TIMEOUT_MS = 30_000;

export class OverpassTiles {
  private readonly cache = new Map<string, Entry>(); // порядок вставки = LRU
  private wanted: string[] = [];
  private networkWanted = new Set<string>();
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
  lastApiError?: string;
  /** Перезапрос не удался после всех попыток — в индикаторе это «ждут повтора». */
  private readonly reloadFailed = new Set<string>();
  mode: OverpassMode = 'off';
  /** Нужны дороги (мосты и развязки): тайлы из кеша без них перезапрашиваются в фоне. */
  roadsWanted = false;

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
      this.update();
    });
  }

  /** Сменить источник данных: всё загруженное сбрасывается, кеш — свой у каждого источника. */
  setSource(source: TileSource) {
    this.source = source;
    this.lastApiError = undefined;
    for (const e of this.cache.values()) {
      if (e.state === 'loading') e.abort.abort();
      if (e.state === 'ready') e.refreshing?.abort();
    }
    this.cache.clear();
    this.layer.clear();
    this.treesPending.clear();
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
    return this.source?.josm ? 'JOSM' : `API ${server().short}`;
  }

  /** Слой JOSM перечитан: загруженные тайлы получают новые данные (старые остаются на экране до пересборки). */
  async refreshJosm() {
    if (!this.source?.josm) return;
    const parsed = await josmParsed();
    for (const [key, e] of [...this.cache]) {
      if (e.state === 'ready') {
        this.cache.set(key, { state: 'ready', ...josmTile(parsed, tileBbox(key)), fetchedAt: Date.now() });
        this.tileReady(key);
      } else if (e.state === 'error') this.cache.delete(key); // JOSM снова отвечает — без ожидания повтора
    }
    this.update();
  }

  /** Перерисовать объекты (после правки тегов): берётся версия из overlay. */
  refreshFeatures(keys: string[]) {
    const want = new Set(keys);
    for (const tile of this.layer.groupKeys()) {
      const e = this.cache.get(tile);
      if (e?.state !== 'ready') continue;
      // Пачкой на тайл: геометрия тайла пересобирается один раз (при сотнях частей здания — не сотни раз)
      const batch: Feature3D[] = [];
      for (const f of e.features) {
        if (!want.has(f.key)) continue;
        const cur = this.overlay(f);
        if (!cur.polygons.length) continue; // удалён — уберёт перерисовка тайла
        this.layer.setViewHidden(f.key, this.bareOutline(cur));
        batch.push(cur);
      }
      if (batch.length) for (const r of this.layer.updateFeatures(tile, batch)) this.rendered.set(r.feature.key, r);
    }
  }

  /** Дороги показанных тайлов (пути на границе — по разу от каждого тайла). */
  roads(): RoadWay[] {
    const out: RoadWay[] = [];
    for (const k of this.wanted) { const e = this.cache.get(k); if (e?.state === 'ready' && e.roads) out.push(...e.roads); }
    return out;
  }

  /** Отдельные деревья видимых тайлов; старые записи кеша без id ещё нельзя выбрать. */
  treePoints(): TreePoint[] {
    const out = new Map<string, TreePoint>();
    for (const k of this.wanted) {
      const e = this.cache.get(k);
      if (e?.state !== 'ready') continue;
      for (const tree of e.trees?.points ?? []) if (tree.key) out.set(tree.key, tree);
    }
    return [...out.values()];
  }

  /** Indoor-объекты загруженных тайлов (без повторов), хотя бы одной вершиной внутри bbox [w, s, e, n]. */
  indoorIn([w, s, e, n]: Bbox): IndoorFeature[] {
    const out = new Map<string, IndoorFeature>();
    for (const t of this.cache.values()) {
      if (t.state !== 'ready') continue;
      for (const f of t.indoor ?? []) {
        if (out.has(f.key)) continue;
        if ((f.point && f.point[0] >= w && f.point[0] <= e && f.point[1] >= s && f.point[1] <= n)
          || f.polygons.some((p) => p.outer.some(([x, y]) => x >= w && x <= e && y >= s && y <= n))) out.set(f.key, f);
      }
    }
    return [...out.values()];
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

  /** Какие объекты рисовать (фильтр по дате OHM); смена — перерисовка показанных тайлов. */
  private visible: (f: Feature3D) => boolean = () => true;
  setFeatureFilter(fn: (f: Feature3D) => boolean) {
    this.visible = fn;
    for (const key of this.layer.groupKeys()) this.show(key);
  }
  /** Проходит ли объект фильтр по дате. */
  isVisible(f: Feature3D): boolean { return this.visible(f); }

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

  /** Исходные данные тайла без несохранённых правок сессии и без нарисованного overlay. */
  cachedFeature(key: string): Feature3D | undefined {
    for (const e of this.cache.values()) {
      if (e.state !== 'ready') continue;
      const feature = e.features.find((f) => f.key === key);
      if (feature) return feature;
    }
  }

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
      const previous = this.groups.get(g.key);
      if (previous) for (const member of previous.members) {
        if (!g.members.includes(member) && this.memberGroup.get(member) === g.key) this.memberGroup.delete(member);
      }
      this.groups.set(g.key, g);
      for (const m of g.members) {
        const cur = this.memberGroup.get(m);
        if (!cur || cur === g.key || !this.groups.has(cur)) this.memberGroup.set(m, g.key);
      }
    }
  }

  /** Ключи нужных сейчас тайлов (видимые и взятые из кеша). */
  tiles(): string[] {
    return this.wanted;
  }

  /** Ключи тайлов, чьи здания сейчас нарисованы нашим слоем. */
  displayed(): string[] {
    return this.layer.groupKeys();
  }

  status(): { ready: number; total: number; loading: number; waiting: number } {
    const count = (state: Entry['state']) => this.wanted.filter((k) => this.cache.get(k)?.state === state && !this.reloading.has(k)).length;
    const reloading = this.wanted.filter((k) => this.reloading.has(k)).length;
    const partial = this.wanted.filter((k) => { const e = this.cache.get(k); return e?.state === 'ready' && e.partial && !this.reloading.has(k); }).length;
    const failed = this.wanted.filter((k) => this.reloadFailed.has(k) && !this.reloading.has(k)).length;
    return {
      ready: count('ready') - partial - failed, total: this.wanted.length,
      loading: count('loading') + partial + count('lookup') + count('queued') + reloading, waiting: count('error') + failed,
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
    const near = this.mode === 'full' ? this.visibleTiles() : [];
    this.networkWanted = new Set(near);
    this.wanted = this.mode === 'off' ? [] : [...new Set([...near, ...this.cachedVisibleTiles()])];
    const wanted = new Set(this.wanted);

    // И показанные, и ещё собирающиеся (их сборку removeGroup отменит)
    for (const key of new Set([...this.layer.groupKeys(), ...this.hiddenOutlines.keys()])) {
      if (wanted.has(key)) continue;
      this.layer.removeGroup(key);
      this.hiddenOutlines.delete(key);
    }
    for (const key of this.layer.treeKeys()) if (!wanted.has(key)) this.layer.setTrees(key, undefined);
    for (const key of [...this.treesPending.keys()]) if (!wanted.has(key)) this.treesPending.delete(key);
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
        if (!this.networkWanted.has(key)) e.refreshing?.abort();
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
      if (!this.networkWanted.has(key)) {
        if (!e && this.mode !== 'off') void this.lookup(key);
        continue;
      }
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
    const old = now - e.fetchedAt > MAX_AGE_MS || (this.roadsWanted && !e.roads && !e.partial);
    return !e.refreshing && old && now >= (e.refreshAfter ?? 0);
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
    // Слой JOSM в IndexedDB не кладём: он меняется вместе с правками в JOSM
    const stored = this.source?.josm ? undefined : await this.store.get(key);
    if (this.cache.get(key)?.state !== 'lookup') return; // за время поиска ушли с тайла
    if (stored) {
      this.cache.set(key, { state: 'ready', ...stored });
      this.evict();
      this.tileReady(key);
    } else if (!this.networkWanted.has(key)) {
      // Дальняя запись вытеснена или старого формата — сеть для неё не включаем
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
    let unreachable = false;
    let cooldown: number | undefined;
    try {
      if (!this.source) throw new Error('источник данных не задан');
      if (this.source.josm) {
        const { features, groups, indoor, trees, roads } = josmTile(await josmParsed(), tileBbox(key));
        if (abort.signal.aborted) throw new DOMException('aborted', 'AbortError');
        this.cache.set(key, { state: 'ready', features, groups, indoor, trees, roads, fetchedAt: Date.now() });
        this.reloading.delete(key);
        this.reloadFailed.delete(key);
        this.evict();
        this.tileReady(key);
        return;
      }
      let via: TileVia = 'api';
      // Дороги в ответе Overpass — только если их просили (у /map они есть всегда)
      const withRoads = this.roadsWanted;
      const seen = new Map<string, OsmElement>();
      // Боевой OSM — сначала Overpass: ответ в разы меньше и не тратит лимит скачивания API (509).
      // Отказ, таймаут или неполный ответ — тот же тайл через /map
      if (this.source.api === SERVERS.prod.api && overpassFree()) {
        try {
          for (const el of await fetchOverpassTile(tileBbox(key), abort.signal, withRoads)) {
            const id = `${el.type}/${el.id}`;
            // Голая копия пути (out skel после рекурсии) не затирает путь с тегами
            if (!(seen.get(id) as { tags?: unknown } | undefined)?.tags || el.tags) seen.set(id, el);
          }
          via = 'overpass';
        } catch (err) {
          if (abort.signal.aborted) throw err;
          console.warn(`Overpass ${key}: ${(err as Error).message} — загружаю через OSM API`);
        }
      }
      if (via === 'api') {
        // Тайл — четвертями, первой та, что ближе к центру экрана: на плотном тайле (десятки МБ ответа) первые
        // здания видны через пару секунд, а не после скачивания всего. Запросы идут по очереди в том же слоте
        // пула — правило «не больше двух потоков» не нарушается. Обновление устаревшего — без промежуточных показов
        const [w, s, e, n] = tileBbox(key);
        const mx = (w + e) / 2, my = (s + n) / 2;
        const c = this.map.getCenter();
        const quads = ([[w, s, mx, my], [mx, s, e, my], [w, my, mx, n], [mx, my, e, n]] as Bbox[])
          .map((q) => ({ q, d: Math.hypot((q[0] + q[2]) / 2 - c.lng, (q[1] + q[3]) / 2 - c.lat) }))
          .sort((a, b) => a.d - b.d).map((x) => x.q);
        for (let i = 0; i < quads.length; i++) {
          // Свой таймаут: браузер ждёт недоступный сервер около минуты, а индикатор «не отвечает» нужен раньше
          const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
          for (const el of await fetchMapSplit(quads[i], ep.url, signal, 4, `${key} quarter ${i + 1}/4`)) seen.set(`${el.type}/${el.id}`, el);
          if (refreshing || i === quads.length - 1) continue;
          // Промежуточный показ: без догрузки мультиполигонов на границе и без записи в кеш
          const els = [...seen.values()];
          const part = timed('тайлы: разбор четверти', () => parseBuildings(els), (r) => `${key}, ${r.features.length} зданий`);
          this.cache.set(key, { state: 'ready', ...part, trees: parseTrees(els), fetchedAt: 0, via, partial: true, refreshing: abort });
          this.tileReady(key);
          this.onChange();
        }
      }
      let elements = await completeRelations([...seen.values()], incompleteBuildingRelations, ep.url, abort.signal, key);
      // Помещения и коридоры на границе тайла (план этажа): без них не страшно — ошибка догрузки не роняет тайл
      try { elements = await completeRelations(elements, incompleteIndoorRelations, ep.url, abort.signal, key); }
      catch (err) { if (abort.signal.aborted) throw err; console.warn('[tiles] indoor: догрузка не удалась', err); }
      // Леса-мультиполигоны на границе тайла (только небольшие и ещё не собранные): без них просто меньше деревьев
      try { elements = await completeRelations(elements, incompleteWoodRelations(this.knownWoods()), ep.url, abort.signal, key); }
      catch (err) { if (abort.signal.aborted) throw err; console.warn('[tiles] леса: догрузка не удалась', err); }
      const { features, groups, indoor } = timed('тайлы: разбор ответа API', () => parseBuildings(elements), (r) => `${key}, ${r.features.length} зданий`);
      const trees = timed('тайлы: разбор деревьев', () => parseTrees(elements), (r) => `${key}, ${r.points.length} деревьев, ${r.woods.length} лесов`);
      // Без дорог в запросе — undefined, а не []: при включении галок тайл перекачается (isStale)
      const roads = via === 'overpass' && !withRoads ? undefined : timed('тайлы: дороги', () => parseRoads(elements), (r) => `${key}, ${r.length} путей`);
      const fetchedAt = Date.now();
      this.cache.set(key, { state: 'ready', features, groups, indoor, trees, roads, fetchedAt, via });
      this.lastApiError = undefined;
      this.reloading.delete(key);
      this.reloadFailed.delete(key);
      void this.store.put(key, { features, groups, indoor, trees, roads, fetchedAt, via });
      this.stored.add(key);
      this.evict();
      this.tileReady(key);
    } catch (err) {
      if (abort.signal.aborted) {
        result = 'aborted';
        if (refreshing) refreshing.refreshing = undefined;
        // Недогруженный тайл (показаны не все четверти) не должен остаться «готовым» — загрузится заново
        const cur = this.cache.get(key);
        if (cur?.state === 'ready' && cur.partial) this.cache.delete(key);
        return;
      }
      // Перегрузка или лимит сервера — повторим позже, сервер «остынет». Сетевая ошибка (TypeError) — тоже:
      // отказ по лимиту без CORS-заголовков (так отвечает OpenGeofiction) браузер отдаёт именно так
      unreachable = err instanceof TypeError || (err instanceof DOMException && err.name === 'TimeoutError');
      const busy = (err instanceof ApiError && [429, 503, 509].includes(err.status)) || unreachable;
      result = busy ? 'busy' : 'error';
      // Лимит скачивания (509): сервер сам говорит, когда можно снова, — до тех пор к нему не ходим
      if (err instanceof ApiError) cooldown = err.retryAfter;
      this.lastApiError = (err as Error).message;
      console.warn(`OSM API ${key}${refreshing ? ' (обновление)' : ''}:`, this.lastApiError);
      if (refreshing) {
        refreshing.refreshing = undefined;
        const tries = this.reloading.get(key);
        if (tries !== undefined && tries + 1 < RELOAD_ATTEMPTS) {
          // Перезапрос по кнопке — повторяем вскоре (инстанс с ошибкой остынет, пойдёт другой)
          this.reloading.set(key, tries + 1);
          const delay = Math.max(busy ? 1_000 : 2_000 * 2 ** tries, cooldown ?? 0);
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
      const delay = Math.max(busy ? 1_000 : Math.min(60_000, 2_000 * 2 ** attempts), cooldown ?? 0);
      this.cache.set(key, { state: 'error', retryAt: Date.now() + delay, attempts: attempts + 1 });
      this.schedulePump(delay);
    } finally {
      if (result === 'aborted') this.reloading.delete(key);
      this.pool.release(ep, result, unreachable, cooldown);
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
    const patch = (features: Feature3D[], groups: BuildingGroup[]): Feature3D[] => {
      if (!features.some((f) => saved.has(f.key) || gone.has(f.key))) return features;
      const out: Feature3D[] = [];
      for (const f of features) {
        if (gone.has(f.key)) continue; // удалён в OSM
        const s = saved.get(f.key);
        if (!s) { out.push(f); continue; }
        const group = groups.find((g) => g.members.includes(f.key));
        const role = group?.roles[group.members.indexOf(f.key)];
        const kind = role === 'part' ? 'part' : role === 'outline' ? 'building' : kindOf(s.tags);
        if (kind) out.push({ ...f, kind, version: s.version, tags: s.tags, polygons: s.polygons ?? f.polygons, hasParts: false, ...(s.ways ? { ways: s.ways } : {}) });
      }
      markOutlinesWithParts(out, out, groups);
      return out;
    };
    const inMemory = new Set<string>();
    for (const [key, e] of this.cache) {
      if (e.state !== 'ready') continue;
      inMemory.add(key);
      if (!touched(e)) continue;
      e.groups = patchGroups(e);
      e.features = patch(e.features, e.groups);
      this.indexGroups(e.groups);
      if (!e.partial) void this.store.put(key, e);
      if (this.layer.groupKeys().includes(key)) this.show(key);
    }
    for (const key of this.stored) {
      if (inMemory.has(key)) continue;
      const stored = await this.store.get(key);
      if (stored && touched(stored)) {
        const groups = patchGroups(stored);
        await this.store.put(key, { ...stored, groups, features: patch(stored.features, groups) });
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
      if (!this.networkWanted.has(key)) continue;
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
  /** Растёт с каждым пришедшим тайлом — для кешей поверх данных тайлов (indoor здания). */
  revision = 0;

  private tileReady(key: string) {
    this.revision++;
    const e = this.cache.get(key);
    if (e?.state === 'ready') this.indexGroups(e.groups);
    if (this.wanted.includes(key)) this.show(key);
    for (const n of neighbours(key)) {
      if (!this.hiddenOutlines.has(n)) continue;
      if (this.ownedFeatures(n).hidden !== this.hiddenOutlines.get(n)) this.show(n);
    }
    // Лес из нового тайла может накрывать и уже показанные (у большого массива узлы — далеко за их границей)
    if (e?.state === 'ready' && e.trees?.woods.length) for (const k of this.wanted) if (k !== key) this.showTrees(k);
  }

  /** Ключи лесов, собранных в загруженных тайлах (их не догружаем повторно). */
  private knownWoods(): Set<string> {
    const out = new Set<string>();
    for (const e of this.cache.values()) if (e.state === 'ready') for (const w of e.trees?.woods ?? []) out.add(w.key);
    return out;
  }

  private readonly woodBoxes = new WeakMap<WoodArea, Bbox>();

  /** Леса загруженных тайлов (без повторов), задевающие bbox. */
  private woodsIn([w, s, e, n]: Bbox): WoodArea[] {
    const out = new Map<string, WoodArea>();
    for (const t of this.cache.values()) {
      if (t.state !== 'ready') continue;
      for (const wood of t.trees?.woods ?? []) {
        if (out.has(wood.key)) continue;
        let b = this.woodBoxes.get(wood);
        if (!b) {
          b = [Infinity, Infinity, -Infinity, -Infinity];
          for (const p of wood.polygons) for (const [x, y] of p.outer) { b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y); }
          this.woodBoxes.set(wood, b);
        }
        if (b[2] >= w && b[0] <= e && b[3] >= s && b[1] <= n) out.set(wood.key, wood);
      }
    }
    return [...out.values()];
  }

  /** Деревья тайла: пересобираются, только когда поменялись его данные или задевающие его леса. */
  private showTrees(key: string) {
    const e = this.cache.get(key);
    if (e?.state !== 'ready') return;
    const own = e.trees ?? NO_TREES;
    const bbox = tileBbox(key);
    const woods = this.woodsIn(bbox);
    const signature = `${e.fetchedAt}:${own.points.length}:${own.rows.length}:${e.features.length}:${this.treeCutsVersion}|${woods.map((w) => w.key).sort().join(',')}`;
    if (this.layer.treeSignature(key) === signature || this.treesPending.get(key) === signature) return;
    if (!own.points.length && !own.rows.length && !woods.length) { this.treesPending.delete(key); this.layer.setTrees(key, undefined); return; }
    const buildings = e.features.flatMap((f) => f.polygons.map((p) => p.outer));
    // Разброс — в воркере; старые деревья тайла остаются на экране, пока не придут новые
    this.treesPending.set(key, signature);
    void scatterTreesAsync(own, woods, buildings, bbox).then((trees) => {
      if (this.treesPending.get(key) !== signature) return; // за это время тайл пересобрали заново или убрали
      this.treesPending.delete(key);
      if (!this.wanted.includes(key)) return;
      const kept = this.cutTrees(trees, bbox);
      this.layer.setTrees(key, timed('деревья: инстансы', () => new TreeGroup(bbox, kept, signature, own.points), (g) => `${key}, ${g.count}`));
    });
  }

  /** Деревья, которые сейчас считает воркер: тайл → подпись. */
  private readonly treesPending = new Map<string, string>();
  /** Полосы поднятого полотна мостов (Меркатор: ax, ay, bx, by, полуширина): деревья под ними не растут. */
  private treeCuts: Float64Array = new Float64Array(0);
  private treeCutsVersion = 0;

  setTreeCuts(cuts: Float64Array) {
    if (cuts === this.treeCuts || (!cuts.length && !this.treeCuts.length)) return;
    this.treeCuts = cuts;
    this.treeCutsVersion++;
    for (const k of this.wanted) this.showTrees(k);
  }

  /** Без деревьев, чья крона задевает поднятое полотно (массив TREE_STRIDE на дерево, как из scatter). */
  private cutTrees(trees: Float64Array, [w, s, e, n]: Bbox): Float64Array {
    const c = this.treeCuts;
    if (!c.length) return trees;
    const mx0 = (w + 180) / 360, mx1 = (e + 180) / 360;
    const my = (lat: number) => (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360;
    const my0 = my(n), my1 = my(s);
    // Метр в Меркаторе на широте тайла; крона в метрах
    const meter = 1 / 40075016.686 / Math.cos(((s + n) / 2) * Math.PI / 180);
    const segs: number[] = [];
    for (let i = 0; i < c.length; i += 5) {
      const pad = c[i + 4] + 20 * meter;
      if (Math.max(c[i], c[i + 2]) + pad < mx0 || Math.min(c[i], c[i + 2]) - pad > mx1) continue;
      if (Math.max(c[i + 1], c[i + 3]) + pad < my0 || Math.min(c[i + 1], c[i + 3]) - pad > my1) continue;
      segs.push(i);
    }
    if (!segs.length) return trees;
    const keep: number[] = [];
    for (let t = 0; t < trees.length; t += TREE_STRIDE) {
      const x = trees[t + TreeField.MX], y = trees[t + TreeField.MY], r = trees[t + TreeField.CROWN] * meter;
      const hit = segs.some((i) => {
        const ax = c[i], ay = c[i + 1], ex = c[i + 2] - ax, ey = c[i + 3] - ay, l2 = ex * ex + ey * ey || 1e-30;
        const u = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / l2));
        return Math.hypot(ax + ex * u - x, ay + ey * u - y) < c[i + 4] + r;
      });
      if (!hit) for (let k = 0; k < TREE_STRIDE; k++) keep.push(trees[t + k]);
    }
    return keep.length === trees.length ? trees : Float64Array.from(keep);
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
    const ownFeatures = [...own.features.map(this.overlay), ...this.extras()].filter((f) => f.polygons.length && this.visible(f));
    const union = new Map<string, Feature3D>();
    for (const f of ownFeatures) union.set(f.key, f); // свои объекты — первыми: их hasParts и пойдёт в рендер
    for (const n of neighbours(key)) {
      const e = this.cache.get(n);
      if (e?.state === 'ready') for (const f of e.features) if (!union.has(f.key)) { const o = this.overlay(f); if (o.polygons.length && this.visible(o)) union.set(f.key, o); }
    }
    // Пересчитываем только свои здания — части берём из всех девяти тайлов
    const groups = [...new Set(ownFeatures.map((f) => this.groupOf(f.key)).filter((g): g is BuildingGroup => !!g))];
    timed('overpass: части у контуров', () => markOutlinesWithParts([...union.values()], ownFeatures, groups), () => `${key}, ${union.size} объектов`);
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
    return !!g && g.roles[g.members.indexOf(f.key)] === 'outline' && !f.renderPolygons;
  }

  private show(key: string) {
    this.showTrees(key);
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

  /** Видимый кеш на любом масштабе: ближайшие к камере тайлы без сетевых запросов. */
  private cachedVisibleTiles(): string[] {
    const b = this.map.getBounds();
    const camera = cameraGroundPosition(this.map) ?? this.map.getCenter();
    const keys = new Set([...this.stored, ...[...this.cache].filter(([, e]) => e.state === 'ready').map(([k]) => k)]);
    return [...keys]
      .filter((k) => {
        const [w, s, e, n] = tileBbox(k);
        return e >= b.getWest() && w <= b.getEast() && n >= b.getSouth() && s <= b.getNorth();
      })
      .map((key) => ({ key, d: distanceToTileMeters(key, camera) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, MAX_VISIBLE)
      .map((t) => t.key);
  }

  private visibleTiles(): string[] {
    const z = OVERPASS_TILE_ZOOM;
    const camera = cameraGroundPosition(this.map);
    if (!camera) return []; // без положения камеры не начинаем новые запросы
    const b = this.map.getBounds();
    const [x0, y1] = lngLatToTile(b.getWest(), b.getSouth(), z);
    const [x1, y0] = lngLatToTile(b.getEast(), b.getNorth(), z);
    // У горизонта getBounds() огромен: перебираем лишь несколько клеток вокруг камеры.
    const [cx, cy] = lngLatToTile(camera.lng, camera.lat, z, false);
    const tileMeters = 40_075_017 * Math.max(0.01, Math.cos(camera.lat * Math.PI / 180)) / 2 ** z;
    const reach = Math.ceil(API_RADIUS_METERS / tileMeters) + 2;
    const tiles: { key: string; d: number }[] = [];
    for (let x = Math.max(x0, Math.floor(cx) - reach); x <= Math.min(x1, Math.floor(cx) + reach); x++) {
      for (let y = Math.max(y0, Math.floor(cy) - reach); y <= Math.min(y1, Math.floor(cy) + reach); y++) {
        const key = `${z}/${x}/${y}`;
        const d = distanceToTileMeters(key, camera);
        if (d <= API_RADIUS_METERS) tiles.push({ key, d });
      }
    }
    return tiles.sort((a, b) => a.d - b.d).slice(0, MAX_NETWORK_VISIBLE).map((t) => t.key);
  }
}

/** Разобранный слой JOSM — один на все тайлы (разбор заново, только когда слой перезапрошен). */
type JosmParsed = ReturnType<typeof parseBuildings> & { trees: TreeData; roads: RoadWay[] };
let josmCache: { elements: OsmElement[]; parsed: JosmParsed } | undefined;
async function josmParsed() {
  const { elements } = await josmLayer();
  if (josmCache?.elements !== elements) josmCache = { elements, parsed: { ...timed('JOSM: разбор слоя', () => parseBuildings(elements), (r) => `${r.features.length} зданий`), trees: parseTrees(elements), roads: parseRoads(elements) } };
  return josmCache.parsed;
}

/** Объекты слоя JOSM, задевающие тайл: кому из соседей принадлежит здание, решает ownedFeatures (по центру). */
function josmTile(all: JosmParsed, [w, s, e, n]: Bbox) {
  const hits = (polygons: Polygon[], point?: [number, number]) => {
    const pts = point ? [point] : polygons.flatMap((p) => p.outer);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    return x1 >= w && x0 <= e && y1 >= s && y0 <= n;
  };
  return {
    features: all.features.filter((f) => hits(f.polygons)),
    groups: all.groups, // без геометрии; по ключу дубли не страшны
    indoor: all.indoor.filter((f) => hits(f.polygons, f.point)),
    trees: all.trees, // свои деревья тайл отбирает сам (по положению), леса — по bbox
    roads: all.roads.filter((r) => r.coords.some(([x, y]) => x >= w && x <= e && y >= s && y <= n)),
  };
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

/** Горизонтальная позиция камеры: центр карты при сильном наклоне может быть далеко от неё. */
function cameraGroundPosition(map: MlMap): { lng: number; lat: number } | undefined {
  type CameraTransform = { getCameraLngLat(): { lng: number; lat: number } };
  const m = map as unknown as { _camera?: { transform?: CameraTransform }; transform?: CameraTransform };
  return (m._camera?.transform ?? m.transform)?.getCameraLngLat();
}

/** Расстояние от камеры до ближайшей точки ячейки, а не до её центра. */
function distanceToTileMeters(key: string, camera: { lng: number; lat: number }): number {
  const [w, s, e, n] = tileBbox(key);
  const lat = Math.max(s, Math.min(n, camera.lat));
  const lon = Math.max(w, Math.min(e, camera.lng));
  const deltaLon = ((camera.lng - lon + 540) % 360) - 180;
  const dx = deltaLon * Math.cos(camera.lat * Math.PI / 180) * 111_320;
  const dy = (camera.lat - lat) * 111_320;
  return Math.hypot(dx, dy);
}

export function tileBbox(key: string): Bbox {
  const [z, x, y] = key.split('/').map(Number);
  const n = 2 ** z;
  const lon = (i: number) => (i / n) * 360 - 180;
  const lat = (j: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * j) / n))) * 180) / Math.PI;
  return [lon(x), lat(y + 1), lon(x + 1), lat(y)];
}

import type { Map as MlMap } from 'maplibre-gl';
import type { Bbox } from '../osm/api';
import { parseBuildings, type Feature3D } from '../osm/model';
import { fetchBuildings, OverpassBusyError, OverpassPool } from '../osm/overpass';
import type { BuildingsLayer, RenderedFeature } from '../render/buildings-layer';
import { GRID_ZOOM } from '../tiles/tile-features';
import { TileStore } from './tile-store';

export const OVERPASS_TILE_ZOOM = GRID_ZOOM;
/** Сколько тайлов держать в кеше данных. */
const CACHE_SIZE = 48;
/** Сколько ближайших к центру тайлов загружать одновременно видимыми. */
const MAX_VISIBLE = 12;
/** Данные старше этого показываем из кеша, но перезапрашиваем в фоне. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Пауза перед повторной попыткой фонового обновления после ошибки. */
const REFRESH_RETRY_MS = 5 * 60 * 1000;

type Entry =
  | { state: 'lookup' } // ищем в IndexedDB
  | { state: 'queued' } // в IndexedDB нет, ждёт свободного инстанса Overpass
  | { state: 'loading'; abort: AbortController }
  | { state: 'ready'; features: Feature3D[]; fetchedAt: number; refreshing?: AbortController; refreshAfter?: number }
  | { state: 'error'; retryAt: number; attempts: number };

/**
 * Подменяет тайловые здания данными Overpass по сетке тайлов z14.
 * Источники по порядку: память (LRU) → IndexedDB → Overpass. Устаревшие тайлы показываются сразу,
 * а в фоне перезапрашиваются. Меши есть только у видимых тайлов.
 */
export class OverpassTiles {
  private readonly cache = new Map<string, Entry>(); // порядок вставки = LRU
  private wanted: string[] = [];
  readonly pool = new OverpassPool();
  readonly store = new TileStore();
  private pumpTimer?: ReturnType<typeof setTimeout>;
  /** Нарисованные здания по ключу OSM — для панели по клику. */
  private readonly rendered = new Map<string, RenderedFeature>();
  enabled = false;

  constructor(private readonly map: MlMap, private readonly layer: BuildingsLayer, private readonly onChange: () => void) {}

  get(key: string): RenderedFeature | undefined {
    return this.rendered.get(key);
  }

  /** Ключи тайлов, чьи здания сейчас нарисованы нашим слоем. */
  displayed(): string[] {
    return this.layer.groupKeys();
  }

  status(): { ready: number; total: number; loading: number; waiting: number } {
    const count = (state: Entry['state']) => this.wanted.filter((k) => this.cache.get(k)?.state === state).length;
    return { ready: count('ready'), total: this.wanted.length, loading: count('loading') + count('lookup') + count('queued'), waiting: count('error') };
  }

  /** Пересчитать нужные тайлы после движения карты. */
  update() {
    this.wanted = this.enabled ? this.visibleTiles() : [];
    const wanted = new Set(this.wanted);

    for (const key of this.layer.groupKeys()) if (!wanted.has(key)) this.layer.removeGroup(key);
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
        if (!this.layer.hasGroup(key)) this.show(key, e.features);
      }
    }
    this.pump();
    this.onChange();
  }

  private pump() {
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
      if (this.wanted.includes(key)) this.show(key, stored.features);
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

  private async load(key: string, attempts: number, ep: ReturnType<OverpassPool['acquire']> & object) {
    const abort = new AbortController();
    const prev = this.cache.get(key);
    // Обновление устаревшего тайла: старые данные остаются на экране, пока не придут новые
    const refreshing = prev?.state === 'ready' ? prev : undefined;
    if (refreshing) refreshing.refreshing = abort;
    else this.cache.set(key, { state: 'loading', abort });
    let result: 'ok' | 'busy' | 'error' | 'aborted' = 'ok';
    try {
      const { features } = parseBuildings(await fetchBuildings(ep.url, tileBbox(key), abort.signal));
      const fetchedAt = Date.now();
      this.cache.set(key, { state: 'ready', features, fetchedAt });
      void this.store.put(key, features, fetchedAt);
      this.evict();
      if (this.wanted.includes(key)) this.show(key, features);
    } catch (err) {
      if (abort.signal.aborted) {
        result = 'aborted';
        if (refreshing) refreshing.refreshing = undefined;
        return;
      }
      const busy = err instanceof OverpassBusyError;
      result = busy ? 'busy' : 'error';
      console.warn(`Overpass ${key}${refreshing ? ' (обновление)' : ''}:`, (err as Error).message);
      if (refreshing) {
        // Данные есть — не мучаем сервер, попробуем обновить позже
        refreshing.refreshing = undefined;
        refreshing.refreshAfter = Date.now() + REFRESH_RETRY_MS;
        return;
      }
      // При перегрузке инстанса повтор сразу уйдёт на другой — пауза короткая;
      // при прочих ошибках — экспоненциальная
      const delay = busy ? 1_000 : Math.min(60_000, 2_000 * 2 ** attempts);
      this.cache.set(key, { state: 'error', retryAt: Date.now() + delay, attempts: attempts + 1 });
      this.schedulePump(delay);
    } finally {
      this.pool.release(ep, result);
      this.pump();
      this.onChange();
    }
  }

  async clearStore() {
    await this.store.clear();
    // Данные в памяти считаем устаревшими — перезапросятся в фоне
    for (const e of this.cache.values()) if (e.state === 'ready') e.fetchedAt = 0;
    this.update();
  }

  private show(key: string, features: Feature3D[]) {
    const [w, s, e, n] = tileBbox(key);
    for (const r of this.layer.setGroup(key, features, [(w + e) / 2, (s + n) / 2])) this.rendered.set(r.feature.key, r);
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

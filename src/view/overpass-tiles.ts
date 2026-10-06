import type { Map as MlMap } from 'maplibre-gl';
import type { Bbox } from '../osm/api';
import { parseBuildings, type Feature3D } from '../osm/model';
import { fetchBuildings, OverpassBusyError } from '../osm/overpass';
import type { BuildingsLayer, RenderedFeature } from '../render/buildings-layer';

import { GRID_ZOOM } from '../tiles/tile-features';

export const OVERPASS_TILE_ZOOM = GRID_ZOOM;
/** Сколько тайлов держать в кеше данных. */
const CACHE_SIZE = 48;
/** Сколько ближайших к центру тайлов загружать одновременно видимыми. */
const MAX_VISIBLE = 12;
const MAX_PARALLEL = 2;

type Entry =
  | { state: 'loading'; abort: AbortController }
  | { state: 'ready'; features: Feature3D[] }
  | { state: 'error'; retryAt: number; attempts: number };

/**
 * Подменяет тайловые здания данными Overpass по сетке тайлов z14.
 * Данные кешируются по ключу тайла; меши есть только у видимых тайлов.
 */
export class OverpassTiles {
  private readonly cache = new Map<string, Entry>(); // порядок вставки = LRU
  private wanted: string[] = [];
  private active = 0;
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
    return { ready: count('ready'), total: this.wanted.length, loading: count('loading'), waiting: count('error') };
  }

  /** Пересчитать нужные тайлы после движения карты. */
  update() {
    this.wanted = this.enabled ? this.visibleTiles() : [];
    const wanted = new Set(this.wanted);

    for (const key of this.layer.groupKeys()) if (!wanted.has(key)) this.layer.removeGroup(key);
    for (const [key, e] of this.cache) {
      // Ушедшие из вида загрузки отменяем, чтобы не занимать слоты Overpass
      if (!wanted.has(key) && e.state === 'loading') { e.abort.abort(); this.cache.delete(key); }
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
    for (const key of this.wanted) {
      if (this.active >= MAX_PARALLEL) break;
      const e = this.cache.get(key);
      if (e?.state === 'ready' || e?.state === 'loading') continue;
      if (e?.state === 'error' && Date.now() < e.retryAt) continue;
      void this.load(key, e?.state === 'error' ? e.attempts : 0);
    }
  }

  private async load(key: string, attempts: number) {
    const abort = new AbortController();
    this.cache.set(key, { state: 'loading', abort });
    this.active++;
    try {
      const { features } = parseBuildings(await fetchBuildings(tileBbox(key), abort.signal));
      this.cache.set(key, { state: 'ready', features });
      this.evict();
      if (this.wanted.includes(key)) this.show(key, features);
    } catch (err) {
      if (abort.signal.aborted) return;
      // Экспоненциальная пауза; при перегрузке Overpass — дольше
      // Первый повтор быстрый — скорее всего, уже на другом инстансе Overpass
      const delay = Math.min(60_000, (err instanceof OverpassBusyError ? 3_000 : 2_000) * 2 ** attempts);
      this.cache.set(key, { state: 'error', retryAt: Date.now() + delay, attempts: attempts + 1 });
      console.warn(`Overpass ${key}:`, (err as Error).message);
      setTimeout(() => this.update(), delay);
    } finally {
      this.active--;
      this.pump();
      this.onChange();
    }
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

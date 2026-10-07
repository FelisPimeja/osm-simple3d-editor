import type { Feature, Geometry } from 'geojson';
import type { Map as MlMap } from 'maplibre-gl';
import polygonClipping from 'polygon-clipping';
import { polygonsOf, type Ring } from './outlines';

/** Запас при обрезке по границе тайла, в градусах (~1 см): чтобы соседние куски не расходились щелью. */
const CLIP_EPS = 1e-7;

export interface TileBuildingFeature {
  id: number;
  /** Ключ тайла сетки z14 (`14/x/y`), в который попадает исходный тайл; нет — исходный тайл мельче z14. */
  tile?: string;
  properties: Record<string, any>;
  /** Полигоны, обрезанные по границе своего тайла (без буфера). */
  polys: Ring[][];
}

interface TileLike {
  tileID: { canonical: { x: number; y: number; z: number } };
  querySourceFeatures(result: Feature<Geometry>[], params: { sourceLayer: string }): void;
}
/**
 * Содержимое загруженного тайла не меняется — результаты разбора кешируем на объекте тайла.
 * WeakMap: выгруженный MapLibre тайл уходит из кеша вместе с ним.
 */
const clippedCache = new WeakMap<TileLike, Map<string, TileBuildingFeature[]>>();
const idsCache = new WeakMap<TileLike, Map<string, Map<string, number[]>>>();

interface TileManagerLike {
  getRenderableIds(): string[];
  getTileByID(id: string): TileLike | undefined;
}

/**
 * Фичи здания из загруженных тайлов, обрезанные по границам своих тайлов.
 *
 * Векторные тайлы содержат геометрию с буфером за границей, и map.querySourceFeatures отдаёт
 * фичи всех тайлов вперемешку: в зоне буфера соседний тайл подкладывает копии чужих зданий.
 * Чтобы обрезать фичу по её тайлу, нужно знать тайл, поэтому идём через внутренний
 * style.tileManagers (не публичное API MapLibre). Если его нет — фичи без обрезки.
 */
export function queryTileBuildings(
  map: MlMap, sourceId: string, sourceLayer: string,
  /** Отбор фич до обрезки (обрезка — самое дорогое). */
  accept: (id: number) => boolean = () => true,
): TileBuildingFeature[] {
  const tm = (map as unknown as { style?: { tileManagers?: Record<string, TileManagerLike> } }).style?.tileManagers?.[sourceId];
  if (!tm?.getRenderableIds || !tm.getTileByID) {
    console.warn('tileManagers недоступен — геометрия тайлов без обрезки по границам');
    return map.querySourceFeatures(sourceId, { sourceLayer })
      .filter((f) => typeof f.id === 'number' && accept(f.id))
      .map((f) => ({ id: f.id as number, properties: f.properties, polys: polygonsOf(f.geometry) }));
  }

  const out: TileBuildingFeature[] = [];
  const seen = new Set<string>();
  for (const id of tm.getRenderableIds()) {
    const tile = tm.getTileByID(id);
    if (!tile) continue;
    const { x, y, z } = tile.tileID.canonical;
    // При overzoom несколько id ссылаются на один и тот же исходный тайл
    const key = `${z}/${x}/${y}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const perTile = clippedCache.get(tile) ?? clippedCache.set(tile, new Map()).get(tile)!;
    const cacheKey = `${sourceLayer}|${accept.toString()}`;
    let clipped = perTile.get(cacheKey);
    if (!clipped) {
      clipped = [];
      const bounds = tileBounds(x, y, z);
      const features: Feature<Geometry>[] = [];
      tile.querySourceFeatures(features, { sourceLayer });
      for (const f of features) {
        if (typeof f.id !== 'number' || !accept(f.id)) continue;
        const polys = polygonsOf(f.geometry).flatMap((p) => clipToBounds(p, bounds));
        // Тайл мельче сетки: клетку определяет потребитель по каждому полигону
        if (polys.length) clipped.push({ id: f.id, tile: z >= GRID_ZOOM ? gridKey(x, y, z) : undefined, properties: f.properties ?? {}, polys });
      }
      perTile.set(cacheKey, clipped);
    }
    out.push(...clipped);
  }
  return out;
}

type Bounds = [w: number, s: number, e: number, n: number];

function tileBounds(x: number, y: number, z: number): Bounds {
  const n = 2 ** z;
  const lon = (i: number) => (i / n) * 360 - 180;
  const lat = (j: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * j) / n))) * 180) / Math.PI;
  return [lon(x) - CLIP_EPS, lat(y + 1) - CLIP_EPS, lon(x + 1) + CLIP_EPS, lat(y) + CLIP_EPS];
}

function clipToBounds(poly: Ring[], [w, s, e, n]: Bounds): Ring[][] {
  let inside = true;
  for (const [px, py] of poly[0]) {
    if (px < w || px > e || py < s || py > n) { inside = false; break; }
  }
  // Большинство полигонов целиком внутри тайла — дорогую обрезку делаем только для пограничных
  if (inside) return [poly];
  try {
    const box: Ring = [[w, s], [e, s], [e, n], [w, n], [w, s]];
    return polygonClipping.intersection(poly as never, [box] as never) as Ring[][];
  } catch {
    return [poly];
  }
}

export const GRID_ZOOM = 14;

/**
 * Ключ тайла сетки z14, содержащего тайл z/x/y. MapLibre при overzoom хранит тайлы
 * с координатами текущего зума (17/79233/40977), а не исходного z14.
 */
export function gridKey(x: number, y: number, z: number): string {
  const d = Math.max(0, z - GRID_ZOOM);
  return `${Math.min(z, GRID_ZOOM)}/${x >> d}/${y >> d}`;
}

/** id тайловых фич зданий по тайлам сетки z14: `14/x/y` → id (без обрезки, для фильтров). */
export function tileFeatureIdsByTile(map: MlMap, sourceId: string, sourceLayer: string): Map<string, number[]> {
  const tm = (map as unknown as { style?: { tileManagers?: Record<string, TileManagerLike> } }).style?.tileManagers?.[sourceId];
  const out = new Map<string, number[]>();
  if (!tm?.getRenderableIds || !tm.getTileByID) return out;
  const seen = new Set<string>();
  for (const id of tm.getRenderableIds()) {
    const tile = tm.getTileByID(id);
    if (!tile) continue;
    const { x, y, z } = tile.tileID.canonical;
    if (seen.has(`${z}/${x}/${y}`)) continue;
    seen.add(`${z}/${x}/${y}`);
    const perTile = idsCache.get(tile) ?? idsCache.set(tile, new Map()).get(tile)!;
    let byGrid = perTile.get(sourceLayer);
    if (!byGrid) {
      byGrid = new Map();
      const features: Feature<Geometry>[] = [];
      tile.querySourceFeatures(features, { sourceLayer });
      for (const f of features) {
        if (typeof f.id !== 'number') continue;
        // Тайл мельче сетки (z < 14) покрывает несколько её клеток — клетку берём по первой точке фичи
        const key = z >= GRID_ZOOM ? gridKey(x, y, z) : gridKeyOfPoint(firstPoint(f.geometry));
        if (!key) continue;
        (byGrid.get(key) ?? byGrid.set(key, []).get(key)!).push(f.id);
      }
      perTile.set(sourceLayer, byGrid);
    }
    for (const [key, tileIds] of byGrid) {
      const ids = out.get(key) ?? out.set(key, []).get(key)!;
      ids.push(...tileIds);
    }
  }
  for (const [key, ids] of out) out.set(key, [...new Set(ids)]);
  return out;
}

function firstPoint(g: Geometry): number[] | undefined {
  switch (g.type) {
    case 'Polygon': return g.coordinates[0]?.[0];
    case 'MultiPolygon': return g.coordinates[0]?.[0]?.[0];
    default: return undefined;
  }
}

/** Клетка сетки z14, содержащая точку [lng, lat]. */
export function gridKeyOfPoint(p: number[] | undefined): string | undefined {
  if (!p) return;
  const n = 2 ** GRID_ZOOM;
  const x = Math.floor(((p[0] + 180) / 360) * n);
  const r = (p[1] * Math.PI) / 180;
  const y = Math.floor(((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * n);
  return `${GRID_ZOOM}/${x}/${y}`;
}

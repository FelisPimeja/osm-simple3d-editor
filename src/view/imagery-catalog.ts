/**
 * Каталог подложек editor-layer-index (public/imagery-catalog.json, собирает scripts/imagery-catalog.mjs): снимки,
 * разрешённые для обводки OSM (permission_osm explicit/implicit). Грузится лениво, после старта карты; в меню слоёв
 * подложка видна, только когда центр карты в её покрытии.
 */
import { CATALOG_PREFIX, registerImagery, type Imagery } from './basemaps';

type Ring = [number, number][];
export interface CatalogImagery extends Imagery {
  /** Лучшая подложка своего региона (best в editor-layer-index) — в меню первой. */
  best?: boolean;
  country?: string;
  date?: string;
  /** [з, ю, в, с]; без покрытия — подложка всего мира. */
  bbox?: [number, number, number, number];
  coverage?: Ring[][];
}

let loading: Promise<CatalogImagery[]> | undefined;

/** Загрузить каталог (один раз) и зарегистрировать его подложки. */
export function loadCatalog(): Promise<CatalogImagery[]> {
  return loading ??= fetch(`${import.meta.env.BASE_URL}imagery-catalog.json`)
    .then((r) => (r.ok ? r.json() : { imagery: [] }))
    .then((d: { imagery?: CatalogImagery[] }) => {
      const list = (d.imagery ?? []).filter((im) => im.id.startsWith(CATALOG_PREFIX) && im.tiles?.length)
        .map((im) => ({ ...im, catalog: true }));
      for (const im of list) registerImagery(im);
      return list;
    })
    .catch((err) => { console.warn('imagery catalog:', err); return []; });
}

function inRing([x, y]: [number, number], r: Ring): boolean {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** Точка в покрытии подложки (внешнее кольцо минус дыры). */
export function covers(im: CatalogImagery, p: [number, number]): boolean {
  if (!im.coverage) return true;
  const [w, s, e, n] = im.bbox!;
  if (p[0] < w || p[0] > e || p[1] < s || p[1] > n) return false;
  return im.coverage.some(([outer, ...holes]) => inRing(p, outer) && !holes.some((h) => inRing(p, h)));
}

/** Подложки каталога в точке: лучшие первыми, потом по имени. */
export function coveringAt(list: CatalogImagery[], p: [number, number]): CatalogImagery[] {
  return list.filter((im) => covers(im, p))
    .sort((a, b) => Number(!!b.best) - Number(!!a.best) || a.name.localeCompare(b.name));
}

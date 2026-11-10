import { pointOnSurface, type IndoorFeature, type LonLat } from '../osm/model';
/** Untagged relation member ways may have no area after union/autosave restore. */
/** По объекту полигона и, если тайл пришёл заново (новые объекты), по самому кольцу. */
const anchors = new WeakMap<object, LonLat>();
const anchorsByRing = new Map<string, LonLat>();

export function indoorAnchor(f: Pick<IndoorFeature, 'point' | 'line' | 'polygons'>): LonLat | undefined {
  if (f.point) return f.point;
  const polygon = f.polygons[0];
  if (!polygon?.outer.length) return;
  if (f.line) return polygon.outer[0];
  if (polygon.outer.length < 3) return undefined;
  // Точка на поверхности дорога (тысячи помещений при каждом пересчёте значков и комплексов) — по полигону;
  // правка геометрии даёт новый объект полигона
  let p = anchors.get(polygon);
  if (!p) {
    const o = polygon.outer, k = `${o.length}|${o[0][0]},${o[0][1]}|${o[o.length >> 1][0]},${o[o.length >> 1][1]}|${polygon.inners.length}`;
    p = anchorsByRing.get(k);
    if (!p) { p = pointOnSurface(polygon); if (anchorsByRing.size > 200000) anchorsByRing.clear(); anchorsByRing.set(k, p); }
    anchors.set(polygon, p);
  }
  return p;
}

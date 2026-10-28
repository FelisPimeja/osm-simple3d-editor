import { pointOnSurface, type IndoorFeature, type LonLat } from '../osm/model';
/** Untagged relation member ways may have no area after union/autosave restore. */
export function indoorAnchor(f: Pick<IndoorFeature, 'point' | 'line' | 'polygons'>): LonLat | undefined {
  if (f.point) return f.point;
  const polygon = f.polygons[0];
  if (!polygon?.outer.length) return;
  return f.line ? polygon.outer[0] : polygon.outer.length >= 3 ? pointOnSurface(polygon) : undefined;
}

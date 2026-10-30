import pc, { type MultiPolygon } from 'polygon-clipping';
import type { Polygon } from '../osm/model';

/** Only an enclosed polygon makes a hole; crossing a wall remains a separate drawing. */
export function enclosedDrawings(container: Polygon, drawings: Polygon[]): Polygon[] {
  const clip = (p: Polygon): MultiPolygon => [[p.outer, ...p.inners].map(r => [...r, r[0]])];
  return drawings.filter(p => {
    if (p.inners.length) return false;
    if (pc.difference(clip(p), clip(container)).length) return false;
    const rest = pc.difference(clip(container), clip(p));
    return rest.length === 1 && rest[0].length === container.inners.length + 2;
  });
}

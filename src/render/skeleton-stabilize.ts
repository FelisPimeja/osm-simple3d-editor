import type { Skeleton } from './skeleton';
import { extendGables, weldRoofSkeleton } from './roof-gables';

type Builder = { buildFromPolygon(rings: number[][][]): Skeleton | null };

/** A split event can leave several almost collinear vertices on a triangular hip. */
function nearTriangleBases(sk: Skeleton): string[] {
  const keys: string[] = [];
  for (const face of sk.polygons) {
    const base = face.filter((i) => sk.vertices[i][2] < 1e-9);
    const tips = face.filter((i) => sk.vertices[i][2] >= 1e-9);
    if (base.length !== 2 || tips.length < 2) continue;
    const apex = tips.reduce((best, i) => sk.vertices[i][2] > sk.vertices[best][2] ? i : best);
    const top = sk.vertices[apex];
    const onSide = (i: number) => base.some((end) => {
      const p = sk.vertices[i], q = sk.vertices[end];
      const d = q.map((v, k) => v - top[k]);
      const length2 = d.reduce((sum, v) => sum + v * v, 0);
      const t = d.reduce((sum, v, k) => sum + v * (p[k] - top[k]), 0) / length2;
      return t > 0 && t < 1 && Math.hypot(...p.map((v, k) => v - top[k] - t * d[k])) < 0.01;
    });
    if (tips.every((i) => i === apex || onSide(i))) keys.push(base.slice().sort((a, b) => a - b).join(','));
  }
  return keys;
}

/** Resolve millimetre-scale CGAL event-order ambiguity without changing the input footprint. */
export function buildStableSkeleton(builder: Builder, rings: number[][][]): Skeleton | null {
  const original = builder.buildFromPolygon(rings);
  if (!original || rings.length !== 1 || rings[0].length > 101) return original;
  const ambiguous = nearTriangleBases(original);
  if (!ambiguous.length) return original;
  let originalGables: number;
  try { originalGables = extendGables(weldRoofSkeleton(original)).gables.size; }
  catch { return original; }
  const contour = rings[0], count = contour.length - 1;
  for (let seed = 0; seed < 16; seed++) {
    const shifted = contour.slice(0, -1).map(([x, y], i) => [
      x + 0.002 * Math.sin((i + 1) * 17.13 + 39.7 + seed * 12.43),
      y + 0.002 * Math.sin((i + 1) * 17.13 + 79.4 + seed * 12.43),
    ]);
    let candidate: Skeleton | null;
    try { candidate = builder.buildFromPolygon([[...shifted, shifted[0]]]); }
    catch { continue; }
    if (!candidate || candidate.polygons.length !== original.polygons.length) continue;
    const triangles = new Set(candidate.polygons.filter((face) =>
      face.filter((i) => candidate.vertices[i][2] < 1e-9).length === 2 &&
      face.filter((i) => candidate.vertices[i][2] >= 1e-9).length === 1,
    ).map((face) => face.filter((i) => candidate.vertices[i][2] < 1e-9).sort((a, b) => a - b).join(',')));
    if (!ambiguous.every((key) => triangles.has(key))) continue;
    // Keep the real wall/roof boundary; only the skeleton event order comes from the perturbation.
    if (!shifted.every(([x, y], i) => candidate.vertices[i] &&
      Math.hypot(candidate.vertices[i][0] - x, candidate.vertices[i][1] - y, candidate.vertices[i][2]) < 0.001)) continue;
    for (let i = 0; i < count; i++) candidate.vertices[i] = [contour[i][0], contour[i][1], 0];
    let repaired: Skeleton;
    let gables: Set<number[]>;
    try {
      repaired = weldRoofSkeleton(candidate);
      gables = extendGables(repaired).gables;
    } catch { continue; }
    const converted = new Set([...gables].map((face) => face.filter((i) => repaired.vertices[i][2] < 1e-9)
      .sort((a, b) => a - b).join(',')));
    if (gables.size < originalGables + ambiguous.length || !ambiguous.every((key) => converted.has(key))) continue;
    return candidate;
  }
  return original;
}

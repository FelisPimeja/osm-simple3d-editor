import { bottomTriangles, type LocalPolygon, type Pt } from './building-geometry';

export const AREA_LEDGE_THICKNESS = 0.3;
type Interval = [number, number];
type Uncovered = (a: Pt, b: Pt) => Interval[];

const cross = (a: Pt, b: Pt) => a[0] * b[1] - a[1] * b[0];
const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];
function inRing([x, y]: Pt, ring: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/** Низ площадки и торцы только её открытых краёв над вторым светом. Верх уже рисует пол indoor=area. */
export function areaLedgeTriangles(polygon: LocalPolygon, voids: LocalPolygon[], top: number, uncovered: Uncovered = () => [[0, 1]], occupied: LocalPolygon[] = []): number[] {
  if (!voids.length) return [];
  const sides: number[] = [];
  let facesVoid = false;
  const bottom = top - AREA_LEDGE_THICKNESS;
  for (const [ri, ring] of [polygon.outer, ...polygon.inners].entries()) {
    const ccw = ring.reduce((s, p, i) => s + cross(p, ring[(i + 1) % ring.length]), 0) > 0;
    const sign = ccw === (ri === 0) ? 1 : -1;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length], d = sub(b, a), len = Math.hypot(...d);
      if (len < 0.005) continue;
      const nx = sign * d[1] / len, ny = -sign * d[0] / len;
      const probe: Pt = [a[0] + nx * 0.05, a[1] + ny * 0.05];
      const cuts = [0, 1];
      // Длинная сторона площадки может выходить во второй свет только частью своей длины.
      for (const v of [...voids, ...occupied]) for (const r of [v.outer, ...v.inners]) for (let j = 0; j < r.length; j++) {
        const e = sub(r[(j + 1) % r.length], r[j]), den = cross(d, e);
        if (Math.abs(den) < 1e-10) continue;
        const q = sub(r[j], probe), t = cross(q, e) / den, u = cross(q, d) / den;
        if (t > 0 && t < 1 && u >= 0 && u <= 1) cuts.push(t);
      }
      cuts.sort((x, y) => x - y);
      for (const [lo, hi] of uncovered(a, b)) for (let j = 0; j + 1 < cuts.length; j++) {
        const t0 = Math.max(lo, cuts[j]), t1 = Math.min(hi, cuts[j + 1]);
        if ((t1 - t0) * len < 0.005) continue;
        const mid = (t0 + t1) / 2, at: Pt = [probe[0] + d[0] * mid, probe[1] + d[1] * mid];
        if (occupied.some((v) => inRing(at, v.outer) && !v.inners.some((r) => inRing(at, r)))) continue;
        facesVoid ||= voids.some((v) => inRing(at, v.outer) && !v.inners.some((r) => inRing(at, r)));
        let p: Pt = [a[0] + d[0] * t0, a[1] + d[1] * t0], q: Pt = [a[0] + d[0] * t1, a[1] + d[1] * t1];
        if (sign < 0) [p, q] = [q, p];
        sides.push(p[0], p[1], bottom, q[0], q[1], bottom, q[0], q[1], top,
          p[0], p[1], bottom, q[0], q[1], top, p[0], p[1], top);
      }
    }
  }
  // Проём определяет, нужна ли площадке толщина. После этого закрываем все её свободные края:
  // маска второго света может не совпадать с концом площадки у эскалатора или лестничной площадки.
  if (!facesVoid) return [];
  const floor = bottomTriangles([polygon], bottom);
  for (let i = 0; i < floor.length; i += 9) {
    if ((floor[i + 3] - floor[i]) * (floor[i + 7] - floor[i + 1]) - (floor[i + 4] - floor[i + 1]) * (floor[i + 6] - floor[i]) <= 0) continue;
    for (let j = 0; j < 3; j++) [floor[i + 3 + j], floor[i + 6 + j]] = [floor[i + 6 + j], floor[i + 3 + j]];
  }
  return [...floor, ...sides];
}

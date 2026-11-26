import { longestEdgeNormal, type Pt } from '../render/building-geometry';

/** Сторона контура считается примыкающей к соседнему объёму, если её точки ближе этого к его стене, м. */
const TOUCH = 0.3;

function distToSegment([px, py]: Pt, [ax, ay]: Pt, [bx, by]: Pt): number {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

function inside([x, y]: Pt, ring: Pt[]): boolean {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/**
 * Направление ската односкатной крыши по умолчанию (roof:direction, градусы от севера по часовой): пристройка
 * обычно опирается высокой стороной на соседний объём, скат — от него. Сторона с наибольшим примыканием к стенам
 * others — верх ската; без соседей — как рисуется без тега (поперёк самой длинной стороны).
 * ring и others — в метрах, x — восток, y — север.
 */
export function skillionDirection(ring: Pt[], others: Pt[][]): number {
  let best = 0, edge: [Pt, Pt] | undefined;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (l < TOUCH) continue;
    const samples = [0.1, 0.3, 0.5, 0.7, 0.9].map((t): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    const hits = samples.filter((q) => others.some((r) => r.some((c, j) => distToSegment(q, c, r[(j + 1) % r.length]) < TOUCH))).length;
    const contact = (hits / samples.length) * l;
    if (contact > best + 1e-6) { best = contact; edge = [a, b]; }
  }
  let deg: number;
  if (!edge) deg = longestEdgeNormal(ring);
  else {
    const [a, b] = edge, l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let n: Pt = [(b[1] - a[1]) / l, -(b[0] - a[0]) / l];
    const mid: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (!inside([mid[0] + n[0] * 0.1, mid[1] + n[1] * 0.1], ring)) n = [-n[0], -n[1]];
    deg = (Math.atan2(n[0], n[1]) * 180) / Math.PI;
  }
  return Math.round(((deg % 360) + 360) % 360) % 360;
}

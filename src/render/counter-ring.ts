type Pt = [number, number];
/** Сторона соседней стены или помещения. */
export type Segment = [Pt, Pt];

/** Конец прилавка на стене: допуск, м. */
const END_TOUCH = 0.05;

/** Глубина прилавка (wall=counter), м. */
export const COUNTER_DEPTH = 0.5;

/**
 * След прилавка: линия пути и её копия со сдвигом вправо по ходу пути (как у барьеров). На изломах — срез по биссектрисе.
 * Без повтора первой точки.
 */
export function counterRing(line: Pt[], depth = COUNTER_DEPTH, ends: Segment[] = []): Pt[] {
  const pts = line.filter((p, i) => !i || Math.hypot(p[0] - line[i - 1][0], p[1] - line[i - 1][1]) > 1e-6);
  if (pts.length < 2) return pts;
  const right = (a: Pt, b: Pt): Pt => { const l = Math.hypot(b[0] - a[0], b[1] - a[1]); return [(b[1] - a[1]) / l, -(b[0] - a[0]) / l]; };
  const offset = pts.map((p, i): Pt => {
    const n1 = right(pts[Math.max(0, i - 1)], pts[Math.max(1, i)]), n2 = right(pts[Math.min(i, pts.length - 2)], pts[Math.min(i + 1, pts.length - 1)]);
    const mx = n1[0] + n2[0], my = n1[1] + n2[1], l = Math.hypot(mx, my) || 1;
    // Не длиннее тройной глубины: на острых углах срез уходил бы далеко за прилавок
    const k = depth / Math.max(1 / 3, (mx * n1[0] + my * n1[1]) / l) / l;
    return [p[0] + mx * k, p[1] + my * k];
  });
  // Торец у примыкающей стены — по её линии, а не поперёк прилавка
  const trim = (i: number, from: number, to: number) => {
    const n = right(pts[from], pts[to]), along = [pts[to][0] - pts[from][0], pts[to][1] - pts[from][1]], l = Math.hypot(along[0], along[1]);
    const p = pts[i];
    let best: Pt | undefined, score = 0.15;
    for (const [c, d] of ends) {
      const ex = d[0] - c[0], ey = d[1] - c[1], len2 = ex * ex + ey * ey;
      if (len2 < 1e-9) continue;
      const u = ((p[0] - c[0]) * ex + (p[1] - c[1]) * ey) / len2;
      if (u < -0.02 || u > 1.02 || Math.abs((p[0] - c[0]) * ey - (p[1] - c[1]) * ex) / Math.sqrt(len2) > END_TOUCH) continue;
      for (const sign of [-1, 1]) {
        const dx = sign * ex / Math.sqrt(len2), dy = sign * ey / Math.sqrt(len2), side = dx * n[0] + dy * n[1];
        // Сторона в глубину прилавка, не слишком вдоль него: при остром угле срез ушёл бы далеко
        if (side > score && Math.abs(dx * along[0] + dy * along[1]) / l < 0.95) { score = side; best = [p[0] + dx * depth / side, p[1] + dy * depth / side]; }
      }
    }
    if (best) offset[i] = best;
  };
  trim(0, 0, 1);
  trim(pts.length - 1, pts.length - 2, pts.length - 1);
  return [...pts, ...offset.reverse()];
}

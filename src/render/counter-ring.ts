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
  let pts = line.filter((p, i) => !i || Math.hypot(p[0] - line[i - 1][0], p[1] - line[i - 1][1]) > 1e-6);
  if (pts.length < 2) return pts;
  // Замкнутый путь: кольцо со срезом по биссектрисе и на стыке начала и конца. Результат — «замочная скважина»:
  // внешнее кольцо, перемычка p0→o0 и внутреннее кольцо (длина 2n+2; перемычки — на индексах n+1 и 2n+2, см. isClosedCounterRing)
  if (pts.length > 3 && Math.hypot(pts[0][0] - pts.at(-1)![0], pts[0][1] - pts.at(-1)![1]) < 1e-6) {
    pts = pts.slice(0, -1);
    const n = pts.length;
    const right = (a: Pt, b: Pt): Pt => { const l = Math.hypot(b[0] - a[0], b[1] - a[1]); return [(b[1] - a[1]) / l, -(b[0] - a[0]) / l]; };
    const off = pts.map((p, i): Pt => {
      const n1 = right(pts[(i - 1 + n) % n], p), n2 = right(p, pts[(i + 1) % n]);
      const mx = n1[0] + n2[0], my = n1[1] + n2[1], l = Math.hypot(mx, my) || 1;
      const k = depth / Math.max(1 / 3, (mx * n1[0] + my * n1[1]) / l) / l;
      return [p[0] + mx * k, p[1] + my * k];
    });
    return [...pts, pts[0], off[0], ...off.slice(1).reverse()];
  }
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

/** Замкнутый прилавок: след counterRing — кольцо с перемычкой (длина чётная, первая точка повторена в середине). */
export const isClosedCounterRing = (ring: Pt[]) => ring.length >= 8 && ring.length % 2 === 0
  && Math.hypot(ring[0][0] - ring[ring.length / 2 - 1][0], ring[0][1] - ring[ring.length / 2 - 1][1]) < 1e-9;

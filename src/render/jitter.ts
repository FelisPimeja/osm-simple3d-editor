/**
 * Дрожание оцифровки на контуре: сантиметровая «гармошка» вершин вдоль прямой стены (обвод по подложке,
 * склейка с соседними путями). Объём по ней получает вертикальные рёбра на плоском фасаде.
 */
type Pt = [number, number];

/** Отклонение вершин от прямой стены, м, ниже которого они — дрожание, а не форма. */
export const JITTER_TOL = 0.03;

/**
 * Номера вершин кольца (без замыкающей точки), которые — дрожание: каждую можно убрать, и все исходные точки между
 * оставшимися соседями лежат ближе tol от отрезка между ними. Кандидаты — только вершины у рёбер короче 4·tol:
 * точки на прямой длинной стены (стыки с соседними частями) остаются. Жадно, сначала самые малые отклонения;
 * остаётся не меньше трёх вершин.
 */
export function jitterVertices(pts: Pt[], tol = JITTER_TOL): number[] {
  const n = pts.length;
  if (n <= 3) return [];
  const len = (i: number) => { const p = pts[i], q = pts[(i + 1) % n]; return Math.hypot(q[0] - p[0], q[1] - p[1]); };
  const cand = new Set(pts.map((_, i) => i).filter((i) => Math.min(len(i), len((i - 1 + n) % n)) < 4 * tol));
  if (!cand.size) return [];
  const dist = (p: Pt, a: Pt, b: Pt) => {
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
  };
  const keep = pts.map((_, i) => i);
  const devAt = (j: number) => {
    const a = keep[(j - 1 + keep.length) % keep.length], b = keep[(j + 1) % keep.length];
    let dev = 0;
    for (let x = (a + 1) % n; x !== b; x = (x + 1) % n) dev = Math.max(dev, dist(pts[x], pts[a], pts[b]));
    return dev;
  };
  while (keep.length > 3) {
    let best = -1, bestDev = tol;
    for (let j = 0; j < keep.length; j++) { if (!cand.has(keep[j])) continue; const d = devAt(j); if (d < bestDev) { bestDev = d; best = j; } }
    if (best < 0) break;
    keep.splice(best, 1);
  }
  const kept = new Set(keep);
  return pts.map((_, i) => i).filter((i) => !kept.has(i));
}

/** Кольцо без дрожания (замыкающая точка сохраняется, если была). */
export function dropJitter(ring: Pt[], tol = JITTER_TOL): Pt[] {
  const closed = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
  const pts = closed ? ring.slice(0, -1) : ring;
  const gone = new Set(jitterVertices(pts, tol));
  if (!gone.size) return ring;
  const out = pts.filter((_, i) => !gone.has(i));
  return closed ? [...out, out[0]] : out;
}

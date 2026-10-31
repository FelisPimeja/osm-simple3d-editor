type Pt = [number, number];

/** Контур или линия плана, метры сцены; closed — кольцо без повтора первой точки. */
export interface AxisRing { pts: Pt[]; closed: boolean }

/** Точка ближе этого к стороне лежит на ней, м. */
const ON_SIDE = 0.05;

const sides = (r: AxisRing): [Pt, Pt][] => r.pts.slice(0, r.closed ? undefined : -1).map((a, i) => [a, r.pts[(i + 1) % r.pts.length]]);
const length = ([a, b]: [Pt, Pt]) => Math.hypot(b[0] - a[0], b[1] - a[1]);

function distance(p: Pt, [a, b]: [Pt, Pt]): number {
  const ex = b[0] - a[0], ey = b[1] - a[1], l2 = ex * ex + ey * ey;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * ex + (p[1] - a[1]) * ey) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * ex, p[1] - a[1] - t * ey);
}

function inside(p: Pt, ring: Pt[]): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[i], [bx, by] = ring[j];
    if ((ay > p[1]) !== (by > p[1]) && p[0] < ((bx - ax) * (p[1] - ay)) / (by - ay) + ax) hit = !hit;
  }
  return hit;
}

const area = (r: Pt[]) => Math.abs(r.reduce((s, [x, y], i) => { const [u, v] = r[(i + 1) % r.length]; return s + x * v - u * y; }, 0)) / 2;

/**
 * Оси рисования от первой точки: в углу — самая длинная из сторон у точки, на стороне — эта сторона, внутри контура —
 * главное направление самого маленького контура вокруг точки (по длине сторон, с точностью до 90°). Ось X берётся
 * ближайшей к ref, чтобы подписи осей не менялись местами. Вне контуров — undefined.
 */
export function localAxes(p: Pt, rings: AxisRing[], ref: Pt): { x: Pt; y: Pt } | undefined {
  const touching = rings.flatMap(sides).filter((s) => length(s) > 1e-6 && distance(p, s) <= ON_SIDE).sort((a, b) => length(b) - length(a));
  let theta: number | undefined;
  if (touching[0]) {
    const [a, b] = touching[0];
    theta = Math.atan2(b[1] - a[1], b[0] - a[0]);
  } else {
    const room = rings.filter((r) => r.closed && r.pts.length > 2 && inside(p, r.pts)).sort((a, b) => area(a.pts) - area(b.pts))[0];
    if (!room) return;
    let sx = 0, sy = 0;
    for (const s of sides(room)) {
      const phi = 4 * Math.atan2(s[1][1] - s[0][1], s[1][0] - s[0][0]);
      sx += length(s) * Math.cos(phi); sy += length(s) * Math.sin(phi);
    }
    if (Math.hypot(sx, sy) < 1e-6) return; // круг: своего направления нет
    theta = Math.atan2(sy, sx) / 4;
  }
  const best = [0, 1, 2, 3].map((k) => theta! + (k * Math.PI) / 2).map((t): Pt => [Math.cos(t), Math.sin(t)])
    .sort((a, b) => b[0] * ref[0] + b[1] * ref[1] - a[0] * ref[0] - a[1] * ref[1])[0];
  return { x: best, y: [-best[1], best[0]] };
}

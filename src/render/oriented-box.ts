import type { Pt } from './building-geometry';

/**
 * Локальная система координат здания: начало в углу основания, оси вдоль сторон
 * минимального по площади описанного прямоугольника (направленного bbox).
 */
export interface LocalFrame {
  /** Начало отсчёта (в метрах той же системы, что и точки). */
  origin: Pt;
  /** Единичные векторы осей: x — вдоль длинной стороны, y — поперёк (x × y = z вверх). */
  x: Pt;
  y: Pt;
  /** Размеры прямоугольника по осям, м. */
  size: [number, number];
}

/** Выпуклая оболочка (монотонная цепочка Эндрю), против часовой стрелки. */
function convexHull(points: Pt[]): Pt[] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Pt[] = [], upper: Pt[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/**
 * Направленный bbox: минимальный по площади прямоугольник, одна из сторон которого лежит на стороне
 * выпуклой оболочки. Ось x — вдоль длинной стороны, повёрнута «на восток» (угол в (−90°, 90°]),
 * y — на 90° против часовой; начало — угол с минимальными координатами по обеим осям.
 */
export function orientedFrame(points: Pt[]): LocalFrame | undefined {
  const hull = convexHull(points);
  if (hull.length < 2) return;
  let best: { area: number; angle: number } | undefined;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const [w, h] = extent(hull, angle);
    const area = (w[1] - w[0]) * (h[1] - h[0]);
    if (!best || area < best.area - 1e-9) best = { area, angle };
  }
  let angle = best!.angle;
  let [u, v] = extent(hull, angle);
  // x — вдоль длинной стороны
  if (v[1] - v[0] > u[1] - u[0]) angle += Math.PI / 2;
  // Нормализуем в (−90°, 90°]: x смотрит скорее на восток, y — на север
  while (angle <= -Math.PI / 2) angle += Math.PI;
  while (angle > Math.PI / 2) angle -= Math.PI;
  [u, v] = extent(hull, angle);
  const x: Pt = [Math.cos(angle), Math.sin(angle)], y: Pt = [-x[1], x[0]];
  return {
    origin: [x[0] * u[0] + y[0] * v[0], x[1] * u[0] + y[1] * v[0]],
    x, y,
    size: [u[1] - u[0], v[1] - v[0]],
  };
}

/** Диапазоны проекций точек на ось под углом angle и на перпендикуляр к ней. */
function extent(points: Pt[], angle: number): [[number, number], [number, number]] {
  const c = Math.cos(angle), s = Math.sin(angle);
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const [px, py] of points) {
    const u = px * c + py * s, v = -px * s + py * c;
    u0 = Math.min(u0, u); u1 = Math.max(u1, u);
    v0 = Math.min(v0, v); v1 = Math.max(v1, v);
  }
  return [[u0, u1], [v0, v1]];
}

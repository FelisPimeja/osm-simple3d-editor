/**
 * Стекло окна и его обводка с переплётом (window:panes=AxB — A по ширине, B по высоте) в плоскости стены.
 * Контур — вдоль стены от середины и вверх от подоконника, м (как windowOutline); без него — прямоугольник.
 */
type Pt = [number, number];

export interface PanePlace { p: Pt; t: Pt; n: Pt; z: number; width: number; height: number; outline?: Pt[] }

/** Число створок переплёта по ширине и высоте: «4x3», «2×1», «3» (только по ширине). */
export function parsePanes(v: string | undefined): [number, number] {
  const m = /^\s*(\d+)\s*(?:[x×*х]\s*(\d+))?\s*$/i.exec(v ?? '');
  if (!m) return [1, 1];
  const c = Math.min(20, Math.max(1, Number(m[1]))), r = Math.min(20, Math.max(1, Number(m[2] ?? 1)));
  return [c, r];
}

const rect = (w: number, h: number): Pt[] => [[-w / 2, 0], [w / 2, 0], [w / 2, h], [-w / 2, h]];

/** Отрезок прямой axis=c (0 — вертикаль x=c, 1 — горизонталь z=c) внутри выпуклого контура. */
function chord(o: Pt[], axis: 0 | 1, c: number): [number, number] | undefined {
  let lo = Infinity, hi = -Infinity;
  o.forEach((a, k) => {
    const b = o[(k + 1) % o.length], da = a[axis] - c, db = b[axis] - c;
    if ((da < 0) === (db < 0) || da === db) return;
    const f = da / (da - db), v = a[1 - axis] + (b[1 - axis] - a[1 - axis]) * f;
    lo = Math.min(lo, v); hi = Math.max(hi, v);
  });
  return hi > lo ? [lo, hi] : undefined;
}

/**
 * Стекло веером (в tris) и линии обводки и переплёта (в lines) окна place, сдвинутые от стены на off
 * (плюс — наружу, минус — вглубь ниши).
 */
export function windowPane(e: PanePlace, panes: [number, number], off: number, tris: number[] | undefined, lines: number[]): void {
  const o = e.outline && e.outline.length >= 3 ? e.outline : rect(e.width, e.height);
  const at = (q: Pt) => [e.p[0] + e.t[0] * q[0] + e.n[0] * off, e.p[1] + e.t[1] * q[0] + e.n[1] * off, e.z + q[1]];
  if (tris) for (let k = 1; k + 1 < o.length; k++) tris.push(...at(o[0]), ...at(o[k]), ...at(o[k + 1]));
  o.forEach((q, k) => lines.push(...at(q), ...at(o[(k + 1) % o.length])));
  const [cols, rows] = panes;
  const xs = o.map((q) => q[0]), zs = o.map((q) => q[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
  for (let i = 1; i < cols; i++) {
    const x = x0 + (x1 - x0) * i / cols, c = chord(o, 0, x);
    if (c) lines.push(...at([x, c[0]]), ...at([x, c[1]]));
  }
  for (let j = 1; j < rows; j++) {
    const z = z0 + (z1 - z0) * j / rows, c = chord(o, 1, z);
    if (c) lines.push(...at([c[0], z]), ...at([c[1], z]));
  }
}

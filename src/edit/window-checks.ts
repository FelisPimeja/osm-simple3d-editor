/**
 * Проверки окон на фасадах (чистая геометрия, метры сцены): окно — прямоугольник в плоскости своей стены
 * (вдоль стены s от узла, высота z). Модуль без импортов — его грузят тесты в node.
 */
type Pt = [number, number];

/** Объём здания: кольца контура (первое — внешнее), низ и верх стен, м. */
export interface CheckPart { key: string; rings: Pt[][]; min: number; top: number }

/** Проём на фасаде: узел p, вдоль стены t, наружу n; низ z, ширина и высота, м. */
export interface CheckOpening { id: number; kind: 'window' | 'entrance'; p: Pt; t: Pt; n: Pt; z: number; width: number; height: number }

export type WindowProblem =
  /** Окно выходит за край стены (за угол или туда, где стены этой плоскости нет). */
  | 'window-off-wall'
  /** Верх окна выше верха стены — заходит в крышу. */
  | 'window-roof'
  /** Низ окна ниже основания стены. */
  | 'window-below'
  /** Окна пересекаются. */
  | 'window-overlap'
  /** Окно пересекается со входом. */
  | 'window-entrance'
  /** За окном — другой объём здания (окно в глухой стене к соседней части). */
  | 'window-blocked';

export interface WindowFinding { id: number; code: WindowProblem; other?: number }

/** Плоскость та же: направления параллельны, точка на прямой, м. */
const PLANE_TOL = 0.05;
/** Перекрытие меньше этого (соприкосновение краями) — не пересечение, м. */
const TOUCH = 0.01;

const dot = (a: Pt, b: Pt) => a[0] * b[0] + a[1] * b[1];

function inRing([x, y]: Pt, ring: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Куски стен в плоскости проёма: отрезок вдоль стены [s0, s1] и высоты [min, top]. */
function coplanarWalls(o: CheckOpening, parts: CheckPart[]) {
  const out: { s0: number; s1: number; min: number; top: number }[] = [];
  for (const part of parts) for (const ring of part.rings) ring.forEach((a, i) => {
    const b = ring[(i + 1) % ring.length], d: Pt = [b[0] - a[0], b[1] - a[1]], l = Math.hypot(d[0], d[1]);
    if (l < 1e-6 || Math.abs(dot(d, o.t)) / l < 0.999) return;
    if (Math.abs(dot([a[0] - o.p[0], a[1] - o.p[1]], o.n)) > PLANE_TOL) return;
    const sa = dot([a[0] - o.p[0], a[1] - o.p[1]], o.t), sb = dot([b[0] - o.p[0], b[1] - o.p[1]], o.t);
    out.push({ s0: Math.min(sa, sb), s1: Math.max(sa, sb), min: part.min, top: part.top });
  });
  return out;
}

/** Окно целиком на стенах своей плоскости (в том числе на стыке частей); нет — что именно не так. */
function coverage(o: CheckOpening, parts: CheckPart[]): WindowProblem | undefined {
  const walls = coplanarWalls(o, parts);
  const hw = o.width / 2, N = 4;
  let off = false, roof = false, below = false;
  for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) {
    const s = -hw + TOUCH + (o.width - 2 * TOUCH) * i / N, z = o.z + TOUCH + (o.height - 2 * TOUCH) * j / N;
    if (walls.some((w) => s >= w.s0 - TOUCH && s <= w.s1 + TOUCH && z >= w.min - TOUCH && z <= w.top + TOUCH)) continue;
    const along = walls.filter((w) => s >= w.s0 - TOUCH && s <= w.s1 + TOUCH);
    if (!along.length) off = true;
    else if (z > Math.max(...along.map((w) => w.top))) roof = true;
    else below = true;
  }
  return off ? 'window-off-wall' : roof ? 'window-roof' : below ? 'window-below' : undefined;
}

/** Два проёма в одной плоскости пересекаются (больше, чем касание краями). */
function overlap(a: CheckOpening, b: CheckOpening): boolean {
  if (Math.abs(dot(a.t, b.t)) < 0.999 || Math.abs(dot([b.p[0] - a.p[0], b.p[1] - a.p[1]], a.n)) > PLANE_TOL) return false;
  // Стена с другой стороны (наружу в разные стороны) — проёмы в разных стенах
  if (dot(a.n, b.n) < 0) return false;
  const sb = dot([b.p[0] - a.p[0], b.p[1] - a.p[1]], a.t);
  const ds = Math.min(a.width / 2, sb + b.width / 2) - Math.max(-a.width / 2, sb - b.width / 2);
  const dz = Math.min(a.z + a.height, b.z + b.height) - Math.max(a.z, b.z);
  return ds > TOUCH && dz > TOUCH;
}

/** За окном (чуть наружу от середины) — объём другой части: окно смотрит в соседа. */
function blocked(o: CheckOpening, parts: CheckPart[]): boolean {
  const q: Pt = [o.p[0] + o.n[0] * 0.3, o.p[1] + o.n[1] * 0.3], z = o.z + o.height / 2;
  return parts.some((p) => z > p.min + TOUCH && z < p.top - TOUCH && p.rings.length > 0 && inRing(q, p.rings[0]) && !p.rings.slice(1).some((h) => inRing(q, h)));
}

/** Проблемы окон здания: окна — среди openings (входы — для пересечений с ними). */
export function checkWindows(openings: CheckOpening[], parts: CheckPart[]): WindowFinding[] {
  const out: WindowFinding[] = [];
  const windows = openings.filter((o) => o.kind === 'window');
  for (const w of windows) {
    const c = coverage(w, parts);
    if (c) out.push({ id: w.id, code: c });
    else if (blocked(w, parts)) out.push({ id: w.id, code: 'window-blocked' });
  }
  for (let i = 0; i < windows.length; i++) for (let j = i + 1; j < windows.length; j++) {
    if (overlap(windows[i], windows[j])) out.push({ id: windows[i].id, code: 'window-overlap', other: windows[j].id });
  }
  for (const w of windows) for (const e of openings) {
    if (e.kind === 'entrance' && overlap(w, e)) out.push({ id: w.id, code: 'window-entrance', other: e.id });
  }
  return out;
}

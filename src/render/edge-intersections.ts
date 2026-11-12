/**
 * Пересечения рёбер разных объектов без общей вершины (низ стены одной части на крыше другой пересекает её край):
 * точки привязки «пересечение». Рёбра — в метрах сцены; поиск пар — по сетке ячеек в плане.
 */
type V3 = { x: number; y: number; z: number };
export interface EdgeLike { key: string; a: V3; b: V3 }
export interface EdgeCrossing { keys: [string, string]; p: V3 }

/** Ребро сходится с другим ближе этого, м, — пересечение. */
const TOUCH = 0.02;
/** Ближе этого к концу ребра, м, — уже вершина, а не пересечение. */
const END = 0.05;
/** Ячейка сетки, м. */
const CELL = 4;

export function edgeIntersections(edges: EdgeLike[]): EdgeCrossing[] {
  const n = edges.length;
  // Габариты рёбер (с запасом TOUCH) — быстрый отсев пар до точного расчёта
  const box = new Float64Array(n * 6);
  const grid = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const { a, b } = edges[i];
    box.set([Math.min(a.x, b.x) - TOUCH, Math.min(a.y, b.y) - TOUCH, Math.min(a.z, b.z) - TOUCH,
      Math.max(a.x, b.x) + TOUCH, Math.max(a.y, b.y) + TOUCH, Math.max(a.z, b.z) + TOUCH], i * 6);
    const x0 = Math.floor(box[i * 6] / CELL), x1 = Math.floor(box[i * 6 + 3] / CELL);
    const y0 = Math.floor(box[i * 6 + 1] / CELL), y1 = Math.floor(box[i * 6 + 4] / CELL);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      const k = x * 1_000_003 + y;
      const list = grid.get(k);
      if (list) list.push(i); else grid.set(k, [i]);
    }
  }
  const out: EdgeCrossing[] = [];
  const pairs = new Set<number>(), points = new Set<string>();
  for (const list of grid.values()) for (let s = 0; s < list.length; s++) {
    const i = list[s], e = edges[i], bi = i * 6;
    for (let t = s + 1; t < list.length; t++) {
      const j = list[t], bj = j * 6;
      if (box[bi] > box[bj + 3] || box[bj] > box[bi + 3] || box[bi + 1] > box[bj + 4] || box[bj + 1] > box[bi + 4]
        || box[bi + 2] > box[bj + 5] || box[bj + 2] > box[bi + 5]) continue;
      const f = edges[j];
      if (e.key === f.key) continue;
      const pair = i < j ? i * n + j : j * n + i;
      if (pairs.has(pair)) continue;
      pairs.add(pair);
      const p = crossing(e, f);
      if (!p) continue;
      const id = `${p.x.toFixed(2)}:${p.y.toFixed(2)}:${p.z.toFixed(2)}:${e.key < f.key ? e.key + '|' + f.key : f.key + '|' + e.key}`;
      if (points.has(id)) continue;
      points.add(id);
      out.push({ keys: [e.key, f.key], p });
    }
  }
  return out;
}

/** Точка, где отрезки сходятся (строго внутри обоих, не у концов); параллельные — нет. */
function crossing(e: EdgeLike, f: EdgeLike): V3 | undefined {
  const u = sub(e.b, e.a), v = sub(f.b, f.a), w = sub(e.a, f.a);
  const a = dot(u, u), b = dot(u, v), c = dot(v, v), d = dot(u, w), q = dot(v, w);
  const den = a * c - b * b;
  if (a < 1e-8 || c < 1e-8 || den < 1e-6 * a * c) return; // вырожденные или параллельные
  const sc = (b * q - c * d) / den, tc = (a * q - b * d) / den;
  const la = Math.sqrt(a), lb = Math.sqrt(c);
  if (sc * la < END || (1 - sc) * la < END || tc * lb < END || (1 - tc) * lb < END) return;
  const p1 = { x: e.a.x + u.x * sc, y: e.a.y + u.y * sc, z: e.a.z + u.z * sc };
  const p2 = { x: f.a.x + v.x * tc, y: f.a.y + v.y * tc, z: f.a.z + v.z * tc };
  if (Math.hypot(p1.x - p2.x, p1.y - p2.y, p1.z - p2.z) > TOUCH) return;
  return { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2, z: (p1.z + p2.z) / 2 };
}

const sub = (p: V3, q: V3): V3 => ({ x: p.x - q.x, y: p.y - q.y, z: p.z - q.z });
const dot = (p: V3, q: V3) => p.x * q.x + p.y * q.y + p.z * q.z;

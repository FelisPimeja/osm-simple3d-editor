/**
 * Трассировка (как tracing в QGIS): путь между двумя точками по рёбрам привязок — контурам, помещениям, стенам.
 * Граф — рёбра на одной высоте, узлы — их вершины (совпадающие с точностью до 1 см — один узел). Точка посреди
 * ребра — временный узел на нём. Путь — кратчайший (Дейкстра); его промежуточные вершины — вершины графа.
 */
type Pt = [number, number];
export interface TraceEdge { a: { x: number; y: number; z: number }; b: { x: number; y: number; z: number } }

/** Точка ближе этого к вершине или ребру — на графе, м. */
const ON_EPS = 0.01;
/** Рёбра дальше этого по высоте от плоскости рисования — не в графе, м. */
const Z_EPS = 0.05;
/** Ячейка сетки поиска вершин на рёбрах, м. */
const CELL = 4;

interface Graph { pts: Pt[]; adj: number[][]; edges: [number, number][]; ids: Map<string, number> }

const cache = new WeakMap<TraceEdge[], Map<number, Graph>>();

function graphOf(edges: TraceEdge[], z: number): Graph {
  let byZ = cache.get(edges);
  if (!byZ) cache.set(edges, byZ = new Map());
  const zk = Math.round(z * 100);
  let g = byZ.get(zk);
  if (g) return g;
  g = { pts: [], adj: [], edges: [], ids: new Map() };
  const node = (x: number, y: number) => {
    const id = `${Math.round(x / ON_EPS)},${Math.round(y / ON_EPS)}`;
    let i = g!.ids.get(id);
    if (i === undefined) { i = g!.pts.length; g!.ids.set(id, i); g!.pts.push([x, y]); g!.adj.push([]); }
    return i;
  };
  const raw: [number, number][] = [];
  for (const e of edges) {
    if (Math.abs(e.a.z - z) > Z_EPS || Math.abs(e.b.z - z) > Z_EPS) continue;
    const i = node(e.a.x, e.a.y), j = node(e.b.x, e.b.y);
    if (i !== j) raw.push([i, j]);
  }
  // Вершины на чужих рёбрах (примыкания помещений к стороне контура) — разбивают эти рёбра
  const grid = new Map<string, number[]>();
  const cell = (x: number, y: number) => `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;
  g.pts.forEach(([x, y], i) => { const c = cell(x, y); (grid.get(c) ?? grid.set(c, []).get(c)!).push(i); });
  const seen = new Set<string>();
  const add = (i: number, j: number) => {
    const id = i < j ? `${i}-${j}` : `${j}-${i}`;
    if (i === j || seen.has(id)) return;
    seen.add(id);
    g!.adj[i].push(j); g!.adj[j].push(i);
    g!.edges.push([i, j]);
  };
  for (const [i, j] of raw) {
    const a = g.pts[i], b = g.pts[j];
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
    const on: [number, number][] = [];
    for (let cx = Math.floor((Math.min(a[0], b[0]) - ON_EPS) / CELL); cx <= Math.floor((Math.max(a[0], b[0]) + ON_EPS) / CELL); cx++)
      for (let cy = Math.floor((Math.min(a[1], b[1]) - ON_EPS) / CELL); cy <= Math.floor((Math.max(a[1], b[1]) + ON_EPS) / CELL); cy++)
        for (const k of grid.get(`${cx},${cy}`) ?? []) {
          if (k === i || k === j) continue;
          const p = g.pts[k], t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2;
          if (t > 0 && t < 1 && Math.hypot(a[0] + dx * t - p[0], a[1] + dy * t - p[1]) < ON_EPS) on.push([t, k]);
        }
    on.sort((u, v) => u[0] - v[0]);
    let prev = i;
    for (const [, k] of on) { add(prev, k); prev = k; }
    add(prev, j);
  }
  byZ.set(zk, g);
  return g;
}

const dist = (a: Pt, b: Pt) => Math.hypot(b[0] - a[0], b[1] - a[1]);

/** Вершина графа в точке p или ребро, на котором она лежит. */
function locate(g: Graph, p: Pt): { node: number } | { edge: [number, number] } | undefined {
  const i = g.ids.get(`${Math.round(p[0] / ON_EPS)},${Math.round(p[1] / ON_EPS)}`);
  if (i !== undefined) return { node: i };
  for (const [i, j] of g.edges) {
    const a = g.pts[i], b = g.pts[j];
    if (dist(a, p) < ON_EPS) return { node: i };
    if (dist(b, p) < ON_EPS) return { node: j };
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
    const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2;
    if (t > 0 && t < 1 && Math.hypot(a[0] + dx * t - p[0], a[1] + dy * t - p[1]) < ON_EPS) return { edge: [i, j] };
  }
}

/**
 * Промежуточные вершины кратчайшего пути от a до b по рёбрам на высоте z (без самих a и b).
 * undefined — a или b не на графе или пути между ними нет; [] — путь — прямой отрезок (одно ребро).
 */
export function tracePath(edges: TraceEdge[], z: number, a: Pt, b: Pt): Pt[] | undefined {
  if (dist(a, b) < ON_EPS) return;
  const g = graphOf(edges, z);
  const la = locate(g, a), lb = locate(g, b);
  if (!la || !lb) return;
  // Временные узлы A = n, B = n + 1 — точки посреди рёбер (или сами вершины)
  const n = g.pts.length, A = n, B = n + 1;
  const pt = (i: number) => (i === A ? a : i === B ? b : g.pts[i]);
  const extra = new Map<number, number[]>([[A, []], [B, []]]);
  const link = (i: number, j: number) => { (extra.get(i) ?? extra.set(i, []).get(i)!).push(j); (extra.get(j) ?? extra.set(j, []).get(j)!).push(i); };
  for (const [v, l] of [[A, la], [B, lb]] as const) {
    if ('node' in l) link(v, l.node);
    else { link(v, l.edge[0]); link(v, l.edge[1]); }
  }
  // Обе точки на одном ребре — отрезок между ними
  if ('edge' in la && 'edge' in lb && la.edge[0] === lb.edge[0] && la.edge[1] === lb.edge[1]) return [];
  const d = new Map<number, number>([[A, 0]]), prev = new Map<number, number>(), done = new Set<number>();
  // Простая куча на массиве: графы планов — тысячи узлов
  const heap: [number, number][] = [[0, A]];
  const push = (x: [number, number]) => {
    heap.push(x);
    for (let i = heap.length - 1; i > 0;) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]]; i = m;
      }
    }
    return top;
  };
  while (heap.length) {
    const [du, u] = pop();
    if (done.has(u)) continue;
    done.add(u);
    if (u === B) break;
    for (const v of [...(u < n ? g.adj[u] : []), ...(extra.get(u) ?? [])]) {
      // Ребро, разбитое временным узлом, целиком не проходим
      if (u < n && v < n && [la, lb].some((l) => 'edge' in l && ((l.edge[0] === u && l.edge[1] === v) || (l.edge[0] === v && l.edge[1] === u)))) continue;
      const dv = du + dist(pt(u), pt(v));
      if (dv < (d.get(v) ?? Infinity)) { d.set(v, dv); prev.set(v, u); push([dv, v]); }
    }
  }
  if (!done.has(B)) return;
  const path: Pt[] = [];
  for (let u = prev.get(B); u !== undefined && u !== A; u = prev.get(u)) path.unshift(pt(u));
  // Сами a и b (если они — вершины графа) — не промежуточные
  return path.filter((p) => dist(p, a) >= ON_EPS && dist(p, b) >= ON_EPS);
}

/**
 * Рёбра треугольной сетки для нескольких углов за один проход — результат совпадает с THREE.EdgesGeometry
 * (тот же порядок отрезков, те же склейки вершин с точностью 1e-4, те же правила пар), но:
 * - пары граней от угла не зависят, поэтому один проход даёт рёбра сразу для всех углов;
 * - prefix — снимок после первых prefix вершин: рёбра одного начала массива (стен) без отдельного прохода;
 * - ключи рёбер числовые (номера склеенных вершин), а не склейка строк на каждую сторону.
 * EdgesGeometry на здание вызывался 3–4 раза и занимал около половины сборки тайла с контурами.
 */

const PRECISION = 1e4;
/** Номер вершины < 2^26: ключ ребра a·2^26 + b точно помещается в double. */
const SHIFT = 2 ** 26;

export interface EdgePassResult {
  /** Рёбра всей сетки — по одному массиву на угол из angles. */
  full: Float32Array[];
  /** Рёбра первых prefix вершин — по одному массиву на угол (если prefix задан). */
  prefix?: Float32Array[];
}

/** Пара граней: отрезок (вершины v0, v1 текущего треугольника) и косинус угла между их нормалями. */
interface Pair { o0: number; o1: number; dot: number }
/** Сторона без пары (пока): откуда брать координаты (смещения в positions). */
interface Open { o0: number; o1: number; nx: number; ny: number; nz: number }

export function edgePass(positions: Float32Array, angles: number[], prefix?: number): EdgePassResult {
  const dots = angles.map((a) => Math.cos((Math.PI / 180) * a));
  const ids = new Map<string, number>();
  const vid = (o: number) => {
    const k = `${Math.round(positions[o] * PRECISION)},${Math.round(positions[o + 1] * PRECISION)},${Math.round(positions[o + 2] * PRECISION)}`;
    let id = ids.get(k);
    if (id === undefined) ids.set(k, id = ids.size);
    return id;
  };
  // Как edgeData в EdgesGeometry: порядок вставки сохраняется, сопоставленная сторона остаётся ключом со значением null
  const open = new Map<number, Open | null>();
  const pairs: Pair[] = [];
  const h = [0, 0, 0], off = [0, 0, 0];
  let snapshot: { pairs: number; open: Open[] } | undefined;
  const count = positions.length / 3;
  for (let i = 0; i < count; i += 3) {
    if (prefix !== undefined && i === prefix) snapshot = { pairs: pairs.length, open: openList(open) };
    const a = i * 3, b = a + 3, c = a + 6;
    // Нормаль — как Triangle.getNormal: (c − b) × (a − b), нормированная
    const ux = positions[c] - positions[b], uy = positions[c + 1] - positions[b + 1], uz = positions[c + 2] - positions[b + 2];
    const vx = positions[a] - positions[b], vy = positions[a + 1] - positions[b + 1], vz = positions[a + 2] - positions[b + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const lsq = nx * nx + ny * ny + nz * nz;
    if (lsq > 0) { const s = 1 / Math.sqrt(lsq); nx *= s; ny *= s; nz *= s; } else { nx = ny = nz = 0; }
    off[0] = a; off[1] = b; off[2] = c;
    h[0] = vid(a); h[1] = vid(b); h[2] = vid(c);
    if (h[0] === h[1] || h[1] === h[2] || h[2] === h[0]) continue; // вырожденный
    for (let j = 0; j < 3; j++) {
      const k = (j + 1) % 3;
      const key = h[j] * SHIFT + h[k], rev = h[k] * SHIFT + h[j];
      const sibling = open.get(rev);
      if (sibling) {
        pairs.push({ o0: off[j], o1: off[k], dot: nx * sibling.nx + ny * sibling.ny + nz * sibling.nz });
        open.set(rev, null);
      } else if (!open.has(key)) {
        open.set(key, { o0: off[j], o1: off[k], nx, ny, nz });
      }
    }
  }
  if (prefix !== undefined && !snapshot) snapshot = { pairs: pairs.length, open: openList(open) };
  const emit = (pairCount: number, rest: Open[], dot: number) => {
    let n = 0;
    for (let p = 0; p < pairCount; p++) if (pairs[p].dot <= dot) n++;
    const out = new Float32Array((n + rest.length) * 6);
    let w = 0;
    const put = (o: number) => { out[w++] = positions[o]; out[w++] = positions[o + 1]; out[w++] = positions[o + 2]; };
    for (let p = 0; p < pairCount; p++) if (pairs[p].dot <= dot) { put(pairs[p].o0); put(pairs[p].o1); }
    for (const e of rest) { put(e.o0); put(e.o1); }
    return out;
  };
  const rest = openList(open);
  return {
    full: dots.map((d) => emit(pairs.length, rest, d)),
    prefix: snapshot && dots.map((d) => emit(snapshot!.pairs, snapshot!.open, d)),
  };
}

function openList(open: Map<number, Open | null>): Open[] {
  const out: Open[] = [];
  for (const e of open.values()) if (e) out.push(e);
  return out;
}

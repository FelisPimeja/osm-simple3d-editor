import type { LonLat } from '../osm/model';
import type { LeafType, TreeData } from '../osm/trees';

// Разброс деревьев тайла — чистые вычисления без three.js и MapLibre (идут в воркере).
// Результат упакован: по TREE_STRIDE чисел на дерево (см. TreeField).

/** Шаг разброса деревьев в лесу, м (сетка общая для всех тайлов — на стыках нет повторов и пустот). */
const WOOD_STEP = 9;
/** Больше деревьев леса на тайл не ставим: шаг растёт (кроны — шире, чтобы полог оставался сомкнутым). */
const MAX_WOOD_TREES = 8000;
/** Шаг деревьев в ряду (natural=tree_row), м. */
const ROW_STEP = 7;
/** Ячейка индекса зданий (деревья леса внутри зданий не ставим), м. */
const BUILDING_CELL = 40;

/** Дерево в мировых координатах Меркатора: размеры в метрах, seed — для разброса цвета и поворота. */
interface TreeInstance { mx: number; my: number; needle: boolean; wood?: boolean; height: number; crown: number; trunk: number; seed: number }

/** Поля дерева в упакованном массиве; FLAGS: 1 — хвойное, 2 — лесное (ствол под пологом не рисуется). */
export const TreeField = { MX: 0, MY: 1, HEIGHT: 2, CROWN: 3, TRUNK: 4, SEED: 5, FLAGS: 6 } as const;
export const TREE_STRIDE = 7;
export const NEEDLE_FLAG = 1;
export const WOOD_FLAG = 2;

/** Как MercatorCoordinate MapLibre: x, y в [0, 1], метр — в этих единицах. */
const EARTH_CIRCUMFERENCE = 2 * Math.PI * 6371008.8;
const merc = ([lng, lat]: LonLat): [number, number] =>
  [(lng + 180) / 360, (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360];
const meterAt = (lat: number) => 1 / EARTH_CIRCUMFERENCE / Math.cos((lat * Math.PI) / 180);

/** Детерминированный шум [0, 1) по целым числам. */
export function hash(a: number, b: number, c = 0): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x2545f491);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Числовой ключ ячейки сетки (индексы — до десятков миллионов, произведение точно в float64). */
const cellKey = (i: number, j: number) => i * 1e8 + j;

function isNeedle(leaf: LeafType | undefined, r: number, mixedDefault: boolean): boolean {
  if (leaf === 'needleleaved') return true;
  if (leaf === 'broadleaved') return false;
  return (leaf === 'mixed' || mixedDefault) && r < 0.5;
}

/** Размеры одиночного дерева: теги, иначе типичные с разбросом ±20 %. */
function single(needle: boolean, r: number, height?: number, crown?: number, trunk?: number) {
  const h = height ?? (needle ? 12 : 10) * (0.8 + 0.4 * r);
  const c = crown ?? h * (needle ? 0.4 : 0.6);
  return { height: h, crown: c, trunk: trunk ?? Math.min(0.6, Math.max(0.12, h * 0.022)) };
}

function pointInRings(x: number, y: number, rings: number[][]): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
      const xi = ring[i], yi = ring[i + 1], xj = ring[j], yj = ring[j + 1];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/**
 * Деревья тайла bbox [w, s, e, n]: отдельные и ряды — свои (по положению в тайле), леса (woods — из всех
 * загруженных тайлов) разбрасываются по общей сетке. В зданиях (buildings — внешние кольца) лес не растёт.
 */
export function scatterTrees(own: TreeData, woods: TreeData['woods'], buildings: LonLat[][], bbox: [number, number, number, number]): Float64Array {
  return pack(scatter(own, woods, buildings, bbox));
}

function pack(trees: TreeInstance[]): Float64Array {
  const out = new Float64Array(trees.length * TREE_STRIDE);
  trees.forEach((t, i) => out.set([t.mx, t.my, t.height, t.crown, t.trunk, t.seed, (t.needle ? NEEDLE_FLAG : 0) | (t.wood ? WOOD_FLAG : 0)], i * TREE_STRIDE));
  return out;
}

function scatter(own: TreeData, woods: TreeData['woods'], buildings: LonLat[][], [w, s, e, n]: [number, number, number, number]): TreeInstance[] {
  const [x0, y0] = merc([w, n]);
  const [x1, y1] = merc([e, s]);
  const inTile = (x: number, y: number) => x >= x0 && x < x1 && y >= y0 && y < y1;
  // Метр в единицах Меркатора — по широте, округлённой до градуса: соседние тайлы получают одну и ту же сетку
  const meter = meterAt(Math.round((s + n) / 2));
  const out: TreeInstance[] = [];

  for (const t of own.points) {
    const [x, y] = merc(t.p);
    if (!inTile(x, y)) continue;
    const r = hash(Math.round(x * 1e9), Math.round(y * 1e9));
    const needle = isNeedle(t.leaf, r, false);
    out.push({ mx: x, my: y, needle, seed: r, ...single(needle, hash(Math.round(x * 1e9), 3, 1), t.height, t.crown, t.trunk) });
  }

  for (const row of own.rows) {
    const pts = row.line.map(merc);
    let next = ROW_STEP / 2, walked = 0; // первое дерево — в полушаге от начала ряда
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
      const len = Math.hypot(bx - ax, by - ay) / meter;
      for (; next <= walked + len; next += ROW_STEP) {
        const f = (next - walked) / len;
        const x = ax + (bx - ax) * f, y = ay + (by - ay) * f;
        if (!inTile(x, y)) continue;
        const r = hash(Math.round(x * 1e9), Math.round(y * 1e9));
        const needle = isNeedle(row.leaf, r, false);
        out.push({ mx: x, my: y, needle, seed: r, ...single(needle, hash(Math.round(y * 1e9), 5, 2), row.height, row.crown) });
      }
      walked += len;
    }
  }

  // Леса: кольца в Меркаторе, обрезанные bbox тайла
  const areas = woods.map((wood) => {
    const rings = wood.polygons.flatMap((p) => [p.outer, ...p.inners]).map((ring) => ring.flatMap(merc));
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (const ring of rings) for (let i = 0; i < ring.length; i += 2) {
      bx0 = Math.min(bx0, ring[i]); bx1 = Math.max(bx1, ring[i]); by0 = Math.min(by0, ring[i + 1]); by1 = Math.max(by1, ring[i + 1]);
    }
    return { wood, rings, box: [Math.max(bx0, x0), Math.max(by0, y0), Math.min(bx1, x1), Math.min(by1, y1)] };
  }).filter((a) => a.box[0] < a.box[2] && a.box[1] < a.box[3]);
  if (!areas.length) return out;

  let step = WOOD_STEP * meter;
  const estimate = areas.reduce((sum, a) => sum + (a.box[2] - a.box[0]) * (a.box[3] - a.box[1]), 0) / (step * step);
  if (estimate > MAX_WOOD_TREES) step *= Math.sqrt(estimate / MAX_WOOD_TREES);
  const stepM = step / meter;

  // Индекс зданий: ячейка → кольца (Меркатор)
  const cell = BUILDING_CELL * meter;
  const index = new Map<number, number[][]>();
  for (const b of buildings) {
    const ring = b.flatMap(merc);
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (let i = 0; i < ring.length; i += 2) {
      bx0 = Math.min(bx0, ring[i]); bx1 = Math.max(bx1, ring[i]); by0 = Math.min(by0, ring[i + 1]); by1 = Math.max(by1, ring[i + 1]);
    }
    if (bx1 < x0 || bx0 > x1 || by1 < y0 || by0 > y1) continue;
    for (let i = Math.floor(bx0 / cell); i <= Math.floor(bx1 / cell); i++) {
      for (let j = Math.floor(by0 / cell); j <= Math.floor(by1 / cell); j++) {
        const k = cellKey(i, j);
        const list = index.get(k);
        if (list) list.push(ring); else index.set(k, [ring]);
      }
    }
  }
  const inBuilding = (x: number, y: number) => !!index.get(cellKey(Math.floor(x / cell), Math.floor(y / cell)))?.some((r) => pointInRings(x, y, [r]));

  const taken = new Set<number>(); // ячейки, занятые перекрывающимся лесом
  for (const { wood, rings, box } of areas) {
    // Построчно: пересечения строки сетки с рёбрами колец (чёт-нечет — дыры тоже), затем ячейки в промежутках
    for (let j = Math.floor(box[1] / step); j * step <= box[3]; j++) {
      const yc = (j + 0.5) * step;
      const xs: number[] = [];
      for (const ring of rings) {
        for (let a = 0, b = ring.length - 2; a < ring.length; b = a, a += 2) {
          const ya = ring[a + 1], yb = ring[b + 1];
          if (ya > yc !== yb > yc) xs.push(ring[a] + ((yc - ya) * (ring[b] - ring[a])) / (yb - ya));
        }
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const from = Math.max(xs[k], box[0]), to = Math.min(xs[k + 1], box[2]);
        for (let i = Math.ceil(from / step - 0.5); (i + 0.5) * step <= to; i++) {
          const id = cellKey(i, j);
          if (taken.has(id)) continue;
          const x = (i + 0.15 + 0.7 * hash(i, j, 1)) * step;
          const y = (j + 0.15 + 0.7 * hash(i, j, 2)) * step;
          if (!inTile(x, y) || inBuilding(x, y)) continue;
          taken.add(id);
          const r = hash(i, j, 3);
          const needle = isNeedle(wood.leaf, hash(i, j, 4), true);
          const height = (needle ? 19 : 16) * (0.8 + 0.4 * r);
          // Кроны — по шагу сетки: полог почти сомкнут, сколько бы деревьев ни уместилось в тайл
          const crown = needle ? Math.min(height * 0.45, Math.max(height * 0.25, stepM * 0.95)) : Math.min(height * 0.8, Math.max(height * 0.4, stepM * 1.2));
          out.push({ mx: x, my: y, needle, wood: true, height, crown, trunk: 0, seed: hash(i, j, 5) });
        }
      }
    }
  }
  return out;
}

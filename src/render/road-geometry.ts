import { isBridge, isElevated, isRailTags, isTunnel, MinHeap, roadLevel, type RoadWay } from '../osm/roads';
import { pointInRing, type LonLat } from '../osm/model';

/**
 * Объёмные мосты, тоннели и развязки (эксперимент).
 *
 * Высоты. layer — только порядок, а не высота, а пандус обычно тегирован как обычная дорога (layer=0).
 * Поэтому высоту задаём узлам неплоских путей (layer × LEVEL_STEP_M), а по сети дорог от них
 * расходится «конус» с уклоном (ROAD_GRADE и др.): подходы сами поднимаются к мосту (или спускаются в тоннель),
 * сколькими бы путями они ни были нарисованы. Затем высоты сглаживаются вдоль линий — без изломов.
 *
 * Профиль. Лента шириной дороги; в узле, где сходятся ровно два отрезка, — общий стык (miter), поэтому
 * собирать пути в цепочки не нужно. У мостов — настил, парапеты и опоры, у пандусов — стенки до земли,
 * тоннели — полупрозрачная коробка (видна сквозь подложку).
 */

/** Высота одного уровня layer, м. */
export const LEVEL_STEP_M = 6;
/** Уклон подходов: дороги — 8 %, пешеходные — 10 %, рельсы — 5 % (поезду круче нельзя). */
const ROAD_GRADE = 0.08;
const PATH_GRADE = 0.1;
const RAIL_GRADE = 0.05;
/** Уклон лестниц (highway=steps): крутой переход между уровнями, до 30°. */
const STEPS_GRADE = Math.tan(30 * Math.PI / 180);
/** Мост с layer=0 (через ручей и т. п.) — чуть над землёй, м. */
const LOW_BRIDGE_M = 1.5;
/** Шаг сгущения линий, м: высота меняется плавно и между далёкими узлами. */
const DENSIFY_M = 8;
const SMOOTH_ITERATIONS = 40;
/** Ниже этого |высоты| подход считается лежащим на земле и не рисуется, м. */
const GROUND_EPS = 0.05;
const DECK_M = 1.2;
const PARAPET_M = 1.0;
const PIER_STEP_M = 30;
const PIER_THICK_M = 1.2;
/** Шаг опор подбирается в этих пределах (одинаковый в пределах моста), м. */
const PIER_STEP_MIN_M = 18;
const PIER_STEP_MAX_M = 45;
/** Опору, всё же вставшую на путь внизу, можно подвинуть на столько, м. */
const PIER_NUDGE_M = 3;
const TUNNEL_CLEARANCE_M = 5;
const RAIL_CLEARANCE_M = 6.5;
const ROAD_CLEARANCE_M = 5;
const PATH_CLEARANCE_M = 2.5;

/** Габарит под мостом, м: над железной дорогой — 6,5, над дорогой — 5, над пешеходной — 2,5. */
function clearance(tags: Record<string, string>): number {
  if (isRailTags(tags)) return RAIL_CLEARANCE_M;
  return PATHS.has(tags.highway) ? PATH_CLEARANCE_M : ROAD_CLEARANCE_M;
}

/**
 * Высота полотна каждого неплоского пути (undefined — путь на земле). Мост, под которым что-то проходит,
 * поднимается так, чтобы под настилом остался габарит нижнего пути; мосты считаются снизу вверх по layer,
 * поэтому мост над мостом учитывает уже поднятый нижний. Мост без пересечений — layer × LEVEL_STEP_M.
 * Пути одного моста (общие узлы, один layer, а также параллельные рядом — встречные полосы, тротуар вдоль)
 * получают общую высоту; group — номер моста.
 */
export function bridgeHeights(ways: RoadWay[], toLocal: (p: LonLat) => [number, number]): { heights: (number | undefined)[]; group: number[] } {
  const level = ways.map((w) => roadLevel(w.tags));
  const pts = ways.map((w) => w.coords.map(toLocal));
  const box = pts.map((ps) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of ps) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    return [x0, y0, x1, y1];
  });
  const crosses = (i: number, j: number) => {
    const [a0, b0, a1, b1] = box[i], [c0, d0, c1, d1] = box[j];
    if (a1 < c0 || c1 < a0 || b1 < d0 || d1 < b0) return false;
    const shared = new Set(ways[i].nodes);
    const p = pts[i], q = pts[j];
    for (let k = 1; k < p.length; k++) {
      for (let m = 1; m < q.length; m++) {
        // Общий узел — это примыкание, а не проход под мостом
        if (shared.has(ways[j].nodes[m - 1]) || shared.has(ways[j].nodes[m])) continue;
        if (segmentsCross(p[k - 1], p[k], q[m - 1], q[m])) return true;
      }
    }
    return false;
  };
  const out: (number | undefined)[] = ways.map(() => undefined);
  const order = ways.map((_, i) => i).filter((i) => isElevated(ways[i].tags)).sort((a, b) => level[a] - level[b]);
  const raised = (i: number) => level[i] >= 0 && !(isTunnel(ways[i].tags) && !isBridge(ways[i].tags));
  // Мост, нарисованный несколькими путями (один layer, общие узлы), — одно полотно с общей высотой
  const parent = ways.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const byNode = new Map<number, number>();
  for (const i of order) {
    if (!raised(i)) continue;
    for (const n of ways[i].nodes) {
      const j = byNode.get(n);
      if (j === undefined) byNode.set(n, i);
      else if (level[j] === level[i]) parent[find(i)] = find(j);
    }
  }
  // Параллельные пути одного уровня рядом (встречные полосы, тротуар вдоль) — тоже одно полотно
  const raisedOrder = order.filter(raised);
  for (let a = 0; a < raisedOrder.length; a++) for (let b = a + 1; b < raisedOrder.length; b++) {
    const i = raisedOrder[a], j = raisedOrder[b];
    if (level[i] !== level[j] || find(i) === find(j)) continue;
    const [a0, b0, a1, b1] = box[i], [c0, d0, c1, d1] = box[j];
    const tol = (roadWidth(ways[i].tags) + roadWidth(ways[j].tags)) / 2 + SIDE_BY_SIDE_TOL_M;
    if (a1 + tol < c0 || c1 + tol < a0 || b1 + tol < d0 || d1 + tol < b0) continue;
    if (sideBySide(pts[i], pts[j], tol) >= SIDE_BY_SIDE_MIN_M) parent[find(i)] = find(j);
  }
  // По уровням снизу вверх: высоты уровня известны целиком до того, как их проверяют мосты выше
  for (let k = 0; k < order.length;) {
    const l = level[order[k]];
    const same: number[] = [];
    for (; k < order.length && level[order[k]] === l; k++) same.push(order[k]);
    const top = new Map<number, number>();
    for (const i of same) {
      if (!raised(i)) { out[i] = l < 0 ? l * LEVEL_STEP_M : -LEVEL_STEP_M; continue; }
      let h: number | undefined;
      for (let j = 0; j < ways.length; j++) {
        if (j === i || level[j] >= l || (out[j] ?? 0) < 0 || !crosses(i, j)) continue;
        h = Math.max(h ?? 0, (out[j] ?? 0) + clearance(ways[j].tags) + DECK_M);
      }
      // layer > 0 без bridge и без путей под ним — только порядок слоёв (проезд над подземным гаражом и т. п.):
      // остаётся на земле, если не входит в цепочку настоящего моста
      if (h === undefined && !isBridge(ways[i].tags)) continue;
      out[i] = h ?? (l === 0 ? LOW_BRIDGE_M : l * LEVEL_STEP_M);
      top.set(find(i), Math.max(top.get(find(i)) ?? 0, out[i]!));
    }
    for (const i of same) if (raised(i) && top.has(find(i))) out[i] = top.get(find(i));
  }
  return { heights: out, group: ways.map((_, i) => find(i)) };
}

/** Отрезки одного направления (без знака) — угол меньше этого. */
const SIDE_BY_SIDE_COS = Math.cos(20 * Math.PI / 180);
/** Допуск к расстоянию между осями соседних путей сверх полусуммы их ширин, м. */
const SIDE_BY_SIDE_TOL_M = 6;
/** Разделитель между встречными проезжими частями общего полотна: ширина и высота, м. */
const DIVIDER_W_M = 0.6;
const DIVIDER_H_M = 0.8;
/** Подходы рядом сливаются в одно полотно, если их высоты различаются не больше, м. */
const RAMP_JOIN_DH_M = 1;
/** Зазор над крышей здания под мостом, м. */
const OBSTACLE_CLEARANCE_M = 1;
/** Здания выше этого мост не перелетает (идёт рядом), м. */
const OBSTACLE_MAX_TOP_M = 40;
/** Полотно выше этого над землёй вырубает деревья под собой, м. */
const TREE_CUT_MIN_M = 1;
/** Откос насыпи железной дороги: заложение на метр высоты (1 : 1,5). */
const SLOPE_RUN = 1.5;
/** Сглаживание ширины вдоль линий (переход ~ √N × 8 м). */
const WIDTH_SMOOTH_ITERATIONS = 20;
/** Заполнение провалов полотна между пересечениями (проходы подъёма к среднему соседей). */
const DECK_FILL_ITERATIONS = 400;
/** Пути считаются идущими рядом, если рядом не меньше этой длины, м. */
const SIDE_BY_SIDE_MIN_M = 10;

/**
 * Сколько метров ломаной p идёт рядом с ломаной q: отрезки почти параллельны, середина отрезка p — не дальше
 * tol от отрезка q (по перпендикуляру) и проецируется на него.
 */
export function sideBySide(p: [number, number][], q: [number, number][], tol: number): number {
  let total = 0;
  for (let k = 1; k < p.length; k++) {
    const [ax, ay] = p[k - 1], [bx, by] = p[k];
    const l = Math.hypot(bx - ax, by - ay);
    if (l < 0.1) continue;
    const mx = (ax + bx) / 2, my = (ay + by) / 2;
    for (let m = 1; m < q.length; m++) {
      const [cx, cy] = q[m - 1], [dx, dy] = q[m];
      const lq = Math.hypot(dx - cx, dy - cy);
      if (lq < 0.1) continue;
      const ux = (dx - cx) / lq, uy = (dy - cy) / lq;
      if (Math.abs(((bx - ax) * ux + (by - ay) * uy) / l) < SIDE_BY_SIDE_COS) continue;
      const t = (mx - cx) * ux + (my - cy) * uy;
      if (t < 0 || t > lq) continue;
      if (Math.abs((mx - cx) * uy - (my - cy) * ux) > tol) continue;
      total += l;
      break;
    }
  }
  return total;
}

/** Расстояние между отрезками pq и rs. */
function segmentDistance(p: [number, number], q: [number, number], r: [number, number], t: [number, number]): number {
  if (segmentsCross(p, q, r, t)) return 0;
  const toSeg = ([x, y]: [number, number], [ax, ay]: [number, number], [bx, by]: [number, number]) => {
    const ex = bx - ax, ey = by - ay, l2 = ex * ex + ey * ey || 1e-12;
    const u = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / l2));
    return Math.hypot(ax + ex * u - x, ay + ey * u - y);
  };
  return Math.min(toSeg(p, r, t), toSeg(q, r, t), toSeg(r, p, q), toSeg(t, p, q));
}

function segmentsCross([ax, ay]: [number, number], [bx, by]: [number, number], [cx, cy]: [number, number], [dx, dy]: [number, number]): boolean {
  const d1 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d2 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  const d3 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d4 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

export interface RoadMeshData {
  /** Непрозрачное: xyz и rgb на вершину, треугольники без индексов; ways — индекс пути на треугольник (для клика). */
  solid: RoadPart;
  /** Полупрозрачное (тоннели, выемки). */
  glass: RoadPart;
  /** Сколько путей нарисовано. */
  ways: number;
  /** Полосы поднятого полотна для вырубки деревьев: по 5 чисел — ax, ay, bx, by (локальные м), полуширина. */
  cuts: number[];
}

export interface RoadPart { positions: Float32Array; colors: Float32Array; ways: Int32Array }

type Rgb = [number, number, number];
const hex = (h: number): Rgb => [(h >> 16 & 255) / 255, (h >> 8 & 255) / 255, (h & 255) / 255];
const ASPHALT = hex(0x6f7378);
/** Балласт рельсового пути. */
const BALLAST = hex(0x8c8378);
/** Рельсы. */
const RAIL = hex(0x4a4642);
const RAIL_H_M = 0.15;
const PATH_TOP = hex(0xb9a98f);
const CONCRETE = hex(0xcfcac0);
const PARAPET = hex(0xe4e0d8);
const EMBANKMENT = hex(0xb7b2a6);
const TUNNEL = hex(0x3f73c4);

const PATHS = new Set(['footway', 'cycleway', 'path', 'steps', 'pedestrian', 'bridleway', 'track']);

/** Ширина проезжей части, м: width, иначе lanes × 3.5, иначе по классу дороги. */
export function roadWidth(tags: Record<string, string>): number {
  const w = Number.parseFloat(tags.width ?? '');
  if (Number.isFinite(w) && w > 0.5 && w < 80) return w;
  const lanes = Number.parseFloat(tags.lanes ?? '');
  if (Number.isFinite(lanes) && lanes > 0 && lanes < 20) return lanes * 3.5 + 1;
  if (isRailTags(tags)) return tags.railway === 'tram' || tags.railway === 'funicular' || tags.railway === 'miniature' ? 3 : 4.5;
  const h = tags.highway ?? '';
  if (h === 'motorway' || h === 'trunk') return 11;
  if (h === 'primary') return 9;
  if (h === 'secondary') return 8;
  if (h === 'tertiary') return 7;
  if (h.endsWith('_link')) return 5;
  if (h === 'service' || h === 'track') return 4;
  if (PATHS.has(h)) return 2.5;
  return 6;
}

interface Edge { a: number; b: number; way: number }

/** toLocal — lon/lat в метры сцены (x — восток, y — север). */
/** Здание под возможным мостом: внешние кольца следа и высоты (низ, верх), м. */
export interface Obstacle { rings: LonLat[][]; min: number; top: number }

/** obstacles — здания: мост над зданием поднимается выше его крыши. */
export function buildRoadMesh(ways: RoadWay[], toLocal: (p: LonLat) => [number, number], obstacles: Obstacle[] = []): RoadMeshData {
  // --- Граф: узлы OSM общие для путей, промежуточные точки сгущения — свои у каждого отрезка
  const xs: number[] = [], ys: number[] = [];
  const vertexOf = new Map<number, number>();
  const addVertex = (x: number, y: number) => { xs.push(x); ys.push(y); return xs.length - 1; };
  const edges: Edge[] = [];
  const { heights: wayHeight, group } = bridgeHeights(ways, toLocal);
  ways.forEach((w, wi) => {
    const ids = w.nodes.map((n, k) => {
      let v = vertexOf.get(n);
      if (v === undefined) { const [x, y] = toLocal(w.coords[k]); vertexOf.set(n, v = addVertex(x, y)); }
      return v;
    });
    for (let k = 1; k < ids.length; k++) {
      const a = ids[k - 1], b = ids[k];
      if (a === b) continue;
      const len = Math.hypot(xs[b] - xs[a], ys[b] - ys[a]);
      const steps = Math.max(1, Math.ceil(len / DENSIFY_M));
      let prev = a;
      for (let s = 1; s < steps; s++) {
        const t = s / steps;
        const v = addVertex(xs[a] + (xs[b] - xs[a]) * t, ys[a] + (ys[b] - ys[a]) * t);
        edges.push({ a: prev, b: v, way: wi });
        prev = v;
      }
      edges.push({ a: prev, b, way: wi });
    }
  });
  const n = xs.length;

  const other = (e: Edge, v: number) => (e.a === v ? e.b : e.a);
  const len = (e: Edge) => Math.hypot(xs[e.b] - xs[e.a], ys[e.b] - ys[e.a]);

  // --- Какая часть моста держит высоту: над путями под ним (с запасом в полширины нижнего пути + 2 м), между
  // крайними такими местами — ровно; дальше к концам полотно свободно и спускается с уклоном подходов, если
  // под ним ничего нет. Мост без найденных пересечений (над водой, оврагом) — ровный целиком, как и тоннели
  const level = ways.map((w) => roadLevel(w.tags));
  const raised = (wi: number) => (wayHeight[wi] ?? 0) > 0;
  const CELL = 25;
  const grid = new Map<string, number[]>();
  const cells = (ei: number) => {
    const e = edges[ei], out: string[] = [];
    const x0 = Math.floor(Math.min(xs[e.a], xs[e.b]) / CELL), x1 = Math.floor(Math.max(xs[e.a], xs[e.b]) / CELL);
    const y0 = Math.floor(Math.min(ys[e.a], ys[e.b]) / CELL), y1 = Math.floor(Math.max(ys[e.a], ys[e.b]) / CELL);
    for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) out.push(`${gx},${gy}`);
    return out;
  };
  edges.forEach((_, ei) => { for (const k of cells(ei)) { const l = grid.get(k); if (l) l.push(ei); else grid.set(k, [ei]); } });
  /** Отрезок моста над путём внизу → запас по сторонам, м, и нужная высота полотна там (низ + габарит + настил). */
  const crossAt = new Map<number, { r: number; need: number }>();
  edges.forEach((e, ei) => {
    if (!raised(e.way)) return;
    for (const k of cells(ei)) for (const ej of grid.get(k) ?? []) {
      const f = edges[ej];
      if (level[f.way] >= level[e.way] || (wayHeight[f.way] ?? 0) < 0) continue;
      if (f.a === e.a || f.a === e.b || f.b === e.a || f.b === e.b) continue;
      if (!segmentsCross([xs[e.a], ys[e.a]], [xs[e.b], ys[e.b]], [xs[f.a], ys[f.a]], [xs[f.b], ys[f.b]])) continue;
      const c = crossAt.get(ei) ?? { r: 0, need: 0 };
      c.r = Math.max(c.r, roadWidth(ways[f.way].tags) / 2 + 2);
      c.need = Math.max(c.need, (wayHeight[f.way] ?? 0) + clearance(ways[f.way].tags) + DECK_M);
      crossAt.set(ei, c);
    }
  });
  // Здания под мостом: полотно над крышей с зазором. Не берём поднятые части (низ выше 3 м — мост, скорее,
  // проходит под ними) и высокие здания (мост идёт рядом, а не над ними)
  const obs = obstacles.filter((o) => o.min < 3 && o.top <= OBSTACLE_MAX_TOP_M).map((o) => {
    const rings = o.rings.map((r) => r.map(toLocal));
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const r of rings) for (const [x, y] of r) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    return { rings, top: o.top, box: [x0, y0, x1, y1] };
  });
  if (obs.length) {
    const ogrid = new Map<string, number[]>();
    obs.forEach((o, oi) => {
      for (let gx = Math.floor(o.box[0] / CELL); gx <= Math.floor(o.box[2] / CELL); gx++) for (let gy = Math.floor(o.box[1] / CELL); gy <= Math.floor(o.box[3] / CELL); gy++) {
        const k = `${gx},${gy}`; const l = ogrid.get(k); if (l) l.push(oi); else ogrid.set(k, [oi]);
      }
    });
    edges.forEach((e, ei) => {
      // Только настоящие мосты: у проезда во дворе layer=1 без bridge — обычно над подземным гаражом, а не над домом
      if (!raised(e.way) || !isBridge(ways[e.way].tags)) return;
      const p: [number, number] = [xs[e.a], ys[e.a]], q: [number, number] = [xs[e.b], ys[e.b]];
      const seen = new Set<number>();
      for (const k of cells(ei)) for (const oi of ogrid.get(k) ?? []) {
        if (seen.has(oi)) continue;
        seen.add(oi);
        const o = obs[oi];
        const hit = o.rings.some((r) => pointInRing(p, r) || pointInRing(q, r) || r.some((a, i) => segmentsCross(p, q, a, r[(i + 1) % r.length])));
        if (!hit) continue;
        const c = crossAt.get(ei) ?? { r: 0, need: 0 };
        c.r = Math.max(c.r, 2);
        c.need = Math.max(c.need, o.top + OBSTACLE_CLEARANCE_M + DECK_M);
        crossAt.set(ei, c);
      }
    });
  }
  const crossedGroups = new Set([...crossAt.keys()].map((ei) => group[edges[ei].way]));
  // Мост без найденных пересечений (и тоннели) — ровный целиком на своей высоте. Мост с пересечениями держит
  // высоту только над ними: у каждого пересечения своя (над дорогой на земле ниже, чем над путём на мосту),
  // с запасом вдоль моста; остальное полотно — по подъёмам и спускам от этих точек (как подходы)
  const pinnedEdge = new Uint8Array(edges.length);
  edges.forEach((e, ei) => { if (wayHeight[e.way] !== undefined && !(raised(e.way) && crossedGroups.has(group[e.way]))) pinnedEdge[ei] = 1; });
  const deckAdj = new Map<number, number[]>();
  edges.forEach((e, ei) => {
    if (!raised(e.way) || !crossedGroups.has(group[e.way])) return;
    for (const v of [e.a, e.b]) { const l = deckAdj.get(v); if (l) l.push(ei); else deckAdj.set(v, [ei]); }
  });
  /** Вершина полотна над пересечением (с запасом) → её высота. */
  const coreHeight = new Map<number, number>();
  for (const [ei, { r, need }] of crossAt) {
    const reach = new Map<number, number>([[edges[ei].a, 0], [edges[ei].b, 0]]);
    const queue = [edges[ei].a, edges[ei].b];
    while (queue.length) {
      const v = queue.shift()!;
      coreHeight.set(v, Math.max(coreHeight.get(v) ?? 0, need));
      for (const ej of deckAdj.get(v) ?? []) {
        const u = other(edges[ej], v), d = reach.get(v)! + len(edges[ej]);
        if (d > r || d >= (reach.get(u) ?? Infinity)) continue;
        reach.set(u, d);
        queue.push(u);
      }
    }
  }
  const pinned = new Uint8Array(n);
  const height = new Float64Array(n);
  const pinSum = new Float64Array(n), pinCount = new Uint16Array(n);
  edges.forEach((e, ei) => {
    if (!pinnedEdge[ei]) return;
    for (const v of [e.a, e.b]) { pinSum[v] += wayHeight[e.way]!; pinCount[v]++; }
  });
  for (let v = 0; v < n; v++) if (pinCount[v]) { pinned[v] = 1; height[v] = pinSum[v] / pinCount[v]; }
  for (const [v, h] of coreHeight) { pinned[v] = 1; height[v] = Math.max(pinCount[v] ? height[v] : 0, h); }

  const adj: number[][] = Array.from({ length: n }, () => []);
  edges.forEach((e, i) => { adj[e.a].push(i); adj[e.b].push(i); });

  // --- Конусы: подъём к мостам (max) и спуск к тоннелям (min) по свободным вершинам; по лестнице — круто
  const steps = edges.map((e) => ways[e.way].tags.highway === 'steps');
  const grade = edges.map((e, ei) => {
    const tags = ways[e.way].tags;
    return steps[ei] ? STEPS_GRADE : isRailTags(tags) ? RAIL_GRADE : PATHS.has(tags.highway) ? PATH_GRADE : ROAD_GRADE;
  });
  // Полотно моста над пересечениями: (1) участки с разной нужной высотой — без обрывов: низкий поднимаем так, чтобы
  // уклон к высокому вдоль моста был не круче уклона подходов; (2) без провалов между ними — свободные вершины
  // полотна только поднимаем к среднему соседей (полотно тянется прямой от горба к горбу)
  if (coreHeight.size) {
    const best = new Float64Array(n).fill(-Infinity);
    const heap = new MinHeap();
    for (const [v, h] of coreHeight) { best[v] = h; heap.push(v, -h); }
    while (heap.size) {
      const [v, k] = heap.pop();
      if (-k < best[v]) continue;
      for (const ei of deckAdj.get(v) ?? []) {
        const u = other(edges[ei], v), cand = best[v] - grade[ei] * len(edges[ei]);
        if (cand <= best[u]) continue;
        best[u] = cand;
        heap.push(u, -cand);
      }
    }
    for (const v of deckAdj.keys()) if (Number.isFinite(best[v])) height[v] = Math.max(height[v], best[v]);
    // И над пересечениями: низкое пересечение между двумя высокими поднимается до прямой между ними (только вверх)
    const deckNb = [...deckAdj].filter(([, es]) => es.length === 2).map(([v, es]) => [v, other(edges[es[0]], v), other(edges[es[1]], v)]);
    for (let it = 0; it < DECK_FILL_ITERATIONS; it++) {
      for (const [v, p, q] of deckNb) height[v] = Math.max(height[v], (height[p] + height[q]) / 2);
    }
    // Пути одного моста рядом (встречные полосы, тротуары — общее полотно) пересекают нижние дороги в разных местах,
    // и их профили расходятся волной. Выравниваем: высота вершины — наибольшая среди вершин других путей того же
    // моста рядом (поперёк — до полусуммы ширин + допуск), затем снова заполняем провалы
    const deckVs = [...deckAdj.keys()];
    const VCELL = 20;
    const vgrid = new Map<string, number[]>();
    const vway = new Map<number, number>();
    for (const v of deckVs) {
      vway.set(v, edges[deckAdj.get(v)![0]].way);
      const k = `${Math.floor(xs[v] / VCELL)},${Math.floor(ys[v] / VCELL)}`;
      const l = vgrid.get(k); if (l) l.push(v); else vgrid.set(k, [v]);
    }
    const near = new Map<number, number[]>();
    for (const v of deckVs) {
      const wv = vway.get(v)!, gx = Math.floor(xs[v] / VCELL), gy = Math.floor(ys[v] / VCELL);
      const list: number[] = [];
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const u of vgrid.get(`${gx + dx},${gy + dy}`) ?? []) {
        const wu = vway.get(u)!;
        if (wu === wv || group[wu] !== group[wv]) continue;
        if (Math.hypot(xs[u] - xs[v], ys[u] - ys[v]) <= (roadWidth(ways[wv].tags) + roadWidth(ways[wu].tags)) / 2 + SIDE_BY_SIDE_TOL_M) list.push(u);
      }
      if (list.length) near.set(v, list);
    }
    for (let round = 0; round < 3; round++) {
      for (const [v, list] of near) for (const u of list) height[v] = Math.max(height[v], height[u]);
      for (let it = 0; it < DECK_FILL_ITERATIONS / 4; it++) {
        for (const [v, p, q] of deckNb) height[v] = Math.max(height[v], (height[p] + height[q]) / 2);
      }
    }
    // Полотно готово — дальше от него, как от закреплённого, расходятся подходы
    for (const v of deckAdj.keys()) if (height[v] > 0) pinned[v] = 1;
  }

  const cone = (sign: 1 | -1) => {
    const best = new Float64Array(n);
    const heap = new MinHeap();
    for (let v = 0; v < n; v++) if (pinned[v] && height[v] * sign > 0) { best[v] = height[v] * sign; heap.push(v, -best[v]); }
    while (heap.size) {
      const [v, k] = heap.pop();
      if (-k < best[v]) continue;
      for (const ei of adj[v]) {
        const u = other(edges[ei], v);
        if (pinned[u]) continue;
        const cand = best[v] - grade[ei] * len(edges[ei]);
        if (cand <= best[u]) continue;
        best[u] = cand;
        heap.push(u, -cand);
      }
    }
    return best;
  };
  const up = cone(1), down = cone(-1);
  for (let v = 0; v < n; v++) if (!pinned[v]) height[v] = up[v] - down[v];

  // --- Сглаживание вдоль линий: только подходы; полотно мостов (закреплённые вершины), развилки и концы держат
  // свою высоту — иначе короткий мост проседает к краям ниже габарита
  // Лестницу не сглаживаем: иначе её крутой уклон расплывётся на соседние дорожки
  const nb = adj.map((es, v) => (es.length === 2 && !pinned[v] && !es.some((ei) => steps[ei]) ? [other(edges[es[0]], v), other(edges[es[1]], v)] : undefined));
  const tmp = new Float64Array(n);
  for (let it = 0; it < SMOOTH_ITERATIONS; it++) {
    for (let v = 0; v < n; v++) { const p = nb[v]; tmp[v] = p ? height[v] * 0.5 + (height[p[0]] + height[p[1]]) * 0.25 : height[v]; }
    height.set(tmp);
  }

  // --- Какие отрезки рисуем: неплоские пути целиком, подходы — пока они над (под) землёй
  const drawn = edges.map((e) => wayHeight[e.way] !== undefined || Math.max(Math.abs(height[e.a]), Math.abs(height[e.b])) > GROUND_EPS);
  const drawnAdj: number[][] = Array.from({ length: n }, () => []);
  edges.forEach((e, i) => { if (drawn[i]) { drawnAdj[e.a].push(i); drawnAdj[e.b].push(i); } });
  const widths = ways.map((w) => roadWidth(w.tags));
  // Ширина в вершине: смена ширины (другое число полос, развилка) — плавно, без ступеньки на краю. В узле — по
  // самой широкой ленте (ветки развилки начинаются во всю ширину), дальше сглаживается вдоль линий на ~30–40 м
  const vertexWidth = new Float64Array(n);
  edges.forEach((e, ei) => {
    if (!drawn[ei]) return;
    for (const v of [e.a, e.b]) vertexWidth[v] = Math.max(vertexWidth[v], widths[e.way]);
  });
  {
    const wnb = drawnAdj.map((es, v) => (es.length === 2 ? [other(edges[es[0]], v), other(edges[es[1]], v)] : undefined));
    // Внутри пути без смены ширины — своя ширина; переход расходится от узла
    const own = Float64Array.from(vertexWidth);
    drawnAdj.forEach((es, v) => { if (es.length === 2 && edges[es[0]].way === edges[es[1]].way) own[v] = widths[edges[es[0]].way]; });
    vertexWidth.set(own);
    const tmpW = new Float64Array(n);
    for (let it = 0; it < WIDTH_SMOOTH_ITERATIONS; it++) {
      for (let v = 0; v < n; v++) { const p = wnb[v]; tmpW[v] = p ? (vertexWidth[p[0]] + vertexWidth[p[1]]) / 2 : vertexWidth[v]; }
      vertexWidth.set(tmpW);
    }
  }

  /** Смещение к левому краю отрезка в вершине v (по направлению a→b), со стыком, если в v сходятся два отрезка. */
  const leftAt = (ei: number, v: number): [number, number] => {
    const e = edges[ei];
    const half = vertexWidth[v] / 2;
    const l = len(e) || 1;
    const tx = (xs[e.b] - xs[e.a]) / l, ty = (ys[e.b] - ys[e.a]) / l;
    const nx = -ty, ny = tx;
    const ds = drawnAdj[v];
    if (ds.length !== 2) return [nx * half, ny * half];
    const o = edges[ds[0] === ei ? ds[1] : ds[0]];
    const far = other(o, v);
    const ol = len(o) || 1;
    // Направление соседа «насквозь» через v в ту же сторону, что a→b
    let ox = (xs[far] - xs[v]) / ol, oy = (ys[far] - ys[v]) / ol;
    if (v === e.a) { ox = -ox; oy = -oy; }
    let mx = nx - oy, my = ny + ox;
    const ml = Math.hypot(mx, my);
    if (ml < 1e-3) return [nx * half, ny * half];
    mx /= ml; my /= ml;
    const k = half / Math.max(mx * nx + my * ny, 0.3);
    return [mx * k, my * k];
  };

  const solid: number[] = [], solidC: number[] = [], solidW: number[] = [];
  const glass: number[] = [], glassC: number[] = [], glassW: number[] = [];
  /** Путь, чьи треугольники сейчас добавляются. */
  let cur = -1;
  const tri = (out: number[], col: number[], c: Rgb, ...p: number[]) => {
    out.push(...p);
    for (let i = 0; i < p.length / 3; i++) col.push(...c);
    (out === solid ? solidW : glassW).push(...Array<number>(p.length / 9).fill(cur));
  };
  /** Четырёхугольник p0 p1 p2 p3 (по кругу) — два треугольника. */
  const quad = (out: number[], col: number[], c: Rgb, p0: number[], p1: number[], p2: number[], p3: number[]) => {
    tri(out, col, c, ...p0, ...p1, ...p2, ...p0, ...p2, ...p3);
  };

  /** Опора-параллелепипед от земли до z: центр (cx, cy), (dx, dy) — единичное направление «вдоль моста». */
  const pierBox = (cx: number, cy: number, dx: number, dy: number, along: number, across: number, z: number) => {
    const tx = dx * along / 2, ty = dy * along / 2, nx = -dy * across / 2, ny = dx * across / 2;
    const corners = [[cx + tx + nx, cy + ty + ny], [cx - tx + nx, cy - ty + ny], [cx - tx - nx, cy - ty - ny], [cx + tx - nx, cy + ty - ny]];
    for (let i = 0; i < 4; i++) {
      const p = corners[i], q = corners[(i + 1) % 4];
      quad(solid, solidC, CONCRETE, [p[0], p[1], 0], [q[0], q[1], 0], [q[0], q[1], z], [p[0], p[1], z]);
    }
  };

  // --- Общее полотно: у отрезка моста — ближайший параллельный отрезок другого пути того же моста слева и справа
  // (встречные полосы, тротуары вдоль — group общий, см. bridgeHeights). Зазор между лентами закрываем настилом,
  // парапеты и боковины на обращённых к соседу сторонах не рисуем. Индекс стороны: 0 — слева, 1 — справа
  /** Есть ли сосед по общему полотну слева и справа. */
  const joined = [new Uint8Array(edges.length), new Uint8Array(edges.length)];
  /**
   * Полуширина ленты со стороны соседа в вершине (NaN — своя): ленты с узким зазором или перекрытием сходятся
   * встык. По вершинам, а не по отрезкам — край меняется плавно, без ступенек.
   */
  const faceHalf = [new Float64Array(n).fill(NaN), new Float64Array(n).fill(NaN)];
  const edgeWidth = (ei: number) => (vertexWidth[edges[ei].a] + vertexWidth[edges[ei].b]) / 2;
  const fillers: { ei: number; fj: number; s: number }[] = [];
  /** Отрезок лежит почти поверх соседнего пути: сторона (0 — левая, 1 — правая), которую лента соседа перекрывает, — без парапета и боковины. */
  const onTop = [new Uint8Array(edges.length), new Uint8Array(edges.length)];
  /** Сосед по общему полотну слева и справа (индекс отрезка, -1 — нет). */
  const neighbour = [new Int32Array(edges.length).fill(-1), new Int32Array(edges.length).fill(-1)];
  edges.forEach((e, ei) => {
    if (!drawn[ei]) return;
    // Мост — с путями того же моста; подход (рампа, без тега моста) — с другими подходами той же высоты рядом
    const bridge = (wayHeight[e.way] ?? 0) > 0;
    if (!bridge && Math.max(height[e.a], height[e.b]) <= GROUND_EPS) return;
    const l = len(e) || 1, ux = (xs[e.b] - xs[e.a]) / l, uy = (ys[e.b] - ys[e.a]) / l;
    const mx = (xs[e.a] + xs[e.b]) / 2, my = (ys[e.a] + ys[e.b]) / 2;
    const maxTol = widths[e.way] / 2 + 15 + SIDE_BY_SIDE_TOL_M;
    const best: ({ fj: number; s: number } | undefined)[] = [undefined, undefined];
    const gx0 = Math.floor((mx - maxTol) / CELL), gx1 = Math.floor((mx + maxTol) / CELL);
    const gy0 = Math.floor((my - maxTol) / CELL), gy1 = Math.floor((my + maxTol) / CELL);
    const seen = new Set<number>();
    for (let gx = gx0; gx <= gx1; gx++) for (let gy = gy0; gy <= gy1; gy++) for (const fj of grid.get(`${gx},${gy}`) ?? []) {
      if (seen.has(fj)) continue;
      seen.add(fj);
      const f = edges[fj];
      if (f.way === e.way || !drawn[fj]) continue;
      if (bridge ? group[f.way] !== group[e.way] : (wayHeight[f.way] ?? 0) > 0) continue;
      const lf = len(f) || 1, vx = (xs[f.b] - xs[f.a]) / lf, vy = (ys[f.b] - ys[f.a]) / lf;
      if (Math.abs(ux * vx + uy * vy) < SIDE_BY_SIDE_COS) continue;
      // Середина отрезка e проецируется на отрезок f; поперечное смещение — по нормали e (+ — слева)
      const t = (mx - xs[f.a]) * vx + (my - ys[f.a]) * vy;
      if (t < 0 || t > lf) continue;
      const px = xs[f.a] + vx * t, py = ys[f.a] + vy * t;
      if (!bridge && Math.abs((height[f.a] + (height[f.b] - height[f.a]) * (t / lf)) - (height[e.a] + height[e.b]) / 2) > RAMP_JOIN_DH_M) continue;
      const sOff = (px - mx) * -uy + (py - my) * ux;
      const tol = (widths[e.way] + widths[f.way]) / 2 + SIDE_BY_SIDE_TOL_M;
      if (Math.abs(sOff) > tol) continue;
      // Путь почти поверх соседа (у развилки ветки накрывают друг друга) — парапеты с обеих сторон не нужны
      if (Math.abs(sOff) < (widths[e.way] + widths[f.way]) / 4) {
        // Край соседа по каждую сторону дальше (или почти вровень) своего края — эта сторона внутри общего полотна
        const he = edgeWidth(ei) / 2, hf = edgeWidth(fj) / 2;
        if (sOff + hf >= he - 0.3) onTop[0][ei] = 1;
        if (-sOff + hf >= he - 0.3) onTop[1][ei] = 1;
        continue;
      }
      const k = sOff > 0 ? 0 : 1;
      if (!best[k] || Math.abs(sOff) < Math.abs(best[k]!.s)) best[k] = { fj, s: sOff };
    }
    for (const k of [0, 1]) {
      const b = best[k];
      if (!b) continue;
      joined[k][ei] = 1;
      neighbour[k][ei] = b.fj;
      const we = edgeWidth(ei), wf = edgeWidth(b.fj);
      const gap = Math.abs(b.s) - (we + wf) / 2;
      // Узкий зазор или перекрытие — край ленты со стороны соседа доводим до стыка (без заплатки и без мерцания),
      // широкий зазор — закрываем настилом
      if (gap < 1) {
        const face = Math.abs(b.s) * we / (we + wf);
        for (const v of [e.a, e.b]) faceHalf[k][v] = Number.isNaN(faceHalf[k][v]) ? face : Math.min(faceHalf[k][v], face);
      } else if (e.way < edges[b.fj].way) fillers.push({ ei, fj: b.fj, s: b.s });
    }
  });

  /** Полотно с настилом (мост): под ним пусто. */
  const isDeck = (ei: number) => isBridge(ways[edges[ei].way].tags) || (wayHeight[edges[ei].way] ?? 0) > 0;
  /**
   * Свободное место сбоку от края полотна (точка, направление наружу) до края ближайшего другого пути, м. Пути
   * над откосом (мост выше top) не мешают.
   */
  const freeSide = (x: number, y: number, nx: number, ny: number, wi: number, top = Infinity) => {
    const reach = 25;
    let best = reach;
    const gx0 = Math.floor((x - reach) / CELL), gx1 = Math.floor((x + reach) / CELL);
    const gy0 = Math.floor((y - reach) / CELL), gy1 = Math.floor((y + reach) / CELL);
    const seen = new Set<number>();
    for (let gx = gx0; gx <= gx1; gx++) for (let gy = gy0; gy <= gy1; gy++) for (const fj of grid.get(`${gx},${gy}`) ?? []) {
      if (seen.has(fj)) continue;
      seen.add(fj);
      const f = edges[fj];
      if (f.way === wi || Math.min(height[f.a], height[f.b]) > top + 1) continue;
      // Пересечение луча наружу с осью f; свободно до края f (полуширина) с запасом 0,5 м
      const ex = xs[f.b] - xs[f.a], ey = ys[f.b] - ys[f.a], den = nx * ey - ny * ex;
      if (Math.abs(den) < 1e-9) continue;
      const t = ((xs[f.a] - x) * ey - (ys[f.a] - y) * ex) / den, u = ((xs[f.a] - x) * ny - (ys[f.a] - y) * nx) / den;
      if (t <= 0 || t > reach || u < 0 || u > 1) continue;
      const along = t - edgeWidth(fj) / 2 - 0.5;
      best = Math.min(best, Math.max(0, along));
    }
    return best;
  };

  const usedWays = new Set<number>();
  const cuts: number[] = [];
  edges.forEach((e, ei) => {
    if (!drawn[ei]) return;
    usedWays.add(e.way);
    cur = e.way;
    // Полотно над землёй (мост, насыпь) — деревья под ним и сквозь него не растут
    if (Math.min(height[e.a], height[e.b]) > TREE_CUT_MIN_M) cuts.push(xs[e.a], ys[e.a], xs[e.b], ys[e.b], edgeWidth(ei) / 2);
    const tags = ways[e.way].tags;
    const [lax, lay] = leftAt(ei, e.a), [lbx, lby] = leftAt(ei, e.b);
    const ax = xs[e.a], ay = ys[e.a], bx = xs[e.b], by = ys[e.b];
    const ha = height[e.a], hb = height[e.b];
    const k = (side: number, v: number) => (Number.isNaN(faceHalf[side][v]) ? 1 : faceHalf[side][v] / (vertexWidth[v] / 2));
    const La = [ax + lax * k(0, e.a), ay + lay * k(0, e.a)], Ra = [ax - lax * k(1, e.a), ay - lay * k(1, e.a)];
    const Lb = [bx + lbx * k(0, e.b), by + lby * k(0, e.b)], Rb = [bx - lbx * k(1, e.b), by - lby * k(1, e.b)];
    const at = (p: number[], z: number) => [p[0], p[1], z];
    const top = isRailTags(tags) ? BALLAST : PATHS.has(tags.highway) ? PATH_TOP : ASPHALT;
    const tunnel = isTunnel(tags) || (!isBridge(tags) && ha <= 0 && hb <= 0);
    if (tunnel) {
      // Коробка тоннеля: пол, стены, потолок — полупрозрачно; выемка (спуск к тоннелю) — без потолка
      const roof = isTunnel(tags);
      const ca = Math.min(ha + TUNNEL_CLEARANCE_M, roof ? Infinity : 0), cb = Math.min(hb + TUNNEL_CLEARANCE_M, roof ? Infinity : 0);
      quad(glass, glassC, TUNNEL, at(La, ha), at(Ra, ha), at(Rb, hb), at(Lb, hb));
      quad(glass, glassC, TUNNEL, at(La, ha), at(Lb, hb), at(Lb, roof ? cb : 0), at(La, roof ? ca : 0));
      quad(glass, glassC, TUNNEL, at(Ra, ha), at(Rb, hb), at(Rb, roof ? cb : 0), at(Ra, roof ? ca : 0));
      if (roof) quad(glass, glassC, TUNNEL, at(La, ca), at(Ra, ca), at(Rb, cb), at(Lb, cb));
      return;
    }
    quad(solid, solidC, top, at(La, ha), at(Ra, ha), at(Rb, hb), at(Lb, hb));
    if (isRailTags(tags)) {
      // Два рельса по оси пути: колея 1520 мм (узкоколейка — 750), рельс 0,1 × 0,15 м
      const l = len(e) || 1, nx = -(by - ay) / l, ny = (bx - ax) / l;
      const g = tags.railway === 'narrow_gauge' ? 0.375 : 0.76;
      for (const off of [g, -g]) {
        const box = (d: number) => [[ax + nx * (off + d), ay + ny * (off + d)], [bx + nx * (off + d), by + ny * (off + d)]];
        const [a1, b1] = box(0.05), [a2, b2] = box(-0.05);
        quad(solid, solidC, RAIL, at(a1, ha + RAIL_H_M), at(b1, hb + RAIL_H_M), at(b2, hb + RAIL_H_M), at(a2, ha + RAIL_H_M));
        quad(solid, solidC, RAIL, at(a1, ha), at(b1, hb), at(b1, hb + RAIL_H_M), at(a1, ha + RAIL_H_M));
        quad(solid, solidC, RAIL, at(a2, ha), at(b2, hb), at(b2, hb + RAIL_H_M), at(a2, ha + RAIL_H_M));
      }
    }
    if (isBridge(tags) || (wayHeight[e.way] ?? 0) > 0) {
      // Настил: низ и боковины, парапеты по краям
      const da = ha - DECK_M, db = hb - DECK_M;
      quad(solid, solidC, CONCRETE, at(La, da), at(Ra, da), at(Rb, db), at(Lb, db));
      // Торец настила, где полотно обрывается
      if (drawnAdj[e.a].length === 1) quad(solid, solidC, CONCRETE, at(La, ha), at(Ra, ha), at(Ra, da), at(La, da));
      if (drawnAdj[e.b].length === 1) quad(solid, solidC, CONCRETE, at(Lb, hb), at(Rb, hb), at(Rb, db), at(Lb, db));
      // Сторона, обращённая к соседу по общему полотну, — без боковины и парапета
      if (!onTop[0][ei] && !joined[0][ei]) quad(solid, solidC, CONCRETE, at(La, ha), at(Lb, hb), at(Lb, db), at(La, da));
      if (!onTop[1][ei] && !joined[1][ei]) quad(solid, solidC, CONCRETE, at(Ra, ha), at(Rb, hb), at(Rb, db), at(Ra, da));
      if (!PATHS.has(tags.highway) || isBridge(tags)) {
        if (!onTop[0][ei] && !joined[0][ei]) quad(solid, solidC, PARAPET, at(La, ha), at(Lb, hb), at(Lb, hb + PARAPET_M), at(La, ha + PARAPET_M));
        if (!onTop[1][ei] && !joined[1][ei]) quad(solid, solidC, PARAPET, at(Ra, ha), at(Rb, hb), at(Rb, hb + PARAPET_M), at(Ra, ha + PARAPET_M));
      }
    } else {
      // Подход на насыпи: подпорные стенки до земли; у железной дороги — откосы 1 : 1,5, насколько позволяет место
      // до соседних путей (остаток высоты — стенка у подножия)
      const rail = isRailTags(tags);
      // Торец насыпи там, где она переходит в мост (под настилом пусто) или лента обрывается над землёй: у дороги —
      // стенка, у железной дороги — откос вперёд по ходу пути (под мост) с клиньями к боковым откосам
      for (const [v, L, R, h, out] of [[e.a, La, Ra, ha, -1], [e.b, Lb, Rb, hb, 1]] as const) {
        if (h <= GROUND_EPS) continue;
        if (drawnAdj[v].length !== 1 && !drawnAdj[v].some((ej) => ej !== ei && isDeck(ej))) continue;
        if (!rail) { quad(solid, solidC, EMBANKMENT, at(L, h), at(R, h), at(R, 0), at(L, 0)); continue; }
        const l = len(e) || 1, dx = (bx - ax) / l * out, dy = (by - ay) / l * out;
        const w = Math.min(h * SLOPE_RUN, freeSide(xs[v], ys[v], dx, dy, e.way, h));
        const z = Math.max(0, h - w / SLOPE_RUN);
        const Lf = [L[0] + dx * w, L[1] + dy * w], Rf = [R[0] + dx * w, R[1] + dy * w];
        quad(solid, solidC, EMBANKMENT, at(L, h), at(R, h), at(Rf, z), at(Lf, z));
        if (z > 0.05) quad(solid, solidC, EMBANKMENT, at(Lf, z), at(Rf, z), at(Rf, 0), at(Lf, 0));
        // Клинья на углах: между торцевым и боковым откосом
        const nx = -dy * out, ny = dx * out; // левая нормаль по ходу a→b
        for (const [P, sgn] of [[L, 1], [R, -1]] as const) {
          const sx = nx * sgn, sy = ny * sgn;
          const ws = Math.min(h * SLOPE_RUN, freeSide(P[0], P[1], sx, sy, e.way, h));
          const side = [P[0] + sx * ws, P[1] + sy * ws], zs = Math.max(0, h - ws / SLOPE_RUN);
          const end = P === L ? Lf : Rf;
          tri(solid, solidC, EMBANKMENT, P[0], P[1], h, side[0], side[1], zs, end[0], end[1], z);
        }
      }
      for (const [k, A, B, sign] of [[0, La, Lb, 1], [1, Ra, Rb, -1]] as const) {
        if (onTop[k][ei] || joined[k][ei]) continue;
        if (!rail) { quad(solid, solidC, EMBANKMENT, at(A, ha), at(B, hb), at(B, 0), at(A, 0)); continue; }
        const l = len(e) || 1, nx = -(by - ay) / l * sign, ny = (bx - ax) / l * sign;
        const foot = (p: number[], h: number) => {
          const w = Math.min(h * SLOPE_RUN, freeSide(p[0], p[1], nx, ny, e.way, h));
          return { p: [p[0] + nx * w, p[1] + ny * w], z: Math.max(0, h - w / SLOPE_RUN) };
        };
        const fa = foot(A, ha), fb = foot(B, hb);
        quad(solid, solidC, EMBANKMENT, at(A, ha), at(B, hb), at(fb.p, fb.z), at(fa.p, fa.z));
        if (fa.z > 0.05 || fb.z > 0.05) quad(solid, solidC, EMBANKMENT, at(fa.p, fa.z), at(fb.p, fb.z), at(fb.p, 0), at(fa.p, 0));
      }
    }
  });

  // Настил в зазоре между лентами общего полотна: от края e (со стороны соседа) до края соседнего пути. Точка на
  // соседе — одна на вершину e и по всему соседнему пути (ближайшая точка его оси), иначе у соседних отрезков края
  // заплатки не совпадают и остаются щели
  const edgesOf = new Map<number, number[]>();
  edges.forEach((e, ei) => { const l = edgesOf.get(e.way); if (l) l.push(ei); else edgesOf.set(e.way, [ei]); });
  const edgeCache = new Map<string, [number, number, number]>();
  /** Край пути fw, обращённый к вершине v: точка и высота. */
  const facing = (v: number, fw: number): [number, number, number] => {
    const key = `${v}:${fw}`;
    const hit = edgeCache.get(key);
    if (hit) return hit;
    const x = xs[v], y = ys[v];
    let best: { d: number; px: number; py: number; h: number; fj: number } | undefined;
    for (const fj of edgesOf.get(fw) ?? []) {
      const f = edges[fj], ex = xs[f.b] - xs[f.a], ey = ys[f.b] - ys[f.a], l2 = ex * ex + ey * ey || 1e-12;
      const u = Math.max(0, Math.min(1, ((x - xs[f.a]) * ex + (y - ys[f.a]) * ey) / l2));
      const px = xs[f.a] + ex * u, py = ys[f.a] + ey * u, d = Math.hypot(px - x, py - y);
      if (!best || d < best.d) best = { d, px, py, h: height[f.a] + (height[f.b] - height[f.a]) * u, fj };
    }
    if (!best) return [x, y, height[v]];
    // От оси соседа назад к вершине — на его полуширину
    const k = best.d ? edgeWidth(best.fj) / 2 / best.d : 0;
    const out: [number, number, number] = [best.px + (x - best.px) * k, best.py + (y - best.py) * k, best.h];
    edgeCache.set(key, out);
    return out;
  };
  for (const { ei, fj, s: sOff } of fillers) {
    const e = edges[ei], f = edges[fj];
    cur = e.way;
    const sign = sOff > 0 ? 1 : -1;
    const [lax, lay] = leftAt(ei, e.a), [lbx, lby] = leftAt(ei, e.b);
    const pa = [xs[e.a] + sign * lax, ys[e.a] + sign * lay, height[e.a]];
    const pb = [xs[e.b] + sign * lbx, ys[e.b] + sign * lby, height[e.b]];
    const qa = facing(e.a, f.way), qb = facing(e.b, f.way);
    const te = ways[e.way].tags, tf = ways[f.way].tags;
    // Между путями — балласт, между тротуарами — их покрытие, иначе асфальт
    const top = isRailTags(te) && isRailTags(tf) ? BALLAST : PATHS.has(te.highway) && PATHS.has(tf.highway) ? PATH_TOP : ASPHALT;
    quad(solid, solidC, top, pa, pb, qb, qa);
    // Между подходами — насыпь до земли, под ней не видно; между мостами — низ настила
    if ((wayHeight[e.way] ?? 0) > 0) quad(solid, solidC, CONCRETE, [pa[0], pa[1], pa[2] - DECK_M], [qa[0], qa[1], qa[2] - DECK_M], [qb[0], qb[1], qb[2] - DECK_M], [pb[0], pb[1], pb[2] - DECK_M]);
  }

  // Разделитель посередине между встречными проезжими частями общего полотна: невысокий бортик по стыку лент
  // (при широком зазоре — по середине настила между ними)
  const isRoad = (wi: number) => !PATHS.has(ways[wi].tags.highway) && !isRailTags(ways[wi].tags);
  edges.forEach((e, ei) => {
    for (const k of [0, 1]) {
      const fj = neighbour[k][ei];
      if (fj < 0) continue;
      const f = edges[fj];
      if (e.way > f.way || !isRoad(e.way) || !isRoad(f.way)) continue;
      const l = len(e) || 1, lf = len(f) || 1;
      if ((xs[e.b] - xs[e.a]) * (xs[f.b] - xs[f.a]) + (ys[e.b] - ys[e.a]) * (ys[f.b] - ys[f.a]) >= 0) continue;
      cur = e.way;
      const sign = k === 0 ? 1 : -1;
      // Поперечное расстояние до оси соседа (по середине e) — стык посередине между краями лент
      const nx = -(ys[e.b] - ys[e.a]) / l, ny = (xs[e.b] - xs[e.a]) / l;
      const mx = (xs[e.a] + xs[e.b]) / 2, my = (ys[e.a] + ys[e.b]) / 2;
      const vx = (xs[f.b] - xs[f.a]) / lf, vy = (ys[f.b] - ys[f.a]) / lf;
      const t = (mx - xs[f.a]) * vx + (my - ys[f.a]) * vy;
      const dist = Math.abs((xs[f.a] + vx * t - mx) * nx + (ys[f.a] + vy * t - my) * ny);
      const we = edgeWidth(ei), wf = edgeWidth(fj);
      const gap = dist - (we + wf) / 2;
      const off = gap < 1 ? dist * we / (we + wf) : we / 2 + gap / 2;
      const [lax, lay] = leftAt(ei, e.a), [lbx, lby] = leftAt(ei, e.b);
      const ka = off / (Math.hypot(lax, lay) || 1), kb = off / (Math.hypot(lbx, lby) || 1);
      const ca = [xs[e.a] + sign * lax * ka, ys[e.a] + sign * lay * ka], cb = [xs[e.b] + sign * lbx * kb, ys[e.b] + sign * lby * kb];
      const ha = height[e.a], hb = height[e.b];
      const hw = DIVIDER_W_M / 2;
      const a1 = [ca[0] + nx * hw, ca[1] + ny * hw], a2 = [ca[0] - nx * hw, ca[1] - ny * hw];
      const b1 = [cb[0] + nx * hw, cb[1] + ny * hw], b2 = [cb[0] - nx * hw, cb[1] - ny * hw];
      quad(solid, solidC, PARAPET, [a1[0], a1[1], ha + DIVIDER_H_M], [b1[0], b1[1], hb + DIVIDER_H_M], [b2[0], b2[1], hb + DIVIDER_H_M], [a2[0], a2[1], ha + DIVIDER_H_M]);
      quad(solid, solidC, PARAPET, [a1[0], a1[1], ha], [b1[0], b1[1], hb], [b1[0], b1[1], hb + DIVIDER_H_M], [a1[0], a1[1], ha + DIVIDER_H_M]);
      quad(solid, solidC, PARAPET, [a2[0], a2[1], ha], [b2[0], b2[1], hb], [b2[0], b2[1], hb + DIVIDER_H_M], [a2[0], a2[1], ha + DIVIDER_H_M]);
    }
  });

  // --- Опоры мостов: равный шаг вдоль каждого моста, подобранный под пути внизу (см. ниже), — опоры не встают
  // на проезжую часть и рельсы, где это возможно
  const pierWays = new Map<number, number[]>();
  edges.forEach((e, ei) => {
    if (!drawn[ei]) return;
    const tags = ways[e.way].tags;
    if (!isBridge(tags) && !((wayHeight[e.way] ?? 0) > 0)) return;
    // Тротуар на общем полотне с проезжей частью держится на её опорах
    if (PATHS.has(tags.highway) && [0, 1].some((k) => neighbour[k][ei] >= 0 && !PATHS.has(ways[edges[neighbour[k][ei]].way].tags.highway))) return;
    const l = pierWays.get(e.way); if (l) l.push(ei); else pierWays.set(e.way, [ei]);
  });
  /** Запас от опоры до края пути внизу: < 0 — задевает. Рельсы — по ширине шпал. */
  const pierClearance = (cx: number, cy: number, nx: number, ny: number, half: number, top: number, wi: number) => {
    // Опора — отрезок поперёк моста (центр ± half по нормали), толщина PIER_THICK_M
    const p: [number, number] = [cx + nx * half, cy + ny * half], q: [number, number] = [cx - nx * half, cy - ny * half];
    let best = Infinity;
    const gx0 = Math.floor((Math.min(p[0], q[0]) - 15) / CELL), gx1 = Math.floor((Math.max(p[0], q[0]) + 15) / CELL);
    const gy0 = Math.floor((Math.min(p[1], q[1]) - 15) / CELL), gy1 = Math.floor((Math.max(p[1], q[1]) + 15) / CELL);
    const seen = new Set<number>();
    for (let gx = gx0; gx <= gx1; gx++) for (let gy = gy0; gy <= gy1; gy++) for (const fj of grid.get(`${gx},${gy}`) ?? []) {
      if (seen.has(fj)) continue;
      seen.add(fj);
      const f = edges[fj];
      if (group[f.way] === group[wi] || Math.max(height[f.a], height[f.b]) > top - 2) continue;
      const tags = ways[f.way].tags;
      const halfF = isRailTags(tags) ? 1.6 : widths[f.way] / 2;
      const d = segmentDistance(p, q, [xs[f.a], ys[f.a]], [xs[f.b], ys[f.b]]) - halfF - PIER_THICK_M / 2 - 0.5;
      best = Math.min(best, d);
    }
    return best;
  };
  for (const [wi, list] of pierWays) {
    // Длина вдоль пути до начала каждого отрезка
    const starts: number[] = [];
    let total = 0;
    for (const ei of list) { starts.push(total); total += len(edges[ei]); }
    const at = (sAlong: number) => {
      let k = 0;
      while (k < list.length - 1 && starts[k + 1] <= sAlong) k++;
      const e = edges[list[k]], l = len(e) || 1, t = Math.max(0, Math.min(1, (sAlong - starts[k]) / l));
      return { ei: list[k], x: xs[e.a] + (xs[e.b] - xs[e.a]) * t, y: ys[e.a] + (ys[e.b] - ys[e.a]) * t, h: height[e.a] + (height[e.b] - height[e.a]) * t, dx: (xs[e.b] - xs[e.a]) / l, dy: (ys[e.b] - ys[e.a]) / l };
    };
    cur = wi;
    // Запас до путей внизу в каждом метре вдоль моста (NaN — полотно слишком низко, опора не нужна)
    const n1 = Math.floor(total) + 1;
    const clr = new Float64Array(n1);
    for (let i = 0; i < n1; i++) {
      const c = at(i);
      clr[i] = c.h - DECK_M < 0.5 ? NaN : pierClearance(c.x, c.y, -c.dy, c.dx, widths[wi] * 0.3, c.h - DECK_M, wi);
    }
    // Шаг (одинаковый в пределах моста) и сдвиг первой опоры — с наименьшим числом опор на путях внизу; при
    // равенстве — шаг ближе к PIER_STEP_M, затем больший наименьший запас
    let best: { step: number; phase: number; bad: number; dev: number; min: number } | undefined;
    for (let step = PIER_STEP_MIN_M; step <= PIER_STEP_MAX_M; step++) {
      for (let phase = 0; phase < step; phase++) {
        let bad = 0, min = Infinity;
        for (let i = phase; i < n1; i += step) {
          if (Number.isNaN(clr[i])) continue;
          if (clr[i] < 0) bad++;
          min = Math.min(min, clr[i]);
        }
        const dev = Math.abs(step - PIER_STEP_M);
        if (!best || bad < best.bad || (bad === best.bad && (dev < best.dev || (dev === best.dev && min > best.min)))) best = { step, phase, bad, dev, min };
      }
    }
    if (!best) continue;
    for (let i = best.phase; i < n1; i += best.step) {
      if (Number.isNaN(clr[i])) continue;
      // Опора на пути внизу — подвинуть на пару метров, если рядом свободнее
      let j = i;
      for (let d = 1; d <= PIER_NUDGE_M && clr[j] < 0; d++) for (const k of [i - d, i + d]) if (k >= 0 && k < n1 && !Number.isNaN(clr[k]) && clr[k] > clr[j]) j = k;
      const c = at(j);
      if (clr[j] >= 0) { pierBox(c.x, c.y, c.dx, c.dy, PIER_THICK_M, widths[wi] * 0.6, c.h - DECK_M); continue; }
      // Всё же на пути внизу (обычно путь идёт вдоль моста под ним) — опора делится на куски по сторонам от пути
      const half = widths[wi] * 0.3, nx = -c.dy, ny = c.dx, STEP = 0.5;
      let run: number | undefined;
      for (let u = -half; u <= half + STEP / 2; u += STEP) {
        const free = u <= half && pierClearance(c.x + nx * u, c.y + ny * u, nx, ny, 0, c.h - DECK_M, wi) >= 0;
        if (free) { run ??= u; continue; }
        if (run !== undefined && u - STEP - run >= 1) {
          const m = (run + u - STEP) / 2;
          pierBox(c.x + nx * m, c.y + ny * m, c.dx, c.dy, PIER_THICK_M, u - STEP - run, c.h - DECK_M);
        }
        run = undefined;
      }
    }
  }

  return {
    solid: { positions: new Float32Array(solid), colors: new Float32Array(solidC), ways: new Int32Array(solidW) },
    glass: { positions: new Float32Array(glass), colors: new Float32Array(glassC), ways: new Int32Array(glassW) },
    ways: usedWays.size,
    cuts,
  };
}

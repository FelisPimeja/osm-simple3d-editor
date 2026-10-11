import { isBridge, isElevated, isTunnel, MinHeap, roadLevel, type RoadWay } from '../osm/roads';
import type { LonLat } from '../osm/model';

/**
 * Объёмные мосты, тоннели и развязки (эксперимент).
 *
 * Высоты. layer — только порядок, а не высота, а пандус обычно тегирован как обычная дорога (layer=0).
 * Поэтому высоту задаём узлам неплоских путей (layer × LEVEL_STEP_M), а по сети дорог от них
 * расходится «конус» с уклоном RAMP_GRADE: подходы сами поднимаются к мосту (или спускаются в тоннель),
 * сколькими бы путями они ни были нарисованы. Затем высоты сглаживаются вдоль линий — без изломов.
 *
 * Профиль. Лента шириной дороги; в узле, где сходятся ровно два отрезка, — общий стык (miter), поэтому
 * собирать пути в цепочки не нужно. У мостов — настил, парапеты и опоры, у пандусов — стенки до земли,
 * тоннели — полупрозрачная коробка (видна сквозь подложку).
 */

/** Высота одного уровня layer, м. */
export const LEVEL_STEP_M = 6;
/** Уклон подходов (5 %). */
const RAMP_GRADE = 0.05;
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
const TUNNEL_CLEARANCE_M = 5;

export interface RoadMeshData {
  /** Непрозрачное: xyz и rgb на вершину, треугольники без индексов. */
  solid: { positions: Float32Array; colors: Float32Array };
  /** Полупрозрачное (тоннели, выемки). */
  glass: { positions: Float32Array; colors: Float32Array };
  /** Сколько путей нарисовано. */
  ways: number;
}

type Rgb = [number, number, number];
const hex = (h: number): Rgb => [(h >> 16 & 255) / 255, (h >> 8 & 255) / 255, (h & 255) / 255];
const ASPHALT = hex(0x6f7378);
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
export function buildRoadMesh(ways: RoadWay[], toLocal: (p: LonLat) => [number, number]): RoadMeshData {
  // --- Граф: узлы OSM общие для путей, промежуточные точки сгущения — свои у каждого отрезка
  const xs: number[] = [], ys: number[] = [];
  const pinSum: number[] = [], pinCount: number[] = [];
  const vertexOf = new Map<number, number>();
  const addVertex = (x: number, y: number) => { xs.push(x); ys.push(y); pinSum.push(0); pinCount.push(0); return xs.length - 1; };
  const edges: Edge[] = [];
  const wayHeight = ways.map((w) => {
    if (!isElevated(w.tags)) return undefined;
    const l = roadLevel(w.tags);
    if (l === 0) return isTunnel(w.tags) ? -LEVEL_STEP_M : LOW_BRIDGE_M;
    return l * LEVEL_STEP_M;
  });
  // Точки сгущения неплоского пути: доля между концами (высота — по концам, когда они известны)
  const between: { v: number; a: number; b: number; t: number }[] = [];
  ways.forEach((w, wi) => {
    const h = wayHeight[wi];
    const ids = w.nodes.map((n, k) => {
      let v = vertexOf.get(n);
      if (v === undefined) { const [x, y] = toLocal(w.coords[k]); vertexOf.set(n, v = addVertex(x, y)); }
      if (h !== undefined) { pinSum[v] += h; pinCount[v]++; }
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
        if (h !== undefined) between.push({ v, a, b, t });
        edges.push({ a: prev, b: v, way: wi });
        prev = v;
      }
      edges.push({ a: prev, b, way: wi });
    }
  });
  const n = xs.length;
  const pinned = new Uint8Array(n);
  const height = new Float64Array(n);
  for (let v = 0; v < n; v++) if (pinCount[v]) { pinned[v] = 1; height[v] = pinSum[v] / pinCount[v]; }
  for (const { v, a, b, t } of between) { pinned[v] = 1; height[v] = height[a] + (height[b] - height[a]) * t; }

  const adj: number[][] = Array.from({ length: n }, () => []);
  edges.forEach((e, i) => { adj[e.a].push(i); adj[e.b].push(i); });
  const other = (e: Edge, v: number) => (e.a === v ? e.b : e.a);
  const len = (e: Edge) => Math.hypot(xs[e.b] - xs[e.a], ys[e.b] - ys[e.a]);

  // --- Конусы: подъём к мостам (max) и спуск к тоннелям (min) по свободным вершинам
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
        const cand = best[v] - RAMP_GRADE * len(edges[ei]);
        if (cand <= best[u]) continue;
        best[u] = cand;
        heap.push(u, -cand);
      }
    }
    return best;
  };
  const up = cone(1), down = cone(-1);
  for (let v = 0; v < n; v++) if (!pinned[v]) height[v] = up[v] - down[v];

  // --- Сглаживание вдоль линий: вершины с двумя соседями, развилки и концы держат свою высоту
  const nb = adj.map((es, v) => (es.length === 2 ? [other(edges[es[0]], v), other(edges[es[1]], v)] : undefined));
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

  /** Смещение к левому краю отрезка в вершине v (по направлению a→b), со стыком, если в v сходятся два отрезка. */
  const leftAt = (ei: number, v: number): [number, number] => {
    const e = edges[ei];
    const half = widths[e.way] / 2;
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

  const solid: number[] = [], solidC: number[] = [];
  const glass: number[] = [], glassC: number[] = [];
  const tri = (out: number[], col: number[], c: Rgb, ...p: number[]) => {
    out.push(...p);
    for (let i = 0; i < p.length / 3; i++) col.push(...c);
  };
  /** Четырёхугольник p0 p1 p2 p3 (по кругу) — два треугольника. */
  const quad = (out: number[], col: number[], c: Rgb, p0: number[], p1: number[], p2: number[], p3: number[]) => {
    tri(out, col, c, ...p0, ...p1, ...p2, ...p0, ...p2, ...p3);
  };

  const usedWays = new Set<number>();
  edges.forEach((e, ei) => {
    if (!drawn[ei]) return;
    usedWays.add(e.way);
    const tags = ways[e.way].tags;
    const [lax, lay] = leftAt(ei, e.a), [lbx, lby] = leftAt(ei, e.b);
    const ax = xs[e.a], ay = ys[e.a], bx = xs[e.b], by = ys[e.b];
    const ha = height[e.a], hb = height[e.b];
    const La = [ax + lax, ay + lay], Ra = [ax - lax, ay - lay], Lb = [bx + lbx, by + lby], Rb = [bx - lbx, by - lby];
    const at = (p: number[], z: number) => [p[0], p[1], z];
    const top = PATHS.has(tags.highway) ? PATH_TOP : ASPHALT;
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
    if (isBridge(tags) || (wayHeight[e.way] ?? 0) > 0) {
      // Настил: низ и боковины, парапеты по краям
      const da = ha - DECK_M, db = hb - DECK_M;
      quad(solid, solidC, CONCRETE, at(La, da), at(Ra, da), at(Rb, db), at(Lb, db));
      quad(solid, solidC, CONCRETE, at(La, ha), at(Lb, hb), at(Lb, db), at(La, da));
      quad(solid, solidC, CONCRETE, at(Ra, ha), at(Rb, hb), at(Rb, db), at(Ra, da));
      if (!PATHS.has(tags.highway) || isBridge(tags)) {
        quad(solid, solidC, PARAPET, at(La, ha), at(Lb, hb), at(Lb, hb + PARAPET_M), at(La, ha + PARAPET_M));
        quad(solid, solidC, PARAPET, at(Ra, ha), at(Rb, hb), at(Rb, hb + PARAPET_M), at(Ra, ha + PARAPET_M));
      }
    } else {
      // Подход на насыпи: подпорные стенки до земли
      quad(solid, solidC, EMBANKMENT, at(La, ha), at(Lb, hb), at(Lb, 0), at(La, 0));
      quad(solid, solidC, EMBANKMENT, at(Ra, ha), at(Rb, hb), at(Rb, 0), at(Ra, 0));
    }
  });

  // --- Опоры мостов: через PIER_STEP_M вдоль каждого моста, от земли до низа настила
  const walked = new Map<number, number>(); // путь → пройдено от последней опоры
  edges.forEach((e, ei) => {
    if (!drawn[ei]) return;
    const tags = ways[e.way].tags;
    if (!isBridge(tags) && !((wayHeight[e.way] ?? 0) > 0)) return;
    const d = (walked.get(e.way) ?? PIER_STEP_M / 2) + len(e);
    if (d < PIER_STEP_M) { walked.set(e.way, d); return; }
    walked.set(e.way, 0);
    const z = height[e.b] - DECK_M;
    if (z < 0.5) return;
    const l = len(e) || 1;
    const tx = (xs[e.b] - xs[e.a]) / l * PIER_THICK_M / 2, ty = (ys[e.b] - ys[e.a]) / l * PIER_THICK_M / 2;
    const half = widths[e.way] * 0.3;
    const nx = -ty / (PIER_THICK_M / 2) * half, ny = tx / (PIER_THICK_M / 2) * half;
    const cx = xs[e.b], cy = ys[e.b];
    const corners = [[cx + tx + nx, cy + ty + ny], [cx - tx + nx, cy - ty + ny], [cx - tx - nx, cy - ty - ny], [cx + tx - nx, cy + ty - ny]];
    for (let i = 0; i < 4; i++) {
      const p = corners[i], q = corners[(i + 1) % 4];
      quad(solid, solidC, CONCRETE, [p[0], p[1], 0], [q[0], q[1], 0], [q[0], q[1], z], [p[0], p[1], z]);
    }
  });

  return {
    solid: { positions: new Float32Array(solid), colors: new Float32Array(solidC) },
    glass: { positions: new Float32Array(glass), colors: new Float32Array(glassC) },
    ways: usedWays.size,
  };
}

import * as THREE from 'three';
import polygonClipping, { type MultiPolygon as ClipMulti, type Polygon as ClipPolygon } from 'polygon-clipping';
import type { LocalPolygon, Pt } from './building-geometry';

/**
 * Оболочка здания из частей: грани части, спрятанные внутри соседних частей (общие стены, низ башни
 * за стеной пристройки, крыша подиума внутри башни), вырезаются. Геометрия 2.5D, поэтому без 3D CSG:
 * - стена (вертикальный треугольник) — в координатах «вдоль стены × высота»: закрыта там, где сразу за ней
 *   (со стороны, противоположной своей части) стоит соседняя — от её низа до её крыши над этим местом;
 * - наклонная или горизонтальная грань — в плане: закрыта там, где она внутри объёма соседней части.
 * Объём части — столбы: след × [низ, верх стен] и по столбу на каждый скат × [верх стен, плоскость ската].
 * Сквозь стекло видно: грань закрывает только непрозрачный сосед (между двумя стеклянными — обе грани прочь).
 */

/** Объём части, которым она закрывает грани соседей. */
export interface ShellSolid {
  polys: LocalPolygon[];
  min: number;
  /** Верх стен: выше — только столбы скатов. */
  wallTop: number;
  /** Треугольники крыши, xyz подряд; вертикальные и лежащие на верху стен отбрасываются. */
  roof: ArrayLike<number>;
  glassWalls: boolean;
  glassRoof: boolean;
}

type Plane = [number, number, number];
type Box = [number, number, number, number];

interface RoofColumn { tri: [Pt, Pt, Pt]; plane: Plane; box: Box; opaque: boolean }
export interface PreparedSolid {
  polys: LocalPolygon[];
  clip: ClipMulti;
  min: number;
  wallTop: number;
  top: number;
  box: Box;
  opaqueWalls: boolean;
  roof: RoofColumn[];
}

/** Сдвиг пробной линии от стены наружу, м: дальше зазора между частями, нарисованными без общих узлов. */
const PROBE = 0.05;
/** Наклонные/горизонтальные грани закрыты, только если они внутри соседа глубже этого, м (совпадающие — не трогаем). */
const FACE_EPS = 0.02;
/** Меньше этой площади кусок не в счёт, м². */
const MIN_AREA = 1e-4;
/**
 * Больше стольких закрытых кусков у грани — без точного вычитания: polygon-clipping на сотне почти совпадающих
 * кусков (скат внутри скатов наложенных частей) считает секунды и даже не возвращается. Тогда грань убираем
 * целиком, если закрыты все её пробные точки, иначе оставляем.
 */
const SNAP = 1e6;
const MAX_PIECES = 24;

export function prepareSolid(s: ShellSolid): PreparedSolid {
  const box: Box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of s.polys) for (const [x, y] of p.outer) grow(box, x, y);
  const roof: RoofColumn[] = [];
  let top = s.wallTop;
  for (let o = 0; o + 9 <= s.roof.length; o += 9) {
    const r = s.roof;
    const x0 = r[o], y0 = r[o + 1], z0 = r[o + 2], x1 = r[o + 3], y1 = r[o + 4], z1 = r[o + 5], x2 = r[o + 6], y2 = r[o + 7], z2 = r[o + 8];
    const plane = planeOf(x0, y0, z0, x1, y1, z1, x2, y2, z2);
    if (!plane) continue;
    if (Math.max(z0, z1, z2) <= s.wallTop + 1e-3) continue; // плоская крыша — это верх столба стен
    top = Math.max(top, z0, z1, z2);
    const b: Box = [Infinity, Infinity, -Infinity, -Infinity];
    grow(b, x0, y0); grow(b, x1, y1); grow(b, x2, y2);
    roof.push({ tri: [[x0, y0], [x1, y1], [x2, y2]], plane, box: b, opaque: !s.glassRoof });
  }
  return { polys: s.polys, clip: snap(toClip(s.polys)), min: s.min, wallTop: s.wallTop, top, box, opaqueWalls: !s.glassWalls, roof };
}

/**
 * Треугольники pos[from, to) (номера вершин) без закрытых соседями участков. ownPolys — контур своей части
 * (по нему видно, с какой стороны стены своя часть); glass — грани стеклянные; others — объёмы остальных частей;
 * flat — объект нулевой толщины (плоский след): закрыт и лёжа на дне соседа.
 */
export function trimTriangles(pos: ArrayLike<number>, from: number, to: number, ownPolys: LocalPolygon[], glass: boolean, others: PreparedSolid[], flat = false, deadline = Infinity): number[] {
  const out: number[] = [];
  for (let v = from; v + 3 <= to; v += 3) {
    const o = v * 3;
    // Время вышло — остальные грани как есть (здание с сотнями частей не должно вешать вкладку)
    if (performance.now() > deadline) { for (let i = o; i < to * 3; i++) out.push(pos[i]); break; }
    const a: V3 = [pos[o], pos[o + 1], pos[o + 2]], b: V3 = [pos[o + 3], pos[o + 4], pos[o + 5]], c: V3 = [pos[o + 6], pos[o + 7], pos[o + 8]];
    const n = normal(a, b, c);
    const len = Math.hypot(n[0], n[1], n[2]);
    let pieces: V3[][] | undefined;
    if (len > 1e-12) {
      const near = nearby(others, a, b, c);
      if (near.length) {
        try {
          pieces = Math.abs(n[2]) < 1e-6 * len ? trimWall(a, b, c, ownPolys, glass, near) : trimFace(a, b, c, glass, near, flat);
        } catch {
          pieces = undefined; // вырожденная геометрия — грань как есть
        }
      }
    }
    if (!pieces) { out.push(...a, ...b, ...c); continue; }
    for (const [p, q, r] of pieces) {
      // Ориентация — как у исходного треугольника
      const m = normal(p, q, r);
      if (m[0] * n[0] + m[1] * n[1] + m[2] * n[2] < 0) out.push(...p, ...r, ...q);
      else out.push(...p, ...q, ...r);
    }
  }
  return out;
}

type V3 = [number, number, number];

/** Стеклянные стены без совпадающих граней indoor-плана: у этих стен нет объёма для trimTriangles. */
type Blocker = { vs: V3[]; box: Box; min: number; max: number };
/** Подготовленные стены (без дублей сторон, с сеткой по плану): один массив стен приходит для каждой стеклянной части. */
const preparedWalls = new WeakMap<object, { blockers: Blocker[]; grid: Map<number, number[]> }>();
const WALL_CELL = 4;
const wallCell = (x: number, y: number) => (x + 32768) * 65536 + (y + 32768);

function prepareWalls(walls: ArrayLike<number>) {
  const hit = typeof walls === 'object' ? preparedWalls.get(walls) : undefined;
  if (hit) return hit;
  const blockers: Blocker[] = [];
  const seen = new Set<string>();
  for (let i = 0; i + 8 < walls.length; i += 9) {
    const vs: V3[] = [[walls[i], walls[i + 1], walls[i + 2]], [walls[i + 3], walls[i + 4], walls[i + 5]], [walls[i + 6], walls[i + 7], walls[i + 8]]];
    const n = normal(vs[0], vs[1], vs[2]), len = Math.hypot(...n);
    if (len < MIN_AREA || Math.abs(n[2]) > len * 1e-6) continue;
    // drawPlan строит обе стороны стены — для вычитания это одна поверхность.
    const key = vs.map((v) => v.map((c) => Math.round(c * SNAP)).join(',')).sort().join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    blockers.push({ vs, box: [Math.min(...vs.map((v) => v[0])), Math.min(...vs.map((v) => v[1])), Math.max(...vs.map((v) => v[0])), Math.max(...vs.map((v) => v[1]))],
      min: Math.min(...vs.map((v) => v[2])), max: Math.max(...vs.map((v) => v[2])) });
  }
  // Сетка по плану: стен на этаж (и этажах под вторым светом) — десятки тысяч, перебирать все на каждую грань долго
  const grid = new Map<number, number[]>();
  blockers.forEach((w, k) => {
    for (let x = Math.floor((w.box[0] - FACE_EPS) / WALL_CELL); x <= Math.floor((w.box[2] + FACE_EPS) / WALL_CELL); x++)
      for (let y = Math.floor((w.box[1] - FACE_EPS) / WALL_CELL); y <= Math.floor((w.box[3] + FACE_EPS) / WALL_CELL); y++)
        (grid.get(wallCell(x, y)) ?? grid.set(wallCell(x, y), []).get(wallCell(x, y))!).push(k);
  });
  const out = { blockers, grid };
  if (typeof walls === 'object') preparedWalls.set(walls, out);
  return out;
}

export function trimCoplanarWalls(pos: ArrayLike<number>, walls: ArrayLike<number>): number[] {
  const { blockers, grid } = prepareWalls(walls);
  const CELL = WALL_CELL, key = wallCell;
  const stamp = new Int32Array(blockers.length).fill(-1);
  const out: number[] = [];
  for (let i = 0; i + 8 < pos.length; i += 9) {
    const a: V3 = [pos[i], pos[i + 1], pos[i + 2]], b: V3 = [pos[i + 3], pos[i + 4], pos[i + 5]], c: V3 = [pos[i + 6], pos[i + 7], pos[i + 8]];
    const n = normal(a, b, c), len = Math.hypot(...n);
    if (len < MIN_AREA || Math.abs(n[2]) > len * 1e-6) { out.push(...a, ...b, ...c); continue; }
    const nx = n[0] / len, ny = n[1] / len, ux = -ny, uy = nx;
    const project = (v: V3): Pt => [(v[0] - a[0]) * ux + (v[1] - a[1]) * uy, v[2]];
    // Float32 фасада и double стен отличаются на микроны. В стыках плит и стен используем сетку 0.1 мм:
    // микронная сетка оставляет почти совпадающие пересечения, на которых polygon-clipping не собирает кольцо.
    const tri = [a, b, c].map((v) => project(v).map((c) => Math.round(c * 1e4) / 1e4) as Pt);
    const box: Box = [Math.min(a[0], b[0], c[0]), Math.min(a[1], b[1], c[1]), Math.max(a[0], b[0], c[0]), Math.max(a[1], b[1], c[1])];
    const z0 = Math.min(a[2], b[2], c[2]), z1 = Math.max(a[2], b[2], c[2]);
    const covered: ClipPolygon[] = [];
    let pieces: V3[][] | undefined;
    try {
      const near: Blocker[] = [];
      for (let x = Math.floor(box[0] / CELL); x <= Math.floor(box[2] / CELL); x++)
        for (let y = Math.floor(box[1] / CELL); y <= Math.floor(box[3] / CELL); y++)
          for (const k of grid.get(key(x, y)) ?? []) if (stamp[k] !== i) { stamp[k] = i; near.push(blockers[k]); }
      for (const wall of near) {
        if (wall.box[0] > box[2] + FACE_EPS || wall.box[2] < box[0] - FACE_EPS || wall.box[1] > box[3] + FACE_EPS || wall.box[3] < box[1] - FACE_EPS || wall.min >= z1 || wall.max <= z0) continue;
        if (!wall.vs.every((v) => Math.abs((v[0] - a[0]) * nx + (v[1] - a[1]) * ny) <= FACE_EPS)) continue;
        const intersection = polygonClipping.intersection(snapAt([ring(tri)], 1e4), snapAt([ring(wall.vs.map(project))], 1e4));
        for (const p of intersection) if (multiArea([p]) >= MIN_AREA) covered.push(p);
      }
      if (covered.length) {
        const hidden = polygonClipping.union(snapAt(covered[0], 1e4), ...covered.slice(1).map((p) => snapAt(p, 1e4)));
        pieces = rest(tri, hidden, ([s, z]) => [a[0] + ux * s, a[1] + uy * s, z]);
      }
    } catch { /* вырожденный стык — сохраняем исходную грань */ }
    if (!pieces) { out.push(...a, ...b, ...c); continue; }
    for (const [p, q, r] of pieces) {
      const m = normal(p, q, r);
      if (m[0] * n[0] + m[1] * n[1] + m[2] * n[2] < 0) out.push(...p, ...r, ...q);
      else out.push(...p, ...q, ...r);
    }
  }
  return out;
}

function nearby(solids: PreparedSolid[], a: V3, b: V3, c: V3): PreparedSolid[] {
  const x0 = Math.min(a[0], b[0], c[0]) - PROBE, x1 = Math.max(a[0], b[0], c[0]) + PROBE;
  const y0 = Math.min(a[1], b[1], c[1]) - PROBE, y1 = Math.max(a[1], b[1], c[1]) + PROBE;
  const z0 = Math.min(a[2], b[2], c[2]), z1 = Math.max(a[2], b[2], c[2]);
  return solids.filter((s) => s.box[0] <= x1 && s.box[2] >= x0 && s.box[1] <= y1 && s.box[3] >= y0 && s.min < z1 && s.top > z0);
}

/**
 * Стена: координаты (s — метры вдоль стены от a, z). Закрытые куски — участки стены, за которыми (со стороны,
 * где нет своей части) столб соседа. Если своя часть ни с одной стороны (внутренняя вертикальная грань) —
 * закрыто там, где соседи с обеих сторон.
 */
function trimWall(a: V3, b: V3, c: V3, ownPolys: LocalPolygon[], glass: boolean, near: PreparedSolid[]): V3[][] | undefined {
  // Линия стены — по самой длинной горизонтальной паре вершин
  const vs = [a, b, c];
  let p = a, q = b, best = -1;
  for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) {
    const d = Math.hypot(vs[i][0] - vs[j][0], vs[i][1] - vs[j][1]);
    if (d > best) { best = d; p = vs[i]; q = vs[j]; }
  }
  const len = best;
  if (len < 1e-3) return;
  const ux = (q[0] - p[0]) / len, uy = (q[1] - p[1]) / len;
  const tri: Pt[] = vs.map((v) => [(v[0] - p[0]) * ux + (v[1] - p[1]) * uy, v[2]]);
  const mx = (a[0] + b[0] + c[0]) / 3, my = (a[1] + b[1] + c[1]) / 3;
  const sides = [1, -1].filter((sg) => !insidePolys(ownPolys, mx - uy * PROBE * sg, my + ux * PROBE * sg));
  if (!sides.length) return;
  let hidden: ClipMulti | undefined;
  const box: Box = [Math.min(p[0], q[0]) - PROBE, Math.min(p[1], q[1]) - PROBE, Math.max(p[0], q[0]) + PROBE, Math.max(p[1], q[1]) + PROBE];
  for (const sg of sides) {
    const line: WallLine = { ax: p[0], ay: p[1], ux, uy, nx: -uy * sg, ny: ux * sg, len };
    const side: ClipPolygon[] = [];
    for (const s of near) {
      if (s.opaqueWalls || glass) {
        for (const [t0, t1] of coveredAlong(line, s.polys.flatMap((poly) => [poly.outer, ...poly.inners]), (x, y) => insidePolys(s.polys, x, y))) {
          const piece = clipAll(tri, [(v) => v[0] - t0 * len, (v) => t1 * len - v[0], (v) => v[1] - s.min, (v) => s.wallTop - v[1]]);
          if (piece) side.push([ring(piece)]);
        }
      }
      for (const r of s.roof) {
        if (!(r.opaque || glass) || r.box[0] > box[2] || r.box[2] < box[0] || r.box[1] > box[3] || r.box[3] < box[1]) continue;
        const inTri = triangleHalfPlanes(r.tri);
        // Плоскость ската над стеной: z = c0 + c1·s
        const c0 = r.plane[0] * p[0] + r.plane[1] * p[1] + r.plane[2], c1 = r.plane[0] * ux + r.plane[1] * uy;
        for (const [t0, t1] of coveredAlong(line, [r.tri], (x, y) => inTri.every((g) => g([x, y]) > 0))) {
          const piece = clipAll(tri, [(v) => v[0] - t0 * len, (v) => t1 * len - v[0], (v) => v[1] - s.wallTop, (v) => c0 + c1 * v[0] - v[1]]);
          if (piece) side.push([ring(piece)]);
        }
      }
    }
    if (!side.length) return; // с одной из сторон ничего — стену видно целиком
    // У стены куски — полосы по длине стены, почти не перекрываются: их объединять дёшево, предел выше
    let use = side;
    if (side.length > MAX_PIECES * 3) {
      if (coarse(tri, side)) continue; // с этой стороны закрыто целиком
      use = largest(side, MAX_PIECES / 2);
    }
    const u = polygonClipping.union(snap(use[0]), ...use.slice(1).map(snap));
    hidden = hidden ? polygonClipping.intersection(snap(hidden), snap(u)) : u;
    if (!hidden.length) return;
  }
  if (!hidden) return []; // закрыто целиком со всех сторон
  const lift = ([s, z]: Pt): V3 => [p[0] + ux * s, p[1] + uy * s, z];
  return rest(tri, hidden, lift);
}

/** Наклонная или горизонтальная грань: в плане, z — по её плоскости. */
function trimFace(a: V3, b: V3, c: V3, glass: boolean, near: PreparedSolid[], flat: boolean): V3[][] | undefined {
  // Плоский след на полу соседа (навес без высоты, голый контур) — внутри него, а не на его дне
  const floor = flat ? -FACE_EPS : FACE_EPS;
  const plane = planeOf(...a, ...b, ...c);
  if (!plane) return;
  const zf = (v: Pt) => plane[0] * v[0] + plane[1] * v[1] + plane[2];
  const tri: Pt[] = [[a[0], a[1]], [b[0], b[1]], [c[0], c[1]]];
  const tb: Box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of tri) grow(tb, x, y);
  const hidden: ClipPolygon[] = [];
  for (const s of near) {
    if (s.opaqueWalls || glass) {
      const piece = clipAll(tri, [(v) => zf(v) - s.min - floor, (v) => s.wallTop - FACE_EPS - zf(v)]);
      if (piece) {
        // Контур соседа не заходит внутрь куска (соседние части касаются по общему ребру) — кусок целиком
        // внутри или снаружи соседа: решает одна точка, без polygon-clipping
        if (!ringsEnter(s.polys, piece)) {
          const cx = piece.reduce((t, v) => t + v[0], 0) / piece.length, cy = piece.reduce((t, v) => t + v[1], 0) / piece.length;
          if (insidePolys(s.polys, cx, cy)) hidden.push(snap([ring(piece)]));
        } else for (const poly of polygonClipping.intersection(snap([ring(piece)]), s.clip)) hidden.push(poly);
      }
    }
    for (const r of s.roof) {
      if (!(r.opaque || glass) || r.box[0] > tb[2] || r.box[2] < tb[0] || r.box[1] > tb[3] || r.box[3] < tb[1]) continue;
      const pl = r.plane;
      const piece = clipAll(tri, [...triangleHalfPlanes(r.tri), (v) => zf(v) - s.wallTop - FACE_EPS, (v) => pl[0] * v[0] + pl[1] * v[1] + pl[2] - FACE_EPS - zf(v)]);
      if (piece) hidden.push([ring(piece)]);
    }
  }
  if (!hidden.length) return;
  // Скат в гуще чужих скатов (купола, главки): точно — долго, а такие грани выше плана этажа
  if (hidden.length > MAX_PIECES) return coarse(tri, hidden) ? [] : undefined;
  return rest(tri, polygonClipping.union(snap(hidden[0]), ...hidden.slice(1).map(snap)), (v) => [v[0], v[1], zf(v)]);
}

/**
 * Самые крупные n кусков. Объединять сотню мелких полос (скаты соседних крыш у длинной стены) — долго, а без них
 * закрыто чуть меньше, но не больше, чем на самом деле: низ стены внутри основания всё равно уходит.
 */
function largest(pieces: ClipPolygon[], n: number): ClipPolygon[] {
  return pieces.map((p) => ({ p, a: Math.abs(signedArea(p[0] as Pt[])) })).sort((x, y) => y.a - x.a).slice(0, n).map((x) => x.p);
}

/** Закрыт ли треугольник кусками целиком — по пробным точкам: центр и точки у вершин и середин сторон. */
function coarse(tri: Pt[], pieces: ClipPolygon[]): boolean {
  const cx = (tri[0][0] + tri[1][0] + tri[2][0]) / 3, cy = (tri[0][1] + tri[1][1] + tri[2][1]) / 3;
  const probes: Pt[] = [[cx, cy]];
  for (let i = 0; i < 3; i++) {
    const [x, y] = tri[i], [x2, y2] = tri[(i + 1) % 3];
    probes.push([x + (cx - x) * 0.05, y + (cy - y) * 0.05], [(x + x2) / 2 + (cx - (x + x2) / 2) * 0.05, (y + y2) / 2 + (cy - (y + y2) / 2) * 0.05]);
  }
  return probes.every(([x, y]) => pieces.some((poly) => inRing(poly[0] as Pt[], x, y) && !poly.slice(1).some((r) => inRing(r as Pt[], x, y))));
}

/** Треугольник tri без hidden, триангулированный и поднятый в 3D; undefined — ничего не закрыто. */
function rest(tri: Pt[], hidden: ClipMulti, lift: (v: Pt) => V3): V3[][] | undefined {
  const hiddenArea = multiArea(hidden);
  if (hiddenArea < MIN_AREA) return;
  if (hiddenArea >= Math.abs(signedArea(tri)) - MIN_AREA) return []; // закрыт целиком
  const visible = polygonClipping.difference(snap([ring(tri)]), snap(hidden));
  const out: V3[][] = [];
  for (const poly of visible) {
    if (multiArea([poly]) < MIN_AREA) continue;
    const contour = poly[0].slice(0, -1).map(([x, y]) => new THREE.Vector2(x, y));
    const holes = poly.slice(1).map((r) => r.slice(0, -1).map(([x, y]) => new THREE.Vector2(x, y)));
    const all = [contour, ...holes].flat();
    for (const [i, j, k] of THREE.ShapeUtils.triangulateShape(contour, holes)) {
      const t = [all[i], all[j], all[k]];
      // Вырожденные треугольники не нужны: у них нет площади, а рёбра рисуются чёрточками
      if (Math.abs((t[1].x - t[0].x) * (t[2].y - t[0].y) - (t[2].x - t[0].x) * (t[1].y - t[0].y)) < MIN_AREA) continue;
      out.push(t.map((v) => lift([v.x, v.y])));
    }
  }
  return out;
}

/**
 * Координаты на сетку в микрон. На вершинах, различающихся в последних знаках double (клинья у стыков стен),
 * polygon-clipping зацикливается внутри одного вызова; после округления те же входы считаются за миллисекунды.
 */
function snap<T extends ClipPolygon | ClipMulti>(g: T): T {
  return snapAt(g, SNAP);
}

function snapAt<T extends ClipPolygon | ClipMulti>(g: T, precision: number): T {
  const r = (v: number) => Math.round(v * precision) / precision;
  const deep = (x: unknown): unknown => (typeof x === 'number' ? r(x) : (x as unknown[]).map(deep));
  return deep(g) as T;
}

/** Выпуклый многоугольник, обрезанный условиями g(v) ≥ 0; undefined — пусто или меньше MIN_AREA. */
function clipAll(poly: Pt[], conds: ((v: Pt) => number)[]): Pt[] | undefined {
  let cur = poly;
  for (const g of conds) {
    const next: Pt[] = [];
    for (let i = 0; i < cur.length; i++) {
      const v = cur[i], w = cur[(i + 1) % cur.length], gv = g(v), gw = g(w);
      if (gv >= 0) next.push(v);
      if ((gv >= 0) !== (gw >= 0)) {
        const t = gv / (gv - gw);
        next.push([v[0] + (w[0] - v[0]) * t, v[1] + (w[1] - v[1]) * t]);
      }
    }
    cur = next;
    if (cur.length < 3) return;
  }
  return Math.abs(signedArea(cur)) < MIN_AREA ? undefined : cur;
}

/** Условия «внутри треугольника» для clipAll. */
function triangleHalfPlanes(t: [Pt, Pt, Pt]): ((v: Pt) => number)[] {
  const o = Math.sign(signedArea(t)) || 1;
  return [0, 1, 2].map((i) => {
    const p = t[i], q = t[(i + 1) % 3];
    return (v: Pt) => o * ((q[0] - p[0]) * (v[1] - p[1]) - (q[1] - p[1]) * (v[0] - p[0]));
  });
}

interface WallLine { ax: number; ay: number; ux: number; uy: number; nx: number; ny: number; len: number }

/** Ближе этого (м) к линии стены вершина соседа — на стене (общий узел или зазор между частями без общих узлов). */
const ON_LINE = PROBE;

/**
 * Участки [t0, t1] стены (t от 0 до 1), за которыми (в сторону n) область inside с контурами rings. Точки
 * раздела — по самой стене: пересечения с краями области и проекции её вершин, лежащих на стене (общие узлы,
 * общие стены), — а не по сдвинутой линии: у конца стены она выходит из соседа раньше, и остаются полоски.
 * Сторону каждого участка проверяем точкой чуть в сторону n от его середины.
 */
function coveredAlong(l: WallLine, rings: Pt[][], inside: (x: number, y: number) => boolean): [number, number][] {
  const ts = [0, 1];
  const dist = (x: number, y: number) => (x - l.ax) * l.nx + (y - l.ay) * l.ny;
  const along = (x: number, y: number) => ((x - l.ax) * l.ux + (y - l.ay) * l.uy) / l.len;
  for (const r of rings) {
    for (let i = 0; i < r.length; i++) {
      const [px, py] = r[i], [qx, qy] = r[(i + 1) % r.length];
      const dp = dist(px, py), dq = dist(qx, qy);
      if (Math.abs(dp) <= ON_LINE) ts.push(along(px, py));
      if (Math.abs(dp) <= ON_LINE || Math.abs(dq) <= ON_LINE || (dp > 0) === (dq > 0)) continue;
      ts.push(along(px + (qx - px) * dp / (dp - dq), py + (qy - py) * dp / (dp - dq)));
    }
  }
  // Общий узел почти на конце стены — ровно на конце: иначе остаётся полоска в доли миллиметра,
  // а на почти совпадающих контурах polygon-clipping ошибается
  const snap = 1e-3 / l.len;
  const cuts = ts.map((t) => (Math.abs(t) < snap ? 0 : Math.abs(1 - t) < snap ? 1 : t)).filter((t) => t >= 0 && t <= 1).sort((x, y) => x - y);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const t0 = cuts[i], t1 = cuts[i + 1];
    if ((t1 - t0) * l.len < 1e-4) continue;
    const tm = (t0 + t1) / 2, e = Math.min(PROBE, (t1 - t0) * l.len / 4);
    if (!inside(l.ax + l.ux * tm * l.len + l.nx * e, l.ay + l.uy * tm * l.len + l.ny * e)) continue;
    const last = out[out.length - 1];
    if (last && t0 - last[1] < 1e-9) last[1] = t1;
    else out.push([t0, t1]);
  }
  return out;
}

/** Отступ от краёв куска для ringsEnter, м: ребро, идущее по краю куска (общий контур), внутрь не заходит. */
const ENTER_EPS = 1e-4;

/** Заходит ли какое-нибудь ребро контуров polys внутрь выпуклого многоугольника piece (сжатого на ENTER_EPS). */
function ringsEnter(polys: LocalPolygon[], piece: Pt[]): boolean {
  const o = Math.sign(signedArea(piece)) || 1;
  // Полуплоскости куска: расстояние до ребра внутрь минус отступ
  const hp = piece.map((p, i) => {
    const q = piece[(i + 1) % piece.length];
    const l = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
    return { p, nx: -o * (q[1] - p[1]) / l, ny: o * (q[0] - p[0]) / l };
  });
  const b: Box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of piece) grow(b, x, y);
  for (const poly of polys) for (const r of [poly.outer, ...poly.inners]) {
    for (let i = 0; i < r.length; i++) {
      const a = r[i], c = r[(i + 1) % r.length];
      if (Math.max(a[0], c[0]) < b[0] || Math.min(a[0], c[0]) > b[2] || Math.max(a[1], c[1]) < b[1] || Math.min(a[1], c[1]) > b[3]) continue;
      // Отрезок a→c, обрезанный полуплоскостями (Кирус — Бек)
      let t0 = 0, t1 = 1;
      for (const h of hp) {
        const da = (a[0] - h.p[0]) * h.nx + (a[1] - h.p[1]) * h.ny - ENTER_EPS;
        const dc = (c[0] - h.p[0]) * h.nx + (c[1] - h.p[1]) * h.ny - ENTER_EPS;
        if (da < 0 && dc < 0) { t1 = -1; break; }
        if (da < 0) t0 = Math.max(t0, da / (da - dc));
        else if (dc < 0) t1 = Math.min(t1, da / (da - dc));
        if (t0 >= t1) break;
      }
      if (t1 - t0 > 1e-9) return true;
    }
  }
  return false;
}

function insidePolys(polys: LocalPolygon[], x: number, y: number): boolean {
  return polys.some((p) => inRing(p.outer, x, y) && !p.inners.some((r) => inRing(r, x, y)));
}

function inRing(ring: Pt[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Плоскость z = a·x + b·y + c через три точки; undefined — вертикальная. */
function planeOf(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, x2: number, y2: number, z2: number): Plane | undefined {
  const d = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
  if (Math.abs(d) < 1e-9) return;
  const a = ((z1 - z0) * (y2 - y0) - (z2 - z0) * (y1 - y0)) / d;
  const b = ((x1 - x0) * (z2 - z0) - (x2 - x0) * (z1 - z0)) / d;
  return [a, b, z0 - a * x0 - b * y0];
}

function normal(a: V3, b: V3, c: V3): V3 {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
}

function grow(b: Box, x: number, y: number) {
  b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y);
}

const ring = (pts: Pt[]): [number, number][] => [...pts, pts[0]];

const toClip = (polys: LocalPolygon[]): ClipMulti => polys.map((p) => [p.outer, ...p.inners].map(ring));

function signedArea(r: Pt[] | [number, number][]): number {
  let s = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]);
  return s / 2;
}

function multiArea(m: ClipMulti): number {
  return m.reduce((sum, poly) => sum + Math.abs(signedArea(poly[0])) - poly.slice(1).reduce((t, r) => t + Math.abs(signedArea(r)), 0), 0);
}

/** Треугольники pos[from, to) (номера вершин), обрезанные снизу плоскостью z = zMin (висящая часть без min_height). */
export function clipAbove(pos: ArrayLike<number>, from: number, to: number, zMin: number): number[] {
  const out: number[] = [];
  for (let o = from * 3; o + 9 <= to * 3; o += 9) {
    const vs: V3[] = [[pos[o], pos[o + 1], pos[o + 2]], [pos[o + 3], pos[o + 4], pos[o + 5]], [pos[o + 6], pos[o + 7], pos[o + 8]]];
    if (vs.every((v) => v[2] >= zMin)) { for (const v of vs) out.push(...v); continue; }
    const poly: V3[] = [];
    for (let i = 0; i < 3; i++) {
      const v = vs[i], w = vs[(i + 1) % 3];
      if (v[2] >= zMin) poly.push(v);
      if ((v[2] >= zMin) !== (w[2] >= zMin)) {
        const t = (zMin - v[2]) / (w[2] - v[2]);
        poly.push([v[0] + (w[0] - v[0]) * t, v[1] + (w[1] - v[1]) * t, zMin]);
      }
    }
    for (let i = 1; i + 1 < poly.length; i++) out.push(...poly[0], ...poly[i], ...poly[i + 1]);
  }
  return out;
}

/**
 * Сечение оболочки на высоте h (в плане): объединение столбов частей, через которые проходит h. Ниже верха стен —
 * весь след части; выше — та часть каждого ската, что выше h (под скатом сечение уже следа: мансарда, купол).
 * Стекло не в счёт: прозрачность — свойство отрисовки, а не объёма.
 */
export function sectionOf(solids: Iterable<PreparedSolid>, h: number): ClipMulti {
  const pieces: ClipMulti = [];
  for (const s of solids) {
    if (h < s.min - 1e-6 || h > s.top + 1e-6) continue;
    if (h < s.wallTop) { pieces.push(...s.clip); continue; }
    for (const { tri, plane: [a, b, c] } of s.roof) {
      // Треугольник ската, отсечённый полуплоскостью a·x + b·y + c ≥ h
      const out: Pt[] = [];
      for (let i = 0; i < 3; i++) {
        const p = tri[i], q = tri[(i + 1) % 3];
        const dp = a * p[0] + b * p[1] + c - h, dq = a * q[0] + b * q[1] + c - h;
        if (dp >= 0) out.push(p);
        if ((dp >= 0) !== (dq >= 0)) { const t = dp / (dp - dq); out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]); }
      }
      if (out.length >= 3 && Math.abs(out.reduce((acc, p, i) => { const q = out[(i + 1) % out.length]; return acc + p[0] * q[1] - q[0] * p[1]; }, 0)) > 2 * MIN_AREA) pieces.push([[...out, out[0]]]);
    }
  }
  if (!pieces.length) return [];
  const sn = snap(pieces);
  try { return polygonClipping.union(sn[0], ...sn.slice(1)); } catch (err) { console.warn('[section] сечение не построено', err); return []; }
}

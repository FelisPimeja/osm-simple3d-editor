import * as THREE from 'three';
import type { Heights } from '../osm/heights';
import { skeletonOf, type Skeleton } from './skeleton';

/** Локальная точка в метрах: x — восток, y — север. */
export type Pt = [number, number];
export interface LocalPolygon { outer: Pt[]; inners: Pt[][] }

type V3 = [number, number, number];

/** Треугольники стен и крыши, плоские массивы xyz. */
export interface BuildingTriangles {
  walls: number[];
  roof: number[];
  /** Форма крыши не поддерживается для этой геометрии и заменена плоской. */
  roofApproximated: boolean;
  /** Скелет ещё считается в воркере — крыша временно упрощённая, здание надо будет пересобрать. */
  pending?: boolean;
}

const SUPPORTED_ANY_POLYGON = new Set(['flat', 'pyramidal', 'dome', 'onion', 'skillion']);
const SUPPORTED_QUAD = new Set(['gabled', 'hipped']);
/** Крыши по straight skeleton на контурах любой формы (gabled/hipped на четырёхугольниках — свой код). */
const SKELETON_SHAPES = new Set(['gabled', 'hipped', 'round', 'gambrel', 'mansard', 'half-hipped', 'saltbox']);
/** Формы, которые на почти прямоугольных контурах строятся вдоль оси описанного прямоугольника. */
const AXIS_SHAPES = new Set(['gabled', 'round', 'gambrel', 'half-hipped', 'saltbox']);

export function buildTriangles(polygons: LocalPolygon[], h: Heights, tags: Record<string, string>): BuildingTriangles {
  const walls: number[] = [];
  const roof: number[] = [];

  const shape = h.roofShape;
  const single = polygons.length === 1 && polygons[0].inners.length === 0 ? polygons[0] : undefined;
  const quadRoof = single && single.outer.length === 4 && SUPPORTED_QUAD.has(shape) && shape !== 'gabled';
  // Двускатная и сводчатая на почти прямоугольных контурах — вдоль оси описанного прямоугольника (учитывает roof:orientation)
  const axis = single && AXIS_SHAPES.has(shape) ? rectAxis(single.outer) : undefined;
  // Скатные крыши на остальных контурах (в т.ч. с дырами и из нескольких полигонов) — по straight skeleton
  const skeletons = !quadRoof && !axis && SKELETON_SHAPES.has(shape) ? polygons.map((p) => skeletonOf(p.outer, p.inners)) : undefined;
  const pending = !!skeletons?.some((sk) => sk === 'pending');
  const skeletonRoof = !!skeletons?.length && skeletons.every((sk) => sk && sk !== 'pending');
  const supported =
    shape === 'flat' ||
    (shape === 'skillion' && polygons.length === 1) ||
    (single && SUPPORTED_ANY_POLYGON.has(shape)) ||
    quadRoof ||
    !!axis ||
    skeletonRoof;
  // Неподдерживаемая крыша: стены до самого верха и плоская крыша
  const wallTop = supported ? h.wallTop : h.top;

  if (supported && shape === 'skillion') {
    addSkillion(walls, roof, polygons[0], h, tags['roof:direction']);
    return { walls, roof, roofApproximated: false };
  }

  for (const p of polygons) {
    for (const ring of [p.outer, ...p.inners]) addWalls(walls, ring, h.min, wallTop);
  }

  if (!supported || shape === 'flat') {
    for (const p of polygons) addFlat(roof, p, wallTop);
  } else if (shape === 'pyramidal') {
    addPyramid(roof, single!.outer, h.wallTop, h.top);
  } else if (shape === 'dome' || shape === 'onion') {
    addDome(roof, single!.outer, h.wallTop, h.top, shape === 'onion');
  } else if (axis && shape === 'saltbox') {
    addSaltboxRoof(roof, walls, single!.outer, axis, h.wallTop, h.roofHeight, tags['roof:orientation'] === 'across', tags['roof:direction']);
  } else if (axis && shape === 'half-hipped') {
    addHalfHippedRoof(roof, walls, single!.outer, axis, h.wallTop, h.roofHeight, tags['roof:orientation'] === 'across');
  } else if (axis) {
    addAxisRoof(roof, walls, single!.outer, axis, h.wallTop, h.roofHeight, tags['roof:orientation'] === 'across', PROFILES[shape]);
  } else if (quadRoof) {
    addQuadRoof(roof, walls, single!.outer, h.wallTop, h.top, shape === 'hipped', tags['roof:orientation'] === 'across');
  } else {
    for (const sk of skeletons!) addSkeletonRoof(roof, walls, sk as Skeleton, h.wallTop, h.roofHeight, GABLED_SHAPES.has(shape), PROFILES[shape]);
  }

  return { walls, roof, roofApproximated: !supported && !pending, pending };
}

function tri(out: number[], a: V3, b: V3, c: V3) {
  out.push(...a, ...b, ...c);
}

function quad(out: number[], a: V3, b: V3, c: V3, d: V3) {
  tri(out, a, b, c);
  tri(out, a, c, d);
}

function addWalls(out: number[], ring: Pt[], z0: number, z1: number) {
  if (z1 <= z0) return;
  for (let i = 0; i < ring.length; i++) {
    const [ax, ay] = ring[i];
    const [bx, by] = ring[(i + 1) % ring.length];
    quad(out, [ax, ay, z0], [bx, by, z0], [bx, by, z1], [ax, ay, z1]);
  }
}

function addFlat(out: number[], p: LocalPolygon, z: number) {
  const contour = p.outer.map(([x, y]) => new THREE.Vector2(x, y));
  const holes = p.inners.map((r) => r.map(([x, y]) => new THREE.Vector2(x, y)));
  const all = [contour, ...holes].flat();
  for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(contour, holes)) {
    tri(out, [all[a].x, all[a].y, z], [all[b].x, all[b].y, z], [all[c].x, all[c].y, z]);
  }
}

function center(ring: Pt[]): Pt {
  let x = 0, y = 0;
  for (const p of ring) { x += p[0]; y += p[1]; }
  return [x / ring.length, y / ring.length];
}

function addPyramid(out: number[], ring: Pt[], z0: number, z1: number) {
  const [cx, cy] = center(ring);
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    tri(out, [a[0], a[1], z0], [b[0], b[1], z0], [cx, cy, z1]);
  }
}

/** Купол/луковица: кольца, стягивающиеся к центру. Корректно для выпуклых контуров. */
function addDome(out: number[], ring: Pt[], z0: number, z1: number, onion: boolean) {
  const [cx, cy] = center(ring);
  const steps = 8;
  const profile = (t: number): [scale: number, z: number] => {
    const a = (t * Math.PI) / 2;
    // Луковица сначала расширяется, потом сужается в шпиль
    const scale = onion ? Math.cos(a) * (1 + 0.35 * Math.sin(a * 2)) : Math.cos(a);
    return [scale, z0 + (z1 - z0) * (onion ? t : Math.sin(a))];
  };
  const ringAt = (s: number, z: number): V3[] => ring.map(([x, y]) => [cx + (x - cx) * s, cy + (y - cy) * s, z]);
  let prev = ringAt(...profile(0));
  for (let k = 1; k <= steps; k++) {
    const cur = ringAt(...profile(k / steps));
    for (let i = 0; i < ring.length; i++) {
      const j = (i + 1) % ring.length;
      quad(out, prev[i], prev[j], cur[j], cur[i]);
    }
    prev = cur;
  }
}

/** Двускатная/вальмовая крыша на четырёхугольнике. Конёк вдоль длинной стороны (или поперёк при roof:orientation=across). */
function addQuadRoof(roof: number[], walls: number[], ring: Pt[], z0: number, z1: number, hipped: boolean, across: boolean) {
  const len = (a: Pt, b: Pt) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  const along01 = len(ring[0], ring[1]) + len(ring[2], ring[3]) >= len(ring[1], ring[2]) + len(ring[3], ring[0]);
  // Поворачиваем так, чтобы конёк шёл параллельно ребру p0→p1
  const r = along01 !== across ? ring : [ring[1], ring[2], ring[3], ring[0]];
  const [p0, p1, p2, p3] = r.map(([x, y]) => [x, y, z0] as V3);
  const mid = (a: V3, b: V3): V3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, z1];
  let m1 = mid(p1, p2);
  let m2 = mid(p3, p0);

  if (hipped) {
    const ridge = Math.hypot(m1[0] - m2[0], m1[1] - m2[1]);
    const inset = Math.min((len(r[1], r[2]) + len(r[3], r[0])) / 4, ridge / 2 - 0.01);
    const dx = (m1[0] - m2[0]) / ridge, dy = (m1[1] - m2[1]) / ridge;
    m1 = [m1[0] - dx * inset, m1[1] - dy * inset, z1];
    m2 = [m2[0] + dx * inset, m2[1] + dy * inset, z1];
  }

  quad(roof, p0, p1, m1, m2);
  quad(roof, p2, p3, m2, m1);
  // Торцы: у двускатной — фронтоны (цвет стен), у вальмовой — скаты
  const ends = hipped ? roof : walls;
  tri(ends, p1, p2, m1);
  tri(ends, p3, p0, m2);
}

/**
 * Вальмовая или двускатная крыша по straight skeleton: каждая грань скелета — скат над своей стороной контура,
 * высота точки пропорциональна расстоянию до контура (самая дальняя точка — конёк на высоте roofHeight).
 * Профиль (round, gambrel, mansard) — высота как функция расстояния до контура; грани режутся на полосы
 * по точкам излома профиля, внутри полосы высота линейна.
 * Двускатная: треугольные грани (торцы вальмовой) превращаются во фронтоны — вершина треугольника
 * переносится на его сторону контура, соседние скаты при этом дотягиваются до торца.
 */
function addSkeletonRoof(
  roof: number[], walls: number[], sk: Skeleton,
  z0: number, roofHeight: number, gabled: boolean, profile: Profile = LINEAR,
) {
  const verts = sk.vertices.map(([x, y, t]) => [x, y, t] as V3);
  const maxT = Math.max(...verts.map((v) => v[2])) || 1;
  const isContour = (i: number) => sk.vertices[i][2] < 1e-9;
  const gables = new Set<number[]>();

  if (gabled) {
    const moved = new Set<number>();
    // Сначала короткие торцы: на квадратоподобных формах вершину делят несколько треугольников
    const ends = sk.polygons
      .filter((f) => f.length === 3 && f.filter(isContour).length === 2)
      .map((f) => {
        const [a, b] = [f[f.length - 1], f[0]].map((i) => sk.vertices[i]);
        return { f, len: Math.hypot(b[0] - a[0], b[1] - a[1]) };
      })
      .sort((p, q) => p.len - q.len);
    for (const { f } of ends) {
      const apex = f.find((i) => !isContour(i))!;
      if (moved.has(apex)) continue;
      const [a, b] = [f[f.length - 1], f[0]].map((i) => sk.vertices[i]);
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const len2 = dx * dx + dy * dy || 1;
      const v = verts[apex];
      const t = ((v[0] - a[0]) * dx + (v[1] - a[1]) * dy) / len2;
      verts[apex] = [a[0] + dx * t, a[1] + dy * t, v[2]];
      moved.add(apex);
      gables.add(f);
    }
  }

  const z = (t: number) => z0 + roofHeight * profile.z(Math.min(1, t / maxT));
  const levels = [0, ...profile.breaks, 1].map((l) => l * maxT);
  levels[0] = -Infinity;
  levels[levels.length - 1] = Infinity;
  for (const f of sk.polygons) {
    const out = gables.has(f) ? walls : roof;
    const poly = f.map((i) => verts[i]);
    // Полосы по «времени» (расстоянию до контура): внутри полосы высота линейна, по полосам — по профилю
    for (let b = 0; b + 1 < levels.length; b++) {
      const band = levels.length === 2 ? poly : clipT(clipT(poly, levels[b], 1), levels[b + 1], -1);
      if (band.length < 3) continue;
      for (const [p, q, r] of triangulate3(band)) tri(out, [p[0], p[1], z(p[2])], [q[0], q[1], z(q[2])], [r[0], r[1], z(r[2])]);
    }
  }
}

/** Описанный прямоугольник минимальной площади (по направлениям сторон контура). */
interface RectAxis { dir: Pt; center: Pt; length: number; width: number }

/** Доля площади описанного прямоугольника, начиная с которой контур считаем «почти прямоугольным». */
const RECT_FILL = 0.85;

function rectAxis(ring: Pt[]): RectAxis | undefined {
  let best: RectAxis & { area: number } | undefined;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (l < 1e-6) continue;
    const u: Pt = [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const p of ring) {
      const pu = p[0] * u[0] + p[1] * u[1], pv = -p[0] * u[1] + p[1] * u[0];
      minU = Math.min(minU, pu); maxU = Math.max(maxU, pu); minV = Math.min(minV, pv); maxV = Math.max(maxV, pv);
    }
    const area = (maxU - minU) * (maxV - minV);
    if (best && area >= best.area) continue;
    const cu = (minU + maxU) / 2, cv = (minV + maxV) / 2;
    const center: Pt = [cu * u[0] - cv * u[1], cu * u[1] + cv * u[0]];
    // dir — вдоль длинной стороны
    best = maxU - minU >= maxV - minV
      ? { dir: u, center, length: maxU - minU, width: maxV - minV, area }
      : { dir: [-u[1], u[0]], center, length: maxV - minV, width: maxU - minU, area };
  }
  if (!best) return;
  let area = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) area += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  return Math.abs(area / 2) >= RECT_FILL * best.area ? best : undefined;
}

/**
 * Двускатная или сводчатая крыша вдоль оси описанного прямоугольника: высота зависит только от расстояния
 * до конька (по умолчанию вдоль длинной стороны, при roof:orientation=across — поперёк).
 * Стены по всему контуру поднимаются до поверхности крыши — на торцах получаются фронтоны.
 */
function addAxisRoof(
  roof: number[], walls: number[], ring: Pt[], ax: RectAxis,
  z0: number, roofHeight: number, across: boolean, profile: Profile = LINEAR,
) {
  const n: Pt = across ? ax.dir : [-ax.dir[1], ax.dir[0]]; // поперёк конька
  const half = (across ? ax.length : ax.width) / 2 || 1;
  // s — расстояние от конька в долях полуширины, -1…1
  const sOf = (p: Pt) => ((p[0] - ax.center[0]) * n[0] + (p[1] - ax.center[1]) * n[1]) / half;
  const z = (sv: number) => {
    const t = 1 - Math.min(1, Math.abs(sv));
    return z0 + roofHeight * profile.z(t);
  };
  // Полосы симметрично от конька (s = 0) к карнизам (|s| = 1) по точкам излома профиля
  const fromRidge = profile.breaks.map((b) => 1 - b).sort((a, b) => a - b);
  const levels = [-Infinity, ...[...fromRidge].reverse().map((l) => -l), 0, ...fromRidge, Infinity];
  const strips = levels.length - 1;

  const poly: V3[] = ring.map((p) => [p[0], p[1], sOf(p)]);
  for (let i = 0; i < strips; i++) {
    const band = clipT(clipT(poly, levels[i], 1), levels[i + 1], -1);
    if (band.length < 3) continue;
    const pts = band.map((p) => new THREE.Vector2(p[0], p[1]));
    for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(pts, [])) {
      tri(roof, [band[a][0], band[a][1], z(band[a][2])], [band[b][0], band[b][1], z(band[b][2])], [band[c][0], band[c][1], z(band[c][2])]);
    }
  }

  // Стены от карниза до крыши: сторону режем на границах полос, чтобы верх стены шёл по профилю
  const inner = levels.slice(1, -1);
  for (let i = 0; i < ring.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const cuts = [0, 1];
    for (const l of inner) {
      const u = (l - a[2]) / (b[2] - a[2]);
      if (u > 0 && u < 1) cuts.push(u);
    }
    cuts.sort((x, y) => x - y);
    for (let k = 0; k + 1 < cuts.length; k++) {
      const p = (u: number): V3 => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
      const p0 = p(cuts[k]), p1 = p(cuts[k + 1]);
      const h0 = z(p0[2]), h1 = z(p1[2]);
      if (h0 - z0 < 1e-6 && h1 - z0 < 1e-6) continue;
      quad(walls, [p0[0], p0[1], z0], [p1[0], p1[1], z0], [p1[0], p1[1], h1], [p0[0], p0[1], h0]);
    }
  }
}

/** Плоскость z = a·x + b·y + c. */
type Plane = [a: number, b: number, c: number];
const planeZ = ([a, b, c]: Plane, x: number, y: number) => a * x + b * y + c;

/** Доля высоты крыши, на которой фронтон полувальмовой крыши срезается вальмой. */
const HALF_HIP_CUT = 0.6;

/**
 * Полувальмовая крыша: двускатная, у которой верх фронтонов срезан небольшими вальмами.
 * Поверхность — минимум из четырёх плоскостей (два ската и две вальмы с тем же уклоном).
 */
function addHalfHippedRoof(roof: number[], walls: number[], ring: Pt[], ax: RectAxis, z0: number, roofHeight: number, across: boolean) {
  const along: Pt = across ? [-ax.dir[1], ax.dir[0]] : ax.dir; // вдоль конька
  const n: Pt = [-along[1], along[0]]; // поперёк
  const halfW = (across ? ax.length : ax.width) / 2 || 1;
  const halfL = (across ? ax.width : ax.length) / 2 || 1;
  const [cx, cy] = ax.center;
  const top = z0 + roofHeight;
  const k = roofHeight / halfW; // уклон скатов, м/м
  const zc = z0 + roofHeight * HALF_HIP_CUT; // высота среза фронтона
  // Плоскость, растущая с уклоном k в направлении d от точки (на расстоянии off от центра) с высоты zBase
  const rising = (d: Pt, off: number, zBase: number): Plane => [k * d[0], k * d[1], zBase - k * (d[0] * cx + d[1] * cy) + k * off];
  const planes: Plane[] = [
    rising(n, halfW, z0), // скат со стороны -n: на s = -halfW высота z0
    rising([-n[0], -n[1]], halfW, z0),
    rising(along, halfL, zc), // вальма у торца -along: на торце высота zc
    rising([-along[0], -along[1]], halfL, zc),
  ];
  addPlanesRoof(roof, walls, ring, planes, z0, top);
}

/** Смещение конька saltbox от середины, в долях полуширины. */
const SALTBOX_RIDGE = 1 / 3;

/**
 * Saltbox: двускатная с коньком, смещённым к одной стороне, — короткий крутой скат и длинный пологий.
 * Карнизы на одной высоте, фронтоны несимметричные. roof:direction — куда смотрит длинный скат
 * (как направление ската у skillion); без него длинный скат — с «левой» стороны оси.
 */
function addSaltboxRoof(roof: number[], walls: number[], ring: Pt[], ax: RectAxis, z0: number, roofHeight: number, across: boolean, direction?: string) {
  const along: Pt = across ? [-ax.dir[1], ax.dir[0]] : ax.dir;
  let n: Pt = [-along[1], along[0]]; // поперёк конька; длинный скат смотрит в -n
  const deg = direction === undefined ? NaN : CARDINAL[direction.toUpperCase()] ?? Number(direction);
  if (Number.isFinite(deg)) {
    const rad = (deg * Math.PI) / 180;
    const d: Pt = [Math.sin(rad), Math.cos(rad)]; // x — восток, y — север
    if (-(n[0] * d[0] + n[1] * d[1]) < 0) n = [-n[0], -n[1]];
  }
  const halfW = (across ? ax.length : ax.width) / 2 || 1;
  const [cx, cy] = ax.center;
  const ridge = halfW * SALTBOX_RIDGE; // конёк сдвинут в сторону +n
  const kLong = roofHeight / (halfW + ridge), kShort = roofHeight / (halfW - ridge);
  // z = z0 + k · (расстояние от карниза), расстояние меряем вдоль d от линии s = -halfW
  const plane = (d: Pt, k: number): Plane => [k * d[0], k * d[1], z0 - k * (d[0] * cx + d[1] * cy) + k * halfW];
  addPlanesRoof(roof, walls, ring, [plane(n, kLong), plane([-n[0], -n[1]], kShort)], z0, z0 + roofHeight);
}

/**
 * Крыша как минимум из плоскостей: контур режется на области, где каждая плоскость ниже остальных
 * (это пересечение полуплоскостей — каждая область плоская), стены поднимаются до той же поверхности.
 */
function addPlanesRoof(roof: number[], walls: number[], ring: Pt[], planes: Plane[], z0: number, cap: number) {
  const zAt = (x: number, y: number) => Math.min(cap, ...planes.map((pl) => planeZ(pl, x, y)));
  for (let i = 0; i < planes.length; i++) {
    let region: V3[] = ring.map(([x, y]) => [x, y, 0]);
    for (let j = 0; j < planes.length && region.length >= 3; j++) {
      if (j === i) continue;
      // Оставляем точки, где plane_i ≤ plane_j (третья координата — разность)
      region = clipT(region.map(([x, y]) => [x, y, planeZ(planes[j], x, y) - planeZ(planes[i], x, y)]), 0, 1);
    }
    if (region.length < 3) continue;
    const pts = region.map((p) => new THREE.Vector2(p[0], p[1]));
    for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(pts, [])) {
      const v = (k: number): V3 => [region[k][0], region[k][1], Math.min(cap, planeZ(planes[i], region[k][0], region[k][1]))];
      tri(roof, v(a), v(b), v(c));
    }
  }
  // Стены: режем стороны в точках, где меняется нижняя плоскость, — между разрезами верх стены линеен
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const cuts = [0, 1];
    for (let p = 0; p < planes.length; p++) {
      for (let q = p + 1; q < planes.length; q++) {
        const da = planeZ(planes[p], ...a) - planeZ(planes[q], ...a);
        const db = planeZ(planes[p], ...b) - planeZ(planes[q], ...b);
        if ((da < 0) !== (db < 0) && da !== db) cuts.push(da / (da - db));
      }
    }
    cuts.sort((x, y) => x - y);
    for (let k = 0; k + 1 < cuts.length; k++) {
      const p0: Pt = [a[0] + (b[0] - a[0]) * cuts[k], a[1] + (b[1] - a[1]) * cuts[k]];
      const p1: Pt = [a[0] + (b[0] - a[0]) * cuts[k + 1], a[1] + (b[1] - a[1]) * cuts[k + 1]];
      const h0 = Math.max(z0, zAt(...p0)), h1 = Math.max(z0, zAt(...p1));
      if (h0 - z0 < 1e-6 && h1 - z0 < 1e-6) continue;
      quad(walls, [p0[0], p0[1], z0], [p1[0], p1[1], z0], [p1[0], p1[1], h1], [p0[0], p0[1], h0]);
    }
  }
}

/** Цилиндрический свод: дуга окружности, t — доля пути от карниза к коньку. */
/**
 * Профиль ската: z(t) — доля высоты крыши, t — доля пути от карниза к коньку (0…1).
 * breaks — точки t, где профиль меняет наклон (по ним режутся полосы).
 */
interface Profile { z: (t: number) => number; breaks: number[] }

const LINEAR: Profile = { z: (t) => t, breaks: [] };

/** Ломаная из двух отрезков через (tb, zb). */
const twoPitch = (tb: number, zb: number): Profile => ({
  z: (t) => (t <= tb ? (t / tb) * zb : zb + ((t - tb) / (1 - tb)) * (1 - zb)),
  breaks: [tb],
});

const ROUND_BANDS = 8;

const PROFILES: Record<string, Profile | undefined> = {
  // Цилиндрический свод: дуга окружности
  round: { z: (t) => Math.sqrt(1 - (1 - t) * (1 - t)), breaks: Array.from({ length: ROUND_BANDS - 1 }, (_, i) => (i + 1) / ROUND_BANDS) },
  // Ломаные крыши: крутой нижний скат и пологий верхний. Пропорции — типичные, теги их не задают
  gambrel: twoPitch(0.3, 0.7),
  mansard: twoPitch(0.25, 0.75),
};

/** Крыши с фронтонами на торцах (остальные скатные — со скатами со всех сторон). */
// half-hipped и saltbox на сложных контурах (без оси) — упрощённо как двускатная
const GABLED_SHAPES = new Set(['gabled', 'round', 'gambrel', 'half-hipped', 'saltbox']);

/** Отсечение многоугольника по третьей координате: sign=1 — оставить t ≥ level, -1 — t ≤ level. */
function clipT(poly: V3[], level: number, sign: 1 | -1): V3[] {
  const out: V3[] = [];
  const inside = (p: V3) => sign * (p[2] - level) >= -1e-9;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    if (inside(a)) out.push(a);
    if (inside(a) !== inside(b)) {
      const u = (level - a[2]) / (b[2] - a[2]);
      out.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, level]);
    }
  }
  return out;
}

/**
 * Триангуляция плоского многоугольника в 3D (x, y, время): проецируем на плоскость, где он «шире» всего.
 * Фронтоны вертикальны, поэтому проекции на xy недостаточно.
 */
function triangulate3(poly: V3[]): [V3, V3, V3][] {
  if (poly.length === 3) return [[poly[0], poly[1], poly[2]]];
  const n = [0, 0, 0];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    n[0] += (a[1] - b[1]) * (a[2] + b[2]);
    n[1] += (a[2] - b[2]) * (a[0] + b[0]);
    n[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const drop = n.map(Math.abs).indexOf(Math.max(...n.map(Math.abs)));
  const [u, v] = [0, 1, 2].filter((i) => i !== drop);
  const pts = poly.map((p) => new THREE.Vector2(p[u], p[v]));
  return THREE.ShapeUtils.triangulateShape(pts, []).map(([a, b, c]) => [poly[a], poly[b], poly[c]]);
}

const CARDINAL: Record<string, number> = {
  N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5,
  S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5,
};

/**
 * Односкатная крыша: плоскость, опускающаяся в сторону roof:direction.
 * Без направления скат идёт перпендикулярно самой длинной стороне контура.
 */
function addSkillion(walls: number[], roof: number[], p: LocalPolygon, h: Heights, direction?: string) {
  let deg = direction === undefined ? NaN : CARDINAL[direction.toUpperCase()] ?? Number(direction);
  if (!Number.isFinite(deg)) deg = longestEdgeNormal(p.outer);
  const rad = (deg * Math.PI) / 180;
  const dir: Pt = [Math.sin(rad), Math.cos(rad)]; // x — восток, y — север
  const proj = (q: Pt) => q[0] * dir[0] + q[1] * dir[1];
  const ps = p.outer.map(proj);
  const lo = Math.min(...ps), span = Math.max(...ps) - lo || 1;
  // Дальше по направлению ската — ниже
  const topAt = (q: Pt) => h.wallTop + h.roofHeight * (1 - (proj(q) - lo) / span);

  for (const ring of [p.outer, ...p.inners]) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      quad(walls, [a[0], a[1], h.min], [b[0], b[1], h.min], [b[0], b[1], topAt(b)], [a[0], a[1], topAt(a)]);
    }
  }
  const contour = p.outer.map(([x, y]) => new THREE.Vector2(x, y));
  const holes = p.inners.map((r) => r.map(([x, y]) => new THREE.Vector2(x, y)));
  const all = [contour, ...holes].flat();
  const v = (i: number): V3 => [all[i].x, all[i].y, topAt([all[i].x, all[i].y])];
  for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(contour, holes)) tri(roof, v(a), v(b), v(c));
}

function longestEdgeNormal(ring: Pt[]): number {
  let best = 0, deg = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (l > best) { best = l; deg = (Math.atan2(b[0] - a[0], b[1] - a[1]) * 180) / Math.PI + 90; }
  }
  return deg;
}

import * as THREE from 'three';
import type { Heights } from '../osm/heights';
import { skeletonOf } from './skeleton';

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
}

const SUPPORTED_ANY_POLYGON = new Set(['flat', 'pyramidal', 'dome', 'onion', 'skillion']);
const SUPPORTED_QUAD = new Set(['gabled', 'hipped']);

export function buildTriangles(polygons: LocalPolygon[], h: Heights, tags: Record<string, string>): BuildingTriangles {
  const walls: number[] = [];
  const roof: number[] = [];

  const shape = h.roofShape;
  const single = polygons.length === 1 && polygons[0].inners.length === 0 ? polygons[0] : undefined;
  const quadRoof = single && single.outer.length === 4 && SUPPORTED_QUAD.has(shape);
  // Скатные крыши на остальных контурах (в т.ч. с дырами и из нескольких полигонов) — по straight skeleton
  const skeletons = !quadRoof && SUPPORTED_QUAD.has(shape) ? polygons.map((p) => skeletonOf(p.outer, p.inners)) : undefined;
  const skeletonRoof = !!skeletons?.length && skeletons.every(Boolean);
  const supported =
    shape === 'flat' ||
    (shape === 'skillion' && polygons.length === 1) ||
    (single && SUPPORTED_ANY_POLYGON.has(shape)) ||
    quadRoof ||
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
  } else if (quadRoof) {
    addQuadRoof(roof, walls, single!.outer, h.wallTop, h.top, shape === 'hipped', tags['roof:orientation'] === 'across');
  } else {
    for (const sk of skeletons!) addSkeletonRoof(roof, walls, sk!, h.wallTop, h.roofHeight, shape === 'gabled');
  }

  return { walls, roof, roofApproximated: !supported };
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
 * Двускатная: треугольные грани (торцы вальмовой) превращаются во фронтоны — вершина треугольника
 * переносится на его сторону контура, соседние скаты при этом дотягиваются до торца.
 */
function addSkeletonRoof(roof: number[], walls: number[], sk: NonNullable<ReturnType<typeof skeletonOf>>, z0: number, roofHeight: number, gabled: boolean) {
  const verts = sk.vertices.map(([x, y, t]) => [x, y, t] as V3);
  const maxT = Math.max(...verts.map((v) => v[2])) || 1;
  const k = roofHeight / maxT;
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

  const at = (i: number): V3 => [verts[i][0], verts[i][1], z0 + verts[i][2] * k];
  for (const f of sk.polygons) {
    const out = gables.has(f) ? walls : roof;
    // Грань может быть невыпуклой — триангулируем в её плоскости по проекции на xy
    const pts = f.map((i) => new THREE.Vector2(verts[i][0], verts[i][1]));
    if (gables.has(f) || f.length === 3) {
      // Фронтон вертикален (проекция вырождена), треугольник — уже треугольник
      tri(out, at(f[0]), at(f[1]), at(f[2]));
      continue;
    }
    for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(pts, [])) tri(out, at(f[a]), at(f[b]), at(f[c]));
  }
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

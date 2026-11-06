import { pointInRing, type IndoorFeature, type LonLat } from '../osm/model';
import type { IndoorOperation, IndoorVertex } from './indoor-geometry';

/**
 * Марш лестницы или эскалатора — пара «линия + полигон» (docs/indoor-stairs.md, «Модель марша»): линия
 * highway=steps задаёт направление, полигон с тегами лестницы — периметр. Связь — только по геометрии и тегам.
 */

/** Теги площади лестницы/эскалатора. */
export const isStairsAreaTags = (t: Record<string, string>) => t.room === 'stairs' || t.stairs === 'yes' || !!t.conveying
  || t.highway === 'steps' || t['area:highway'] === 'steps';

/** Конец линии от контура полигона не дальше этого, м, — на контуре. */
export const PAIR_END_TOLERANCE = 0.4;

const sameLevels = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => v === b[i]);
const metres = (o: LonLat) => { const kx = Math.cos(o[1] * Math.PI / 180) * 111320, ky = 111320; return {
  to: (p: LonLat): [number, number] => [(p[0] - o[0]) * kx, (p[1] - o[1]) * ky],
  back: (p: [number, number]): LonLat => [o[0] + p[0] / kx, o[1] + p[1] / ky] }; };
const inside = (p: LonLat, poly: IndoorFeature['polygons'][number]) => pointInRing(p, poly.outer) && !poly.inners.some((h) => pointInRing(p, h));

/** Ближайшая сторона кольца к точке p (м): индекс начала стороны, доля вдоль неё и расстояние. */
function nearestSide(p: LonLat, ring: LonLat[]): { i: number; t: number; d: number } {
  const m = metres(p);
  let best = { i: -1, t: 0, d: Infinity };
  ring.forEach((q, i) => {
    const a = m.to(q), b = m.to(ring[(i + 1) % ring.length]), ux = b[0] - a[0], uy = b[1] - a[1], l2 = ux * ux + uy * uy;
    const t = l2 ? Math.max(0, Math.min(1, (-a[0] * ux - a[1] * uy) / l2)) : 0;
    const d = Math.hypot(a[0] + ux * t, a[1] + uy * t);
    if (d < best.d) best = { i, t, d };
  });
  return best;
}

/** Ось марша: путь highway=steps (лестница или эскалатор) с направлением. */
export const isStairsAxis = (f: IndoorFeature) => !!f.escalator && !!f.line && (f.polygons[0]?.outer.length ?? 0) >= 2;

/**
 * Полигон пары для оси: теги лестницы, те же level, линия проходит через него от стороны до стороны (концы на контуре,
 * середина внутри) и других осей тех же level в нём нет. anyLevels — без сравнения level: найти пару, у которой
 * уровни уже разошлись (синхронизация level её чинит).
 */
export function pairedArea(axis: IndoorFeature, all: IndoorFeature[], anyLevels = false): IndoorFeature | undefined {
  if (!isStairsAxis(axis)) return;
  const line = axis.polygons[0].outer, s = line[0], e = line[line.length - 1];
  const mid: LonLat = [(s[0] + e[0]) / 2, (s[1] + e[1]) / 2];
  for (const area of all) {
    if (area.line || area.point || area.polygons.length !== 1 || area.polygons[0].inners.length || !isStairsAreaTags(area.tags)) continue;
    const poly = area.polygons[0];
    if ((!anyLevels && !sameLevels(area.levels, axis.levels)) || !inside(mid, poly)) continue;
    if (nearestSide(s, poly.outer).d > PAIR_END_TOLERANCE || nearestSide(e, poly.outer).d > PAIR_END_TOLERANCE) continue;
    const others = all.filter((f) => f.key !== axis.key && isStairsAxis(f) && sameLevels(f.levels, axis.levels) && (() => {
      const o = f.polygons[0].outer, m: LonLat = [(o[0][0] + o[o.length - 1][0]) / 2, (o[0][1] + o[o.length - 1][1]) / 2];
      return inside(m, poly);
    })());
    if (others.length) return;
    return area;
  }
}

/** Ось пары для полигона лестницы. */
export function pairedAxis(area: IndoorFeature, all: IndoorFeature[]): IndoorFeature | undefined {
  if (area.line || area.point || !isStairsAreaTags(area.tags)) return;
  return all.find((f) => isStairsAxis(f) && pairedArea(f, all)?.key === area.key);
}

/** Второй объект пары (для оси — полигон, для полигона — ось). */
export const stairsPartner = (f: IndoorFeature, all: IndoorFeature[]) => isStairsAxis(f) ? pairedArea(f, all) : pairedAxis(f, all);

/**
 * Полигон за осью: вершина хранится в системе оси — доля длины вдоль неё и расстояние поперёк (м). Перенос и поворот
 * оси переносят полигон, удлинение растягивает его вдоль оси, ширина остаётся. Только для прямой оси (2 точки).
 */
export function followAxis(area: LonLat[], from: [LonLat, LonLat], to: [LonLat, LonLat]): LonLat[] {
  const m = metres(from[0]);
  const [a, b] = from.map(m.to), [a2, b2] = to.map(m.to);
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]), L2 = Math.hypot(b2[0] - a2[0], b2[1] - a2[1]);
  if (L < 1e-3 || L2 < 1e-3) return area;
  const u = [(b[0] - a[0]) / L, (b[1] - a[1]) / L], u2 = [(b2[0] - a2[0]) / L2, (b2[1] - a2[1]) / L2];
  return area.map((p) => {
    const q = m.to(p), dx = q[0] - a[0], dy = q[1] - a[1];
    const s = (dx * u[0] + dy * u[1]) / L, t = -dx * u[1] + dy * u[0];
    return m.back([a2[0] + u2[0] * s * L2 - u2[1] * t, a2[1] + u2[1] * s * L2 + u2[0] * t]);
  });
}

/** Ось за полигоном: каждый конец остаётся на своей стороне, на той же доле её длины. */
export function followArea(axis: LonLat[], from: LonLat[], to: LonLat[]): LonLat[] {
  return axis.map((p, k) => {
    if (k !== 0 && k !== axis.length - 1) return p;
    const side = nearestSide(p, from);
    if (side.i < 0 || side.d > PAIR_END_TOLERANCE) return p;
    const a = to[side.i], b = to[(side.i + 1) % to.length];
    return [a[0] + (b[0] - a[0]) * side.t, a[1] + (b[1] - a[1]) * side.t];
  });
}

/**
 * Перемещение вершин с учётом пар: двигается одна сторона пары — вторая следует (followAxis / followArea).
 * Возвращает операцию с явными местами всех вершин (to); без пар — исходную.
 */
export function withStairsPartners(op: IndoorOperation, all: IndoorFeature[]): IndoorOperation {
  if (op.type !== 'move') return op;
  const touched = new Set(op.vertices.map((v) => v.key));
  const vertices: IndoorVertex[] = [...op.vertices];
  const to: LonLat[] = op.vertices.map((v, i) => {
    if (op.to?.[i]) return op.to[i];
    const f = all.find((x) => x.key === v.key), p = f?.polygons[v.poly];
    const c = p && (v.ring === 0 ? p.outer : p.inners[v.ring - 1])?.[v.i];
    return c ? [c[0] + op.delta[0], c[1] + op.delta[1]] : [0, 0];
  });
  const target = (key: string, i: number, old: LonLat) => {
    const k = op.vertices.findIndex((v) => v.key === key && v.poly === 0 && v.ring === 0 && v.i === i);
    return k >= 0 ? to[k] : old;
  };
  let added = false;
  for (const key of touched) {
    const f = all.find((x) => x.key === key);
    if (!f) continue;
    const partner = stairsPartner(f, all);
    if (!partner || touched.has(partner.key)) continue;
    const axis = isStairsAxis(f) ? f : partner, area = axis === f ? partner : f;
    const line = axis.polygons[0].outer, ring = area.polygons[0].outer;
    if (line.length !== 2) continue;
    if (axis === f) {
      const next = followAxis(ring, [line[0], line[1]], [target(axis.key, 0, line[0]), target(axis.key, 1, line[1])]);
      next.forEach((p, i) => { vertices.push({ key: area.key, poly: 0, ring: 0, i }); to.push(p); });
    } else {
      const next = followArea(line, ring, ring.map((p, i) => target(area.key, i, p)));
      next.forEach((p, i) => { vertices.push({ key: axis.key, poly: 0, ring: 0, i }); to.push(p); });
    }
    touched.add(partner.key);
    added = true;
  }
  return added ? { type: 'move', vertices, delta: op.delta, to } : op;
}

/** Полуширина полигона пары поперёк прямой оси (a→b), м: дальняя от оси вершина. */
export function pairHalfWidth(area: LonLat[], axis: [LonLat, LonLat]): number {
  const m = metres(axis[0]), b = m.to(axis[1]), L = Math.hypot(b[0], b[1]) || 1;
  return Math.max(0, ...area.map((p) => { const q = m.to(p); return Math.abs(-q[0] * b[1] / L + q[1] * b[0] / L); }));
}

/**
 * Ширина полигона пары симметрично относительно оси: расстояние каждой вершины поперёк оси умножается на factor,
 * положение вдоль оси сохраняется.
 */
export function scaleAcross(area: LonLat[], axis: [LonLat, LonLat], factor: number): LonLat[] {
  const m = metres(axis[0]), b = m.to(axis[1]), L = Math.hypot(b[0], b[1]) || 1, u = [b[0] / L, b[1] / L];
  return area.map((p) => {
    const q = m.to(p), s = q[0] * u[0] + q[1] * u[1], t = -q[0] * u[1] + q[1] * u[0];
    return m.back([u[0] * s - u[1] * t * factor, u[1] * s + u[0] * t * factor]);
  });
}

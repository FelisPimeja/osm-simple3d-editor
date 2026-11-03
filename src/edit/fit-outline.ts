import polygonClipping from 'polygon-clipping';
import { pointInRing, type Feature3D, type LonLat } from '../osm/model';
import { partGround } from './validate';

/** Точка в метрах сцены. */
type Pt = [number, number];
/** Расстояние до стены, ближе которого точка — на ней, м. */
const ON_WALL = 0.05;
/** Вход ближе этого к новой стене уже на ней: встаёт в кольцо на месте, м. */
const ENTRANCE_ON_WALL = 0.2;

function segDist([px, py]: Pt, [ax, ay]: Pt, [bx, by]: Pt): number {
  const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

/** Кольцо без лишних точек на прямых (замкнутое на входе, открытое на выходе). */
function clean(closed: number[][]): Pt[] {
  const ring = closed.slice(0, -1) as Pt[];
  const out: Pt[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = out.length ? out[out.length - 1] : ring[ring.length - 1], b = ring[i], c = ring[(i + 1) % ring.length];
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 0.01) continue;
    if (segDist(b, a, c) < 0.1) continue; // на прямой a–c
    out.push(b);
  }
  return out;
}

/**
 * Объединение внешних колец (метры сцены): внешнее кольцо и дворы; undefined — объединение из нескольких кусков
 * или вырождено.
 */
export function unitedRings(rings: Pt[][]): { outer: Pt[]; holes: Pt[][] } | undefined {
  const polys = rings.map((r) => [[...r, r[0]]] as Pt[][]);
  const u = polygonClipping.union(polys[0], ...polys.slice(1));
  if (u.length !== 1) return;
  const outer = clean(u[0][0]);
  return outer.length < 3 ? undefined : { outer, holes: u[0].slice(1).map(clean).filter((h) => h.length >= 3) };
}

/** Нависающие части, вышедшие хоть одной вершиной за кольцо outer и ещё без положительного layer: им — layer=1. */
export function raisedOutside(parts: Feature3D[], outer: Pt[], toLocal: (c: LonLat) => Pt): string[] {
  const inside = (c: LonLat) => {
    const q = toLocal(c);
    return pointInRing(q, outer) || outer.some((a, j) => segDist(q, a, outer[(j + 1) % outer.length]) < ON_WALL);
  };
  return parts.filter((f) => f.polygons?.length && partGround(f.tags) === 'raised' && !(Number(f.tags.layer) > 0)
    && !f.polygons.every((p) => p.outer.every(inside))).map((f) => f.key);
}

/**
 * Входы прежнего контура, которых нет в новом кольце ids/coords: лежащий на новой стене встаёт в кольцо на месте,
 * прочий (кроме вершин частей на земле — те на своих местах) переезжает на ближайшую стену. Узел, который есть и в
 * других путях (вершина нависающей части), не двигается — иначе поедет и их геометрия: на стену встаёт новый узел
 * (id от newId), ему — теги входа (detached). Правит ids/coords на месте.
 */
export function keepOutlineEntrances(outline: Feature3D, groundParts: Feature3D[], ids: number[], coords: LonLat[],
  isEntrance: (id: number) => boolean, toLocal: (c: LonLat) => Pt, toLonLat: (p: Pt) => LonLat,
  shared: (id: number) => boolean = () => false, newId: () => number = () => { throw new Error('newId'); },
): { moved: number; detached: { from: number; to: number; at: LonLat }[] } {
  const detached: { from: number; to: number; at: LonLat }[] = [];
  const inParts = new Set(groundParts.flatMap((f) => f.polygons.flatMap((p) => [...p.outerIds ?? [], ...(p.innerIds ?? []).flat()])));
  const old = outline.polygons.flatMap((p) => {
    const cs = [...p.outer, ...p.inners.flat()];
    return [...p.outerIds ?? [], ...(p.innerIds ?? []).flat()].map((id, i) => ({ id, c: cs[i] }));
  });
  let moved = 0;
  for (const { id, c } of old) {
    if (ids.includes(id) || !isEntrance(id)) continue;
    const q = toLocal(c);
    const loc = coords.map(toLocal);
    let best = { d: Infinity, i: 0, p: q };
    for (let i = 0; i < loc.length; i++) {
      const a = loc[i], b = loc[(i + 1) % loc.length], dx = b[0] - a[0], dy = b[1] - a[1], l = dx * dx + dy * dy;
      const t = l ? Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / l)) : 0;
      const p: Pt = [a[0] + t * dx, a[1] + t * dy], d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (d < best.d) best = { d, i, p };
    }
    const on = best.d < ENTRANCE_ON_WALL;
    if (!on && inParts.has(id)) continue;
    const at = on ? c : toLonLat(best.p);
    const to = !on && shared(id) ? newId() : id;
    if (to !== id) detached.push({ from: id, to, at });
    ids.splice(best.i + 1, 0, to);
    coords.splice(best.i + 1, 0, at);
    if (!on) moved++;
  }
  return { moved, detached };
}

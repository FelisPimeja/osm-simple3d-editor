import type { LonLat, Polygon } from '../osm/model';
import type { Line } from './session';

export interface RoomWall { key: string; polygon: number; ring: number; edge: number }
export type WallSpan = [LonLat, LonLat];
export interface WallTarget { span: WallSpan; levels: number[] }
const TURN = 0.05;
const EPS = 0.02;

/** Метры около выбранной стены, без потери точности на больших координатах. */
function local(origin: LonLat) {
  const kx = Math.cos(origin[1] * Math.PI / 180) * 111320;
  return (p: LonLat): LonLat => [(p[0] - origin[0]) * kx, (p[1] - origin[1]) * 111320];
}

/** Вся прямая сторона кольца, включая промежуточные узлы. */
export function roomWallSpan(polygons: Polygon[], wall: RoomWall): WallSpan {
  const p = polygons[wall.polygon], ring = [p.outer, ...p.inners][wall.ring];
  const loc = local(ring[wall.edge]), pts = ring.map(loc), n = ring.length;
  const straight = (i: number) => {
    const a = pts[(i + n - 1) % n], b = pts[i], c = pts[(i + 1) % n];
    const t = Math.atan2(c[1] - b[1], c[0] - b[0]) - Math.atan2(b[1] - a[1], b[0] - a[0]);
    return Math.abs(Math.atan2(Math.sin(t), Math.cos(t))) < TURN;
  };
  let first = wall.edge, last = (first + 1) % n;
  for (let k = 0; k < n - 2 && straight(first); k++) first = (first + n - 1) % n;
  for (let k = 0; k < n - 2 && straight(last); k++) last = (last + 1) % n;
  return [ring[first], ring[last]];
}

/** Часть ребра, перекрытая выбранной прямой стороной (в метрах — тот же допуск, что у рёбер). */
export function wallOverlap(a: LonLat, b: LonLat, span: WallSpan): [number, number] | undefined {
  const loc = local(a), q = loc(b), c = loc(span[0]), d = loc(span[1]);
  const len = Math.hypot(...q);
  if (len < EPS) return;
  const off = (p: LonLat) => Math.abs(p[0] * q[1] - p[1] * q[0]) / len;
  if (off(c) > EPS || off(d) > EPS) return;
  const along = (p: LonLat) => (p[0] * q[0] + p[1] * q[1]) / (len * len);
  const lo = Math.max(0, Math.min(along(c), along(d))), hi = Math.min(1, Math.max(along(c), along(d)));
  return (hi - lo) * len > EPS ? [lo, hi] : undefined;
}

export function roomTouchesWall(polygons: Polygon[], spans: WallSpan[]): boolean {
  return polygons.some((p) => [p.outer, ...p.inners].some((r) => r.some((a, i) => spans.some((s) => wallOverlap(a, r[(i + 1) % r.length], s)))));
}

/** Остатки контура как незамкнутые стены; узлы исходного помещения переиспользуются. */
export function remainingRoomWalls(polygons: Polygon[], spans: WallSpan[], nodeAt: (p: LonLat) => number): Line[] {
  const out: Line[] = [];
  for (const p of polygons) for (const ring of [p.outer, ...p.inners]) {
    const parts: Line[] = [];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      let intervals: [number, number][] = [[0, 1]];
      for (const span of spans) {
        const overlap = wallOverlap(a, b, span);
        if (!overlap) continue;
        const [lo, hi] = overlap;
        intervals = intervals.flatMap(([x, y]) => {
          if (hi <= x || lo >= y) return [[x, y]];
          const keep: [number, number][] = [];
          if (lo > x + 1e-8) keep.push([x, lo]);
          if (hi < y - 1e-8) keep.push([hi, y]);
          return keep;
        });
      }
      for (const [lo, hi] of intervals) {
        const at = (t: number): LonLat => t === 0 ? a : t === 1 ? b : [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        const coords = [at(lo), at(hi)], ids = coords.map(nodeAt);
        const prev = parts.at(-1);
        if (prev?.ids.at(-1) === ids[0]) { prev.ids.push(ids[1]); prev.coords.push(coords[1]); }
        else parts.push({ ids, coords });
      }
    }
    if (parts.length > 1 && parts.at(-1)!.ids.at(-1) === parts[0].ids[0]) {
      const last = parts.pop()!;
      parts[0] = { ids: [...last.ids, ...parts[0].ids.slice(1)], coords: [...last.coords, ...parts[0].coords.slice(1)] };
    }
    out.push(...parts);
  }
  return out;
}

/** Общая стена удаляется на этажах выбранного объекта; на дополнительных этажах соседа остаётся. */
export function materializeRoomWalls(polygons: Polygon[], tags: Record<string, string>, levels: number[], targets: WallTarget[], nodeAt: (p: LonLat) => number): { line: Line; tags: Record<string, string> }[] {
  const byGeometry = new Map<string, { line: Line; levels: number[] }>();
  for (const l of levels) {
    const spans = targets.filter((t) => t.levels.includes(l)).map((t) => t.span);
    for (const line of remainingRoomWalls(polygons, spans, nodeAt)) {
      // Замкнутый indoor=wall имеет крышку сечения (шахта). Стены комнаты должны остаться открытыми ways.
      const mid = Math.floor(line.ids.length / 2);
      const lines = line.ids[0] === line.ids.at(-1) ? [
        { ids: line.ids.slice(0, mid + 1), coords: line.coords.slice(0, mid + 1) },
        { ids: line.ids.slice(mid), coords: line.coords.slice(mid) },
      ] : [line];
      for (const part of lines) {
        const k = part.ids.join(',');
        const entry = byGeometry.get(k) ?? { line: part, levels: [] };
        entry.levels.push(l);
        byGeometry.set(k, entry);
      }
    }
  }
  const wallTags: Record<string, string> = { indoor: 'wall', level: tags.level ?? String(levels[0] ?? 0) };
  if (tags.repeat_on) wallTags.repeat_on = tags.repeat_on;
  return [...byGeometry.values()].map((entry) => ({ line: entry.line,
    tags: entry.levels.length === levels.length ? { ...wallTags } : { indoor: 'wall', level: entry.levels.join(';') } }));
}

/** Door belongs to a removed span only on a shared floor and within 2 cm of it. */
export function pointOnRemovedWall(point: LonLat, levels: number[], targets: WallTarget[]): boolean {
  const toLocal = local(point);
  return targets.some(({span, levels: floors}) => {
    if (!floors.some(l => levels.includes(l))) return false;
    const a = toLocal(span[0]), b = toLocal(span[1]);
    const dx=b[0]-a[0],dy=b[1]-a[1],length2=dx*dx+dy*dy;
    const t=length2 ? Math.max(0,Math.min(1,-(a[0]*dx+a[1]*dy)/length2)) : 0;
    return Math.hypot(a[0]+t*dx,a[1]+t*dy)<=EPS;
  });
}

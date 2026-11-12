import { cutDoorOpenings } from './door-openings';

type Pt = [number, number];
/** Вход на стене: точка p на фасаде, t — вдоль стены, n — наружу, z — порог. */
export interface RecessPlace { p: Pt; t: Pt; n: Pt; z: number; width?: number }

/** Глубина ниши входа, м. */
export const RECESS_DEPTH = 0.3;
/** Пол ниши чуть выше порога: на земле он иначе мерцает с картой. */
const SILL = 0.01;
/** Точка входа считается на стене, если до её плоскости не дальше этого, м. */
const ON_WALL = 0.15;

/** Треугольник тоньше этого (высота к длинной стороне), м, — вырожденный. */
const SLIVER = 1e-3;

/**
 * Без вырожденных треугольников: разрезка стены оставляет треугольники с тремя вершинами на одной прямой
 * (на диагонали исходного четырёхугольника). Их не видно, но их стороны — непарные, и сборка рёбер рисует
 * их линиями поперёк проёма.
 */
function dropSlivers(p: ArrayLike<number>): number[] {
  const out: number[] = [];
  for (let i = 0; i + 8 < p.length; i += 9) {
    const ux = p[i + 3] - p[i], uy = p[i + 4] - p[i + 1], uz = p[i + 5] - p[i + 2];
    const vx = p[i + 6] - p[i], vy = p[i + 7] - p[i + 1], vz = p[i + 8] - p[i + 2];
    const wx = vx - ux, wy = vy - uy, wz = vz - uz;
    const twice = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    const longest = Math.sqrt(Math.max(ux * ux + uy * uy + uz * uz, vx * vx + vy * vy + vz * vz, wx * wx + wy * wy + wz * wz));
    if (!(longest > 0) || twice / longest < SLIVER) continue;
    for (let k = 0; k < 9; k++) out.push(p[i + k]);
  }
  return out;
}

/**
 * Ниши входов без CSG: проём в вертикальных стенах (cutDoorOpenings) и пять граней ниши — боковые, задняя,
 * пол и потолок. Ниша обрезается по высоте объекта [min, top]: проём, проходящий через несколько частей,
 * каждая вырезает в своих пределах; пол и потолок — только у той части, где они есть.
 * Ориентация граней не важна (материал зданий двусторонний). Нечего делать — undefined.
 */
export function recessEntrances(walls: ArrayLike<number>, places: RecessPlace[],
  opts: { width: number; height: number; min: number; top: number; depth?: number }): number[] | undefined {
  if (!places.length || !walls.length) return;
  const depth = opts.depth ?? RECESS_DEPTH;
  // Проём — от пола ниши (на земле он на SILL выше порога), иначе под полом осталась бы щель
  const sill = (e: RecessPlace) => (e.z <= 1e-3 ? SILL : 0);
  const doors = places.map((e) => ({ x: e.p[0], y: e.p[1], z: e.z + sill(e), width: e.width ?? opts.width, height: opts.height - sill(e) }));
  const cut = cutDoorOpenings(Float32Array.from(walls), doors, opts.width, opts.height, ON_WALL);
  const out = dropSlivers(cut);
  const quad = (a: number[], b: number[], c: number[], d: number[]) => out.push(...a, ...b, ...c, ...a, ...c, ...d);
  for (const e of places) {
    const w = (e.width ?? opts.width) / 2;
    const z0 = Math.max(e.z, opts.min), z1 = Math.min(e.z + opts.height, opts.top);
    if (z1 - z0 < 1e-3) continue;
    const at = (s: number, d: number): Pt => [e.p[0] + e.t[0] * s - e.n[0] * d, e.p[1] + e.t[1] * s - e.n[1] * d];
    const [a, b, a2, b2] = [at(-w, 0), at(w, 0), at(-w, depth), at(w, depth)];
    const v = (p: Pt, z: number) => [p[0], p[1], z];
    // Пол ниши — у той части, где порог; на земле — чуть выше, чтобы не мерцать с картой
    const floor = e.z >= opts.min - 1e-3 ? e.z + sill(e) : undefined;
    const lo = floor ?? z0;
    quad(v(a, lo), v(a2, lo), v(a2, z1), v(a, z1)); // боковая
    quad(v(b, lo), v(b2, lo), v(b2, z1), v(b, z1)); // боковая
    quad(v(a2, lo), v(b2, lo), v(b2, z1), v(a2, z1)); // задняя
    if (floor !== undefined) quad(v(a, floor), v(b, floor), v(b2, floor), v(a2, floor));
    if (e.z + opts.height <= opts.top + 1e-3) quad(v(a, z1), v(b, z1), v(b2, z1), v(a2, z1)); // потолок
  }
  return out;
}

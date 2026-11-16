import type { RecessPlace } from './entrance-recess';

type Pt = [number, number];

/** Типы зданий без окон по умолчанию (как в OSM2World, плюс явно служебные). */
const NO_WINDOWS = new Set(['garage', 'garages', 'carport', 'roof', 'greenhouse', 'hangar', 'industrial', 'church',
  'parking', 'transformer_tower', 'water_tower', 'silo', 'storage_tank', 'bunker', 'ruins', 'construction']);

/** Подбор параметров генерации (временная панель): шаг, м; ширина, м; высота и подоконник — доли этажа; простенок у угла, м. */
export const windowTuning = { step: 2, width: 1, height: 0.5, breast: 0.3, corner: 0.5 };
/** Поворот контура меньше этого (рад) — не угол: узел входа посреди стены не делит фасад. */
const STRAIGHT = 0.05;
/** Зазор между окном и входом по горизонтали, м. */
const DOOR_GAP = 0.3;

/** Генерировать ли окна зданию: есть этажи, тип не служебный, нет window=no и стеклянного фасада. */
export function wantsGeneratedWindows(tags: Record<string, string>): boolean {
  if (tags.window === 'no' || tags.windows === 'no') return false;
  if (!(Number(tags['building:levels']) > 0)) return false;
  if (tags['building:material'] === 'glass' || tags.material === 'glass') return false;
  if (tags.parking === 'multi-storey') return false;
  const type = tags['building:part'] && tags['building:part'] !== 'yes' ? tags['building:part'] : tags.building;
  return !NO_WINDOWS.has(type ?? '');
}

export interface WindowGenOpts {
  /** Низ и верх стен части, м. */
  min: number;
  top: number;
  /** Этажей в части (building:levels − building:min_level). */
  levels: number;
  width: number;
  /** Шаг окон вдоль фасада, м. */
  step: number;
  /** От угла до края окна — не меньше, м. */
  corner: number;
  /** Доли высоты этажа. */
  height: number;
  breast: number;
  /** Входы части: окно, перекрывающее вход, не ставится. */
  doors: RecessPlace[];
  doorWidth: number;
  doorHeight: number;
  /** За стеной в точке p на высоте z — другой объём (глухая стена к соседу). */
  blocked: (p: Pt, z: number) => boolean;
  /** В стене в точке p (чуть внутри объёма) на высотах z0..z1 — проём (арка): окна там нет. */
  hole?: (p: Pt, t: Pt, z0: number, z1: number) => boolean;
}

/** Окна на фасадах части: по этажам, равным шагом вдоль каждой стены. rings — кольца полигона (первое — внешнее). */
export function generateWindows(polygons: Pt[][][], o: WindowGenOpts): RecessPlace[] {
  const out: RecessPlace[] = [];
  const levelH = (o.top - o.min) / o.levels;
  if (!(levelH > 1.5)) return out;
  const h = o.height * levelH, breast = o.breast * levelH;
  for (const rings of polygons) rings.forEach((ring, r) => {
    let area = 0;
    for (let i = 0; i < ring.length; i++) { const a = ring[i], b = ring[(i + 1) % ring.length]; area += a[0] * b[1] - b[0] * a[1]; }
    // Наружу из объёма: у внешнего кольца — вправо от обхода против часовой, у дыр — наоборот
    const right = (area > 0) === (r === 0);
    // Фасады — между настоящими углами: вершины на прямой (узлы входов, стыки) фасад не делят
    const m = ring.length;
    const corners: number[] = [];
    for (let i = 0; i < m; i++) {
      const p = ring[(i + m - 1) % m], c = ring[i], q = ring[(i + 1) % m];
      const a1 = Math.atan2(c[1] - p[1], c[0] - p[0]), a2 = Math.atan2(q[1] - c[1], q[0] - c[0]);
      const d = Math.abs(Math.atan2(Math.sin(a2 - a1), Math.cos(a2 - a1)));
      if (d > STRAIGHT) corners.push(i);
    }
    if (corners.length < 2) return;
    for (let ci = 0; ci < corners.length; ci++) {
      const a = ring[corners[ci]], b = ring[corners[(ci + 1) % corners.length]];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const n = Math.round(len / o.step);
      if (n < 1 || len < o.width + 2 * o.corner) continue;
      const t: Pt = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
      const nrm: Pt = right ? [t[1], -t[0]] : [-t[1], t[0]];
      const step = len / n;
      for (let k = 0; k < n; k++) {
        const s = Math.min(Math.max((k + 0.5) * step, o.corner + o.width / 2), len - o.corner - o.width / 2);
        const p: Pt = [a[0] + t[0] * s, a[1] + t[1] * s];
        const probe: Pt = [p[0] + nrm[0] * 0.3, p[1] + nrm[1] * 0.3];
        const inner: Pt = [p[0] - nrm[0] * 0.3, p[1] - nrm[1] * 0.3];
        for (let l = 0; l < o.levels; l++) {
          const z = o.min + l * levelH + breast;
          if (z + h > o.top - 0.05) continue;
          if (o.blocked(probe, z + h / 2)) continue;
          if (o.hole?.(inner, t, z - 0.2, z + h + 0.2)) continue;
          const door = o.doors.some((d) => {
            const along = (d.p[0] - p[0]) * t[0] + (d.p[1] - p[1]) * t[1];
            const off = Math.abs((d.p[0] - p[0]) * nrm[0] + (d.p[1] - p[1]) * nrm[1]);
            const dh = d.height ?? o.doorHeight, dw = d.width ?? o.doorWidth;
            return off < 0.5 && Math.abs(along) < (o.width + dw) / 2 + DOOR_GAP && z < d.z + dh + 0.2 && z + h > d.z;
          });
          if (!door) out.push({ p, t, n: nrm, z, width: o.width, height: h });
        }
      }
    }
  });
  return out;
}

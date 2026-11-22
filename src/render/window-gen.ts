import type { RecessPlace } from './entrance-recess';

type Pt = [number, number];

/** Типы зданий без окон по умолчанию (как в OSM2World, плюс явно служебные). */
const NO_WINDOWS = new Set(['garage', 'garages', 'carport', 'roof', 'greenhouse', 'hangar', 'industrial', 'church',
  'parking', 'transformer_tower', 'water_tower', 'silo', 'storage_tank', 'bunker', 'ruins', 'construction']);

/** Подбор параметров генерации (временная панель): шаг, м; ширина, м; высота и подоконник — доли этажа; простенок у угла, м. */
export const windowTuning = { step: 3, width: 1, height: 0.5, breast: 0.27, corner: 2, alignDoors: true };
/** Поворот контура меньше этого (рад) — не угол: узел входа посреди стены не делит фасад. */
const STRAIGHT = 0.05;
/** Зазор между окном и входом по горизонтали, м. */
const DOOR_GAP = 0.3;

/** Генерировать ли окна зданию: есть этажи, тип не служебный, нет window=no и стеклянного фасада. */
export function wantsGeneratedWindows(tags: Record<string, string>): boolean {
  if (tags.window === 'no' || tags.windows === 'no') return false;
  if (!(Number(tags['building:levels']) > 0) && !partWindowSize(tags)) return false;
  if (tags['building:material'] === 'glass' || tags.material === 'glass') return false;
  if (tags.parking === 'multi-storey') return false;
  const type = tags['building:part'] && tags['building:part'] !== 'yes' ? tags['building:part'] : tags.building;
  return !NO_WINDOWS.has(type ?? '');
}

/** Размеры окон части из её тегов window:width / window:height / window:breast (м), если задано хоть одно. */
export function partWindowSize(tags: Record<string, string>): { width?: number; height?: number; breast?: number } | undefined {
  const m = (k: string, zero = false) => { const v = parseFloat(tags[k] ?? ''); return Number.isFinite(v) && (v > 0 || (zero && v === 0)) ? v : undefined; };
  const r = { width: m('window:width'), height: m('window:height'), breast: m('window:breast', true) };
  return r.width === undefined && r.height === undefined && r.breast === undefined ? undefined : r;
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
  /** Окна поровну по фасаду: сколько влезает с простенком, одно — по середине (размеры окон заданы тегами части). */
  even?: boolean;
  /** Ставить ось окон над каждым входом фасада, остальные — равномерно между входами и углами. */
  alignDoors?: boolean;
  /** Доли высоты этажа. */
  height: number;
  breast: number;
  /** Входы части: окно, перекрывающее вход, не ставится. */
  doors: (RecessPlace & { reach?: number })[];
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
      // Фасад — ломаная между углами (у плавно изогнутой стены — много узлов): окна ставятся по её длине на сам отрезок
      const i0 = corners[ci], i1 = corners[(ci + 1) % corners.length];
      const pts: Pt[] = [];
      for (let i = i0; ; i = (i + 1) % m) { pts.push(ring[i]); if (i === i1 && pts.length > 1) break; }
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
      const len = cum[cum.length - 1];
      if (len < o.width + 2 * o.corner) continue;
      const frame = (k: number) => {
        const a = pts[k], b = pts[k + 1], l = cum[k + 1] - cum[k] || 1;
        const t: Pt = [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
        return { a, t, nrm: (right ? [t[1], -t[0]] : [-t[1], t[0]]) as Pt };
      };
      /** Точка, направление и нормаль на расстоянии s вдоль фасада. */
      const at = (s: number) => {
        let k = 0;
        while (k < pts.length - 2 && cum[k + 1] < s) k++;
        const f = frame(k);
        return { ...f, p: [f.a[0] + f.t[0] * (s - cum[k]), f.a[1] + f.t[1] * (s - cum[k])] as Pt };
      };
      /** Проекция точки на фасад: расстояние вдоль и отступ от стены. */
      const project = (q: Pt) => {
        let best = { s: 0, off: Infinity };
        for (let k = 0; k < pts.length - 1; k++) {
          const f = frame(k), l = cum[k + 1] - cum[k];
          const along = Math.max(0, Math.min(l, (q[0] - f.a[0]) * f.t[0] + (q[1] - f.a[1]) * f.t[1]));
          const off = Math.hypot(q[0] - f.a[0] - f.t[0] * along, q[1] - f.a[1] - f.t[1] * along);
          if (off < best.off) best = { s: cum[k] + along, off };
        }
        return best;
      };
      const lo = o.corner + o.width / 2, hi = len - o.corner - o.width / 2;
      // Оси входов на этом фасаде (вдоль, м); близкие — одна ось
      const axes: number[] = [];
      if (o.alignDoors) for (const d of o.doors.map((d) => ({ d, ...project(d.p) })).filter((x) => x.off < (x.d.reach ?? 0.5) && x.s >= lo && x.s <= hi).map((x) => x.s).sort((x, y) => x - y))
        if (!axes.length || d - axes[axes.length - 1] > o.step / 2) axes.push(d);
      const cols: number[] = [];
      if (!axes.length) {
        // Оси окон — между крайними (простенок у угла от края окна), шаг ближайший к заданному
        const k = Math.round((hi - lo) / o.step);
        if (o.even) {
          // Сколько окон влезает с простенком (step − width) между ними — по середине равных долей фасада
          const n = Math.max(1, Math.floor((len - 2 * o.corner + o.step - o.width) / o.step));
          for (let j = 0; j < n; j++) cols.push(len * (j + 0.5) / n);
        } else if (k < 1) cols.push((lo + hi) / 2);
        else for (let j = 0; j <= k; j++) cols.push(lo + (hi - lo) * j / k);
      } else {
        // Между угловым окном (lo/hi) и входом и между входами — равный шаг, ближайший к заданному
        const span = (from: number, to: number, withFrom: boolean, withTo: boolean) => {
          const k = Math.max(1, Math.round((to - from) / o.step));
          for (let j = withFrom ? 0 : 1; j <= (withTo ? k : k - 1); j++) cols.push(from + (to - from) * j / k);
        };
        if (axes[0] - lo >= o.step / 2) span(lo, axes[0], true, false);
        axes.forEach((x, i) => { cols.push(x); if (i + 1 < axes.length) span(x, axes[i + 1], false, false); });
        const last = axes[axes.length - 1];
        if (hi - last >= o.step / 2) span(last, hi, false, true);
      }
      for (const s of cols) {
        const { p, t, nrm } = at(s);
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
            return off < (d.reach ?? 0.5) && Math.abs(along) < (o.width + dw) / 2 + DOOR_GAP && z < d.z + dh + 0.2 && z + h > d.z;
          });
          if (!door) out.push({ p, t, n: nrm, z, width: o.width, height: h });
        }
      }
    }
  });
  return out;
}

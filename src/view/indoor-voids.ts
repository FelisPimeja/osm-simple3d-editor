import polygonClipping, { type MultiPolygon } from 'polygon-clipping';

/** Пустоты задаются многоуровневыми помещениями; отсутствие разметки не означает второй свет. */
type Pt = [number, number];

export interface LevelPlan {
  /** Контур этажа: следы объектов здания, которые есть на этом этаже (или полигоны indoor=level). */
  floor: MultiPolygon;
  /** Всё размеченное на этаже: помещения, коридоры, зоны, колонны и стены. */
  mapped: MultiPolygon;
  /** Явные многоуровневые помещения без пола на этом этаже. */
  explicitVoids?: MultiPolygon;
}

export interface LevelVoid {
  /** Пустота на этом этаже. */
  polygon: MultiPolygon;
  /** Этажи ниже, видимые сквозь неё: от ближнего к самому нижнему (на нём — пол). */
  through: number[];
}

const ringArea = (r: Pt[]) => { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]); return Math.abs(a / 2); };
export const multiArea = (m: MultiPolygon) => m.reduce((s, poly) => s + ringArea(poly[0] as Pt[]) - poly.slice(1).reduce((t, r) => t + ringArea(r as Pt[]), 0), 0);

function safe(fn: () => MultiPolygon): MultiPolygon {
  try { return fn(); } catch { return []; }
}

const open = (r: Pt[]): Pt[] => (r.length && (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1]) ? [...r, r[0]] : r);
/** Only explicitly mapped multilevel spaces create voids. */
export function findVoids(n: number, plans: Map<number, LevelPlan>): LevelVoid[] {
  const plan = plans.get(n);
  if (!plan?.floor.length || !plan.explicitVoids?.length) return [];
  const lower = [...plans.keys()].filter(k => k < n).sort((a,b) => b-a);
  if (!lower.length) return [];
  return plan.explicitVoids.filter(poly => multiArea([poly]) > 1e-6).map(poly => {
    const through: number[] = [], area = multiArea([poly]);
    for (const k of lower) {
      through.push(k);
      if (multiArea(safe(() => polygonClipping.intersection([poly], plans.get(k)!.mapped))) >= area * .999) break;
    }
    return {polygon:[poly], through};
  });
}

/** Объект здания для контура этажа: полигоны (в метрах) и высоты низа и верха стен. */
export interface PlanPart { polygons: Pt[][][]; min: number; wallTop: number }
/** Indoor-объект в метрах. */
export interface PlanIndoor { kind: string; polygons: Pt[][][]; levels: number[]; line?: boolean; /** Этажи, где у объекта пол (floorLevels). */ floors?: number[] }

const unionOf = (polys: Pt[][][]): MultiPolygon => (polys.length ? safe(() => polygonClipping.union(polys[0] as never, ...(polys.slice(1) as never[]))) : []);

/** Планы этажей для поиска пустот. levels — этажи панели (номер, пол и потолок, м). */
export function buildPlans(levels: { n: number; floor: number; ceil: number }[], parts: PlanPart[], indoor: PlanIndoor[]): Map<number, LevelPlan> {
  const plans = new Map<number, LevelPlan>();
  for (const l of levels) {
    const onLevel = indoor.filter((f) => !f.line && f.levels.includes(l.n));
    const levelPolys = onLevel.filter((f) => f.kind === 'level').flatMap((f) => f.polygons.map((p) => p.map(open)));
    const partPolys = parts.filter((p) => p.min <= l.floor + 0.5 && p.wallTop >= l.ceil - 0.5).flatMap((p) => p.polygons.map((q) => q.map(open)));
    // Разметка пола нужна лишь для перекрытия явных многоуровневых пустот. Неразмеченные участки остаются полом.
    const mappedPolys = onLevel.filter((f) => f.kind !== 'level' && (f.floors ?? [Math.min(...f.levels)]).includes(l.n)).flatMap((f) => f.polygons.map((p) => p.map(open)));
    const mapped = unionOf(mappedPolys);
    let floor = unionOf(levelPolys.length ? levelPolys : partPolys);
    // Части не дают контур этажа (подземные этажи — части от земли, неточные высоты этажей): весь след здания
    // и всё, что обведено разметкой (дыры размеченного — тоже этаж): под землёй этаж часто шире следа здания
    if (!levelPolys.length && multiArea(floor) < 0.5 * multiArea(mapped)) {
      const outlines = mappedPolys.map((p) => [p[0]]);
      floor = unionOf([...parts.flatMap((p) => p.polygons.map((q) => q.map(open))), ...outlines]);
    }
    const spaces = indoor.filter(f => !f.line && ['room','area','corridor'].includes(f.kind)
      && f.levels.length > 1 && l.n > Math.min(...f.levels) && l.n <= Math.max(...f.levels)
      && !(f.floors ?? [Math.min(...f.levels)]).includes(l.n))
      .flatMap(f => f.polygons.map(p => p.map(open)));
    const explicitVoids = spaces.length ? safe(() => polygonClipping.intersection(floor, polygonClipping.difference(unionOf(spaces), mapped))) : [];
    plans.set(l.n, { floor, mapped, explicitVoids });
  }
  return plans;
}

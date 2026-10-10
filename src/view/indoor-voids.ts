import polygonClipping, { type MultiPolygon } from 'polygon-clipping';
import { offsetPolygon } from '../edit/offset-tool';

/**
 * Второй свет (атриумы, пустоты в перекрытиях). В Simple Indoor Tagging отдельного тега нет: пустоту рисуют
 * отсутствием размеченного пространства — дырой в коридоре/зоне или просто неразмеченным местом. Ищем так:
 * контур этажа минус всё размеченное на нём; узкие остатки (толщины стен, полосы вдоль фасада, щели между
 * помещениями) убираем морфологическим открытием (сжать на OPEN_WIDTH и расширить обратно); оставляем
 * крупные куски, под которыми этажом ниже — размеченное пространство (если там тоже пусто — свет на несколько
 * этажей: спускаемся дальше). Координаты — метры в локальной плоской системе.
 */

type Pt = [number, number];

/** Полуширина «открытия»: остатки уже 2·OPEN_WIDTH — не пустота, м. */
const OPEN_WIDTH = 1;
/** Меньше этой площади — не пустота, м². */
const MIN_VOID_AREA = 15;
/** Доля контура этажа, покрытая разметкой, начиная с которой неразмеченное считаем пустотой (а не недорисованным). */
const MIN_COVERAGE = 0.5;
/** Этажи ниже (вместе) закрывают пустоту разметкой не меньше чем на эту долю — там пол, видный сквозь неё. */
const FLOOR_BELOW = 0.6;
/** Глубже стольких этажей пустоту не продолжаем. */
const MAX_DEPTH = 4;

export interface LevelPlan {
  /** Контур этажа: следы объектов здания, которые есть на этом этаже (или полигоны indoor=level). */
  floor: MultiPolygon;
  /** Всё размеченное на этаже: помещения, коридоры, зоны, колонны и стены. */
  mapped: MultiPolygon;
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
const unclose = (r: Pt[]): Pt[] => (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1] ? r.slice(0, -1) : r);

/**
 * Морфологическое открытие: убрать части уже 2·w. Каждый кусок обрезается только своим исходным (одно большое
 * пересечение polygon-clipping иногда не собирает кольца на почти совпадающих рёбрах); не вышло — кусок как есть
 * (сжатие и расширение и так почти не выходят за исходный).
 */
function opening(m: MultiPolygon, w: number): MultiPolygon {
  const out: MultiPolygon = [];
  for (const poly of m) {
    const shrunk = offsetPolygon({ ring: unclose(poly[0] as Pt[]), inners: poly.slice(1).map((r) => unclose(r as Pt[])) }, -w);
    if (typeof shrunk === 'string') continue;
    for (const p of shrunk) {
      const back = offsetPolygon({ ring: p[0], inners: p.slice(1) }, w);
      if (typeof back === 'string') continue;
      for (const q of back) {
        const grown = q.map(open);
        try { out.push(...polygonClipping.intersection([poly], [grown] as never)); } catch { out.push(grown); }
      }
    }
  }
  return out;
}

/** Пустоты этажа n. plans — планы этажей по номерам. */
export function findVoids(n: number, plans: Map<number, LevelPlan>): LevelVoid[] {
  const plan = plans.get(n);
  if (!plan || !plan.floor.length || !plan.mapped.length) return [];
  const floorArea = multiArea(plan.floor);
  if (!floorArea) return [];
  const covered = multiArea(safe(() => polygonClipping.intersection(plan.floor, plan.mapped)));
  // Этаж размечен мало: пустоты ищем, только если на нём хоть что-то есть, а один из этажей ниже (свет бывает на
  // несколько этажей) размечен хорошо — галереи вокруг атриума: разметка узкая, остальное — второй свет
  if (covered / floorArea < MIN_COVERAGE) {
    const wellMapped = (k: number) => {
      const p = plans.get(k), a = p ? multiArea(p.floor) : 0;
      return !!p && a > 0 && multiArea(safe(() => polygonClipping.intersection(p.floor, p.mapped))) / a >= MIN_COVERAGE;
    };
    let found = false;
    for (let k = n - 1; k >= n - MAX_DEPTH && !found; k--) found = wellMapped(k);
    if (covered <= 0 || !found) return [];
  }
  const free = opening(safe(() => polygonClipping.difference(plan.floor, plan.mapped)), OPEN_WIDTH);
  const out: LevelVoid[] = [];
  for (const poly of free) {
    const piece: MultiPolygon = [poly];
    const area = multiArea(piece);
    if (area < MIN_VOID_AREA) continue;
    // Пол под пустотой копится по этажам вниз: часть видно на ближнем этаже (эскалаторы у края атриума), часть —
    // глубже; пустота — если суммарно этажи ниже закрывают её не меньше чем на FLOOR_BELOW
    const through: number[] = [];
    let seen: MultiPolygon = [];
    let ok = false;
    for (let k = n - 1; k >= n - MAX_DEPTH; k--) {
      const below = plans.get(k);
      if (!below) break;
      through.push(k);
      seen = safe(() => polygonClipping.union(seen, polygonClipping.intersection(piece, below.mapped)));
      if (multiArea(seen) / area >= FLOOR_BELOW) { ok = true; break; }
    }
    if (ok) out.push({ polygon: piece, through });
  }
  return out;
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
    // Дыры колонн и стен — тоже возможная пустота (стена-кольцо вокруг атриума, relation/17888772); пустотелые
    // колонны и шахты отсеивает проверка этажа ниже: под шахтой до самого низа пусто
    // Объект на нескольких этажах (эскалатор, лестница, зал в два света: level=-1;0) — пол только на нижнем,
    // выше он — пустота (relation/17919018)
    const mappedPolys = onLevel.filter((f) => f.kind !== 'level' && (f.floors ?? f.levels).includes(l.n)).flatMap((f) => f.polygons.map((p) => p.map(open)));
    const mapped = unionOf(mappedPolys);
    let floor = unionOf(levelPolys.length ? levelPolys : partPolys);
    // Части не дают контур этажа (подземные этажи — части от земли, неточные высоты этажей): весь след здания
    // и всё, что обведено разметкой (дыры размеченного — тоже этаж): под землёй этаж часто шире следа здания
    if (!levelPolys.length && multiArea(floor) < 0.5 * multiArea(mapped)) {
      const outlines = mappedPolys.map((p) => [p[0]]);
      floor = unionOf([...parts.flatMap((p) => p.polygons.map((q) => q.map(open))), ...outlines]);
    }
    plans.set(l.n, { floor, mapped });
  }
  return plans;
}

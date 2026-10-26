import type { IndoorFeature } from './model';
import { LEVEL_HEIGHT } from './heights';

/** Правдоподобный шаг этажа, м: часть с шагом вне этих границ в сетку этажей не попадает. */
export const MIN_LEVEL_STEP = 2, MAX_LEVEL_STEP = 10;

/** Этаж панели; src — объект, по тегам которого он посчитан (нет — из indoor-данных). */
export interface Level {
  n: number; floor: number; ceil: number; src?: string;
  /** Из indoor=level этажа: обозначение (level:ref), название, высота задана явно (height). */
  ref?: string; name?: string; explicit?: boolean;
  /** Явные высоты этажей части не уместились в её высоту: этажи выходят выше верха стен. */
  overflow?: boolean;
  /** Объекты indoor=level этажа и высота из их height (даже если в расчёт не пошла — не сходится с частью). */
  levelKeys?: string[]; heightTag?: string;
}

/** Этаж, размеченный indoor=level: высота этажа (height — правдоподобная), level:ref, name. */
export interface LevelInfo { height?: number; heightTag?: string; ref?: string; name?: string; keys: string[] }

/**
 * indoor=level здания по номерам этажей. По вики height на indoor=level — высота самого этажа, а не отметка пола:
 * отметка — сумма высот этажей ниже. Неправдоподобная высота (вся высота здания и т. п.) не в счёт.
 */
export function indoorLevelInfo(indoor: IndoorFeature[]): Map<number, LevelInfo> {
  const out = new Map<number, LevelInfo>();
  for (const f of indoor) {
    if (f.kind !== 'level') continue;
    // indoor=level, совмещённый с частью или зданием (way/666671146: building:part + height=4.2/8.4/12.6), —
    // height там по Simple 3D (верх части), а не высота этажа: не читаем и не правим
    const own = !f.tags['building:part'] && !f.tags.building;
    const h = own ? parseFloat(f.tags.height ?? '') : NaN;
    const height = Number.isFinite(h) && h >= MIN_LEVEL_STEP && h <= MAX_LEVEL_STEP ? h : undefined;
    for (const n of f.levels) {
      const cur = out.get(n);
      out.set(n, { height: cur?.height ?? height, heightTag: cur?.heightTag ?? (own ? f.tags.height : undefined), ref: cur?.ref ?? f.tags['level:ref'], name: cur?.name ?? f.tags.name, keys: [...cur?.keys ?? [], ...(own ? [f.key] : [])] });
    }
  }
  return out;
}

/**
 * Этажи одной части: надземные от building:min_level, подземные из building:levels:underground. Явные высоты
 * (indoor=level + height) применяются всегда: отметка пола — сумма высот ниже, остальные этажи делят остаток
 * высоты стен поровну, но не ниже MIN_LEVEL_STEP. Не уместились в высоту части — overflow (этажи выше верха
 * стен; предупреждение в свойствах этажа). Дробная этажность — поровну все, явные не в счёт.
 * Подвалы — вниз от нуля, каждый своей высоты (явной или шагом части).
 */
export function partLevels(p: { min: number; wallTop: number; levels: number; minLevel: number; under: number; step: number },
  info: Map<number, LevelInfo>): { n: number; floor: number; ceil: number; explicit: boolean; overflow?: boolean }[] {
  const out: { n: number; floor: number; ceil: number; explicit: boolean; overflow?: boolean }[] = [];
  const from = Math.floor(p.minLevel), to = Math.ceil(p.levels);
  const known = [...Array(Math.max(0, to - from)).keys()].map((i) => info.get(from + i)?.height);
  const rest = known.filter((x) => x === undefined).length;
  const sum = known.reduce<number>((a, x) => a + (x ?? 0), 0);
  const restStep = rest ? Math.max(MIN_LEVEL_STEP, (p.wallTop - p.min - sum) / rest) : 0;
  const useKnown = Number.isInteger(p.levels) && Number.isInteger(p.minLevel) && known.some((x) => x !== undefined);
  const overflow = useKnown && sum + rest * restStep > p.wallTop - p.min + 0.01;
  let z = p.min;
  for (let n = from; n < to; n++) {
    const k = useKnown ? known[n - from] : undefined;
    const floor = useKnown ? z : p.min + (n - p.minLevel) * p.step;
    const hn = useKnown ? k ?? restStep : p.step;
    out.push({ n, floor, ceil: floor + hn, explicit: k !== undefined, ...(overflow ? { overflow } : {}) });
    z += hn;
  }
  let zu = 0;
  for (let n = -1; n >= -p.under; n--) {
    const k = info.get(n)?.height;
    out.push({ n, floor: zu - (k ?? p.step), ceil: zu, explicit: k !== undefined });
    zu -= k ?? p.step;
  }
  return out;
}

/**
 * Этажи из indoor-данных, которых нет в этажности: наращиваем от ближайшего известного этажа — вверх пол на
 * потолке этажа ниже, вниз потолок на полу этажа выше; высота — явная (indoor=level) или шаг соседа. Без
 * этажности — от земли: этаж 0 с нуля.
 */
export function withIndoorLevels(levels: Level[], indoor: IndoorFeature[], info: Map<number, LevelInfo> = new Map()): Level[] {
  const have = new Set(levels.map((l) => l.n));
  const extra = new Set<number>();
  for (const f of indoor) for (const n of f.levels) if (Number.isInteger(n) && !have.has(n) && Math.abs(n) < 100) extra.add(n);
  if (!extra.size) return levels;
  const out = [...levels];
  const byN = new Map(levels.map((l) => [l.n, l]));
  // Без этажности — от земли: этаж 0 с нуля. Дальше наращиваем от ближайшего известного этажа: вверх — пол на
  // потолке этажа ниже, вниз — потолок на полу этажа выше; высота — явная (indoor=level) или шаг соседа
  const near = (n: number) => levels.reduce<Level | undefined>((best, l) => (!best || Math.abs(l.n - n) < Math.abs(best.n - n) ? l : best), undefined);
  const stepOf = (n: number) => { const l = near(n); return l ? l.ceil - l.floor : LEVEL_HEIGHT; };
  const add = (l: Level) => { out.push(l); byN.set(l.n, l); };
  const ups = [...extra].filter((n) => n >= 0).sort((a, b) => a - b), downs = [...extra].filter((n) => n < 0).sort((a, b) => b - a);
  for (const n of ups) {
    const below = byN.get(n - 1);
    const hn = info.get(n)?.height ?? stepOf(n);
    const l = near(n);
    const floor = below ? below.ceil : l ? l.floor + (n - l.n) * (l.ceil - l.floor) : n * hn;
    add({ n, floor, ceil: floor + hn, explicit: info.get(n)?.height !== undefined });
  }
  for (const n of downs) {
    const above = byN.get(n + 1);
    const hn = info.get(n)?.height ?? stepOf(n);
    const l = near(n);
    const ceil = above ? above.floor : l ? l.floor + (n + 1 - l.n) * (l.ceil - l.floor) : (n + 1) * hn;
    add({ n, floor: ceil - hn, ceil, explicit: info.get(n)?.height !== undefined });
  }
  return out.sort((x, y) => y.n - x.n);
}

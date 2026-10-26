import type { IndoorFeature } from './model';
import { LEVEL_HEIGHT } from './heights';

/** Правдоподобный шаг этажа, м: часть с шагом вне этих границ в сетку этажей не попадает. */
export const MIN_LEVEL_STEP = 2, MAX_LEVEL_STEP = 10;

/** Этаж панели; src — объект, по тегам которого он посчитан (нет — из indoor-данных). */
export interface Level {
  n: number; floor: number; ceil: number; src?: string;
  /** Из indoor=level этажа: обозначение (level:ref), название, высота задана явно (height). */
  ref?: string; name?: string; explicit?: boolean;
}

/** Этаж, размеченный indoor=level: высота этажа (height — правдоподобная), level:ref, name. */
export interface LevelInfo { height?: number; ref?: string; name?: string }

/**
 * indoor=level здания по номерам этажей. По вики height на indoor=level — высота самого этажа, а не отметка пола:
 * отметка — сумма высот этажей ниже. Неправдоподобная высота (вся высота здания и т. п.) не в счёт.
 */
export function indoorLevelInfo(indoor: IndoorFeature[]): Map<number, LevelInfo> {
  const out = new Map<number, LevelInfo>();
  for (const f of indoor) {
    if (f.kind !== 'level') continue;
    const h = parseFloat(f.tags.height ?? '');
    const height = Number.isFinite(h) && h >= MIN_LEVEL_STEP && h <= MAX_LEVEL_STEP ? h : undefined;
    for (const n of f.levels) {
      const cur = out.get(n) ?? {};
      out.set(n, { height: cur.height ?? height, ref: cur.ref ?? f.tags['level:ref'], name: cur.name ?? f.tags.name });
    }
  }
  return out;
}

/**
 * Этажи одной части: надземные от building:min_level, подземные из building:levels:underground. Явные высоты
 * (indoor=level + height): отметка пола — сумма высот ниже, остальные этажи делят остаток высоты стен поровну.
 * Остаток неправдоподобен (явные высоты не сходятся с высотой части) или этажность дробная — поровну все.
 * Подвалы — вниз от нуля, каждый своей высоты (явной или шагом части).
 */
export function partLevels(p: { min: number; wallTop: number; levels: number; minLevel: number; under: number; step: number },
  info: Map<number, LevelInfo>): { n: number; floor: number; ceil: number; explicit: boolean }[] {
  const out: { n: number; floor: number; ceil: number; explicit: boolean }[] = [];
  const from = Math.floor(p.minLevel), to = Math.ceil(p.levels);
  const known = [...Array(Math.max(0, to - from)).keys()].map((i) => info.get(from + i)?.height);
  const rest = known.filter((x) => x === undefined).length;
  const sum = known.reduce<number>((a, x) => a + (x ?? 0), 0);
  const restStep = rest ? (p.wallTop - p.min - sum) / rest : 0;
  const useKnown = Number.isInteger(p.levels) && Number.isInteger(p.minLevel) && known.some((x) => x !== undefined)
    && (!rest || (restStep >= MIN_LEVEL_STEP && restStep <= MAX_LEVEL_STEP));
  let z = p.min;
  for (let n = from; n < to; n++) {
    const k = useKnown ? known[n - from] : undefined;
    const floor = useKnown ? z : p.min + (n - p.minLevel) * p.step;
    const hn = useKnown ? k ?? restStep : p.step;
    out.push({ n, floor, ceil: floor + hn, explicit: k !== undefined });
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

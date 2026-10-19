import type { ExpressionSpecification, FilterSpecification, Map as MlMap } from 'maplibre-gl';
import { convertFilter, expression } from '@maplibre/maplibre-gl-style-spec';

/**
 * Даты OpenHistoricalMap: объект существует с start_date (включительно) до end_date (не включая).
 * Нет start_date — существовал всегда, нет end_date — существует до сих пор. Даты — десятичные годы
 * (1850-07-01 → 1850.5), как start_decdate/end_decdate в векторных тайлах OHM.
 */

/** Дней в году (пролептический григорианский календарь; год 0 — високосный, как в ISO 8601). */
const daysIn = (y: number) => (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 366 : 365);
/** Номер дня в году с нуля: месяц 1…12, день 1…31. */
function dayOfYear(y: number, m: number, d: number): number {
  const t = new Date(Date.UTC(2000, m - 1, d));
  t.setUTCFullYear(y);
  const t0 = new Date(Date.UTC(2000, 0, 1));
  t0.setUTCFullYear(y);
  return Math.round((t.getTime() - t0.getTime()) / 86400000);
}
/** Десятичный год начала дня: 1850-07-02 → 1850 + 182/365. */
const decimal = (y: number, m = 1, d = 1) => y + dayOfYear(y, m, d) / daysIn(y);

/** Дата из значения OSM: 1850, 1850-03, 1850-03-12, ~1850, 1850s, -0500 (месяц и день — если указаны). */
export function parseDate(v: string | undefined): { y: number; m?: number; d?: number } | undefined {
  const r = v?.trim().replace(/^~/, '').match(/^(-?\d{1,4})(?:-(\d\d))?(?:-(\d\d))?/);
  if (!r) return;
  const y = Number(r[1]), m = r[2] ? Number(r[2]) : undefined, d = r[3] ? Number(r[3]) : undefined;
  if (m !== undefined && (m < 1 || m > 12)) return;
  if (d !== undefined && (d < 1 || d > 31)) return;
  return { y, m, d };
}

/** Десятичный год из значения даты OSM (начало указанного года/месяца/дня); undefined — не разобрали. */
export function decimalDate(v: string | undefined): number | undefined {
  const p = parseDate(v);
  return p && decimal(p.y, p.m, p.d);
}

/** Дата ГГГГ-ММ-ДД для десятичного года (день, в котором он лежит). */
export function isoDay(t: number): string {
  const y = Math.floor(t);
  const doy = Math.min(daysIn(y) - 1, Math.max(0, Math.floor((t - y) * daysIn(y) + 1e-9)));
  const d = new Date(Date.UTC(2000, 0, 1));
  d.setUTCFullYear(y);
  d.setUTCDate(1 + doy); // переполнение дня — по календарю года y
  const yy = y < 0 ? '-' + String(-y).padStart(4, '0') : String(y).padStart(4, '0');
  return `${yy}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** Период карты в десятичных годах [from, to): годы from…to включительно — [from, to + 1). */
export interface DateSpan { from: number; to: number }
export const yearsSpan = (from: number, to: number): DateSpan => ({ from, to: to + 1 });

/** Период значения даты: год — весь год, ГГГГ-ММ — месяц, ГГГГ-ММ-ДД — день. */
export function dateSpan(v: string): DateSpan | undefined {
  const p = parseDate(v);
  if (!p) return;
  if (p.m === undefined) return yearsSpan(p.y, p.y);
  if (p.d === undefined) return { from: decimal(p.y, p.m), to: p.m === 12 ? p.y + 1 : decimal(p.y, p.m + 1) };
  const from = decimal(p.y, p.m, p.d);
  return { from, to: from + 1 / daysIn(p.y) };
}

/** Существовал ли объект с тегами хоть когда-то в периоде. */
export function existsIn(tags: Record<string, string>, span: DateSpan): boolean {
  const start = decimalDate(tags.start_date), end = decimalDate(tags.end_date);
  return (start === undefined || start < span.to) && (end === undefined || end > span.from);
}

/** Выражение MapLibre для фичей тайлов OHM с полями start_decdate/end_decdate. */
function dateExpression(span: DateSpan): ExpressionSpecification {
  return ['all',
    ['any', ['!', ['has', 'start_decdate']], ['<', ['to-number', ['get', 'start_decdate']], span.to]],
    ['any', ['!', ['has', 'end_decdate']], ['>', ['to-number', ['get', 'end_decdate']], span.from]]];
}

/** Исходные фильтры слоёв подложки (до наложения даты): id → фильтр. */
const original = new WeakMap<MlMap, Map<string, unknown>>();

/**
 * Фильтр по дате для слоёв подложки из источника source (undefined — снять). Фильтр слоя дополняется
 * условием даты; фильтр старого синтаксиса (["has", "shop"], ["==", "kind", "x"]) сначала переводится
 * в выражение — смешивать синтаксисы в одном фильтре нельзя.
 */
export function applyBasemapDate(map: MlMap, source: string, t: DateSpan | undefined) {
  let saved = original.get(map);
  if (!saved) {
    saved = new Map();
    for (const l of map.getStyle().layers) if ('source' in l && l.source === source) saved.set(l.id, l.filter);
    original.set(map, saved);
  }
  for (const [id, filter] of saved) {
    if (!map.getLayer(id)) continue;
    const f = filter as FilterSpecification | undefined;
    if (t === undefined) { map.setFilter(id, f ?? null); continue; }
    const base = f === undefined ? undefined : expression.isExpressionFilter(f) ? f : convertFilter(f);
    map.setFilter(id, base === undefined ? dateExpression(t) : ['all', base, dateExpression(t)] as ExpressionSpecification);
  }
}

/** Значение даты OSM с той же точностью, что у образца: год, ГГГГ-ММ или ГГГГ-ММ-ДД. */
function formatDate(y: number, m?: number, d?: number): string {
  const yy = y < 0 ? '-' + String(-y).padStart(4, '0') : String(y);
  if (m === undefined) return yy;
  const ym = `${y < 0 ? yy : yy.padStart(4, '0')}-${String(m).padStart(2, '0')}`;
  return d === undefined ? ym : `${ym}-${String(d).padStart(2, '0')}`;
}

/**
 * Сдвиг даты на n дней ('d'), месяцев ('m') или лет ('y'); точность значения сохраняется, а у шага по дням
 * и месяцам она поднимается до него (1850 + 1 день → 1850-01-02). Несуществующий день (31 февраля) — последний в месяце.
 */
export function shiftDate(v: string, unit: 'd' | 'm' | 'y', n: number): string | undefined {
  const p = parseDate(v);
  if (!p) return;
  if (unit === 'd') {
    const t = decimal(p.y, p.m ?? 1, p.d ?? 1);
    const day = 1 / daysIn(p.y);
    // Шаг назад через границу года — по длине предыдущего года
    return isoDay(n >= 0 ? t + n * day + day / 2 : t + n / daysIn(p.y - (t + n * day < p.y ? 1 : 0)) + day / 2);
  }
  let y = p.y, m = p.m;
  if (unit === 'm') {
    const k = y * 12 + (m ?? 1) - 1 + n;
    y = Math.floor(k / 12);
    m = k - y * 12 + 1;
  } else y += n;
  if (m === undefined) return formatDate(y);
  if (p.d === undefined) return formatDate(y, m);
  const last = new Date(Date.UTC(2000, m, 0));
  last.setUTCFullYear(y, m, 0);
  return formatDate(y, m, Math.min(p.d ?? 1, last.getUTCDate()));
}

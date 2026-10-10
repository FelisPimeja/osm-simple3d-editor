import type { ExpressionSpecification, Map as MlMap } from 'maplibre-gl';

/**
 * Даты OpenHistoricalMap: объект существует с start_date (включительно) до end_date (не включая).
 * Нет start_date — существовал всегда, нет end_date — существует до сих пор. Даты — десятичные годы
 * (1850-07-01 → 1850.5), как start_decdate/end_decdate в векторных тайлах OHM.
 */

/** Десятичный год из значения даты OSM: 1850, 1850-03, 1850-03-12, ~1850, 1850s, -0500; undefined — не разобрали. */
export function decimalDate(v: string | undefined): number | undefined {
  const m = v?.trim().replace(/^~/, '').match(/^(-?\d{1,4})(?:-(\d\d))?(?:-(\d\d))?/);
  if (!m) return;
  const y = Number(m[1]), mo = m[2] ? Number(m[2]) - 1 : 0, d = m[3] ? Number(m[3]) - 1 : 0;
  return y + mo / 12 + d / 365;
}

/** Период карты в десятичных годах [from, to): годы from…to включительно — [from, to + 1). */
export interface DateSpan { from: number; to: number }
export const yearsSpan = (from: number, to: number): DateSpan => ({ from, to: to + 1 });

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
 * условием даты; слои со старым (не выражением) синтаксисом фильтра пропускаем — смешивать нельзя.
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
    const expr = filter === undefined || JSON.stringify(filter).includes('["get"');
    if (!expr) continue;
    const f = filter as ExpressionSpecification | undefined;
    map.setFilter(id, t === undefined ? f ?? null : f ? ['all', f, dateExpression(t)] : dateExpression(t));
  }
}

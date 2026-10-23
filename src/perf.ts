/**
 * Логирование производительности: медленные операции и зависания главного потока.
 * Включается в консоли: localStorage['osm3d.perf'] = '1' (и перезагрузка); в dev-сборке включено всегда.
 * Сводка — perfReport() в консоли (в dev); после первой загрузки печатается сама.
 */

const ENABLED = (() => {
  if (typeof window === 'undefined') return false; // тесты в Node
  try { return import.meta.env?.DEV || localStorage.getItem('osm3d.perf') === '1'; } catch { return false; }
})();

/** Операции дольше этого порога пишутся в консоль сразу, мс. */
const SLOW_MS = 30;

interface Stat { count: number; total: number; max: number }
const stats = new Map<string, Stat>();

/** Отметка времени последней замеренной операции (мс от начала загрузки страницы). */
let lastActivity = 0;
let loadReported = false;
let tilesStarted = false;
let quietTimer: ReturnType<typeof setTimeout> | undefined;
/** Сколько тишины считать «загрузка закончилась», мс. */
const QUIET_MS = 3000;

function record(label: string, ms: number, detail?: string | (() => string)) {
  lastActivity = performance.now();
  // Тишину считаем только с первой сборки зданий: до неё грузятся стиль карты, шрифты, база и ответы API
  if (label.includes('треугольники')) tilesStarted = true;
  if (!loadReported && tilesStarted) { clearTimeout(quietTimer); quietTimer = setTimeout(reportLoad, QUIET_MS); }
  const s = stats.get(label) ?? stats.set(label, { count: 0, total: 0, max: 0 }).get(label)!;
  s.count++;
  s.total += ms;
  s.max = Math.max(s.max, ms);
  // Подпись считается только для медленных: у быстрых (тысячи зданий) это лишняя работа
  if (ms >= SLOW_MS) { const d = typeof detail === 'function' ? detail() : detail; console.warn(`[perf] ${label}: ${ms.toFixed(0)} мс${d ? ` (${d})` : ''}`); }
}

/** Замер синхронной операции. detail — строка или функция от результата (например, число объектов). */
export function timed<T>(label: string, fn: () => T, detail?: (r: T) => string): T {
  if (!ENABLED) return fn();
  const t = performance.now();
  const r = fn();
  record(label, performance.now() - t, detail && (() => detail(r)));
  return r;
}

/** Замер асинхронной операции или стадии, засечённой вручную (no-op, если логирование выключено). */
export function recordMs(label: string, ms: number, detail?: string) {
  if (ENABLED) record(label, ms, detail);
}

/** Замер промиса: время от вызова до результата. */
export async function timedAsync<T>(label: string, p: Promise<T>): Promise<T> {
  if (!ENABLED) return p;
  const t = performance.now();
  const r = await p;
  record(label, performance.now() - t);
  return r;
}

/**
 * Первая загрузка закончилась (QUIET_MS без замеренных операций): сводка в консоль. Время — от начала
 * загрузки страницы до последней операции; суммы асинхронных стадий (IndexedDB, воркеры) идут параллельно
 * с основным потоком и могут перекрываться.
 */
function reportLoad() {
  if (loadReported) return;
  loadReported = true;
  console.info(`[perf] загрузка: последняя операция через ${(lastActivity / 1000).toFixed(1)} с после открытия страницы`);
  loadSummary = { lastActivityMs: Math.round(lastActivity), rows: perfReport() };
  if (typeof window !== 'undefined') Object.assign(window, { perfLoad: loadSummary }); // тесты убирают подставной window
}

export function perfReport() {
  const rows = [...stats].map(([label, s]) => ({
    label, count: s.count, 'total, мс': Math.round(s.total), 'avg, мс': +(s.total / s.count).toFixed(1), 'max, мс': Math.round(s.max),
  }));
  rows.sort((a, b) => b['total, мс'] - a['total, мс']);
  console.table(rows);
  return rows;
}

/** Сводка первой загрузки (для чтения из консоли или автотестов): undefined, пока загрузка не закончилась. */
export let loadSummary: { lastActivityMs: number; rows: ReturnType<typeof perfReport> } | undefined;

export function perfReset() {
  stats.clear();
}

if (ENABLED) {
  // Зависания главного потока > 50 мс (Long Tasks API, Chrome/Edge) — с тем, что шло непосредственно перед ними
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) console.warn(`[perf] зависание ${e.duration.toFixed(0)} мс`);
    }).observe({ type: 'longtask', buffered: true });
  } catch { /* браузер не поддерживает */ }
  Object.assign(window, { perfReport, perfReset });
}

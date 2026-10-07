/**
 * Логирование производительности: медленные операции и зависания главного потока.
 * Включается в консоли: localStorage['osm3d.perf'] = '1' (и перезагрузка); в dev-сборке включено всегда.
 * Сводка — perfReport() в консоли (в dev).
 */

const ENABLED = (() => {
  try { return import.meta.env?.DEV || localStorage.getItem('osm3d.perf') === '1'; } catch { return false; }
})();

/** Операции дольше этого порога пишутся в консоль сразу, мс. */
const SLOW_MS = 30;

interface Stat { count: number; total: number; max: number }
const stats = new Map<string, Stat>();

function record(label: string, ms: number, detail?: string) {
  const s = stats.get(label) ?? stats.set(label, { count: 0, total: 0, max: 0 }).get(label)!;
  s.count++;
  s.total += ms;
  s.max = Math.max(s.max, ms);
  if (ms >= SLOW_MS) console.warn(`[perf] ${label}: ${ms.toFixed(0)} мс${detail ? ` (${detail})` : ''}`);
}

/** Замер синхронной операции. detail — строка или функция от результата (например, число объектов). */
export function timed<T>(label: string, fn: () => T, detail?: (r: T) => string): T {
  if (!ENABLED) return fn();
  const t = performance.now();
  const r = fn();
  record(label, performance.now() - t, detail?.(r));
  return r;
}

export function perfReport() {
  const rows = [...stats].map(([label, s]) => ({
    label, count: s.count, 'total, мс': Math.round(s.total), 'avg, мс': +(s.total / s.count).toFixed(1), 'max, мс': Math.round(s.max),
  }));
  console.table(rows.sort((a, b) => b['total, мс'] - a['total, мс']));
}

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

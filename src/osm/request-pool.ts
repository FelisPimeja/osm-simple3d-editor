/**
 * Ограничение параллельных запросов к серверу данных (OSM API): правила OSMF — не больше двух потоков
 * скачивания с одного клиента. После отказа по перегрузке (429/503/509) сервер «остывает».
 */
/** Параллельных запросов на сервер. */
const PER_ENDPOINT = 2;
/** Сколько сервер «остывает» после отказа по перегрузке. */
const COOLDOWN_MS = 30_000;

/** unreachable — последний запрос не дошёл до сервера (таймаут, обрыв соединения); сбрасывается первым успешным. */
export interface Endpoint { url: string; host: string; active: number; coolUntil: number; ok: number; failed: number; unreachable: boolean }

export class RequestPool {
  readonly endpoints: Endpoint[];

  constructor(urls: string[]) {
    this.endpoints = urls.map((url) => ({ url, host: new URL(url).host, active: 0, coolUntil: 0, ok: 0, failed: 0, unreachable: false }));
  }

  /** Свободный сервер или undefined, если все заняты или остывают. */
  acquire(): Endpoint | undefined {
    const now = Date.now();
    const free = this.endpoints.filter((e) => e.coolUntil <= now && e.active < PER_ENDPOINT);
    const ep = free.sort((a, b) => a.active - b.active)[0];
    if (ep) ep.active++;
    return ep;
  }

  release(ep: Endpoint, result: 'ok' | 'busy' | 'error' | 'aborted', unreachable = false) {
    ep.active--;
    if (result === 'ok') { ep.ok++; ep.unreachable = false; }
    if (unreachable) ep.unreachable = true;
    if (result === 'busy' || result === 'error') ep.failed++;
    if (result === 'busy') ep.coolUntil = Date.now() + COOLDOWN_MS;
  }

  /** Через сколько мс освободится ближайший остывающий сервер (0 — есть доступные). */
  nextAvailableIn(): number {
    const now = Date.now();
    if (this.endpoints.some((e) => e.coolUntil <= now)) return 0;
    return Math.min(...this.endpoints.map((e) => e.coolUntil - now));
  }
}

import type { Bbox, OsmElement } from './api';

/**
 * Публичные инстансы Overpass с полной планетой и CORS.
 * (2026-10: overpass.private.coffee и overpass.kumi.systems не отвечали, overpass.osm.ch — только Швейцария.)
 */
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  // VK/mail.ru
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
/** Параллельных запросов на один инстанс (у overpass-api.de 4 слота на IP — оставляем запас). */
const PER_ENDPOINT = 2;
/** Сколько инстанс «остывает» после 429/504/сетевой ошибки. */
const COOLDOWN_MS = 30_000;

export class OverpassBusyError extends Error {}

export interface Endpoint { url: string; host: string; active: number; coolUntil: number; ok: number; failed: number }

/** Пул инстансов: запрос уходит на наименее загруженный здоровый инстанс. */
export class OverpassPool {
  readonly endpoints: Endpoint[];

  /** urls — инстансы Overpass (по умолчанию публичные) или единственный адрес OSM API. */
  constructor(urls: string[] = ENDPOINTS) {
    this.endpoints = urls.map((url) => ({ url, host: new URL(url).host, active: 0, coolUntil: 0, ok: 0, failed: 0 }));
  }

  /** Свободный инстанс или undefined, если все заняты или остывают. */
  acquire(): Endpoint | undefined {
    const now = Date.now();
    const free = this.endpoints.filter((e) => e.coolUntil <= now && e.active < PER_ENDPOINT);
    const ep = free.sort((a, b) => a.active - b.active)[0];
    if (ep) ep.active++;
    return ep;
  }

  release(ep: Endpoint, result: 'ok' | 'busy' | 'error' | 'aborted') {
    ep.active--;
    if (result === 'ok') ep.ok++;
    if (result === 'busy' || result === 'error') ep.failed++;
    if (result === 'busy') ep.coolUntil = Date.now() + COOLDOWN_MS;
  }

  /** Через сколько мс освободится ближайший остывающий инстанс (0 — есть доступные). */
  nextAvailableIn(): number {
    const now = Date.now();
    if (this.endpoints.some((e) => e.coolUntil <= now)) return 0;
    return Math.min(...this.endpoints.map((e) => e.coolUntil - now));
  }
}

/**
 * Здания и части в bbox со всеми членами отношений и узлами.
 * `out body` без meta: версий нет — для просмотра они не нужны, редактирование берёт данные из API.
 * (`out geom` проверяли — не быстрее: время уходит на очередь сервера, а не на выдачу.)
 */
export async function fetchBuildings(endpoint: string, [w, s, e, n]: Bbox, signal?: AbortSignal): Promise<OsmElement[]> {
  const bbox = `${s},${w},${n},${e}`;
  const query = `[out:json][timeout:60];
(
  way["building"](${bbox});
  way["building:part"](${bbox});
  relation["building"]["type"="multipolygon"](${bbox});
  relation["building:part"]["type"="multipolygon"](${bbox});
  relation["type"="building"](${bbox});
);
out body;
>;
out skel qt;`;
  const host = new URL(endpoint).host;
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(query)}`,
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    // Ответ 429 бывает без CORS-заголовков — браузер видит его как сетевую ошибку
    throw new OverpassBusyError(`${host}: сеть/лимит (${(err as Error).message})`);
  }
  // 429 — превышен лимит слотов, 504 — сервер перегружен: имеет смысл повторить позже
  if (res.status === 429 || res.status === 504) throw new OverpassBusyError(`${host}: ${res.status}`);
  if (!res.ok) throw new Error(`${host}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as { elements: OsmElement[] }).elements;
}

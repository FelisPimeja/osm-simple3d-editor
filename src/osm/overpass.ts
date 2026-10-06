import type { Bbox, OsmElement } from './api';

/**
 * Публичные инстансы Overpass с полной планетой и CORS. При перегрузке одного переключаемся на следующий.
 * (2026-10: overpass.private.coffee и overpass.kumi.systems не отвечали, overpass.osm.ch — только Швейцария.)
 */
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
let current = 0;

export class OverpassBusyError extends Error {}

function switchEndpoint() {
  current = (current + 1) % ENDPOINTS.length;
  console.info('Overpass: переключаемся на', ENDPOINTS[current]);
}

/**
 * Здания и части в bbox со всеми членами отношений и узлами.
 * `out body` без meta: версий нет — для просмотра они не нужны, редактирование берёт данные из API.
 */
export async function fetchBuildings([w, s, e, n]: Bbox, signal?: AbortSignal): Promise<OsmElement[]> {
  const bbox = `${s},${w},${n},${e}`;
  const query = `[out:json][timeout:60];
(
  way["building"](${bbox});
  way["building:part"](${bbox});
  relation["building"]["type"="multipolygon"](${bbox});
  relation["building:part"]["type"="multipolygon"](${bbox});
);
out body;
>;
out skel qt;`;
  const endpoint = ENDPOINTS[current];
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
    if (endpoint === ENDPOINTS[current]) switchEndpoint();
    throw new OverpassBusyError(`${new URL(endpoint).host}: сеть/лимит (${(err as Error).message})`);
  }
  // 429 — превышен лимит слотов, 504 — сервер перегружен: имеет смысл повторить позже
  if (res.status === 429 || res.status === 504) {
    if (endpoint === ENDPOINTS[current]) switchEndpoint();
    throw new OverpassBusyError(`${new URL(endpoint).host}: ${res.status}`);
  }
  if (!res.ok) throw new Error(`Overpass ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as { elements: OsmElement[] }).elements;
}

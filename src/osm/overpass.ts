import type { Bbox, OsmElement } from './api';
import { RAILWAYS } from './roads';

/**
 * Overpass — первая линия загрузки тайлов боевого OSM: в отличие от /map отдаёт только нужное (здания, помещения,
 * деревья), ответ в десятки раз меньше и не расходует лимит скачивания OSM API. При отказе тайл идёт через /map.
 * (2026-10: из публичных инстансов стабильно отвечает только overpass-api.de; mail.ru — 504, остальные молчат.)
 */
const ENDPOINT = 'https://overpass-api.de/api/interpreter';
/** Дольше — считаем, что сервер в очереди, и идём в OSM API. */
const TIMEOUT_MS = 20_000;
/** Пауза после отказа (429/504, таймаут, неполный ответ) — сервер «остывает», тайлы идут через API. */
const COOLDOWN_MS = 3 * 60_000;

let active = false;
let coolUntil = 0;

/** Свободен ли Overpass: один запрос за раз (слотов на IP мало), не во время паузы после отказа. */
export const overpassFree = () => !active && Date.now() >= coolUntil;

/**
 * Здания, части, помещения, точки этажей, деревья и леса в bbox — в том же виде, что /map (с версиями, узлы путей).
 * Отношения-леса — без членов: большие леса (сотни путей) догружает completeRelations, только небольшие.
 * roads — ещё дороги и рельсовые пути (для объёмных мостов и тоннелей; без галок не качаем — ответ заметно больше).
 */
export async function fetchOverpassTile([w, s, e, n]: Bbox, signal: AbortSignal, roads = false): Promise<OsmElement[]> {
  const b = `${s},${w},${n},${e}`;
  const roadSets = roads ? `\n  way["highway"](${b}); way["railway"~"^(${[...RAILWAYS].join('|')})$"](${b});` : '';
  const query = `[out:json][timeout:25];
(
  way["building"](${b}); way["building:part"](${b});
  relation["building"](${b}); relation["building:part"](${b}); relation["type"="building"](${b});
  way["indoor"](${b}); relation["indoor"](${b}); node["level"](${b}); node["repeat_on"](${b});
  node["natural"="tree"](${b}); way["natural"="tree_row"](${b});
  way["natural"="wood"](${b}); way["landuse"="forest"](${b});${roadSets}
)->.a;
.a out meta;
.a >;
out skel qt;
(relation["natural"="wood"](${b}); relation["landuse"="forest"](${b}););
out meta;`;
  active = true;
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(query)}`,
      signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
    });
    if (!res.ok) throw new Error(`Overpass ${res.status}`);
    const json = (await res.json()) as { elements: OsmElement[]; remark?: string };
    // При перегрузке Overpass отвечает 200 с частью данных и remark «runtime error…» — такой ответ неполный
    if (json.remark && /runtime error|timed out|out of memory/i.test(json.remark)) throw new Error(`Overpass: ${json.remark.slice(0, 120)}`);
    return json.elements;
  } catch (err) {
    // Отмена пользователем (ушли с тайла) — не вина сервера
    if (!signal.aborted) coolUntil = Date.now() + COOLDOWN_MS;
    throw err;
  } finally {
    active = false;
  }
}

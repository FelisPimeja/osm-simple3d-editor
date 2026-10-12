import { getToken } from './auth';
import { server } from './servers';
import { tr } from '../i18n';

export type Bbox = [west: number, south: number, east: number, north: number];

/** Временно: один лог на каждый фактический запрос данных, включая отмены и ошибки. */
const LOG_API_REQUESTS = true;
function logApiRequest(kind: 'map' | 'relation', api: string, target: string, context: string | undefined,
  status: number | 'network error' | 'aborted', started: number, elements?: number, contentLength?: string | null) {
  if (!LOG_API_REQUESTS) return;
  console.info('[OSM API]', {
    kind, host: new URL(api).host, target, context, status,
    ms: Math.round(performance.now() - started),
    elements,
    bytes: contentLength ? Number(contentLength) : undefined,
  });
}

export interface OsmNode { type: 'node'; id: number; lat: number; lon: number; tags?: Record<string, string> }
export interface OsmWay { type: 'way'; id: number; nodes: number[]; tags?: Record<string, string>; version: number }
export interface OsmMember { type: 'node' | 'way' | 'relation'; ref: number; role: string }
export interface OsmRelation { type: 'relation'; id: number; members: OsmMember[]; tags?: Record<string, string>; version: number }
export type OsmElement = OsmNode | OsmWay | OsmRelation;

// /map отдаёт все узлы и пути в bbox плюс отношения, которые на них ссылаются.
// Члены отношений за пределами bbox не приходят — такие мультиполигоны будут неполными.
export async function fetchMap(bbox: Bbox, api = server().api, signal?: AbortSignal, context?: string): Promise<OsmElement[]> {
  const started = performance.now();
  let status: number | 'network error' | 'aborted' = 'network error';
  let count: number | undefined;
  let contentLength: string | null = null;
  try {
    const res = await fetch(`${api}/map.json?bbox=${bbox.join(',')}`, { signal });
    status = res.status;
    contentLength = res.headers.get('content-length');
    if (!res.ok) {
      const text = await res.text();
      throw new ApiError(res.status, `OSM API ${res.status}: ${text || res.statusText}`, retryAfterMs(res, text));
    }
    const data = (await res.json()) as { elements: OsmElement[] };
    count = data.elements.length;
    return data.elements;
  } catch (err) {
    if (signal?.aborted) status = 'aborted';
    throw err;
  } finally {
    logApiRequest('map', api, bbox.join(','), context, status, started, count, contentLength);
  }
}

/** retryAfter — через сколько мс сервер разрешил повторить (Retry-After или «try again in N seconds» у 509). */
export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly retryAfter?: number) { super(message); }
}

function retryAfterMs(res: Response, text: string): number | undefined {
  const header = Number(res.headers.get('retry-after'));
  if (header > 0) return header * 1000;
  const m = /try again in (\d+) seconds?/i.exec(text);
  return m ? Number(m[1]) * 1000 : undefined;
}

/**
 * /map по области любого размера: при отказе «слишком много узлов/большая область» (400)
 * делим на четыре и запрашиваем по частям (до depth уровней).
 */
export async function fetchMapSplit(bbox: Bbox, api = server().api, signal?: AbortSignal, depth = 4, context?: string): Promise<OsmElement[]> {
  try {
    return await fetchMap(bbox, api, signal, context);
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 400 || depth <= 0) throw err;
  }
  const [w, s, e, n] = bbox;
  const mx = (w + e) / 2, my = (s + n) / 2;
  const quads: Bbox[] = [[w, s, mx, my], [mx, s, e, my], [w, my, mx, n], [mx, my, e, n]];
  const seen = new Map<string, OsmElement>();
  // По очереди — не заваливать API параллельными тяжёлыми запросами
  for (const q of quads) for (const el of await fetchMapSplit(q, api, signal, depth - 1, context)) seen.set(`${el.type}/${el.id}`, el);
  return [...seen.values()];
}

/** Отношение со всеми членами и их узлами. */
export async function fetchRelationFull(id: number, api = server().api, signal?: AbortSignal, context?: string): Promise<OsmElement[]> {
  const started = performance.now();
  let status: number | 'network error' | 'aborted' = 'network error';
  let count: number | undefined;
  let contentLength: string | null = null;
  try {
    const res = await fetch(`${api}/relation/${id}/full.json`, { signal });
    status = res.status;
    contentLength = res.headers.get('content-length');
    if (!res.ok) throw new Error(tr('OSM API {status} для relation/{id}', { status: res.status, id }));
    const elements = ((await res.json()) as { elements: OsmElement[] }).elements;
    count = elements.length;
    return elements;
  } catch (err) {
    if (signal?.aborted) status = 'aborted';
    throw err;
  } finally {
    logApiRequest('relation', api, String(id), context, status, started, count, contentLength);
  }
}

/** Догрузить мультиполигоны, у которых часть членов вне запрошенной области (elements дополняется на месте). */
export async function completeRelations(
  elements: OsmElement[], isIncomplete: (elements: OsmElement[]) => number[], api = server().api, signal?: AbortSignal, context?: string,
): Promise<OsmElement[]> {
  const missing = isIncomplete(elements);
  // Неполный результат (часть зданий без геометрии) не должен выглядеть как полный — иначе он попадёт в кеш
  if (missing.length > 200) throw new Error(tr('слишком много неполных мультиполигонов ({n})', { n: missing.length }));
  const extra: OsmElement[] = [];
  // По одному: тайлы и так грузятся в два потока, а правила OSMF — не больше двух потоков скачивания
  for (let i = 0; i < missing.length; i++) {
    const batch = await Promise.allSettled([fetchRelationFull(missing[i], api, signal, context)]);
    for (const r of batch) {
      if (r.status === 'rejected') throw new Error(tr('не догрузилось отношение: {error}', { error: (r.reason as Error).message }));
      extra.push(...r.value);
    }
  }
  const seen = new Set(elements.map((e) => `${e.type}/${e.id}`));
  for (const e of extra) {
    const key = `${e.type}/${e.id}`;
    if (!seen.has(key)) { seen.add(key); elements.push(e); }
  }
  return elements;
}

/** Дольше этого после 509 не ждём — пусть пользователь повторит сам, мс. */
const MAX_WAIT = 120_000;

/**
 * Чтение текущих версий (перед отправкой правок). С токеном, если вошли: лимит скачивания API тогда считается
 * по пользователю, а не по IP, который уже потратила загрузка тайлов. После 509 ждём названное сервером время.
 */
async function getJson(url: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const token = server().api === url.slice(0, server().api.length) ? getToken() : undefined;
    const res = await fetch(url, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
    if (res.ok) return res;
    const text = await res.text();
    const wait = retryAfterMs(res, text);
    if (res.status === 509 && attempt < 2 && wait !== undefined && wait <= MAX_WAIT) {
      apiWaitListener?.(Math.ceil(wait / 1000));
      await new Promise((r) => setTimeout(r, wait + 1000));
      continue;
    }
    throw new ApiError(res.status, `OSM API ${res.status}: ${text || res.statusText}`, wait);
  }
}

let apiWaitListener: ((seconds: number) => void) | undefined;
/** Кому сообщать об ожидании после 509 (статус отправки правок). */
export function onApiWait(f: ((seconds: number) => void) | undefined) { apiWaitListener = f; }

/** Текущие узлы (с версиями и тегами) по id. */
export async function fetchNodes(ids: number[], api = server().api): Promise<Map<number, OsmNode & { version: number }>> {
  const out = new Map<number, OsmNode & { version: number }>();
  for (let i = 0; i < ids.length; i += 100) {
    const res = await getJson(`${api}/nodes.json?nodes=${ids.slice(i, i + 100).join(',')}`);
    for (const e of ((await res.json()) as { elements: (OsmNode & { version: number })[] }).elements) out.set(e.id, e);
  }
  return out;
}

/** Текущие версии путей и отношений (multi-fetch, пачками по 100). */
export async function fetchElements(keys: string[], api = server().api): Promise<Map<string, OsmWay | OsmRelation>> {
  const out = new Map<string, OsmWay | OsmRelation>();
  for (const type of ['way', 'relation'] as const) {
    const ids = keys.filter((k) => k.startsWith(`${type}/`)).map((k) => k.split('/')[1]);
    for (let i = 0; i < ids.length; i += 100) {
      const res = await getJson(`${api}/${type}s.json?${type}s=${ids.slice(i, i + 100).join(',')}`);
      for (const e of ((await res.json()) as { elements: (OsmWay | OsmRelation)[] }).elements) out.set(`${e.type}/${e.id}`, e);
    }
  }
  return out;
}

/** Отношения, в которые входит путь (текущие версии). */
export async function fetchWayRelations(id: number, api = server().api): Promise<OsmRelation[]> {
  const res = await getJson(`${api}/way/${id}/relations.json`);
  return ((await res.json()) as { elements: OsmRelation[] }).elements;
}

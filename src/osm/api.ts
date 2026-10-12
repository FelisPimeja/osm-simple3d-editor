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
      throw new ApiError(res.status, `OSM API ${res.status}: ${text || res.statusText}`);
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

export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
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

/** Текущие версии путей и отношений (multi-fetch, пачками по 100). */
/** Текущие узлы (с версиями и тегами) по id. */
export async function fetchNodes(ids: number[], api = server().api): Promise<Map<number, OsmNode & { version: number }>> {
  const out = new Map<number, OsmNode & { version: number }>();
  for (let i = 0; i < ids.length; i += 100) {
    const res = await fetch(`${api}/nodes.json?nodes=${ids.slice(i, i + 100).join(',')}`);
    if (!res.ok) throw new Error(`OSM API ${res.status}: ${(await res.text()) || res.statusText}`);
    for (const e of ((await res.json()) as { elements: (OsmNode & { version: number })[] }).elements) out.set(e.id, e);
  }
  return out;
}

export async function fetchElements(keys: string[], api = server().api): Promise<Map<string, OsmWay | OsmRelation>> {
  const out = new Map<string, OsmWay | OsmRelation>();
  for (const type of ['way', 'relation'] as const) {
    const ids = keys.filter((k) => k.startsWith(`${type}/`)).map((k) => k.split('/')[1]);
    for (let i = 0; i < ids.length; i += 100) {
      const res = await fetch(`${api}/${type}s.json?${type}s=${ids.slice(i, i + 100).join(',')}`);
      if (!res.ok) throw new Error(`OSM API ${res.status}: ${(await res.text()) || res.statusText}`);
      for (const e of ((await res.json()) as { elements: (OsmWay | OsmRelation)[] }).elements) out.set(`${e.type}/${e.id}`, e);
    }
  }
  return out;
}

/** Отношения, в которые входит путь (текущие версии). */
export async function fetchWayRelations(id: number, api = server().api): Promise<OsmRelation[]> {
  const res = await fetch(`${api}/way/${id}/relations.json`);
  if (!res.ok) throw new Error(`OSM API ${res.status}: ${(await res.text()) || res.statusText}`);
  return ((await res.json()) as { elements: OsmRelation[] }).elements;
}

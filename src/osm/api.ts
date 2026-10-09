import { server } from './servers';

export type Bbox = [west: number, south: number, east: number, north: number];

export interface OsmNode { type: 'node'; id: number; lat: number; lon: number; tags?: Record<string, string> }
export interface OsmWay { type: 'way'; id: number; nodes: number[]; tags?: Record<string, string>; version: number }
export interface OsmMember { type: 'node' | 'way' | 'relation'; ref: number; role: string }
export interface OsmRelation { type: 'relation'; id: number; members: OsmMember[]; tags?: Record<string, string>; version: number }
export type OsmElement = OsmNode | OsmWay | OsmRelation;

// /map отдаёт все узлы и пути в bbox плюс отношения, которые на них ссылаются.
// Члены отношений за пределами bbox не приходят — такие мультиполигоны будут неполными.
export async function fetchMap(bbox: Bbox, api = server().api, signal?: AbortSignal): Promise<OsmElement[]> {
  const res = await fetch(`${api}/map.json?bbox=${bbox.join(',')}`, { signal });
  if (!res.ok) {
    const text = await res.text();
    throw new ApiError(res.status, `OSM API ${res.status}: ${text || res.statusText}`);
  }
  const data = (await res.json()) as { elements: OsmElement[] };
  return data.elements;
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/**
 * /map по области любого размера: при отказе «слишком много узлов/большая область» (400)
 * делим на четыре и запрашиваем по частям (до depth уровней).
 */
export async function fetchMapSplit(bbox: Bbox, api = server().api, signal?: AbortSignal, depth = 4): Promise<OsmElement[]> {
  try {
    return await fetchMap(bbox, api, signal);
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 400 || depth <= 0) throw err;
  }
  const [w, s, e, n] = bbox;
  const mx = (w + e) / 2, my = (s + n) / 2;
  const quads: Bbox[] = [[w, s, mx, my], [mx, s, e, my], [w, my, mx, n], [mx, my, e, n]];
  const seen = new Map<string, OsmElement>();
  // По очереди — не заваливать API параллельными тяжёлыми запросами
  for (const q of quads) for (const el of await fetchMapSplit(q, api, signal, depth - 1)) seen.set(`${el.type}/${el.id}`, el);
  return [...seen.values()];
}

/** Отношение со всеми членами и их узлами. */
export async function fetchRelationFull(id: number, api = server().api, signal?: AbortSignal): Promise<OsmElement[]> {
  const res = await fetch(`${api}/relation/${id}/full.json`, { signal });
  if (!res.ok) throw new Error(`OSM API ${res.status} для relation/${id}`);
  return ((await res.json()) as { elements: OsmElement[] }).elements;
}

/** /map + догрузка мультиполигонов, у которых часть членов вне bbox. */
export async function fetchArea(
  bbox: Bbox, isIncomplete: (elements: OsmElement[]) => number[], api = server().api, signal?: AbortSignal,
): Promise<OsmElement[]> {
  const elements = await fetchMapSplit(bbox, api, signal);
  const missing = isIncomplete(elements);
  // Неполный результат (часть зданий без геометрии) не должен выглядеть как полный — иначе он попадёт в кеш
  if (missing.length > 200) throw new Error(`слишком много неполных мультиполигонов (${missing.length})`);
  const extra: OsmElement[] = [];
  // Небольшими пачками, чтобы не заваливать API параллельными запросами
  for (let i = 0; i < missing.length; i += 6) {
    const batch = await Promise.allSettled(missing.slice(i, i + 6).map((id) => fetchRelationFull(id, api, signal)));
    for (const r of batch) {
      if (r.status === 'rejected') throw new Error(`не догрузилось отношение: ${(r.reason as Error).message}`);
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

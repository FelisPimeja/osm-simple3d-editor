export const OSM_API = 'https://api.openstreetmap.org/api/0.6';

export type Bbox = [west: number, south: number, east: number, north: number];

export interface OsmNode { type: 'node'; id: number; lat: number; lon: number; tags?: Record<string, string> }
export interface OsmWay { type: 'way'; id: number; nodes: number[]; tags?: Record<string, string>; version: number }
export interface OsmMember { type: 'node' | 'way' | 'relation'; ref: number; role: string }
export interface OsmRelation { type: 'relation'; id: number; members: OsmMember[]; tags?: Record<string, string>; version: number }
export type OsmElement = OsmNode | OsmWay | OsmRelation;

// /map отдаёт все узлы и пути в bbox плюс отношения, которые на них ссылаются.
// Члены отношений за пределами bbox не приходят — такие мультиполигоны будут неполными.
export async function fetchMap(bbox: Bbox): Promise<OsmElement[]> {
  const res = await fetch(`${OSM_API}/map.json?bbox=${bbox.join(',')}`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OSM API ${res.status}: ${text || res.statusText}`);
  }
  const data = (await res.json()) as { elements: OsmElement[] };
  return data.elements;
}

/** Отношение со всеми членами и их узлами. */
export async function fetchRelationFull(id: number): Promise<OsmElement[]> {
  const res = await fetch(`${OSM_API}/relation/${id}/full.json`);
  if (!res.ok) throw new Error(`OSM API ${res.status} для relation/${id}`);
  return ((await res.json()) as { elements: OsmElement[] }).elements;
}

/** /map + догрузка мультиполигонов, у которых часть членов вне bbox. */
export async function fetchArea(bbox: Bbox, isIncomplete: (elements: OsmElement[]) => number[]): Promise<OsmElement[]> {
  const elements = await fetchMap(bbox);
  const missing = isIncomplete(elements).slice(0, 200);
  const extra: OsmElement[] = [];
  // Небольшими пачками, чтобы не заваливать API параллельными запросами
  for (let i = 0; i < missing.length; i += 6) {
    const batch = await Promise.allSettled(missing.slice(i, i + 6).map(fetchRelationFull));
    for (const r of batch) if (r.status === 'fulfilled') extra.push(...r.value);
  }
  const seen = new Set(elements.map((e) => `${e.type}/${e.id}`));
  for (const e of extra) {
    const key = `${e.type}/${e.id}`;
    if (!seen.has(key)) { seen.add(key); elements.push(e); }
  }
  return elements;
}

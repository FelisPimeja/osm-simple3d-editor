import type { OsmElement, OsmNode, OsmWay } from './api';
import type { LonLat } from './model';

/**
 * Объект с готовой 3D-моделью (тег 3dmr=<id>, репозиторий 3dmr.eu), кроме зданий и частей — те приходят
 * объектами Feature3D: узел, путь или отношение (крепость, мост, памятник). p — куда ставить модель
 * (узел, центр вершин пути или членов отношения); ring — вершины, по ним размер в плане (поправка единиц).
 */
export interface ModelNode { id: number; type?: 'node' | 'way' | 'relation'; p: LonLat; tags: Record<string, string>; ring?: LonLat[] }

const isBuilding = (t: Record<string, string>) => t.building !== undefined || t['building:part'] !== undefined;

export function modelObjectKey(m: ModelNode): string { return `${m.type ?? 'node'}/${m.id}`; }

export function parseModelNodes(elements: OsmElement[]): ModelNode[] {
  const out: ModelNode[] = [];
  const nodes = new Map<number, OsmNode>(), ways = new Map<number, OsmWay>();
  for (const el of elements) {
    if (el.type === 'node') nodes.set(el.id, el);
    else if (el.type === 'way') ways.set(el.id, el);
  }
  const coords = (ids: number[]) => ids.map((id) => nodes.get(id)).filter((n): n is OsmNode => !!n).map((n): LonLat => [n.lon, n.lat]);
  const centre = (pts: LonLat[]): LonLat => [pts.reduce((a, c) => a + c[0], 0) / pts.length, pts.reduce((a, c) => a + c[1], 0) / pts.length];
  for (const el of elements) {
    const t = el.tags;
    if (!t?.['3dmr']) continue;
    if (el.type === 'node') { out.push({ id: el.id, p: [el.lon, el.lat], tags: t }); continue; }
    if (isBuilding(t)) continue;
    const ring = el.type === 'way'
      ? coords(el.nodes[0] === el.nodes[el.nodes.length - 1] ? el.nodes.slice(0, -1) : el.nodes)
      : el.members.filter((m) => m.type === 'way').flatMap((m) => coords(ways.get(m.ref)?.nodes ?? []));
    // Член отношения или путь целиком вне ответа — не знаем, куда ставить
    if (!ring.length) continue;
    out.push({ id: el.id, type: el.type, p: centre(ring), tags: t, ring });
  }
  return out;
}

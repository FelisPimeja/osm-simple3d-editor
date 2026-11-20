import { looseLength } from './heights';
import type { OsmElement, OsmNode, OsmRelation, OsmWay } from './api';
import { joinRings, pointInRing, type LonLat } from './model';

/** Вид листвы: из leaf_type, а без него — по роду/виду (хвойные). mixed — смешанный лес. */
export type LeafType = 'broadleaved' | 'needleleaved' | 'mixed';

/** Отдельное дерево (natural=tree): размеры — из тегов, если указаны, м. */
export interface TreePoint { key?: string; tags?: Record<string, string>; p: LonLat; leaf?: LeafType; height?: number; crown?: number; trunk?: number }
/** Ряд деревьев (natural=tree_row) — ломаная. */
export interface TreeRow { key: string; line: LonLat[]; leaf?: LeafType; height?: number; crown?: number; dates?: LifeDates; nodes?: number[]; tags?: Record<string, string> }
/** Лес (natural=wood, landuse=forest): кольца без повторённой замыкающей точки. */
/** Путь-член мультиполигона леса: узлы и координаты как в OSM (замкнутый — с повторённым первым узлом). */
export interface WoodMember { key: string; role: 'outer' | 'inner'; nodes: number[]; coords: LonLat[]; tags?: Record<string, string> }
/**
 * У леса-пути — nodes (кольцо без повторённого замыкающего узла) и tags, у мультиполигона — members и tags: их можно
 * править.
 */
export interface WoodArea { key: string; polygons: { outer: LonLat[]; inners: LonLat[][] }[]; leaf?: LeafType; dates?: LifeDates; nodes?: number[]; members?: WoodMember[]; tags?: Record<string, string> }
/** start_date / end_date объекта (OpenHistoricalMap) — для фильтра по дате; нет — существовал всегда. */
export type LifeDates = { start_date?: string; end_date?: string };

function lifeDates(tags: Record<string, string>): LifeDates | undefined {
  if (!tags.start_date && !tags.end_date) return;
  return { ...(tags.start_date ? { start_date: tags.start_date } : {}), ...(tags.end_date ? { end_date: tags.end_date } : {}) };
}
export interface TreeData { points: TreePoint[]; rows: TreeRow[]; woods: WoodArea[] }

export const NO_TREES: TreeData = { points: [], rows: [], woods: [] };

/** Хвойные роды (genus, первое слово species/taxon) — когда leaf_type не указан. */
const CONIFERS = new Set([
  'abies', 'cedrus', 'chamaecyparis', 'cryptomeria', 'cupressus', 'juniperus', 'larix', 'metasequoia', 'picea',
  'pinus', 'pseudotsuga', 'sequoia', 'sequoiadendron', 'taxodium', 'taxus', 'thuja', 'tsuga', 'platycladus',
]);

export function leafOf(tags: Record<string, string>): LeafType | undefined {
  const t = tags.leaf_type;
  if (t === 'needleleaved') return 'needleleaved';
  if (t === 'broadleaved' || t === 'leafless') return 'broadleaved';
  if (t === 'mixed') return 'mixed';
  for (const k of ['genus', 'species', 'taxon']) {
    const g = tags[k]?.trim().split(/\s+/)[0]?.toLowerCase();
    if (g) return CONIFERS.has(g) ? 'needleleaved' : 'broadleaved';
  }
  return undefined;
}

/** Число из тега в метрах («12», «12 m», «12.5м»); undefined — нет или нелепое. */
function meters(v: string | undefined, max: number): number | undefined {
  if (!v) return undefined;
  const n = looseLength(v.replace(',', '.').replace(/\s*м$/, ''));
  return Number.isFinite(n) && n > 0 && n <= max ? n : undefined;
}

/** Ряд деревьев из пути (теги, узлы, ломаная) — и для правок сессии. */
export function rowFromWay(key: string, tags: Record<string, string>, nodes: number[], line: LonLat[]): TreeRow {
  return { key, line, leaf: leafOf(tags), height: meters(tags.height, 150), crown: meters(tags.diameter_crown, 60), dates: lifeDates(tags), nodes, tags };
}
/** Лес из замкнутого пути: nodes и outer — кольцо без повторённой замыкающей вершины. */
export function woodFromWay(key: string, tags: Record<string, string>, nodes: number[], outer: LonLat[]): WoodArea {
  return { key, polygons: [{ outer, inners: [] }], leaf: leafOf(tags), dates: lifeDates(tags), nodes, tags };
}

/** Лес-мультиполигон из колец (правки сессии, вставка). */
export function woodFromRings(key: string, tags: Record<string, string>, polygons: WoodArea['polygons'], members?: WoodMember[]): WoodArea {
  return { key, polygons, leaf: leafOf(tags), dates: lifeDates(tags), tags, ...(members ? { members } : {}) };
}

/**
 * Кольца мультиполигона из путей-членов (узлы и координаты): внешние — из outer, дыры — в своё внешнее кольцо.
 * Кольца без повторённой замыкающей точки; не собрались — пусто.
 */
export function ringsFromMembers(members: WoodMember[]): WoodArea['polygons'] {
  const at = new Map<number, LonLat>();
  for (const m of members) m.nodes.forEach((id, i) => at.set(id, m.coords[i]));
  const outers = joinRings(members.filter((m) => m.role !== 'inner').map((m) => m.nodes));
  const inners = joinRings(members.filter((m) => m.role === 'inner').map((m) => m.nodes));
  if (!outers) return [];
  const polygons: WoodArea['polygons'] = [];
  for (const r of outers) if (r.length >= 4) polygons.push({ outer: r.slice(0, -1).map((id) => at.get(id)!), inners: [] });
  for (const r of inners ?? []) {
    if (r.length < 4) continue;
    const inner = r.slice(0, -1).map((id) => at.get(id)!);
    polygons.find((p) => pointInRing(inner[0], p.outer))?.inners.push(inner);
  }
  return polygons;
}

export function isWood(tags?: Record<string, string>): boolean {
  return tags?.natural === 'wood' || tags?.landuse === 'forest';
}

/** Деревья, ряды и леса из ответа OSM API. Неполные мультиполигоны лесов пропускаются. */
export function parseTrees(elements: OsmElement[]): TreeData {
  const nodes = new Map<number, OsmNode>();
  const ways = new Map<number, OsmWay>();
  const relations: OsmRelation[] = [];
  for (const e of elements) {
    if (e.type === 'node') nodes.set(e.id, e);
    else if (e.type === 'way') { if (!ways.get(e.id)?.tags || e.tags) ways.set(e.id, e); }
    else relations.push(e);
  }
  const coords = (ids: number[]): LonLat[] | null => {
    const out: LonLat[] = [];
    for (const id of ids) {
      const n = nodes.get(id);
      if (!n) return null;
      out.push([n.lon, n.lat]);
    }
    return out;
  };

  const points: TreePoint[] = [];
  for (const n of nodes.values()) {
    if (n.tags?.natural !== 'tree') continue;
    const circ = meters(n.tags.circumference, 30);
    points.push({
      key: `node/${n.id}`, tags: n.tags, p: [n.lon, n.lat], leaf: leafOf(n.tags), height: meters(n.tags.height ?? n.tags.est_height, 150),
      crown: meters(n.tags.diameter_crown, 60), ...(circ ? { trunk: circ / (2 * Math.PI) } : {}),
    });
  }

  const rows: TreeRow[] = [];
  const woods: WoodArea[] = [];
  for (const w of ways.values()) {
    if (w.tags?.natural === 'tree_row') {
      const line = coords(w.nodes);
      if (line && line.length >= 2) rows.push(rowFromWay(`way/${w.id}`, w.tags, w.nodes.slice(), line));
      continue;
    }
    if (!isWood(w.tags) || w.nodes.length < 4 || w.nodes[0] !== w.nodes[w.nodes.length - 1]) continue;
    const outer = coords(w.nodes.slice(0, -1));
    if (outer) woods.push(woodFromWay(`way/${w.id}`, w.tags!, w.nodes.slice(0, -1), outer));
  }
  for (const r of relations) {
    if (r.tags?.type !== 'multipolygon' || !isWood(r.tags)) continue;
    const segs = { outer: [] as number[][], inner: [] as number[][] };
    let incomplete = false;
    for (const m of r.members) {
      if (m.type !== 'way') continue;
      const w = ways.get(m.ref);
      if (!w) { incomplete = true; break; }
      (m.role === 'inner' ? segs.inner : segs.outer).push(w.nodes);
    }
    const outerRings = incomplete ? null : joinRings(segs.outer);
    const innerRings = incomplete ? null : joinRings(segs.inner);
    if (!outerRings || !innerRings) continue;
    const polygons: WoodArea['polygons'] = [];
    for (const ring of outerRings) {
      const outer = coords(ring.slice(0, -1));
      if (outer && outer.length >= 3) polygons.push({ outer, inners: [] });
    }
    for (const ring of innerRings) {
      const inner = coords(ring.slice(0, -1));
      if (!inner || inner.length < 3) continue;
      polygons.find((p) => pointInRing(inner[0], p.outer))?.inners.push(inner);
    }
    if (!polygons.length) continue;
    // Пути-члены с узлами — для правки (все узлы есть — иначе мультиполигон только показывается)
    const members: WoodMember[] = [];
    for (const m of r.members) {
      const w = m.type === 'way' ? ways.get(m.ref) : undefined, cs = w && coords(w.nodes);
      if (!w || !cs) { members.length = 0; break; }
      members.push({ key: `way/${w.id}`, role: m.role === 'inner' ? 'inner' : 'outer', nodes: w.nodes.slice(), coords: cs, ...(w.tags ? { tags: w.tags } : {}) });
    }
    woods.push(woodFromRings(`relation/${r.id}`, r.tags, polygons, members.length ? members : undefined));
  }
  return { points, rows, woods };
}

/**
 * id мультиполигонов-лесов, у которых в выборке не хватает путей: не больше limit и только не слишком большие
 * (огромные лесные массивы целиком не нужны) и ещё не собранные в других тайлах (known).
 */
export function incompleteWoodRelations(known: Set<string>, limit = 5, maxMembers = 300) {
  return (elements: OsmElement[]): number[] => {
    const ways = new Set(elements.filter((e) => e.type === 'way').map((e) => e.id));
    return elements
      .filter((e): e is OsmRelation => e.type === 'relation' && e.tags?.type === 'multipolygon' && isWood(e.tags))
      .filter((r) => !known.has(`relation/${r.id}`) && r.members.length <= maxMembers)
      .filter((r) => r.members.some((m) => m.type === 'way' && !ways.has(m.ref)))
      .map((r) => r.id)
      .slice(0, limit);
  };
}

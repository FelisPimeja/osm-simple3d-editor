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
/** Полоса без деревьев леса вдоль дороги, рельсов или водотока: ось и полуширина полосы с отступом, м. */
export interface Clearance { line: LonLat[]; r: number }
export interface TreeData {
  points: TreePoint[]; rows: TreeRow[]; woods: WoodArea[]; clear?: Clearance[];
  /** Леса-мультиполигоны, задевающие тайл, но собранные не в нём (их пути — за границей): догружаются по id, если ни один тайл их не держит. */
  woodRels?: number[];
}

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

/** Отдельное дерево из узла (теги, точка) — и для правок сессии. */
export function treeFromNode(key: string, tags: Record<string, string>, p: LonLat): TreePoint {
  const circ = meters(tags.circumference, 30);
  return { key, tags, p, leaf: leafOf(tags), height: meters(tags.height ?? tags.est_height, 150), crown: meters(tags.diameter_crown, 60), ...(circ ? { trunk: circ / (2 * Math.PI) } : {}) };
}

export function isWood(tags?: Record<string, string>): boolean {
  return tags?.natural === 'wood' || tags?.landuse === 'forest';
}

/** Отступ деревьев леса от края дороги, рельсов, водотока, м. */
const CLEAR_GAP = 3;
const ROAD_HALF: Record<string, number> = {
  motorway: 6, trunk: 5.5, primary: 4.5, secondary: 4, tertiary: 3.5, unclassified: 3, residential: 3, living_street: 2.5,
  motorway_link: 3.5, trunk_link: 3.5, primary_link: 3, secondary_link: 3, tertiary_link: 3, service: 2, track: 1.5,
  pedestrian: 2, footway: 0.8, path: 0.6, cycleway: 1, bridleway: 0.8, steps: 0.8,
};
const RAIL_HALF: Record<string, number> = { rail: 2.5, light_rail: 2, narrow_gauge: 1.5, tram: 1.5, subway: 2.5, preserved: 2 };
const WATER_HALF: Record<string, number> = { river: 6, canal: 4, stream: 1, drain: 0.8, ditch: 0.6, brook: 0.8, tidal_channel: 3 };

/** Полуширина полосы пути, м (по тегу width, иначе по виду); undefined — не мешает лесу (тоннель, не дорога). */
function clearHalf(tags: Record<string, string>): number | undefined {
  if (tags.tunnel && tags.tunnel !== 'no') return;
  const half = tags.highway ? ROAD_HALF[tags.highway] : tags.railway ? RAIL_HALF[tags.railway] : tags.waterway ? WATER_HALF[tags.waterway] : undefined;
  if (half === undefined) return;
  const w = meters(tags.width, 200);
  return (w ? w / 2 : half) + CLEAR_GAP;
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
    points.push(treeFromNode(`node/${n.id}`, n.tags, [n.lon, n.lat]));
  }

  const rows: TreeRow[] = [];
  const woods: WoodArea[] = [];
  const clear: Clearance[] = [];
  for (const w of ways.values()) {
    const half = w.tags && clearHalf(w.tags);
    if (half) { const line = coords(w.nodes); if (line && line.length >= 2) clear.push({ line, r: half }); }
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
  return { points, rows, woods, clear };
}

/** Больше путей — огромный массив, целиком не догружаем. */
export const WOOD_REL_MAX_MEMBERS = 300;

/**
 * id мультиполигонов-лесов, у которых в выборке не хватает путей: не больше limit и только не слишком большие
 * (огромные лесные массивы целиком не нужны) и ещё не собранные в других тайлах (known).
 */
export function incompleteWoodRelations(known: Set<string>, limit = 5, maxMembers = WOOD_REL_MAX_MEMBERS) {
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

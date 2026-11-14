import { computeHeights } from './heights';
import polygonClipping, { type MultiPolygon as ClipMulti } from 'polygon-clipping';
import type { OsmElement, OsmNode, OsmRelation, OsmWay } from './api';

export type LonLat = [number, number];

/** Кольца без повторённой замыкающей точки. */
/** outerIds/innerIds — id узлов колец (параллельно координатам); в старом кеше их нет. */
export interface Polygon { outer: LonLat[]; inners: LonLat[][]; outerIds?: number[]; innerIds?: number[][] }

export interface Feature3D {
  key: string; // 'way/123' | 'relation/456'
  type: 'way' | 'relation';
  id: number;
  version: number;
  tags: Record<string, string>;
  kind: 'building' | 'part';
  polygons: Polygon[];
  /** Контур здания, у которого есть building:part — сам не рендерится. */
  hasParts: boolean;
  /** У мультиполигона — его пути-члены (для правки топологии); в старом кеше нет. */
  ways?: MemberWay[];
  /** Узлы контура с entrance=* (вход на фасаде): id и теги узла. */
  entrances?: Entrance[];
}

/** at — вход не узел контура объекта, а лежит на его стене (дверь indoor-стены на фасаде): там его и ставить. */
export interface Entrance { id: number; tags: Record<string, string>; at?: LonLat }

/** Путь-член мультиполигона: id, роль, узлы (как в OSM, у замкнутого первый = последний) и теги. */
export interface MemberWay { id: number; role: string; nodes: number[]; tags?: Record<string, string> }

/** Отношение type=building: здание, собранное из контура и частей. Своей геометрии нет. */
export interface BuildingGroup {
  key: string; // 'relation/456'
  type: 'relation';
  id: number;
  version: number;
  tags: Record<string, string>;
  /** Ключи членов-путей и отношений (в т. ч. не загруженных). */
  members: string[];
  /** Роли членов (outline, part…) — параллельно members. */
  roles: string[];
}

/** Виды indoor-объектов (Simple Indoor Tagging), которые рисуем поэтажно. */
export type IndoorKind = 'room' | 'area' | 'corridor' | 'level' | 'wall' | 'column' | 'poi';
const INDOOR_KINDS = new Set<string>(['room', 'area', 'corridor', 'level', 'wall', 'column']); // poi — отдельно

/** Помещение, коридор, площадка или этаж целиком (indoor=*), с номерами этажей, на которых он есть. */
/**
 * Этажи, на которых у объекта пол. Объект на нескольких этажах в level (эскалатор, лестница, зал в два света:
 * level=-1;0 или 1-3) — вертикальное пространство: пол только на нижнем, выше — пустота. repeat_on — то же
 * помещение на каждом этаже: пол на каждом; лифтовая шахта обрабатывается отдельно при построении проёмов.
 * Площадь лестницы с осью эскалатора — исключение: её пол только внизу, выше остаётся проём.
 */
export function floorLevels(f: IndoorFeature): number[] {
  const own = parseLevels(f.tags.level);
  const out = new Set(parseLevels(f.tags.repeat_on));
  // Лифтовая шахта отдельно вырезается в плане. Лестницы, как другие многоуровневые комнаты, открыты выше нижнего пола.
  if (own.length > 1 && !f.escalatorArea && isElevatorShaft(f.tags)) for (const l of own) out.add(l);
  out.add(own.length ? Math.min(...own) : f.levels[0] ?? 0);
  return [...out];
}

/** Лифтовая шахта: её проёмы добавляются отдельно при построении плана. */
function isElevatorShaft(t: Record<string, string>): boolean {
  if (t.conveying) return false;
  return t.highway === 'elevator' || t.elevator === 'yes' || t.room === 'elevator';
}

export interface IndoorFeature {
  key: string;
  tags: Record<string, string>;
  kind: IndoorKind;
  polygons: Polygon[];
  /** Точечный объект (kind=poi): дверь, лифт, туалет, магазин… — узел или точка на поверхности помещения. */
  point?: LonLat;
  /** Стена-линия (indoor=wall на незамкнутом или замкнутом пути): outer — ломаная, не кольцо. */
  line?: boolean;
  /** Ось эскалатора (highway=steps + conveying=*), либо площадь вокруг такой оси. */
  escalator?: boolean;
  /**
   * Транспорт внутри здания (вокзал): platform — платформа (railway=platform, public_transport=platform), rail — путь
   * (railway=rail и т. п.). Берутся и без level — тогда этаж 0 и noLevel (валидатор предложит указать этаж).
   */
  transit?: 'platform' | 'rail';
  /** Уровень не размечен (нет level и repeat_on): этаж выбран по умолчанию. */
  noLevel?: boolean;
  /** Путь вокзала: куски оси в пределах здания (рисуются рельсами); сама геометрия с узлами — целиком, для правки. */
  trackRuns?: LonLat[][];
  /** Лестница (highway=steps без conveying) — модель и правка как у эскалатора, escalator тоже true. */
  stairs?: boolean;
  escalatorArea?: boolean;
  /** Номера этажей из level (+ repeat_on); без level — [0]. */
  levels: number[];
}

/**
 * Разбирает значение level / repeat_on: '1', '-1', '0.5', '0;1', '1-3' (целые внутри диапазона),
 * '-2--1'. Нераспознанное пропускается.
 */
export function parseLevels(v?: string): number[] {
  const out = new Set<number>();
  for (const raw of (v ?? '').split(';')) {
    const s = raw.trim();
    const range = s.match(/^(-?\d+(?:\.\d+)?)\s*-\s*(-?\d+(?:\.\d+)?)$/);
    if (range) {
      let [a, b] = [Number(range[1]), Number(range[2])];
      if (a > b) [a, b] = [b, a];
      out.add(a);
      for (let l = Math.ceil(a); l <= b && l - a < 200; l++) out.add(l);
      out.add(b);
      continue;
    }
    const n = Number(s);
    if (s && Number.isFinite(n)) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

/** Теги, по которым узел с level — значок на плане этажа (как в indoorequal). */
const POI_KEYS = ['door', 'entrance', 'amenity', 'shop', 'office', 'tourism', 'emergency', 'vending', 'leisure', 'craft', 'healthcare'];

/** Узел или помещение — точечный объект плана этажа. */
export function isIndoorPoi(tags?: Record<string, string>): boolean {
  if (!tags) return false;
  if (tags.room === 'toilet' || tags.room === 'toilets' || tags.room === 'stairs' || tags.room === 'elevator' || tags.room === 'reception' || tags.room === 'security') return true;
  if (tags.indoor === 'door' || tags.highway === 'elevator' || tags.elevator === 'yes' || tags.stairs === 'yes' || tags.highway === 'steps') return true;
  return POI_KEYS.some((k) => tags[k] !== undefined && tags[k] !== 'no');
}

/** Indoor-объект с другими тегами (правка indoor/level в редакторе): вид и этажи — по новым тегам. */
export function withIndoorTags(f: IndoorFeature, tags: Record<string, string>): IndoorFeature {
  const levels = parseLevels(tags.level);
  for (const l of parseLevels(tags.repeat_on)) if (!levels.includes(l)) levels.push(l);
  const kind = f.kind === 'poi' ? 'poi' : indoorKind(tags) ?? f.kind;
  return { ...f, tags, kind, levels: levels.length ? levels.sort((a, b) => a - b) : [0] };
}

/** Платформа или железнодорожный путь (для вокзалов: показываются на плане этажа и без indoor). */
const RAIL_TRACKS = new Set(['rail', 'subway', 'light_rail', 'tram', 'narrow_gauge', 'monorail']);
export function transitOf(t?: Record<string, string>): 'platform' | 'rail' | undefined {
  if (!t) return;
  if (t.railway === 'platform' || t.public_transport === 'platform') return 'platform';
  if (t.railway && RAIL_TRACKS.has(t.railway)) return 'rail';
}

/** Ключи линейных объектов: с ними indoor=yes — признак «внутри», а не площадь (кроме area=yes). */
const LINEAR_KEYS = ['highway', 'railway', 'waterway', 'barrier', 'conveying', 'power'];

function indoorKind(tags?: Record<string, string>): IndoorKind | undefined {
  if (tags?.indoor === 'yes' && tags.barrier === 'fence' && tags.fence_type === 'railing') return 'wall';
  const k = tags?.indoor;
  // indoor=yes — общее «внутреннее пространство», как площадка. Но на линейном объекте (дорожка, рельсы, ограда)
  // это лишь признак «проходит внутри» (way/1154805379: замкнутый highway=footway + indoor=yes) — не площадь
  if (k === 'yes') return tags!.area !== 'yes' && LINEAR_KEYS.some((key) => tags![key] !== undefined) ? undefined : 'area';
  return k && INDOOR_KINDS.has(k) ? k as IndoorKind : undefined;
}

export interface ParseResult {
  features: Feature3D[];
  groups: BuildingGroup[];
  /** Indoor-объекты (помещения и т. п.) — для поэтажных планов. */
  indoor: IndoorFeature[];
  skipped: { key: string; reason: string }[];
}

/**
 * id indoor-мультиполигонов (помещения, коридоры у границы тайла), у которых в выборке не хватает путей;
 * не больше limit — план этажа необязателен, лишние запросы ради него не нужны.
 */
export function incompleteIndoorRelations(elements: OsmElement[], limit = 100): number[] {
  const ways = new Set(elements.filter((e) => e.type === 'way').map((e) => e.id));
  return elements
    .filter((e): e is OsmRelation => e.type === 'relation' && e.tags?.type === 'multipolygon' && !kindOf(e.tags) && !!indoorKind(e.tags))
    .filter((r) => r.members.some((m) => m.type === 'way' && !ways.has(m.ref)))
    .map((r) => r.id)
    .slice(0, limit);
}

/** id мультиполигонов-зданий, у которых в выборке не хватает путей. */
export function incompleteBuildingRelations(elements: OsmElement[]): number[] {
  const ways = new Set(elements.filter((e) => e.type === 'way').map((e) => e.id));
  return elements
    .filter((e): e is OsmRelation => e.type === 'relation' && e.tags?.type === 'multipolygon' && !!kindOf(e.tags))
    .filter((r) => r.members.some((m) => m.type === 'way' && !ways.has(m.ref)))
    .map((r) => r.id);
}

/**
 * Контур без своей высоты и не часть: если это outline отношения type=building, здание целиком нарисовано
 * частями — в просмотре такой контур не рисуем, в режиме здания он выключен по умолчанию и плоский.
 */
export function isBareOutlineTags(tags: Record<string, string>): boolean {
  const part = tags['building:part'];
  return tags.height === undefined && tags['building:levels'] === undefined && (part === undefined || part === 'no');
}

/** Контур здания с building:part — одновременно и часть (рисуется объёмом). */
export function isOutlinePart(tags: Record<string, string>): boolean {
  const part = tags['building:part'];
  return part !== undefined && part !== 'no';
}

export function kindOf(tags?: Record<string, string>): Feature3D['kind'] | undefined {
  if (!tags) return;
  if (tags['building:part'] && tags['building:part'] !== 'no') return 'part';
  if (tags.building && tags.building !== 'no') return 'building';
}

/**
 * Часть здания, размеченная ещё и как помещение, стена или колонна (relation/17748313: building:part + indoor=area
 * + level=1, way/180591366: building:part + indoor=corridor + level=-1) — кроме объёма рисуем и на плане её этажа.
 */
function partIndoorKind(kind: Feature3D['kind'], tags?: Record<string, string>): IndoorKind | undefined {
  if (kind !== 'part' || tags?.level === undefined) return;
  const ik = indoorKind(tags);
  // Стена и колонна (relation/8432745: building:part + indoor=wall + level=0) — на плане чёрная заливка среза
  return ik === 'area' || ik === 'corridor' || ik === 'room' || ik === 'wall' || ik === 'column' ? ik : undefined;
}

export function parseBuildings(elements: OsmElement[]): ParseResult {
  const nodes = new Map<number, OsmNode>();
  const ways = new Map<number, OsmWay>();
  const relations: OsmRelation[] = [];
  for (const e of elements) {
    // Узел тоже приходит дважды (с тегами и голым после «>») — голая копия тегов не затирает
    if (e.type === 'node') { if (!nodes.get(e.id)?.tags || e.tags) nodes.set(e.id, e); }
    // Путь может прийти дважды: с тегами (out body) и ещё раз голым (out skel после «>» от отношений,
    // членом которых он является) — голая копия не должна затирать теги, иначе части отношений пропадают
    else if (e.type === 'way') { if (!ways.get(e.id)?.tags || e.tags) ways.set(e.id, e); }
    else relations.push(e);
  }
  const memberKind = new Map<string, Feature3D['kind']>();
  for (const r of relations) if (r.tags?.type === 'building') {
    for (const m of r.members) {
      if (m.type === 'node') continue;
      if (m.role === 'outline') memberKind.set(`${m.type}/${m.ref}`, 'building');
      if (m.role === 'part') memberKind.set(`${m.type}/${m.ref}`, 'part');
    }
  }

  const features: Feature3D[] = [];
  const groups: BuildingGroup[] = [];
  const indoor: IndoorFeature[] = [];
  const addIndoor = (key: string, tags: Record<string, string>, kind: IndoorKind, polygons: Polygon[], line = false) => {
    const levels = parseLevels(tags.level);
    for (const l of parseLevels(tags.repeat_on)) if (!levels.includes(l)) levels.push(l);
    // Платформа, размеченная и как indoor-площадка (relation/15063503: indoor=area + railway=platform) — тоже транспорт:
    // красится как платформа, а не белым полом зала
    const transit = kind !== 'poi' && !line ? transitOf(tags) : undefined;
    indoor.push({ key, tags, kind, polygons, ...(line ? { line } : {}), ...(transit === 'platform' ? { transit } : {}), levels: levels.length ? levels.sort((a, b) => a - b) : [0] });
    // Помещение-магазин, кафе, туалет… — ещё и значок в его середине
    if (kind !== 'poi' && !line && polygons.length && isIndoorPoi(tags)) {
      const point = pointOnSurface(polygons[0]);
      indoor.push({ key: `${key}#poi`, tags, kind: 'poi', polygons: [], point, levels: indoor[indoor.length - 1].levels });
    }
  };
  // Точечные объекты этажей: узлы с level
  for (const n of nodes.values()) {
    if (n.tags?.level === undefined || !isIndoorPoi(n.tags)) continue;
    const levels = parseLevels(n.tags.level);
    for (const l of parseLevels(n.tags.repeat_on)) if (!levels.includes(l)) levels.push(l);
    if (levels.length) indoor.push({ key: `node/${n.id}`, tags: n.tags, kind: 'poi', polygons: [], point: [n.lon, n.lat], levels });
  }
  const skipped: ParseResult['skipped'] = [];
  const toCoords = (ring: number[]): LonLat[] | null => {
    const out: LonLat[] = [];
    for (const id of ring.slice(0, -1)) {
      const n = nodes.get(id);
      if (!n) return null;
      out.push([n.lon, n.lat]);
    }
    return out.length >= 3 ? out : null;
  };

  for (const w of ways.values()) {
    const kind = memberKind.get(`way/${w.id}`) ?? kindOf(w.tags);
    const ik = kind ? partIndoorKind(kind, w.tags) : indoorKind(w.tags);
    if (!kind && w.tags?.highway === 'steps' && w.tags.conveying && w.tags.conveying !== 'no' && w.nodes[0] !== w.nodes[w.nodes.length - 1]) {
      const pts = w.nodes.map((id) => nodes.get(id)).filter((n): n is OsmNode => !!n).map((n): LonLat => [n.lon, n.lat]);
      if (pts.length >= 2) {
        addIndoor(`way/${w.id}`, w.tags, 'area', [{ outer: pts, inners: [], ...(pts.length === w.nodes.length ? { outerIds: w.nodes.slice() } : {}) }], true);
        indoor[indoor.length - 1].escalator = true;
      }
    } else if (!kind && isStairsLine(w.tags) && w.nodes[0] !== w.nodes[w.nodes.length - 1] && parseLevels(w.tags!.level).length >= 2) {
      const pts = w.nodes.map((id) => nodes.get(id)).filter((n): n is OsmNode => !!n).map((n): LonLat => [n.lon, n.lat]);
      if (pts.length >= 2 && isStraight(pts)) {
        addIndoor(`way/${w.id}`, w.tags!, 'area', [{ outer: pts, inners: [], ...(pts.length === w.nodes.length ? { outerIds: w.nodes.slice() } : {}) }], true);
        Object.assign(indoor[indoor.length - 1], { escalator: true, stairs: true });
      }
    } else if (!kind && !ik && transitOf(w.tags)) {
      // Платформа и путь вокзала — и без indoor, и без level: в здание попадут, если его задевают (отбор — по зданию)
      const t = transitOf(w.tags)!, closed = w.nodes[0] === w.nodes[w.nodes.length - 1];
      const pts = w.nodes.map((id) => nodes.get(id)).filter((n): n is OsmNode => !!n).map((n): LonLat => [n.lon, n.lat]);
      if (t === 'platform' && closed && pts.length >= 4) addIndoor(`way/${w.id}`, w.tags!, 'area', [{ outer: pts.slice(0, -1), inners: [], ...(pts.length === w.nodes.length ? { outerIds: w.nodes.slice(0, -1), innerIds: [] } : {}) }]);
      else if (pts.length >= 2) addIndoor(`way/${w.id}`, w.tags!, 'area', [{ outer: pts, inners: [], ...(pts.length === w.nodes.length ? { outerIds: w.nodes.slice() } : {}) }], true);
      else continue;
      Object.assign(indoor[indoor.length - 1], { transit: t, ...(w.tags!.level === undefined && w.tags!.repeat_on === undefined ? { noLevel: true } : {}) });
    } else if (ik === 'wall') {
      // Стена — ломаная (у замкнутой последняя точка повторяет первую — оставляем, чтобы стена замкнулась)
      const pts = w.nodes.map((id) => nodes.get(id)).filter((n): n is OsmNode => !!n).map((n): LonLat => [n.lon, n.lat]);
      if (pts.length >= 2 && pts.length === w.nodes.length) addIndoor(`way/${w.id}`, w.tags!, ik, [{ outer: pts, inners: [], outerIds: w.nodes.slice() }], true);
    } else if (ik && w.nodes[0] === w.nodes[w.nodes.length - 1]) {
      const outer = toCoords(w.nodes);
      if (outer) addIndoor(`way/${w.id}`, w.tags!, ik, [{ outer, inners: [], outerIds: w.nodes.slice(0, -1), innerIds: [] }]);
    }
    if (!kind) continue;
    const key = `way/${w.id}`;
    if (w.nodes[0] !== w.nodes[w.nodes.length - 1]) { skipped.push({ key, reason: 'незамкнутый путь' }); continue; }
    const outer = toCoords(w.nodes);
    if (!outer) { skipped.push({ key, reason: 'нет узлов' }); continue; }
    features.push({ key, type: 'way', id: w.id, version: w.version, tags: w.tags ?? {}, kind, polygons: [{ outer, inners: [], outerIds: w.nodes.slice(0, -1), innerIds: [] }], hasParts: false });
  }

  for (const r of relations) {
    if (r.tags?.type === 'building') {
      groups.push({
        key: `relation/${r.id}`, type: 'relation', id: r.id, version: r.version, tags: r.tags,
        members: r.members.filter((m) => m.type !== 'node').map((m) => `${m.type}/${m.ref}`),
        roles: r.members.filter((m) => m.type !== 'node').map((m) => m.role),
      });
      continue;
    }
    const kind = memberKind.get(`relation/${r.id}`) ?? kindOf(r.tags);
    const ik = kind ? partIndoorKind(kind, r.tags) : indoorKind(r.tags);
    if ((!kind && !ik) || r.tags?.type !== 'multipolygon') continue;
    const key = `relation/${r.id}`;
    const segs = { outer: [] as number[][], inner: [] as number[][] };
    const memberWays: MemberWay[] = [];
    let incomplete = false;
    for (const m of r.members) {
      if (m.type !== 'way') continue;
      const w = ways.get(m.ref);
      if (!w) { incomplete = true; break; }
      (m.role === 'inner' ? segs.inner : segs.outer).push(w.nodes);
      memberWays.push({ id: w.id, role: m.role, nodes: w.nodes, ...(w.tags ? { tags: w.tags } : {}) });
    }
    const outerRings = incomplete ? null : joinRings(segs.outer);
    const innerRings = incomplete ? null : joinRings(segs.inner);
    if (!outerRings || !innerRings) { skipped.push({ key, reason: 'неполный мультиполигон (члены вне области)' }); continue; }

    const polygons: Polygon[] = [];
    for (const ring of outerRings) {
      const outer = toCoords(ring);
      if (outer) polygons.push({ outer, inners: [], outerIds: ring.slice(0, -1), innerIds: [] });
    }
    for (const ring of innerRings) {
      const inner = toCoords(ring);
      if (!inner) continue;
      const p = polygons.find((p) => pointInRing(inner[0], p.outer));
      if (p) { p.inners.push(inner); p.innerIds!.push(ring.slice(0, -1)); }
    }
    if (ik) { if (polygons.length) addIndoor(key, r.tags!, ik, polygons); if (!kind) continue; }
    if (!polygons.length) { skipped.push({ key, reason: 'нет узлов' }); continue; }
    features.push({ key, type: 'relation', id: r.id, version: r.version, tags: r.tags ?? {}, kind: kind!, polygons, hasParts: false, ways: memberWays });
  }

  for (const f of features) {
    const ids = new Set(f.polygons.flatMap((p) => [...(p.outerIds ?? []), ...(p.innerIds ?? []).flat()]));
    const entrances = [...ids].flatMap((id) => { const t = nodes.get(id)?.tags; return entranceOf(t) ? [{ id, tags: t! }] : []; });
    if (entrances.length) f.entrances = entrances;
  }
  attachWallEntrances(features, nodes);
  markOutlinesWithParts(features, features, groups);
  return { features, groups, indoor, skipped };
}

/** Склеивает пути в замкнутые кольца по общим концевым узлам. null — если кольцо не замыкается. */
export function joinRings(segments: number[][]): number[][] | null {
  const pool = segments.map((s) => [...s]);
  const rings: number[][] = [];
  while (pool.length) {
    let cur = pool.shift()!;
    while (cur[0] !== cur[cur.length - 1]) {
      const end = cur[cur.length - 1];
      const i = pool.findIndex((s) => s[0] === end || s[s.length - 1] === end);
      if (i < 0) return null;
      let next = pool.splice(i, 1)[0];
      if (next[0] !== end) next = next.reverse();
      cur = cur.concat(next.slice(1));
    }
    rings.push(cur);
  }
  return rings;
}

export function pointInRing([x, y]: LonLat, ring: LonLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Индекс рёбер кольца по горизонтальным полосам: в полосе точки — только пересекающие её рёбра. */
interface RingBands { y0: number; k: number; bands: Int32Array[]; n: number }
const ringBands = new WeakMap<LonLat[], RingBands>();
const FAST_MIN = 32;

/**
 * pointInRing для неизменяемых колец загруженных данных (контуры зданий, этажи), которые проверяют тысячи раз:
 * кольцо в сотни вершин — по индексу полос. Кольцо, правленное на месте, дало бы устаревший индекс — для
 * редактируемой геометрии обычный pointInRing.
 */
export function pointInRingFast(p: LonLat, ring: LonLat[]): boolean {
  if (ring.length < FAST_MIN) return pointInRing(p, ring);
  let ix = ringBands.get(ring);
  if (!ix || ix.n !== ring.length) {
    let y0 = Infinity, y1 = -Infinity;
    for (const [, y] of ring) { if (y < y0) y0 = y; if (y > y1) y1 = y; }
    const count = Math.max(1, Math.min(256, ring.length >> 2)), k = count / ((y1 - y0) || 1);
    const lists: number[][] = Array.from({ length: count }, () => []);
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i][1], b = ring[j][1];
      const lo = Math.max(0, Math.floor((Math.min(a, b) - y0) * k)), hi = Math.min(count - 1, Math.floor((Math.max(a, b) - y0) * k));
      for (let t = lo; t <= hi; t++) lists[t].push(i);
    }
    ringBands.set(ring, ix = { y0, k, bands: lists.map((l) => Int32Array.from(l)), n: ring.length });
  }
  const [x, y] = p;
  const t = Math.floor((y - ix.y0) * ix.k);
  if (t < 0 || t >= ix.bands.length) return false;
  let inside = false;
  for (const i of ix.bands[t]) {
    const j = i === 0 ? ring.length - 1 : i - 1;
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function centroid(ring: LonLat[]): LonLat {
  let x = 0, y = 0;
  for (const p of ring) { x += p[0]; y += p[1]; }
  return [x / ring.length, y / ring.length];
}

/** Площадь полигона в условных единицах (градусы², долгота сжата на cos широты). */
function area(p: Polygon): number {
  const k = Math.cos((p.outer[0][1] * Math.PI) / 180);
  const ringArea = (r: LonLat[]) => {
    let a = 0;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]);
    return Math.abs(a / 2) * k;
  };
  return ringArea(p.outer) - p.inners.reduce((s, h) => s + ringArea(h), 0);
}

/**
 * Точка заведомо внутри полигона: центр вершин, а если он снаружи (П- и Г-образные контуры) —
 * середина самого широкого внутреннего отрезка горизонтали через середину по высоте.
 */
export function pointOnSurface(p: Polygon): LonLat {
  const inside = (c: LonLat) => pointInRing(c, p.outer) && !p.inners.some((h) => pointInRing(c, h));
  const c = centroid(p.outer);
  if (inside(c)) return c;
  let s = Infinity, n = -Infinity;
  for (const [, y] of p.outer) { s = Math.min(s, y); n = Math.max(n, y); }
  for (const t of [0.5, 0.25, 0.75, 0.1, 0.9]) {
    const y = s + (n - s) * t;
    const xs: number[] = [];
    for (const ring of [p.outer, ...p.inners]) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if ((yi > y) !== (yj > y)) xs.push(xi + ((y - yi) / (yj - yi)) * (xj - xi));
      }
    }
    xs.sort((a, b) => a - b);
    let best: LonLat | undefined, width = 0;
    for (let i = 0; i + 1 < xs.length; i += 2) {
      if (xs[i + 1] - xs[i] > width) { width = xs[i + 1] - xs[i]; best = [(xs[i] + xs[i + 1]) / 2, y]; }
    }
    if (best) return best;
  }
  return c;
}

/**
 * Контур здания не рисуется, если поверх него есть хоть одна building:part (схема Simple 3D Buildings): части
 * описывают здание целиком. Части — члены его отношения type=building, а без отношения — части, чья точка
 * поверхности лежит в контуре. Контур с building:part (не no) — сам часть: рисуется всегда.
 */
export function markOutlinesWithParts(features: Feature3D[], targets: Feature3D[] = features, groups: BuildingGroup[] = []) {
  const byKey = new Map(features.map((f) => [f.key, f]));
  const groupByOutline = new Map<string, BuildingGroup>();
  const assignedParts = new Set<string>();
  for (const group of groups) {
    for (let i = 0; i < group.members.length; i++) {
      if (group.roles[i] === 'outline') groupByOutline.set(group.members[i], group);
      if (group.roles[i] === 'part') assignedParts.add(group.members[i]);
    }
  }
  // Части раскладываем по сетке ~0.0005° (≈50 м): здание смотрит только ячейки под своими габаритами
  const CELL = 0.0005;
  const grid = new Map<string, { key: string; c: LonLat; min: number }[]>();
  for (const f of features) {
    if (f.kind !== 'part') continue;
    const min = computeHeights(f.tags).min;
    for (const p of f.polygons) {
      const c = pointOnSurface(p);
      const k = `${Math.floor(c[0] / CELL)},${Math.floor(c[1] / CELL)}`;
      (grid.get(k) ?? grid.set(k, []).get(k)!).push({ key: f.key, c, min });
    }
  }
  for (const b of targets) {
    if (b.kind !== 'building') continue;
    // Контур с building:part — сам тоже часть: рисуется объёмом, хоть внутри и другие части
    if (isOutlinePart(b.tags)) { b.hasParts = false; continue; }
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const p of b.polygons) for (const [x, y] of p.outer) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }
    const inside = (c: LonLat) => b.polygons.some((p) => pointInRing(c, p.outer) && !p.inners.some((h) => pointInRing(c, h)));
    const explicit = groupByOutline.get(b.key);
    const candidates = new Set<string>();
    const explicitParts = explicit && new Set(explicit.members.filter((_, i) => explicit.roles[i] === 'part'));
    // Явный состав здания — его части, где бы они ни лежали
    if (explicitParts) for (const key of explicitParts) candidates.add(key);
    for (let i = Math.floor(w / CELL); !explicit && i <= Math.floor(e / CELL); i++) {
      for (let j = Math.floor(s / CELL); j <= Math.floor(n / CELL); j++) {
        for (const part of grid.get(`${i},${j}`) ?? []) {
          if (assignedParts.has(part.key)) continue;
          // Любая часть внутри, и приподнятая (навес над колоннами АЗС — issue #48)
          if (inside(part.c)) candidates.add(part.key);
        }
      }
    }
    b.hasParts = [...candidates].some((key) => byKey.get(key)?.kind === 'part');
  }
}

/** Внутренняя лестница-линия: highway=steps + indoor=yes без конвейера. */
export const isStairsLine = (t?: Record<string, string>) =>
  !!t && t.highway === 'steps' && t.indoor === 'yes' && (!t.conveying || t.conveying === 'no');

/** Ломаная без поворотов: все точки не дальше 0,3 м (и 3 % длины) от отрезка между концами. */
export function isStraight(pts: LonLat[]): boolean {
  const k = Math.cos(pts[0][1] * Math.PI / 180) * 111320, m = 111320;
  const a = pts[0], b = pts[pts.length - 1];
  const dx = (b[0] - a[0]) * k, dy = (b[1] - a[1]) * m, len = Math.hypot(dx, dy);
  if (len < 1e-6) return false;
  const tol = Math.min(0.3, len * 0.03);
  return pts.every((p) => Math.abs(((p[0] - a[0]) * k) * dy - ((p[1] - a[1]) * m) * dx) / len <= tol);
}

/** Вход на стене объекта не дальше этого, м. */
const WALL_ENTRANCE_TOL = 0.1;
/**
 * Тип входа узла: entrance=*, а въезд на парковку (amenity=parking_entrance) без него — гаражный въезд.
 * Тег в данные не пишется: только толкование при отрисовке и проверках.
 */
export function entranceOf(t?: Record<string, string>): string | undefined {
  return t?.entrance ?? (t?.amenity === 'parking_entrance' ? 'garage' : undefined);
}

/**
 * Входы, не входящие в контур ни одного объекта (дверь на indoor-стене, вход с дорожкой), но лежащие на стене
 * объекта: вход в здание — ставим на этот фасад (по точке, а не по вершине).
 */
function attachWallEntrances(features: Feature3D[], nodes: Map<number, OsmNode>) {
  const used = new Set(features.flatMap((f) => (f.entrances ?? []).map((e) => e.id)));
  const loose = [...nodes.values()].filter((n) => entranceOf(n.tags) && !used.has(n.id));
  if (!loose.length) return;
  const pad = 2e-6;
  const boxes = features.map((f) => {
    let w = Infinity, s = Infinity, e = -Infinity, nn = -Infinity;
    for (const p of f.polygons) for (const [x, y] of p.outer) { if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > nn) nn = y; }
    return [w - pad, s - pad, e + pad, nn + pad];
  });
  for (const n of loose) {
    const kx = Math.cos(n.lat * Math.PI / 180) * 111320, ky = 111320;
    for (const [fi, f] of features.entries()) {
      const bx = boxes[fi];
      if (n.lon < bx[0] || n.lon > bx[2] || n.lat < bx[1] || n.lat > bx[3]) continue;
      const on = f.polygons.some((p) => [p.outer, ...p.inners].some((r) => r.some((a, i) => {
        const b = r[(i + 1) % r.length];
        const ex = (b[0] - a[0]) * kx, ey = (b[1] - a[1]) * ky, px = (n.lon - a[0]) * kx, py = (n.lat - a[1]) * ky, l2 = ex * ex + ey * ey;
        const t = l2 ? Math.max(0, Math.min(1, (px * ex + py * ey) / l2)) : 0;
        return Math.hypot(px - ex * t, py - ey * t) <= WALL_ENTRANCE_TOL;
      })));
      if (on) (f.entrances ??= []).push({ id: n.id, tags: n.tags!, at: [n.lon, n.lat] });
    }
  }
}

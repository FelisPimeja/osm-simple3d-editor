import { computeHeights } from './heights';
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
}

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
 * помещение на каждом этаже: пол на каждом.
 */
export function floorLevels(f: IndoorFeature): number[] {
  const own = parseLevels(f.tags.level);
  const out = new Set(parseLevels(f.tags.repeat_on));
  out.add(own.length ? Math.min(...own) : f.levels[0] ?? 0);
  return [...out];
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
  if (tags.indoor === 'door' || tags.highway === 'elevator' || tags.elevator === 'yes' || tags.stairs === 'yes' || tags.highway === 'steps') return true;
  return POI_KEYS.some((k) => tags[k] !== undefined && tags[k] !== 'no');
}

function indoorKind(tags?: Record<string, string>): IndoorKind | undefined {
  const k = tags?.indoor;
  if (k === 'yes') return 'area'; // общее «внутреннее пространство» — как площадка
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

export function kindOf(tags?: Record<string, string>): Feature3D['kind'] | undefined {
  if (!tags) return;
  if (tags['building:part'] && tags['building:part'] !== 'no') return 'part';
  if (tags.building && tags.building !== 'no') return 'building';
}

export function parseBuildings(elements: OsmElement[]): ParseResult {
  const nodes = new Map<number, OsmNode>();
  const ways = new Map<number, OsmWay>();
  const relations: OsmRelation[] = [];
  for (const e of elements) {
    if (e.type === 'node') nodes.set(e.id, e);
    // Путь может прийти дважды: с тегами (out body) и ещё раз голым (out skel после «>» от отношений,
    // членом которых он является) — голая копия не должна затирать теги, иначе части отношений пропадают
    else if (e.type === 'way') { if (!ways.get(e.id)?.tags || e.tags) ways.set(e.id, e); }
    else relations.push(e);
  }

  const features: Feature3D[] = [];
  const groups: BuildingGroup[] = [];
  const indoor: IndoorFeature[] = [];
  const addIndoor = (key: string, tags: Record<string, string>, kind: IndoorKind, polygons: Polygon[], line = false) => {
    const levels = parseLevels(tags.level);
    for (const l of parseLevels(tags.repeat_on)) if (!levels.includes(l)) levels.push(l);
    indoor.push({ key, tags, kind, polygons, ...(line ? { line } : {}), levels: levels.length ? levels.sort((a, b) => a - b) : [0] });
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
    const kind = kindOf(w.tags);
    const ik = kind ? undefined : indoorKind(w.tags);
    if (ik === 'wall') {
      // Стена — ломаная (у замкнутой последняя точка повторяет первую — оставляем, чтобы стена замкнулась)
      const pts = w.nodes.map((id) => nodes.get(id)).filter((n): n is OsmNode => !!n).map((n): LonLat => [n.lon, n.lat]);
      if (pts.length >= 2) addIndoor(`way/${w.id}`, w.tags!, ik, [{ outer: pts, inners: [] }], true);
    } else if (ik && w.nodes[0] === w.nodes[w.nodes.length - 1]) {
      const outer = toCoords(w.nodes);
      if (outer) addIndoor(`way/${w.id}`, w.tags!, ik, [{ outer, inners: [] }]);
    }
    if (!kind) continue;
    const key = `way/${w.id}`;
    if (w.nodes[0] !== w.nodes[w.nodes.length - 1]) { skipped.push({ key, reason: 'незамкнутый путь' }); continue; }
    const outer = toCoords(w.nodes);
    if (!outer) { skipped.push({ key, reason: 'нет узлов' }); continue; }
    features.push({ key, type: 'way', id: w.id, version: w.version, tags: w.tags!, kind, polygons: [{ outer, inners: [], outerIds: w.nodes.slice(0, -1), innerIds: [] }], hasParts: false });
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
    const kind = kindOf(r.tags);
    const ik = kind ? undefined : indoorKind(r.tags);
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
    if (ik) { if (polygons.length) addIndoor(key, r.tags!, ik, polygons); continue; }
    if (!polygons.length) { skipped.push({ key, reason: 'нет узлов' }); continue; }
    features.push({ key, type: 'relation', id: r.id, version: r.version, tags: r.tags!, kind: kind!, polygons, hasParts: false, ways: memberWays });
  }

  markOutlinesWithParts(features);
  return { features, groups, indoor, skipped };
}

/** Склеивает пути в замкнутые кольца по общим концевым узлам. null — если кольцо не замыкается. */
function joinRings(segments: number[][]): number[][] | null {
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

/** Запас по высоте (м): часть, начинающаяся не ниже «верх контура − запас», стоит на контуре, а не внутри него. */
const ON_TOP_TOLERANCE = 1;

/** Доля площади контура, при которой части считаются его заменой. */
const PARTS_COVERAGE = 0.5;

/**
 * Simple 3D: контур здания не рисуется, если внутри него есть building:part.
 * Но часто частями размечены только надстройки (пентхаусы, башенки), а объём здания задан контуром
 * (например, relation/3756395) — поэтому скрываем контур, только если части покрывают заметную долю площади.
 * Считаем только части внутри объёма контура (начинаются ниже его верха). Части поверх контура —
 * надстройка (relation/2142333: контур 12 этажей, части с 12-го), объём под ними рисует контур.
 * Нижних этажей среди частей может и не быть (лежат в незагруженном соседнем тайле) — это не повод
 * рисовать контур коробкой поверх остальных частей (relation/3271452, Троицкая башня).
 */
export function markOutlinesWithParts(features: Feature3D[], targets: Feature3D[] = features) {
  // Части раскладываем по сетке ~0.0005° (≈50 м): здание смотрит только ячейки под своими габаритами
  const CELL = 0.0005;
  const grid = new Map<string, { c: LonLat; area: number; min: number }[]>();
  for (const f of features) {
    if (f.kind !== 'part') continue;
    const min = computeHeights(f.tags).min;
    for (const p of f.polygons) {
      const c = pointOnSurface(p);
      const k = `${Math.floor(c[0] / CELL)},${Math.floor(c[1] / CELL)}`;
      (grid.get(k) ?? grid.set(k, []).get(k)!).push({ c, area: area(p), min });
    }
  }
  for (const b of targets) {
    if (b.kind !== 'building') continue;
    const top = computeHeights(b.tags).top;
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const p of b.polygons) for (const [x, y] of p.outer) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }
    const inside = (c: LonLat) => b.polygons.some((p) => pointInRing(c, p.outer) && !p.inners.some((h) => pointInRing(c, h)));
    let covered = 0;
    for (let i = Math.floor(w / CELL); i <= Math.floor(e / CELL); i++) {
      for (let j = Math.floor(s / CELL); j <= Math.floor(n / CELL); j++) {
        for (const part of grid.get(`${i},${j}`) ?? []) if (part.min < top - ON_TOP_TOLERANCE && inside(part.c)) covered += part.area;
      }
    }
    b.hasParts = covered >= PARTS_COVERAGE * b.polygons.reduce((sum, p) => sum + area(p), 0);
  }
}

import type { OsmMember } from '../osm/api';
import type { LonLat, Polygon } from '../osm/model';

export type Tags = Record<string, string>;

/**
 * Объект с тегами: здание/часть (Feature3D, у него ещё и геометрия) или отношение type=building (у него члены).
 * Геометрия не меняется на месте: при правке объекту присваиваются новые полигоны.
 */
export interface Tagged { key: string; version: number; tags: Tags; relMembers?: OsmMember[]; polygons?: Polygon[] }

/** Сдвинутый узел: откуда (как было в данных) и куда. */
export interface NodeMove { id: number; from: LonLat; to: LonLat }

export interface TagChange {
  key: string; // 'way/123'
  feature: Tagged;
  /** Теги, как они пришли из API. */
  before: Tags;
  after: Tags;
  /** Новый объект (ещё нет в OSM). */
  created: boolean;
  /** Новый список членов отношения, если он менялся, и исходный. */
  members?: OsmMember[];
  membersBefore?: OsmMember[];
  /** Сдвинутые узлы, если менялась геометрия. */
  nodeMoves?: NodeMove[];
  /** Новый список узлов пути (замкнутый, первый = последний), если он менялся или путь новый, и исходный. */
  wayNodes?: { before: number[]; after: number[] };
  /** Новые узлы (отрицательные id) в этом пути. */
  newNodes?: { id: number; at: LonLat }[];
  /** Изменённые теги: значение undefined — тег удалён/отсутствует. */
  diff: { tag: string; from?: string; to?: string }[];
}

/** Правка одного объекта в шаге истории. before/after = null — объекта нет (создание и его отмена). */
interface Entry {
  key: string;
  before: Tags | null; after: Tags | null;
  mBefore?: OsmMember[]; mAfter?: OsmMember[];
  gBefore?: Polygon[]; gAfter?: Polygon[];
}
/** Действие интерфейса в общей истории (скрытие частей и т. п.): данные не меняет, но отменяется так же. */
export interface ViewAction { undo(): void; redo(): void }
/** Шаг истории — одна или несколько правок, отменяемых вместе, или действие интерфейса. */
type Step = Entry[] | ViewAction;
const isView = (s: Step): s is ViewAction => !Array.isArray(s);

/** Правка в составе одного шага: новые теги и/или геометрия. */
export interface ObjectEdit {
  key: string;
  tags?: Tags;
  polygons?: Polygon[];
  /** Новый состав членов отношения. */
  members?: OsmMember[];
  /** Новый объект (рассечение): создаётся в этом же шаге. */
  create?: Tagged;
}

/**
 * Правки поверх данных: исходные теги, состав и геометрия, текущие и история шагов для undo/redo.
 * Теги меняются на месте — рендер и панель всегда видят текущее состояние.
 */
export class EditSession {
  private readonly features = new Map<string, Tagged>();
  private readonly original = new Map<string, Tags>();
  private readonly originalMembers = new Map<string, OsmMember[]>();
  private readonly originalGeometry = new Map<string, Polygon[]>();
  private undoStack: Step[] = [];
  private redoStack: Step[] = [];
  /** Созданные в сессии объекты и те из них, что сейчас существуют (создание можно отменить). */
  private readonly created = new Set<string>();
  private readonly alive = new Set<string>();

  constructor(features: Tagged[], private readonly onChange: (keys: string[]) => void) {
    for (const f of features) this.track(f);
  }

  /** Начать отслеживать объект (если ещё не отслеживается): его текущее состояние становится исходным. */
  track(entity: Tagged): Tagged {
    const known = this.features.get(entity.key);
    if (known) return known;
    this.features.set(entity.key, entity);
    this.original.set(entity.key, { ...entity.tags });
    if (entity.relMembers) this.originalMembers.set(entity.key, entity.relMembers.map((m) => ({ ...m })));
    if (entity.polygons) this.originalGeometry.set(entity.key, entity.polygons);
    return entity;
  }

  /** Отслеживается ли объект (созданный и отменённый — тоже). */
  has(key: string): boolean {
    return this.features.has(key);
  }

  /** Заменить членов отношения (шаг истории). */
  setMembers(key: string, members: OsmMember[]) {
    const f = this.get(key);
    if (!f?.relMembers || sameMembers(f.relMembers, members)) return;
    const tags = { ...f.tags };
    this.push([{ key, before: tags, after: tags, mBefore: f.relMembers, mAfter: members }]);
  }

  /** Несколько правок тегов и геометрии одним шагом истории (перемещение группы объектов). */
  editMany(edits: ObjectEdit[]) {
    const step: Entry[] = [];
    for (const e of edits) {
      if (e.create) {
        const c = e.create;
        this.features.set(c.key, c);
        this.original.set(c.key, {});
        this.created.add(c.key);
        step.push({ key: c.key, before: null, after: { ...c.tags }, gAfter: c.polygons });
        continue;
      }
      const f = this.get(e.key);
      if (!f) continue;
      const tags = e.tags ?? f.tags;
      step.push({ key: e.key, before: { ...f.tags }, after: { ...tags },
        ...(e.polygons ? { gBefore: f.polygons, gAfter: e.polygons } : {}),
        ...(e.members ? { mBefore: f.relMembers, mAfter: e.members } : {}) });
    }
    if (step.length) this.push(step);
  }

  private membersChanged(key: string): boolean {
    const f = this.features.get(key);
    const orig = this.originalMembers.get(key);
    return !!f?.relMembers && !!orig && !sameMembers(orig, f.relMembers);
  }

  /** Узлы, сдвинутые относительно исходной геометрии (по id: список узлов мог измениться). */
  private nodeMoves(key: string): NodeMove[] {
    const f = this.features.get(key);
    const orig = this.originalGeometry.get(key);
    if (!f?.polygons || !orig || f.polygons === orig) return [];
    const was = nodeCoords(orig), now = nodeCoords(f.polygons);
    const moves: NodeMove[] = [];
    for (const [id, to] of now) {
      const from = was.get(id);
      if (from && (from[0] !== to[0] || from[1] !== to[1])) moves.push({ id, from, to });
    }
    return moves;
  }

  /** Список узлов пути (замкнутый) — только у путей из одного кольца. */
  private wayNodes(key: string): { before: number[]; after: number[] } | undefined {
    const f = this.features.get(key);
    if (!f?.polygons || !key.startsWith('way/')) return;
    const ring = (ps: Polygon[] | undefined) => (ps?.length === 1 && ps[0].outerIds ? [...ps[0].outerIds, ps[0].outerIds[0]] : undefined);
    const after = ring(f.polygons);
    if (!after) return;
    const before = this.created.has(key) ? [] : ring(this.originalGeometry.get(key));
    if (!before || (before.length === after.length && before.every((id, i) => id === after[i]))) return;
    return { before, after };
  }

  get(key: string): Tagged | undefined {
    return this.exists(key) ? this.features.get(key) : undefined;
  }

  private exists(key: string): boolean {
    return !this.created.has(key) || this.alive.has(key);
  }

  /** Созданные в сессии и существующие сейчас объекты. */
  createdAlive(): Tagged[] {
    return [...this.alive].map((k) => this.features.get(k)!).filter(Boolean);
  }

  isCreated(key: string): boolean {
    return this.created.has(key);
  }

  /** Добавить новый объект (шаг истории). */
  create(entity: Tagged) {
    this.features.set(entity.key, entity);
    this.original.set(entity.key, {});
    if (entity.relMembers) this.originalMembers.set(entity.key, []);
    this.created.add(entity.key);
    this.push([{ key: entity.key, before: null, after: { ...entity.tags } }]);
  }

  originalTags(key: string): Tags | undefined {
    return this.original.get(key);
  }

  /** Записать значения тегов (undefined или '' — удалить тег). Один вызов — один шаг истории. */
  setTags(key: string, values: Record<string, string | undefined>) {
    const f = this.get(key);
    if (!f) return;
    const before = { ...f.tags };
    const after = { ...f.tags };
    for (const [tag, raw] of Object.entries(values)) {
      const v = raw?.trim();
      if (v) after[tag] = v;
      else delete after[tag];
    }
    if (sameTags(before, after)) return;
    this.push([{ key, before, after }]);
  }

  /** Вернуть объект к исходным тегам, составу и геометрии (тоже шаг истории). */
  revert(key: string) {
    if (this.created.has(key)) return;
    const f = this.get(key);
    const orig = this.original.get(key);
    if (!f || !orig || !this.isChanged(key)) return;
    const members = this.membersChanged(key) ? this.originalMembers.get(key)!.map((m) => ({ ...m })) : undefined;
    const geometry = this.originalGeometry.get(key);
    const moved = geometry && f.polygons !== geometry;
    this.push([{ key, before: { ...f.tags }, after: { ...orig },
      ...(members ? { mBefore: f.relMembers, mAfter: members } : {}),
      ...(moved ? { gBefore: f.polygons, gAfter: geometry } : {}) }]);
  }

  /** Действие интерфейса в историю (уже выполнено): Cmd+Z его отменит. */
  pushView(action: ViewAction) {
    this.undoStack.push(action);
    this.redoStack = [];
    this.onChange([]);
  }

  /** Убрать из истории действия интерфейса (например, при выходе из режима здания — они о его сцене). */
  dropViewActions() {
    const before = this.undoStack.length + this.redoStack.length;
    this.undoStack = this.undoStack.filter((s) => !isView(s));
    this.redoStack = this.redoStack.filter((s) => !isView(s));
    if (this.undoStack.length + this.redoStack.length !== before) this.onChange([]);
  }

  /** Есть ли в истории правки данных (а не только действия интерфейса). */
  hasDataHistory(): boolean {
    return [...this.undoStack, ...this.redoStack].some((s) => !isView(s));
  }

  undo(): string | undefined {
    const step = this.undoStack.pop();
    if (!step) return;
    this.redoStack.push(step);
    if (isView(step)) { step.undo(); this.onChange([]); return; }
    for (const e of [...step].reverse()) this.apply(e.key, e.before, e.mBefore, e.gBefore);
    this.notify(step);
    return step[0].key;
  }

  redo(): string | undefined {
    const step = this.redoStack.pop();
    if (!step) return;
    this.undoStack.push(step);
    if (isView(step)) { step.redo(); this.onChange([]); return; }
    for (const e of step) this.apply(e.key, e.after, e.mAfter, e.gAfter);
    this.notify(step);
    return step[0].key;
  }

  canUndo() { return this.undoStack.length > 0; }
  canRedo() { return this.redoStack.length > 0; }

  /** Объекты, теги, состав или геометрия которых отличаются от исходных. */
  changes(): TagChange[] {
    const out: TagChange[] = [];
    for (const [key, f] of this.features) {
      if (!this.exists(key)) continue;
      const before = this.original.get(key)!;
      const created = this.created.has(key);
      const members = this.membersChanged(key);
      const moves = this.nodeMoves(key);
      const nodes = this.wayNodes(key);
      if (!created && !members && !moves.length && !nodes && sameTags(before, f.tags)) continue;
      const tags = [...new Set([...Object.keys(before), ...Object.keys(f.tags)])].sort();
      const diff = tags.filter((t) => before[t] !== f.tags[t]).map((tag) => ({ tag, from: before[tag], to: f.tags[tag] }));
      if (members) {
        const orig = this.originalMembers.get(key)!;
        diff.push({ tag: '(члены)', from: String(orig.length), to: String(f.relMembers!.length) });
      }
      if (moves.length) diff.push({ tag: '(геометрия)', from: '', to: `сдвинуто узлов: ${moves.length}` });
      const newNodes = nodes ? [...nodeCoords(f.polygons ?? [])].filter(([id]) => id < 0).map(([id, at]) => ({ id, at })) : [];
      if (nodes && !created) diff.push({ tag: '(узлы)', from: String(nodes.before.length - 1), to: String(nodes.after.length - 1) });
      out.push({ key, feature: f, created, before, after: { ...f.tags }, diff,
        members: members ? f.relMembers : undefined, membersBefore: members ? this.originalMembers.get(key) : undefined,
        nodeMoves: moves.length ? moves : undefined, wayNodes: nodes, newNodes: newNodes.length ? newNodes : undefined });
    }
    return out;
  }

  isChanged(key: string, tag?: string): boolean {
    const f = this.get(key);
    const orig = this.original.get(key);
    if (!f || !orig) return false;
    if (this.created.has(key)) return true;
    if (!tag && (this.membersChanged(key) || this.nodeMoves(key).length || this.wayNodes(key))) return true;
    return tag ? f.tags[tag] !== orig[tag] : !sameTags(f.tags, orig);
  }

  /**
   * После загрузки: временные (отрицательные) id узлов и путей стали настоящими — заменяем их в геометрии
   * и в членах отношений (до markSaved: иначе исходный состав отношения разойдётся с текущим).
   */
  remapIds(nodes: Map<number, number>, ways: Map<number, number>) {
    if (!nodes.size && !ways.size) return;
    const ids = (a?: number[]) => a?.map((id) => nodes.get(id) ?? id);
    const polys = (ps: Polygon[]) => ps.map((p) => ({ ...p, outerIds: ids(p.outerIds), innerIds: p.innerIds?.map((r) => ids(r)!) }));
    const members = (ms: OsmMember[]) => ms.map((m) => (m.type === 'way' && ways.has(m.ref) ? { ...m, ref: ways.get(m.ref)! } : m));
    for (const [key, f] of this.features) {
      if (f.polygons) f.polygons = polys(f.polygons);
      if (f.relMembers) f.relMembers = members(f.relMembers);
      const og = this.originalGeometry.get(key);
      if (og) this.originalGeometry.set(key, polys(og));
      const om = this.originalMembers.get(key);
      if (om) this.originalMembers.set(key, members(om));
    }
  }

  /**
   * После загрузки в OSM: записанное становится исходным, версии — новыми.
   * История очищается — отменять уже отправленное нельзя.
   */
  markSaved(saved: Map<string, { version: number; tags: Tags; newKey?: string }>) {
    for (const [oldKey, { version, tags, newKey }] of saved) {
      const f = this.features.get(oldKey);
      if (!f) continue;
      // Созданный объект получил настоящий id
      let key = oldKey;
      if (newKey) {
        key = f.key = newKey;
        this.features.delete(oldKey);
        this.original.delete(oldKey);
        this.originalMembers.delete(oldKey);
        this.originalGeometry.delete(oldKey);
        this.created.delete(oldKey);
        this.alive.delete(oldKey);
        this.features.set(key, f);
      }
      f.version = version;
      this.original.set(key, { ...tags });
      if (f.relMembers) this.originalMembers.set(key, f.relMembers.map((m) => ({ ...m })));
      if (f.polygons) this.originalGeometry.set(key, f.polygons);
      for (const t of Object.keys(f.tags)) delete f.tags[t];
      Object.assign(f.tags, tags);
    }
    this.undoStack = [];
    this.redoStack = [];
    this.onChange([...saved].map(([k, s]) => s.newKey ?? k));
  }

  private push(step: Entry[]) {
    this.undoStack.push(step);
    this.redoStack = [];
    for (const e of step) this.apply(e.key, e.after, e.mAfter, e.gAfter);
    this.notify(step);
  }

  private notify(step: Entry[]) {
    this.onChange([...new Set(step.map((e) => e.key))]);
  }

  private apply(key: string, tags: Tags | null, members?: OsmMember[], polygons?: Polygon[]) {
    const f = this.features.get(key)!;
    if (members) f.relMembers = members;
    if (polygons) f.polygons = polygons;
    if (this.created.has(key)) {
      if (tags) this.alive.add(key);
      else { this.alive.delete(key); return; }
    }
    if (!tags) return;
    // Меняем объект тегов на месте — на него ссылаются рендер и панель.
    // Копия: tags может быть тем же объектом, что f.tags (при создании), — иначе очистка сотрёт и источник
    tags = { ...tags };
    for (const t of Object.keys(f.tags)) delete f.tags[t];
    Object.assign(f.tags, tags);
  }
}

/** id узла → координаты по всем кольцам (без id — пропускаем). */
function nodeCoords(polys: Polygon[]): Map<number, LonLat> {
  const out = new Map<number, LonLat>();
  for (const p of polys) {
    p.outerIds?.forEach((id, i) => out.set(id, p.outer[i]));
    p.inners.forEach((r, j) => p.innerIds?.[j]?.forEach((id, i) => out.set(id, r[i])));
  }
  return out;
}

function sameMembers(a: OsmMember[], b: OsmMember[]): boolean {
  return a.length === b.length && a.every((m, i) => m.type === b[i].type && m.ref === b[i].ref && m.role === b[i].role);
}

function sameTags(a: Tags, b: Tags): boolean {
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => a[k] === b[k]);
}

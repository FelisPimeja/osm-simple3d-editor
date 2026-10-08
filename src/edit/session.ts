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
/** Шаг истории — одна или несколько правок, отменяемых вместе. */
type Step = Entry[];

/** Правка в составе одного шага: новые теги и/или геометрия. */
export interface ObjectEdit { key: string; tags?: Tags; polygons?: Polygon[] }

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
    const step: Step = [];
    for (const e of edits) {
      const f = this.get(e.key);
      if (!f) continue;
      const tags = e.tags ?? f.tags;
      step.push({ key: e.key, before: { ...f.tags }, after: { ...tags },
        ...(e.polygons ? { gBefore: f.polygons, gAfter: e.polygons } : {}) });
    }
    if (step.length) this.push(step);
  }

  private membersChanged(key: string): boolean {
    const f = this.features.get(key);
    const orig = this.originalMembers.get(key);
    return !!f?.relMembers && !!orig && !sameMembers(orig, f.relMembers);
  }

  /** Узлы, сдвинутые относительно исходной геометрии. */
  private nodeMoves(key: string): NodeMove[] {
    const f = this.features.get(key);
    const orig = this.originalGeometry.get(key);
    if (!f?.polygons || !orig || f.polygons === orig) return [];
    const moves = new Map<number, NodeMove>();
    const ring = (ids: number[] | undefined, a: LonLat[], b: LonLat[]) => {
      if (!ids) return;
      ids.forEach((id, i) => {
        if (a[i] && b[i] && (a[i][0] !== b[i][0] || a[i][1] !== b[i][1])) moves.set(id, { id, from: a[i], to: b[i] });
      });
    };
    orig.forEach((p, i) => {
      const q = f.polygons![i];
      if (!q) return;
      ring(p.outerIds, p.outer, q.outer);
      p.inners.forEach((h, j) => ring(p.innerIds?.[j], h, q.inners[j] ?? []));
    });
    return [...moves.values()];
  }

  get(key: string): Tagged | undefined {
    return this.exists(key) ? this.features.get(key) : undefined;
  }

  private exists(key: string): boolean {
    return !this.created.has(key) || this.alive.has(key);
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

  undo(): string | undefined {
    const step = this.undoStack.pop();
    if (!step) return;
    this.redoStack.push(step);
    for (const e of [...step].reverse()) this.apply(e.key, e.before, e.mBefore, e.gBefore);
    this.notify(step);
    return step[0].key;
  }

  redo(): string | undefined {
    const step = this.redoStack.pop();
    if (!step) return;
    this.undoStack.push(step);
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
      if (!created && !members && !moves.length && sameTags(before, f.tags)) continue;
      const tags = [...new Set([...Object.keys(before), ...Object.keys(f.tags)])].sort();
      const diff = tags.filter((t) => before[t] !== f.tags[t]).map((tag) => ({ tag, from: before[tag], to: f.tags[tag] }));
      if (members) {
        const orig = this.originalMembers.get(key)!;
        diff.push({ tag: '(члены)', from: String(orig.length), to: String(f.relMembers!.length) });
      }
      if (moves.length) diff.push({ tag: '(геометрия)', from: '', to: `сдвинуто узлов: ${moves.length}` });
      out.push({ key, feature: f, created, before, after: { ...f.tags }, diff,
        members: members ? f.relMembers : undefined, membersBefore: members ? this.originalMembers.get(key) : undefined,
        nodeMoves: moves.length ? moves : undefined });
    }
    return out;
  }

  isChanged(key: string, tag?: string): boolean {
    const f = this.get(key);
    const orig = this.original.get(key);
    if (!f || !orig) return false;
    if (this.created.has(key)) return true;
    if (!tag && (this.membersChanged(key) || this.nodeMoves(key).length)) return true;
    return tag ? f.tags[tag] !== orig[tag] : !sameTags(f.tags, orig);
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

  private push(step: Step) {
    this.undoStack.push(step);
    this.redoStack = [];
    for (const e of step) this.apply(e.key, e.after, e.mAfter, e.gAfter);
    this.notify(step);
  }

  private notify(step: Step) {
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

function sameMembers(a: OsmMember[], b: OsmMember[]): boolean {
  return a.length === b.length && a.every((m, i) => m.type === b[i].type && m.ref === b[i].ref && m.role === b[i].role);
}

function sameTags(a: Tags, b: Tags): boolean {
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => a[k] === b[k]);
}

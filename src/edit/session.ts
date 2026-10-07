import type { OsmMember } from '../osm/api';

export type Tags = Record<string, string>;

/** Объект с тегами: здание/часть (Feature3D) или отношение type=building (у него ещё и члены). */
export interface Tagged { key: string; version: number; tags: Tags; relMembers?: OsmMember[] }

export interface TagChange {
  key: string; // 'way/123'
  feature: Tagged;
  /** Теги, как они пришли из API. */
  before: Tags;
  after: Tags;
  /** Новый объект (ещё нет в OSM). */
  created: boolean;
  /** Новый список членов отношения, если он менялся. */
  members?: OsmMember[];
  /** Изменённые теги: значение undefined — тег удалён/отсутствует. */
  diff: { tag: string; from?: string; to?: string }[];
}

/** before/after = null — объекта нет (создание и его отмена). */
interface Step { key: string; before: Tags | null; after: Tags | null; mBefore?: OsmMember[]; mAfter?: OsmMember[] }

/**
 * Правки тегов в режиме редактирования: исходные теги (из API), текущие и история шагов для undo/redo.
 * Feature3D.tags меняется на месте — рендер и панель всегда видят текущее состояние.
 */
export class EditSession {
  private readonly features = new Map<string, Tagged>();
  private readonly original = new Map<string, Tags>();
  private readonly originalMembers = new Map<string, OsmMember[]>();
  private undoStack: Step[] = [];
  private redoStack: Step[] = [];
  /** Созданные в сессии объекты и те из них, что сейчас существуют (создание можно отменить). */
  private readonly created = new Set<string>();
  private readonly alive = new Set<string>();

  constructor(features: Tagged[], private readonly onChange: (keys: string[]) => void) {
    for (const f of features) {
      this.features.set(f.key, f);
      this.original.set(f.key, { ...f.tags });
      if (f.relMembers) this.originalMembers.set(f.key, f.relMembers.map((m) => ({ ...m })));
    }
  }

  /** Заменить членов отношения (шаг истории). */
  setMembers(key: string, members: OsmMember[]) {
    const f = this.get(key);
    if (!f?.relMembers || sameMembers(f.relMembers, members)) return;
    const tags = { ...f.tags };
    this.undoStack.push({ key, before: tags, after: tags, mBefore: f.relMembers, mAfter: members });
    this.redoStack = [];
    this.apply(key, tags, members);
  }

  private membersChanged(key: string): boolean {
    const f = this.features.get(key);
    const orig = this.originalMembers.get(key);
    return !!f?.relMembers && !!orig && !sameMembers(orig, f.relMembers);
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
    this.undoStack.push({ key: entity.key, before: null, after: { ...entity.tags } });
    this.redoStack = [];
    this.apply(entity.key, entity.tags);
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
    this.undoStack.push({ key, before, after });
    this.redoStack = [];
    this.apply(key, after);
  }

  /** Вернуть объект к исходным тегам (тоже шаг истории). */
  revert(key: string) {
    if (this.created.has(key)) return;
    const f = this.get(key);
    const orig = this.original.get(key);
    if (!f || !orig || sameTags(f.tags, orig)) return;
    this.undoStack.push({ key, before: { ...f.tags }, after: { ...orig } });
    this.redoStack = [];
    this.apply(key, orig);
  }

  undo(): string | undefined {
    const step = this.undoStack.pop();
    if (!step) return;
    this.redoStack.push(step);
    this.apply(step.key, step.before, step.mBefore);
    return step.key;
  }

  redo(): string | undefined {
    const step = this.redoStack.pop();
    if (!step) return;
    this.undoStack.push(step);
    this.apply(step.key, step.after, step.mAfter);
    return step.key;
  }

  canUndo() { return this.undoStack.length > 0; }
  canRedo() { return this.redoStack.length > 0; }

  /** Объекты, теги которых отличаются от исходных. */
  changes(): TagChange[] {
    const out: TagChange[] = [];
    for (const [key, f] of this.features) {
      if (!this.exists(key)) continue;
      const before = this.original.get(key)!;
      const created = this.created.has(key);
      const members = this.membersChanged(key);
      if (!created && !members && sameTags(before, f.tags)) continue;
      const tags = [...new Set([...Object.keys(before), ...Object.keys(f.tags)])].sort();
      const diff = tags.filter((t) => before[t] !== f.tags[t]).map((tag) => ({ tag, from: before[tag], to: f.tags[tag] }));
      if (members) {
        const orig = this.originalMembers.get(key)!;
        diff.push({ tag: '(члены)', from: String(orig.length), to: String(f.relMembers!.length) });
      }
      out.push({ key, feature: f, created, before, after: { ...f.tags }, diff, members: members ? f.relMembers : undefined });
    }
    return out;
  }

  isChanged(key: string, tag?: string): boolean {
    const f = this.get(key);
    const orig = this.original.get(key);
    if (!f || !orig) return false;
    if (this.created.has(key)) return true;
    if (!tag && this.membersChanged(key)) return true;
    return tag ? f.tags[tag] !== orig[tag] : !sameTags(f.tags, orig);
  }

  /**
   * После загрузки в OSM: записанные теги становятся исходными, версии — новыми.
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
        this.created.delete(oldKey);
        this.alive.delete(oldKey);
        this.features.set(key, f);
      }
      f.version = version;
      this.original.set(key, { ...tags });
      if (f.relMembers) this.originalMembers.set(key, f.relMembers.map((m) => ({ ...m })));
      for (const t of Object.keys(f.tags)) delete f.tags[t];
      Object.assign(f.tags, tags);
    }
    this.undoStack = [];
    this.redoStack = [];
    this.onChange([...saved].map(([k, s]) => s.newKey ?? k));
  }

  private apply(key: string, tags: Tags | null, members?: OsmMember[]) {
    const f = this.features.get(key)!;
    if (members) f.relMembers = members;
    if (this.created.has(key)) {
      if (tags) this.alive.add(key);
      else { this.alive.delete(key); this.onChange([key]); return; }
    }
    if (!tags) return;
    // Меняем объект тегов на месте — на него ссылаются рендер и панель.
    // Копия: tags может быть тем же объектом, что f.tags (при создании), — иначе очистка сотрёт и источник
    tags = { ...tags };
    for (const t of Object.keys(f.tags)) delete f.tags[t];
    Object.assign(f.tags, tags);
    this.onChange([key]);
  }
}

function sameMembers(a: OsmMember[], b: OsmMember[]): boolean {
  return a.length === b.length && a.every((m, i) => m.type === b[i].type && m.ref === b[i].ref && m.role === b[i].role);
}

function sameTags(a: Tags, b: Tags): boolean {
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => a[k] === b[k]);
}

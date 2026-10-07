import type { Feature3D } from '../osm/model';

export type Tags = Record<string, string>;

export interface TagChange {
  key: string; // 'way/123'
  feature: Feature3D;
  /** Теги, как они пришли из API. */
  before: Tags;
  after: Tags;
  /** Изменённые теги: значение undefined — тег удалён/отсутствует. */
  diff: { tag: string; from?: string; to?: string }[];
}

interface Step { key: string; before: Tags; after: Tags }

/**
 * Правки тегов в режиме редактирования: исходные теги (из API), текущие и история шагов для undo/redo.
 * Feature3D.tags меняется на месте — рендер и панель всегда видят текущее состояние.
 */
export class EditSession {
  private readonly features = new Map<string, Feature3D>();
  private readonly original = new Map<string, Tags>();
  private undoStack: Step[] = [];
  private redoStack: Step[] = [];

  constructor(features: Feature3D[], private readonly onChange: (keys: string[]) => void) {
    for (const f of features) {
      this.features.set(f.key, f);
      this.original.set(f.key, { ...f.tags });
    }
  }

  get(key: string): Feature3D | undefined {
    return this.features.get(key);
  }

  originalTags(key: string): Tags | undefined {
    return this.original.get(key);
  }

  /** Записать значения тегов (undefined или '' — удалить тег). Один вызов — один шаг истории. */
  setTags(key: string, values: Record<string, string | undefined>) {
    const f = this.features.get(key);
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
    const f = this.features.get(key);
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
    this.apply(step.key, step.before);
    return step.key;
  }

  redo(): string | undefined {
    const step = this.redoStack.pop();
    if (!step) return;
    this.undoStack.push(step);
    this.apply(step.key, step.after);
    return step.key;
  }

  canUndo() { return this.undoStack.length > 0; }
  canRedo() { return this.redoStack.length > 0; }

  /** Объекты, теги которых отличаются от исходных. */
  changes(): TagChange[] {
    const out: TagChange[] = [];
    for (const [key, f] of this.features) {
      const before = this.original.get(key)!;
      if (sameTags(before, f.tags)) continue;
      const tags = [...new Set([...Object.keys(before), ...Object.keys(f.tags)])].sort();
      const diff = tags.filter((t) => before[t] !== f.tags[t]).map((tag) => ({ tag, from: before[tag], to: f.tags[tag] }));
      out.push({ key, feature: f, before, after: { ...f.tags }, diff });
    }
    return out;
  }

  isChanged(key: string, tag?: string): boolean {
    const f = this.features.get(key);
    const orig = this.original.get(key);
    if (!f || !orig) return false;
    return tag ? f.tags[tag] !== orig[tag] : !sameTags(f.tags, orig);
  }

  private apply(key: string, tags: Tags) {
    const f = this.features.get(key)!;
    // Меняем объект тегов на месте — на него ссылаются рендер и панель
    for (const t of Object.keys(f.tags)) delete f.tags[t];
    Object.assign(f.tags, tags);
    this.onChange([key]);
  }
}

function sameTags(a: Tags, b: Tags): boolean {
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => a[k] === b[k]);
}

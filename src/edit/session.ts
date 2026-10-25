import type { OsmMember } from '../osm/api';
import type { LonLat, Polygon } from '../osm/model';
import { tr } from '../i18n';
import { apseDirection } from '../osm/apse';

export type Tags = Record<string, string>;

/**
 * Объект с тегами: здание/часть (Feature3D, у него ещё и геометрия) или отношение type=building (у него члены).
 * Геометрия не меняется на месте: при правке объекту присваиваются новые полигоны.
 */
export interface Tagged {
  key: string; version: number; tags: Tags; relMembers?: OsmMember[]; polygons?: Polygon[];
  /** Путь-член мультиполигона (без своей геометрии здания): узлы по порядку и их координаты. */
  line?: Line;
  /** Путь отрезан от этого пути (при отправке его добавляют рядом с ним во все отношения, где был исходный). */
  splitFrom?: number;
}

/** Узлы пути (у замкнутого первый = последний) и их координаты. */
export interface Line { ids: number[]; coords: LonLat[] }

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
  /** Объект удалён (уходит в <delete>). */
  deleted?: boolean;
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
export interface Entry {
  key: string;
  before: Tags | null; after: Tags | null;
  mBefore?: OsmMember[]; mAfter?: OsmMember[];
  gBefore?: Polygon[]; gAfter?: Polygon[];
  /** null — пути-члена не было (правка его добавила): отмена его убирает. */
  lBefore?: Line | null; lAfter?: Line;
}
/** Действие интерфейса в общей истории (скрытие частей и т. п.): данные не меняет, но отменяется так же. */
export interface ViewAction {
  undo(): void; redo(): void;
  /** Не про сцену здания (например, правка своей подложки) — при выходе из режима здания остаётся в истории. */
  keep?: boolean;
}
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
  /** Новые узлы пути-члена. */
  line?: Line;
  /** Новый объект (рассечение): создаётся в этом же шаге. */
  create?: Tagged;
  /** Удалить объект (созданный в сессии — просто отменить его создание). */
  delete?: boolean;
}

/** Состояние сессии для автосохранения (IndexedDB): простые данные, без действий интерфейса в истории. */
export interface SessionSnapshot {
  features: Tagged[];
  original: [string, Tags][];
  originalMembers: [string, OsmMember[]][];
  originalGeometry: [string, Polygon[]][];
  originalLine: [string, Line][];
  created: string[]; alive: string[]; deleted: string[];
  undo: Entry[][]; redo: Entry[][];
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
  private readonly originalLine = new Map<string, Line>();
  private undoStack: Step[] = [];
  private redoStack: Step[] = [];
  /** Действие интерфейса, отменяемое вместе с шагом правок (подложка, сдвинутая вместе с частями). */
  private readonly attached = new WeakMap<Entry[], ViewAction>();
  /** Созданные в сессии объекты и те из них, что сейчас существуют (создание можно отменить). */
  private readonly created = new Set<string>();
  private readonly alive = new Set<string>();
  /** Удалённые объекты из данных (созданные при удалении просто перестают существовать). */
  private readonly deleted = new Set<string>();

  constructor(features: Tagged[], private readonly onChange: (keys: string[]) => void) {
    for (const f of features) this.track(f);
  }

  /** Снимок для автосохранения. Действия интерфейса из истории выпадают — после перезагрузки их не к чему применить. */
  snapshot(): SessionSnapshot {
    const data = (steps: Step[]) => steps.filter((st): st is Entry[] => !isView(st));
    return {
      features: [...this.features.values()],
      original: [...this.original], originalMembers: [...this.originalMembers],
      originalGeometry: [...this.originalGeometry], originalLine: [...this.originalLine],
      created: [...this.created], alive: [...this.alive], deleted: [...this.deleted],
      undo: data(this.undoStack), redo: data(this.redoStack),
    };
  }

  /** Вернуть сохранённое состояние (сессия должна быть пустой). Ключи восстановленных объектов. */
  restore(s: SessionSnapshot): string[] {
    for (const f of s.features) this.features.set(f.key, f);
    for (const [k, v] of s.original) this.original.set(k, v);
    for (const [k, v] of s.originalMembers) this.originalMembers.set(k, v);
    for (const [k, v] of s.originalGeometry) this.originalGeometry.set(k, v);
    for (const [k, v] of s.originalLine) this.originalLine.set(k, v);
    for (const k of s.created) this.created.add(k);
    for (const k of s.alive) this.alive.add(k);
    for (const k of s.deleted) this.deleted.add(k);
    this.undoStack = s.undo;
    this.redoStack = s.redo;
    return [...this.features.keys()];
  }

  /** Начать отслеживать объект (если ещё не отслеживается): его текущее состояние становится исходным. */
  track(entity: Tagged): Tagged {
    const known = this.features.get(entity.key);
    if (known) return known;
    this.features.set(entity.key, entity);
    this.original.set(entity.key, { ...entity.tags });
    if (entity.relMembers) this.originalMembers.set(entity.key, entity.relMembers.map((m) => ({ ...m })));
    if (entity.polygons) this.originalGeometry.set(entity.key, entity.polygons);
    if (entity.line) this.originalLine.set(entity.key, entity.line);
    return entity;
  }

  /** Обновить исходное состояние объекта, если его ещё не затрагивали правки или история. */
  refresh(entity: Tagged): boolean {
    const key = entity.key;
    if (this.created.has(key) || this.deleted.has(key) || (this.has(key) && this.isChanged(key)) ||
      [...this.undoStack, ...this.redoStack].some((step) => !isView(step) && step.some((entry) => entry.key === key))) return false;
    this.features.delete(key);
    this.original.delete(key);
    this.originalMembers.delete(key);
    this.originalGeometry.delete(key);
    this.originalLine.delete(key);
    this.track(entity);
    return true;
  }

  /** Отслеживается ли объект (созданный и отменённый — тоже). */
  has(key: string): boolean {
    return this.features.has(key);
  }

  /** Существующие отслеживаемые отношения, в составе которых есть объект key. */
  parentsOf(key: string): Tagged[] {
    return [...this.features.values()].filter((f) => !this.deleted.has(f.key) &&
      f.relMembers?.some((m) => `${m.type}/${m.ref}` === key));
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
        if (c.relMembers) this.originalMembers.set(c.key, []);
        this.created.add(c.key);
        step.push({ key: c.key, before: null, after: { ...c.tags }, gAfter: c.polygons, lAfter: c.line });
        continue;
      }
      const f = this.get(e.key);
      if (!f) continue;
      if (e.delete) {
        step.push({ key: e.key, before: { ...f.tags }, after: null, ...(e.polygons ? { gBefore: f.polygons, gAfter: e.polygons } : {}) });
        continue;
      }
      const tags = e.tags ?? f.tags;
      step.push({ key: e.key, before: { ...f.tags }, after: { ...tags },
        ...(e.polygons ? { gBefore: f.polygons, gAfter: e.polygons } : {}),
        ...(e.line ? { lBefore: f.line ?? null, lAfter: e.line } : {}),
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
    const ring = (ps: Polygon[] | undefined) => (ps?.length === 1 && ps[0].outerIds ? [...ps[0].outerIds, ps[0].outerIds[0]] : undefined);
    if (f?.line) {
      const after = f.line.ids;
      // Путь-здание, ставший путём-членом мультиполигона: «было» — его кольцо
      const before = this.created.has(key) ? [] : this.originalLine.get(key)?.ids ?? ring(this.originalGeometry.get(key));
      if (!before || (before.length === after.length && before.every((id, i) => id === after[i]))) return;
      return { before, after };
    }
    if (!f?.polygons || !key.startsWith('way/')) return;
    const after = ring(f.polygons);
    if (!after) return;
    const before = this.created.has(key) ? [] : ring(this.originalGeometry.get(key));
    if (!before || (before.length === after.length && before.every((id, i) => id === after[i]))) return;
    return { before, after };
  }

  /** Отслеживаемый объект как есть — и созданный, но отменённый (для восстановления связей после вставки). */
  tracked(key: string): Tagged | undefined {
    return this.features.get(key);
  }

  /** Откуда отрезан путь — и у исчезнувшего из сессии куска (цепочка разрезов до серверного пути не рвётся). */
  splitFromOf(key: string): number | undefined {
    return this.features.get(key)?.splitFrom;
  }

  get(key: string): Tagged | undefined {
    return this.exists(key) ? this.features.get(key) : undefined;
  }

  private exists(key: string): boolean {
    return !this.deleted.has(key) && (!this.created.has(key) || this.alive.has(key));
  }

  /** Объект из данных удалён в сессии. */
  isDeleted(key: string): boolean {
    return this.deleted.has(key);
  }

  /** Отслеживаемые пути-члены мультиполигонов (существующие сейчас). */
  lineEntities(): Tagged[] {
    return [...this.features.values()].filter((f) => f.line && this.exists(f.key));
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

  /**
   * Правки edit и уже выполненное действие интерфейса — одним шагом истории; правок не вышло — только действие.
   */
  editWithView(action: ViewAction, edit: () => void) {
    const n = this.undoStack.length;
    edit();
    const last = this.undoStack.at(-1);
    if (this.undoStack.length > n && last && !isView(last)) this.attached.set(last, action);
    else this.pushView(action);
  }

  /** Убрать из истории действия интерфейса (например, при выходе из режима здания — они о его сцене). */
  dropViewActions() {
    const before = this.undoStack.length + this.redoStack.length;
    this.undoStack = this.undoStack.filter((s) => !isView(s) || s.keep);
    this.redoStack = this.redoStack.filter((s) => !isView(s) || s.keep);
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
    for (const e of [...step].reverse()) this.apply(e.key, e.before, e.mBefore, e.gBefore, e.lBefore);
    this.attached.get(step)?.undo();
    this.notify(step);
    return step[0].key;
  }

  redo(): string | undefined {
    const step = this.redoStack.pop();
    if (!step) return;
    this.undoStack.push(step);
    if (isView(step)) { step.redo(); this.onChange([]); return; }
    for (const e of step) this.apply(e.key, e.after, e.mAfter, e.gAfter, e.lAfter);
    this.attached.get(step)?.redo();
    this.notify(step);
    return step[0].key;
  }

  canUndo() { return this.undoStack.length > 0; }
  canRedo() { return this.redoStack.length > 0; }

  /** Объекты, теги, состав или геометрия которых отличаются от исходных. */
  changes(): TagChange[] {
    const out: TagChange[] = [];
    for (const [key, f] of this.features) {
      if (this.deleted.has(key)) {
        const before = this.original.get(key)!;
        out.push({ key, feature: f, created: false, deleted: true, before, after: {},
          diff: [{ tag: tr('(объект)'), from: tr('есть'), to: tr('удалён') }] });
        continue;
      }
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
        // '(члены)' — метка-данные: по ней main.ts показывает состав отношения, не переводим
        diff.push({ tag: '(члены)', from: String(orig.length), to: String(f.relMembers!.length) });
      }
      if (moves.length) diff.push({ tag: tr('(геометрия)'), from: '', to: tr('сдвинуто узлов: {n}', { n: moves.length }) });
      const coords = f.line ? new Map(f.line.ids.map((id, i) => [id, f.line!.coords[i]] as const)) : nodeCoords(f.polygons ?? []);
      const newNodes = nodes ? [...coords].filter(([id]) => id < 0).map(([id, at]) => ({ id, at })) : [];
      if (nodes && !created) diff.push({ tag: tr('(узлы)'), from: String(nodes.before.length - 1), to: String(nodes.after.length - 1) });
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
    // Новый объект изменён целиком; по отдельным тегам «было» нет — не помечаем
    if (this.created.has(key)) return !tag;
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
    const line = (l: Line) => ({ ids: ids(l.ids)!, coords: l.coords });
    for (const [key, f] of this.features) {
      if (f.line) f.line = line(f.line);
      const ol = this.originalLine.get(key);
      if (ol) this.originalLine.set(key, line(ol));
      if (f.splitFrom !== undefined && ways.has(f.splitFrom)) f.splitFrom = ways.get(f.splitFrom);
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
  markSaved(saved: Map<string, { version: number; tags: Tags; newKey?: string }>, deleted: string[] = []) {
    // Удалённые на сервере — больше не отслеживаем
    for (const key of deleted) {
      this.deleted.delete(key);
      this.features.delete(key);
      this.original.delete(key);
      this.originalMembers.delete(key);
      this.originalGeometry.delete(key);
      this.originalLine.delete(key);
    }
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
        this.originalLine.delete(oldKey);
        this.created.delete(oldKey);
        this.alive.delete(oldKey);
        this.features.set(key, f);
      }
      f.version = version;
      this.original.set(key, { ...tags });
      if (f.relMembers) this.originalMembers.set(key, f.relMembers.map((m) => ({ ...m })));
      if (f.polygons) this.originalGeometry.set(key, f.polygons);
      if (f.line) this.originalLine.set(key, f.line);
      f.splitFrom = undefined;
      for (const t of Object.keys(f.tags)) delete f.tags[t];
      Object.assign(f.tags, tags);
    }
    this.undoStack = [];
    this.redoStack = [];
    this.onChange([...[...saved].map(([k, s]) => s.newKey ?? k), ...deleted]);
  }

  /**
   * Перед шагом истории: объект, который создаётся в том же шаге (отношение здания без отношения, чьих членов
   * правят), — отменяется вместе с правкой.
   */
  beforeStep?: (keys: string[]) => Tagged | undefined;

  private push(step: Entry[]) {
    const c = this.beforeStep?.(step.map((e) => e.key));
    if (c && !this.features.has(c.key)) {
      this.features.set(c.key, c);
      this.original.set(c.key, {});
      if (c.relMembers) this.originalMembers.set(c.key, []);
      this.created.add(c.key);
      step = [{ key: c.key, before: null, after: { ...c.tags } }, ...step];
    }
    // Апсида без roof:direction — пишем то, что построено: другие редакторы угадывают торец иначе
    for (const e of step) {
      if (!e.after || e.after['roof:direction'] !== undefined) continue;
      const dir = apseDirection(e.after, e.gAfter ?? this.features.get(e.key)?.polygons);
      if (dir !== undefined) e.after = { ...e.after, 'roof:direction': dir };
    }
    this.undoStack.push(step);
    this.redoStack = [];
    for (const e of step) this.apply(e.key, e.after, e.mAfter, e.gAfter, e.lAfter);
    this.notify(step);
  }

  private notify(step: Entry[]) {
    this.onChange([...new Set(step.map((e) => e.key))]);
  }

  private apply(key: string, tags: Tags | null, members?: OsmMember[], polygons?: Polygon[], line?: Line | null) {
    const f = this.features.get(key)!;
    if (members) f.relMembers = members;
    if (polygons) f.polygons = polygons;
    if (line) f.line = line;
    else if (line === null) delete f.line;
    if (this.created.has(key)) {
      if (tags) this.alive.add(key);
      else { this.alive.delete(key); return; }
    } else if (tags) this.deleted.delete(key);
    else { this.deleted.add(key); return; }
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

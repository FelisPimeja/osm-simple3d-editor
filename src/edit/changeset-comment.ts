import type { TagChange } from './session';
import { tr } from '../i18n';

/** Что генератору нужно знать о зданиях: к какому отношению относится объект и как оно называется. */
export interface CommentContext {
  /** Ключ отношения type=building, в которое входит объект (или сам ключ, если это отношение). */
  groupOf(key: string): string | undefined;
  /** Является ли ключ отношением type=building. */
  isGroup(key: string): boolean;
  /** Название здания: name отношения или его контура (outline). */
  buildingName(groupKey: string): string | undefined;
  /** Исправлены ли в объекте проблемы, найденные проверкой (были в исходных тегах, а теперь нет). */
  fixedIssues?(key: string): boolean;
}

/** Что произошло со зданием — по этим признакам выбираются пункты комментария. */
interface BuildingEdits {
  added: number;
  removed: number;
  /** Изменены теги частей/контура. */
  attributes: boolean;
  /** Сдвинуты узлы частей. */
  moved: boolean;
  /** Удалены объекты (части или отдельные здания). */
  deleted?: boolean;
  /** Исправлены ошибки, найденные проверкой. */
  fixed?: boolean;
  indoorTags?: boolean;
}

/** Однозначное исправление входа, ошибочно поставленного на внутренней двери. */
function fixesIndoorDoor(c: TagChange): boolean {
  return !c.created && !c.deleted && !c.members && !c.nodeMoves?.length && !c.wayNodes
    && (c.before.indoor === undefined || c.before.indoor === 'door') && c.after.indoor === 'door'
    && c.before.entrance === 'yes' && c.after.entrance === undefined
    && c.after.door !== undefined
    && c.diff.every((d) => d.tag === 'entrance' || d.tag === 'door' || d.tag === 'indoor');
}

type IndoorComponent = 'door' | 'wall' | 'room' | 'corridor' | 'column' | 'stairs' | 'elevator' | 'escalator' | 'other';

/** Prefer the original kind so deletion or removal of identifying tags remains an indoor edit. */
function indoorComponent(c: TagChange): IndoorComponent | undefined {
  if (c.before.building || c.before['building:part'] || c.after.building || c.after['building:part']) return;
  for (const t of [c.before, c.after]) {
    if (t.door || t.indoor === 'door' || (c.key.startsWith('node/') && t.entrance && t.level !== undefined)) return 'door';
    if ((t.highway === 'steps' || t.stairs === 'yes') && t.conveying && t.conveying !== 'no') return 'escalator';
    if (t.highway === 'elevator' || t.elevator === 'yes') return 'elevator';
    if (t.indoor === 'stairs' || t.highway === 'steps' || t.stairs === 'yes') return 'stairs';
    if (t.indoor === 'wall' || t.indoor === 'room' || t.indoor === 'corridor' || t.indoor === 'column') return t.indoor;
    if (t.room && t.level !== undefined) return 'room';
  }
  if ([c.before, c.after].some(t => t.indoor || t.level !== undefined && (t.shop || t.amenity || t.office))) return 'other';
}

export function isIndoorChange(c: TagChange): boolean { return indoorComponent(c) !== undefined; }

type IndoorAction = 'created' | 'deleted' | 'tags' | 'geometry';

/** Indoor changes use their own component names, including deleted objects and open wall ways. */
export function suggestComment(changes: TagChange[], ctx: CommentContext): string {
  if (changes.length && changes.every(fixesIndoorDoor)) return tr('Исправление тегов indoor');
  const indoor = changes.filter(isIndoorChange);
  const building = changes.filter(c => !isIndoorChange(c));
  if (!indoor.length) return suggestBuildingComment(building, ctx);
  const counts = new Map<IndoorAction, Map<IndoorComponent, number>>();
  const add = (action: IndoorAction, kind: IndoorComponent) => {
    let kinds = counts.get(action);
    if (!kinds) counts.set(action, kinds = new Map());
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  };
  for (const c of indoor) {
    const kind = indoorComponent(c)!;
    if (c.deleted) add('deleted', kind);
    else if (c.created) add('created', kind);
    else {
      if (c.diff.some(d => !d.tag.startsWith('('))) add('tags', kind);
      if (c.nodeMoves?.length || c.wayNodes || c.members) add('geometry', kind);
    }
  }
  const components: Record<IndoorComponent, string> = {
    door: tr('двери'), wall: tr('стены'), room: tr('помещения'), corridor: tr('коридоры'), column: tr('колонны'),
    stairs: tr('лестницы'), elevator: tr('лифты'), escalator: tr('эскалаторы'), other: tr('объекты плана'),
  };
  const actions: Record<IndoorAction, string> = {
    created: tr('добавлены'), deleted: tr('удалены'), tags: tr('изменены теги'), geometry: tr('изменена геометрия'),
  };
  const lines = (compact: boolean) => [...counts].map(([action, kinds]) => {
    const detail = compact ? String([...kinds.values()].reduce((sum, n) => sum + n, 0))
      : [...kinds].map(([kind, n]) => `${components[kind]} (${n})`).join(', ');
    return `${actions[action]}: ${detail}`;
  });
  const format = (compact: boolean) => `${tr('Поэтажные планы:')} ${lines(compact).join('; ')}`;
  let text = format(false);
  if (text.length > MAX_LENGTH) text = format(true);
  if (!building.length) return text;
  const buildings = suggestBuildingComment(building, ctx);
  if (text.length + buildings.length + 2 <= MAX_LENGTH) return `${text}\n\n${buildings}`;
  const combined = `${text}; ${tr('правки зданий')}`;
  return combined.length <= MAX_LENGTH ? combined : `${format(true)}; ${tr('правки зданий')}`;
}

/**
 * Предлагаемый комментарий к пакету правок. Правки раскладываются по зданиям (отношениям type=building),
 * для каждого — заголовок с названием и пункты по видам правок. Объекты вне отношений — отдельным блоком.
 * Логику пунктов будем ветвить по мере появления новых инструментов.
 */
function suggestBuildingComment(changes: TagChange[], ctx: CommentContext): string {
  if (changes.length && changes.every(fixesIndoorDoor)) return tr('Исправление тегов indoor');
  const buildings = new Map<string, BuildingEdits>();
  const loose: BuildingEdits = { added: 0, removed: 0, attributes: false, moved: false };
  const edits = (key: string | undefined) => {
    if (!key) return loose;
    let e = buildings.get(key);
    if (!e) buildings.set(key, e = { added: 0, removed: 0, attributes: false, moved: false });
    return e;
  };

  // Отношения, созданные в этом пакете (новое здание из частей или из рассечённого отдельного здания)
  const created = new Set(changes.filter((c) => c.created && ctx.isGroup(c.key)).map((c) => c.key));
  const removedFromGroups = new Set(changes.flatMap((c) => (c.membersBefore ?? []).map((m) => `${m.type}/${m.ref}`)));
  for (const c of changes) {
    if (ctx.isGroup(c.key)) {
      // Состав отношения: сколько членов добавлено и убрано
      const e = edits(c.key);
      if (c.members) {
        const id = (m: { type: string; ref: number }) => `${m.type}/${m.ref}`;
        const was = new Set((c.membersBefore ?? []).map(id)), now = new Set(c.members.map(id));
        e.added += c.members.filter((m) => !was.has(id(m))).length;
        e.removed += (c.membersBefore ?? []).filter((m) => !now.has(id(m))).length;
      }
      continue;
    }
    const e = edits(ctx.groupOf(c.key));
    // Удалённая часть уже учтена как изменение состава её отношения
    if (c.deleted) { if (!removedFromGroups.has(c.key)) e.deleted = true; continue; }
    if (c.diff.some((d) => !d.tag.startsWith('('))) e.attributes = true;
    if (fixesIndoorDoor(c)) e.indoorTags = true;
    if (c.nodeMoves?.length) e.moved = true;
    if (!c.created && ctx.fixedIssues?.(c.key)) e.fixed = true;
  }

  const loosePoints = points(loose, false);
  const names = [...buildings.keys()].map((k) => ctx.buildingName(k));

  // 1. Подробно: по блоку на здание с пунктами
  const blocks: string[] = [];
  [...buildings].forEach(([key, e], i) => {
    const name = names[i];
    const title = created.has(key)
      ? (name ? tr('Новое отношение здания «{name}»:', { name }) : tr('Новое отношение здания:'))
      : name ? tr('«{name}»:', { name }) : tr('Правки в отношение здания:');
    blocks.push([title, ...points(e, true)].join('\n'));
  });
  if (loosePoints.length) blocks.push([tr('Правки отдельных зданий:'), ...loosePoints].join('\n'));
  const full = blocks.join('\n\n');
  if (full.length <= MAX_LENGTH) return full;

  // 2. Короче: общие пункты по всем зданиям и список названий
  const all: BuildingEdits = { added: 0, removed: 0, attributes: false, moved: false };
  for (const e of buildings.values()) {
    all.added += e.added; all.removed += e.removed;
    all.attributes ||= e.attributes; all.moved ||= e.moved; all.deleted ||= e.deleted; all.fixed ||= e.fixed; all.indoorTags ||= e.indoorTags;
  }
  const allNew = [...buildings.keys()].every((k) => created.has(k));
  const head = (list: string) => allNew
    ? tr('Новые отношения зданий{list}:', { list }) : tr('Правки в отношения зданий{list}:', { list });
  const named = names.filter((n): n is string => !!n).map((name) => tr('«{name}»', { name }));
  const tail = [...(buildings.size ? points(all, true) : []), ...(loosePoints.length ? [tr('* правки отдельных зданий')] : [])];
  const lines = (list: string) => (buildings.size ? [head(list), ...tail] : [tr('Правки отдельных зданий:'), ...loosePoints]).join('\n');
  // Названий — сколько влезет, остальные — «и ещё N»
  for (let n = named.length; n >= 0; n--) {
    const rest = buildings.size - n;
    const shown = named.slice(0, n).join(', ');
    const list = n ? ' ' + (rest ? tr('{names} и ещё {rest}', { names: shown, rest }) : shown)
      : buildings.size > 1 ? ` (${buildings.size})` : '';
    const text = lines(list);
    if (text.length <= MAX_LENGTH) return text;
  }
  return lines('').slice(0, MAX_LENGTH - 1) + '…';
}

/** Ограничение длины комментария (в OSM — 255 символов, оставляем запас). */
const MAX_LENGTH = 250;

/** Пункты комментария; parts — правки частей здания (иначе — отдельных зданий вне отношений). */
function points(e: BuildingEdits, parts: boolean): string[] {
  const out: string[] = [];
  if (e.added && !e.removed) out.push(tr('* добавлены новые части'));
  else if (e.removed) out.push(tr('* изменён состав частей'));
  if (e.attributes) out.push(parts ? tr('* изменены параметры отдельных частей') : tr('* изменены параметры отдельных зданий'));
  if (e.deleted) out.push(parts ? tr('* удалены отдельные части') : tr('* удалены отдельные здания'));
  if (e.moved) out.push(parts ? tr('* перемещены отдельные части') : tr('* перемещены отдельные здания'));
  if (e.fixed) out.push(tr('* исправление ошибок'));
  if (e.indoorTags) out.push(tr('* исправление тегов indoor'));
  return out;
}

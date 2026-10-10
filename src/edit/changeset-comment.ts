import type { TagChange } from './session';

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
}

/**
 * Предлагаемый комментарий к пакету правок. Правки раскладываются по зданиям (отношениям type=building),
 * для каждого — заголовок с названием и пункты по видам правок. Объекты вне отношений — отдельным блоком.
 * Логику пунктов будем ветвить по мере появления новых инструментов.
 */
export function suggestComment(changes: TagChange[], ctx: CommentContext): string {
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
    if (c.nodeMoves?.length) e.moved = true;
    if (!c.created && ctx.fixedIssues?.(c.key)) e.fixed = true;
  }

  const loosePoints = points(loose, 'зданий');
  const names = [...buildings.keys()].map((k) => ctx.buildingName(k));

  // 1. Подробно: по блоку на здание с пунктами
  const blocks: string[] = [];
  [...buildings].forEach(([key, e], i) => {
    const title = created.has(key) ? `Новое отношение здания${names[i] ? ` «${names[i]}»` : ''}`
      : names[i] ? `«${names[i]}»` : 'Правки в отношение здания';
    blocks.push([`${title}:`, ...points(e, 'частей')].join('\n'));
  });
  if (loosePoints.length) blocks.push(['Правки отдельных зданий:', ...loosePoints].join('\n'));
  const full = blocks.join('\n\n');
  if (full.length <= MAX_LENGTH) return full;

  // 2. Короче: общие пункты по всем зданиям и список названий
  const all: BuildingEdits = { added: 0, removed: 0, attributes: false, moved: false };
  for (const e of buildings.values()) {
    all.added += e.added; all.removed += e.removed;
    all.attributes ||= e.attributes; all.moved ||= e.moved; all.deleted ||= e.deleted; all.fixed ||= e.fixed;
  }
  const allNew = [...buildings.keys()].every((k) => created.has(k));
  const head = (list: string) => `${allNew ? 'Новые отношения зданий' : 'Правки в отношения зданий'}${list}:`;
  const named = names.filter((n): n is string => !!n).map((n) => `«${n}»`);
  const tail = [...(buildings.size ? points(all, 'частей') : []), ...(loosePoints.length ? ['* правки отдельных зданий'] : [])];
  const lines = (list: string) => (buildings.size ? [head(list), ...tail] : ['Правки отдельных зданий:', ...loosePoints]).join('\n');
  // Названий — сколько влезет, остальные — «и ещё N»
  for (let n = named.length; n >= 0; n--) {
    const rest = buildings.size - n;
    const list = n ? ` ${named.slice(0, n).join(', ')}${rest ? ` и ещё ${rest}` : ''}` : buildings.size > 1 ? ` (${buildings.size})` : '';
    const text = lines(list);
    if (text.length <= MAX_LENGTH) return text;
  }
  return lines('').slice(0, MAX_LENGTH - 1) + '…';
}

/** Ограничение длины комментария (в OSM — 255 символов, оставляем запас). */
const MAX_LENGTH = 250;

function points(e: BuildingEdits, what: string): string[] {
  const out: string[] = [];
  if (e.added && !e.removed) out.push('* добавлены новые части');
  else if (e.removed) out.push('* изменён состав частей');
  if (e.attributes) out.push(`* изменены параметры отдельных ${what}`);
  if (e.deleted) out.push(`* удалены отдельные ${what === 'частей' ? 'части' : 'здания'}`);
  if (e.moved) out.push(`* перемещены отдельные ${what === 'частей' ? 'части' : 'здания'}`);
  if (e.fixed) out.push('* исправление ошибок');
  return out;
}

import type { TagChange } from './session';

/** Что генератору нужно знать о зданиях: к какому отношению относится объект и как оно называется. */
export interface CommentContext {
  /** Ключ отношения type=building, в которое входит объект (или сам ключ, если это отношение). */
  groupOf(key: string): string | undefined;
  /** Является ли ключ отношением type=building. */
  isGroup(key: string): boolean;
  /** Название здания: name отношения или его контура (outline). */
  buildingName(groupKey: string): string | undefined;
}

/** Что произошло со зданием — по этим признакам выбираются пункты комментария. */
interface BuildingEdits {
  added: number;
  removed: number;
  /** Изменены теги частей/контура. */
  attributes: boolean;
  /** Сдвинуты узлы частей. */
  moved: boolean;
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
    if (c.diff.some((d) => !d.tag.startsWith('('))) e.attributes = true;
    if (c.nodeMoves?.length) e.moved = true;
  }

  const blocks: string[] = [];
  for (const [key, e] of buildings) {
    const name = ctx.buildingName(key);
    blocks.push([`Правки в отношение здания${name ? ` «${name}»` : ''}:`, ...points(e, 'частей')].join('\n'));
  }
  const loosePoints = points(loose, 'зданий');
  if (loosePoints.length) blocks.push(['Правки отдельных зданий:', ...loosePoints].join('\n'));
  return blocks.join('\n\n');
}

function points(e: BuildingEdits, what: string): string[] {
  const out: string[] = [];
  if (e.added && !e.removed) out.push('* добавлены новые части');
  else if (e.removed) out.push('* изменён состав частей');
  if (e.attributes) out.push(`* изменены параметры отдельных ${what}`);
  if (e.moved) out.push(`* перемещены отдельные ${what === 'частей' ? 'части' : 'здания'}`);
  return out;
}

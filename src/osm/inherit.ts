/**
 * Наследование «общих» свойств частью здания от контура (outline) и отношения type=building.
 *
 * В Simple 3D правила наследования нет — это соглашение рендереров (F4, Streets GL). Мы наследуем в рендере,
 * чтобы здание не выглядело серым, но при правке предупреждаем: свойства лучше задать на самой части.
 * Этажность и высоту не наследуем: по вики на контуре они — максимум по частям, а не значение для каждой.
 */
export const INHERITABLE = ['building:colour', 'roof:colour', 'roof:shape', 'building:material', 'roof:material'] as const;

/** Американское написание тоже встречается в данных. */
const ALIASES: Record<string, string> = { 'building:colour': 'building:color', 'roof:colour': 'roof:color' };

export function inheritedValue(tags: Record<string, string>, tag: string): string | undefined {
  return tags[tag] ?? (ALIASES[tag] ? tags[ALIASES[tag]] : undefined);
}

/** Есть ли у объекта своё значение (с учётом общего colour/material и американского написания). */
function hasOwn(tags: Record<string, string>, tag: string): boolean {
  if (inheritedValue(tags, tag) !== undefined) return true;
  if (tag === 'building:colour') return tags.colour !== undefined;
  if (tag === 'building:material') return tags.material !== undefined; // устаревший вариант для фасада
  return false;
}

/**
 * Теги, которых нет у объекта, но которые он наследует от источников (по порядку: контур, затем отношение).
 * Пусто — наследовать нечего.
 */
export function inheritedTags(tags: Record<string, string>, sources: Record<string, string>[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tag of INHERITABLE) {
    if (hasOwn(tags, tag)) continue;
    for (const src of sources) {
      const v = inheritedValue(src, tag);
      if (v !== undefined) { out[tag] = v; break; }
    }
  }
  return out;
}

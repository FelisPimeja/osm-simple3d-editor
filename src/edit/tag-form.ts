import { INHERITABLE, inheritedValue } from '../osm/inherit';
import type { EditSession } from './session';

type FieldType = 'length' | 'int' | 'select' | 'direction' | 'colour';

interface Field {
  tag: string;
  label: string;
  type: FieldType;
  options?: string[];
  placeholder?: string;
}

const ROOF_SHAPES = ['flat', 'gabled', 'hipped', 'pyramidal', 'skillion', 'dome', 'onion', 'round', 'gambrel', 'mansard', 'half-hipped', 'saltbox'];

const FIELDS: Field[] = [
  { tag: 'height', label: 'Высота, м', type: 'length', placeholder: 'до верха крыши' },
  { tag: 'min_height', label: 'Низ, м', type: 'length' },
  { tag: 'building:levels', label: 'Этажей', type: 'int' },
  { tag: 'building:min_level', label: 'Нижний этаж', type: 'int' },
  { tag: 'roof:shape', label: 'Форма крыши', type: 'select', options: ROOF_SHAPES },
  { tag: 'roof:height', label: 'Высота крыши, м', type: 'length' },
  { tag: 'roof:direction', label: 'Направление ската', type: 'direction', placeholder: '0–360 или N, SE…' },
  { tag: 'roof:orientation', label: 'Конёк', type: 'select', options: ['along', 'across'] },
  { tag: 'building:colour', label: 'Цвет стен', type: 'colour' },
  { tag: 'roof:colour', label: 'Цвет крыши', type: 'colour' },
];

const CARDINALS = new Set(['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']);

/** Пустое значение валидно (означает удаление тега). */
function isValid(type: FieldType, v: string): boolean {
  v = v.trim();
  if (!v) return true;
  switch (type) {
    case 'length': return /^\d+(\.\d+)?( ?m)?$/.test(v);
    case 'int': return /^\d+$/.test(v);
    case 'direction': return CARDINALS.has(v.toUpperCase()) || (/^\d+(\.\d+)?$/.test(v) && Number(v) <= 360);
    case 'colour': return CSS.supports('color', v.split(';')[0].trim());
    default: return true;
  }
}

/** CSS-цвет (имя, hex, rgb()) → #rrggbb для <input type="color">. */
function toHex(v: string | undefined): string {
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx || !v) return '#ffffff';
  ctx.fillStyle = '#ffffff';
  ctx.fillStyle = v.split(';')[0].trim();
  return ctx.fillStyle.startsWith('#') ? ctx.fillStyle : '#ffffff';
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

const INHERITABLE_SET = new Set<string>(INHERITABLE);

/** Поля только для некоторых форм крыши (рендер их учитывает только там). */
const SHAPE_ONLY: Record<string, string[]> = {
  'roof:direction': ['skillion', 'saltbox'],
  'roof:orientation': ['gabled', 'hipped', 'half-hipped', 'gambrel', 'round', 'saltbox'],
};

/** Откуда наследуются значения: контур (outline) и/или само отношение здания. */
export interface InheritSource { label: string; tags: Record<string, string> }

/** Значок «унаследовано» — стрелка вниз из рамки. */
const ICON_INHERIT = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2.5h10"/><path d="M8 5v8.5M5 10.5l3 3 3-3"/></svg>';

/** HTML формы тегов для объекта. sources — откуда показывать унаследованные значения (по порядку). */
export function renderTagForm(key: string, session: EditSession, sources: InheritSource[] = []): string {
  const f = session.get(key);
  if (!f) return '';
  const orig = session.originalTags(key) ?? {};
  const inheritedAny: string[] = [];
  // Форма крыши — своя или унаследованная: от неё зависит, нужны ли направление ската и конёк
  const shape = f.tags['roof:shape'] ?? sources.map((s) => s.tags['roof:shape']).find((v) => v !== undefined);
  const rows = FIELDS.filter((field) => {
    const only = SHAPE_ONLY[field.tag];
    // Уже заданное значение показываем всегда — чтобы его было видно и можно было удалить
    return !only || f.tags[field.tag] !== undefined || (!!shape && only.includes(shape));
  }).map((field) => {
    const value = f.tags[field.tag] ?? '';
    const changed = session.isChanged(key, field.tag);
    const was = changed ? `было: ${orig[field.tag] ?? '—'}` : '';
    // Своего значения нет — показываем унаследованное серым (placeholder) со значком и пояснением
    const from = !value && INHERITABLE_SET.has(field.tag) ? sources.find((src) => inheritedValue(src.tags, field.tag)) : undefined;
    const inherited = from ? inheritedValue(from.tags, field.tag) : undefined;
    const hint = from ? `Не задано у объекта — унаследовано из ${from.label}: ${field.tag}=${inherited}. Модель рисуется с ним, но в OSM лучше задать значение на самой части.` : '';
    if (from) inheritedAny.push(field.label.replace(/,.*$/, '').toLowerCase());
    const common = `data-tag="${esc(field.tag)}" data-type="${field.type}" title="${esc(hint || was || field.tag)}"`;
    let control: string;
    if (field.type === 'select') {
      // Нестандартное значение из данных тоже показываем, чтобы не потерять его
      const options = [...new Set([...(value && !field.options!.includes(value) ? [value] : []), ...field.options!])];
      // Унаследованное — серым в пустом варианте
      control = withBadge(`<select ${common}${inherited ? ' class="inherited"' : ''}><option value="">${esc(inherited ?? '—')}</option>${options
        .map((o) => `<option value="${esc(o)}"${o === value ? ' selected' : ''}>${esc(o)}</option>`)
        .join('')}</select>`, hint);
    } else if (field.type === 'colour') {
      control = `<span class="colour-field"><input type="color" value="${toHex(value || inherited)}" data-picker-for="${esc(field.tag)}"${inherited ? ' class="inherited"' : ''} />
        ${withBadge(`<input type="text" ${common} value="${esc(value)}" placeholder="${esc(inherited ?? '#rrggbb или имя')}" />`, hint)}</span>`;
    } else {
      control = withBadge(`<input type="text" inputmode="${field.type === 'int' ? 'numeric' : 'text'}" ${common} value="${esc(value)}" placeholder="${esc(inherited ?? field.placeholder ?? '')}" />`, hint);
    }
    return `<label class="tag-row${changed ? ' changed' : ''}"><span>${esc(field.label)}</span>${control}</label>`;
  }).join('');
  // У нового объекта «как было» — нет (отменить создание — undo)
  const revert = session.isChanged(key) && !session.isCreated(key) ? '<button type="button" data-revert>Вернуть как было</button>' : '';
  // Наследование — соглашение рендереров, а не схемы: советуем задать свойства на самой части
  const warn = inheritedAny.length
    ? `<p class="warn inherit-warn">⚠ ${esc(inheritedAny.join(', '))} — взято у здания (серым в полях). Другие программы могут не наследовать: лучше задать на самой части.</p>`
    : '';
  // material на здании — устаревший вариант building:material (вики: Key:material): предлагаем замену
  const legacy = f.tags.material !== undefined
    ? `<p class="warn">⚠ material=${esc(f.tags.material)} — для зданий устарел, фасад описывает building:material${f.tags['building:material'] ? ' (уже задан — material можно удалить)' : ''}.
        <button type="button" data-fix-material>${f.tags['building:material'] ? 'Удалить material' : 'Заменить на building:material'}</button></p>`
    : '';
  return `<form class="tag-form" data-key="${esc(key)}" onsubmit="return false">${legacy}${warn}${rows}${revert}</form>`;
}

/** Поле со значком «унаследовано» справа (только если есть пояснение). */
function withBadge(input: string, hint: string): string {
  if (!hint) return input;
  return `<span class="inherit-field" title="${esc(hint)}">${input}<span class="inherit-badge">${ICON_INHERIT}</span></span>`;
}

/** Обработчики формы (делегирование на контейнер; вешается один раз). */
export function bindTagForms(container: HTMLElement, session: () => EditSession | undefined) {
  const commit = (input: HTMLInputElement | HTMLSelectElement) => {
    const form = input.closest<HTMLFormElement>('.tag-form');
    const s = session();
    if (!form || !s) return;
    const { tag, type } = input.dataset;
    if (!tag || !type) return;
    const ok = isValid(type as FieldType, input.value);
    input.classList.toggle('invalid', !ok);
    if (ok) s.setTags(form.dataset.key!, { [tag]: input.value });
  };

  container.addEventListener('change', (e) => {
    const el = e.target as HTMLInputElement | HTMLSelectElement;
    if (el.dataset.tag) return commit(el);
    // Палитра: пишем hex в текстовое поле и применяем
    const pickerFor = (el as HTMLInputElement).dataset.pickerFor;
    if (pickerFor) {
      const text = el.closest('.colour-field')?.querySelector<HTMLInputElement>(`[data-tag="${CSS.escape(pickerFor)}"]`);
      if (text) { text.value = el.value; commit(text); }
    }
  });
  // Подсветка ошибок сразу при вводе, применение — по change (Enter или уход с поля)
  container.addEventListener('input', (e) => {
    const el = e.target as HTMLInputElement;
    if (el.dataset.tag && el.dataset.type) el.classList.toggle('invalid', !isValid(el.dataset.type as FieldType, el.value));
  });
  container.addEventListener('click', (e) => {
    const fix = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-fix-material]');
    const fixForm = fix?.closest<HTMLFormElement>('.tag-form');
    const s = session();
    if (fixForm && s) {
      const key = fixForm.dataset.key!;
      const t = s.get(key)?.tags;
      if (t?.material !== undefined) s.setTags(key, { 'building:material': t['building:material'] ?? t.material, material: undefined });
      return;
    }
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-revert]');
    const form = btn?.closest<HTMLFormElement>('.tag-form');
    if (form) session()?.revert(form.dataset.key!);
  });
}

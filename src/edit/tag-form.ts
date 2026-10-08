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
  if (!ctx || !v) return '#d9d0c9';
  ctx.fillStyle = '#d9d0c9';
  ctx.fillStyle = v.split(';')[0].trim();
  return ctx.fillStyle.startsWith('#') ? ctx.fillStyle : '#d9d0c9';
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/** HTML формы тегов для объекта. */
export function renderTagForm(key: string, session: EditSession): string {
  const f = session.get(key);
  if (!f) return '';
  const orig = session.originalTags(key) ?? {};
  const rows = FIELDS.map((field) => {
    const value = f.tags[field.tag] ?? '';
    const changed = session.isChanged(key, field.tag);
    const was = changed ? `было: ${orig[field.tag] ?? '—'}` : '';
    const common = `data-tag="${esc(field.tag)}" data-type="${field.type}" title="${esc(was || field.tag)}"`;
    let control: string;
    if (field.type === 'select') {
      // Нестандартное значение из данных тоже показываем, чтобы не потерять его
      const options = [...new Set([...(value && !field.options!.includes(value) ? [value] : []), ...field.options!])];
      control = `<select ${common}><option value="">—</option>${options
        .map((o) => `<option value="${esc(o)}"${o === value ? ' selected' : ''}>${esc(o)}</option>`)
        .join('')}</select>`;
    } else if (field.type === 'colour') {
      control = `<span class="colour-field"><input type="color" value="${toHex(value)}" data-picker-for="${esc(field.tag)}" />
        <input type="text" ${common} value="${esc(value)}" placeholder="#rrggbb или имя" /></span>`;
    } else {
      control = `<input type="text" inputmode="${field.type === 'int' ? 'numeric' : 'text'}" ${common} value="${esc(value)}" placeholder="${esc(field.placeholder ?? '')}" />`;
    }
    return `<label class="tag-row${changed ? ' changed' : ''}"><span>${esc(field.label)}</span>${control}</label>`;
  }).join('');
  const revert = session.isChanged(key) ? '<button type="button" data-revert>Вернуть как было</button>' : '';
  return `<form class="tag-form" data-key="${esc(key)}" onsubmit="return false">${rows}${revert}</form>`;
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
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-revert]');
    const form = btn?.closest<HTMLFormElement>('.tag-form');
    if (form) session()?.revert(form.dataset.key!);
  });
}

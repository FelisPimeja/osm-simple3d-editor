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

const NUMERIC = new Set<FieldType>(['length', 'int', 'direction']);
/** Формула для числовых полей: =+1, =-2, =*3, =/8 — применяется к значению каждого объекта. */
const FORMULA = /^=\s*([+\-*/])\s*(\d+(?:[.,]\d+)?)$/;

/** Значение тега после формулы (undefined — у объекта нет числового значения, не трогаем). */
function applyFormula(type: FieldType, input: string, current: string | undefined): string | undefined {
  const m = FORMULA.exec(input.trim());
  if (!m) return input;
  const cur = parseFloat(current ?? '');
  if (!Number.isFinite(cur)) return;
  const n = Number(m[2].replace(',', '.'));
  let v = m[1] === '+' ? cur + n : m[1] === '-' ? cur - n : m[1] === '*' ? cur * n : n ? cur / n : cur;
  if (type === 'direction') v = ((v % 360) + 360) % 360;
  v = type === 'int' ? Math.round(v) : Math.round(v * 100) / 100;
  return String(v);
}

/** Пустое значение валидно (означает удаление тега). */
function isValid(type: FieldType, v: string): boolean {
  v = v.trim();
  if (!v) return true;
  if (NUMERIC.has(type) && FORMULA.test(v)) return true;
  switch (type) {
    case 'length': return /^-?\d+(\.\d+)?( ?m)?$/.test(v);
    case 'int': return /^-?\d+$/.test(v);
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

/** Форма тегов для нескольких объектов: общее значение или «разные» серым; правка — сразу для всех. */
export function renderMultiTagForm(keys: string[], session: EditSession): string {
  const feats = keys.map((k) => session.get(k)).filter((f): f is NonNullable<typeof f> => !!f);
  if (!feats.length) return '';
  const values = (tag: string) => [...new Set(feats.map((f) => f.tags[tag] ?? ''))];
  const shapes = values('roof:shape');
  const rows = FIELDS.filter((field) => {
    const only = SHAPE_ONLY[field.tag];
    return !only || values(field.tag).some(Boolean) || shapes.some((v) => only.includes(v));
  }).map((field) => {
    const vs = values(field.tag);
    const mixed = vs.length > 1;
    const value = mixed ? '' : vs[0];
    const changed = feats.some((f) => session.isChanged(f.key, field.tag));
    const shown = mixed ? `разные: ${vs.map((v) => v || '—').slice(0, 6).join(', ')}${vs.length > 6 ? '…' : ''}` : '';
    const tip = mixed ? `${shown}${NUMERIC.has(field.type) ? '. Число — всем одно значение; =+1, =-2, =*2, =/8 — к значению каждого' : ''}` : field.tag;
    const common = `data-tag="${esc(field.tag)}" data-type="${field.type}" title="${esc(tip)}"`;
    const cls = mixed ? ' class="mixed"' : '';
    let control: string;
    if (field.type === 'select') {
      const extra = vs.filter((v) => v && !field.options!.includes(v));
      const options = [...new Set([...extra, ...field.options!])];
      control = `<select ${common}${cls}><option value="">${mixed ? 'разные' : '—'}</option>${options
        .map((o) => `<option value="${esc(o)}"${o === value ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    } else if (field.type === 'colour') {
      control = `<span class="colour-field"><input type="color" value="${toHex(value || vs.find(Boolean))}" data-picker-for="${esc(field.tag)}"${cls} />
        <input type="text" ${common}${cls} value="${esc(value)}" placeholder="${mixed ? 'разные' : '#rrggbb или имя'}" /></span>`;
    } else {
      control = `<input type="text" inputmode="${field.type === 'int' ? 'numeric' : 'text'}" ${common}${cls} value="${esc(value)}" placeholder="${esc(mixed ? 'разные' : field.placeholder ?? '')}" />`;
    }
    return `<label class="tag-row${changed ? ' changed' : ''}"><span>${esc(field.label)}</span>${control}</label>`;
  }).join('');
  return `<form class="tag-form" data-keys="${esc(feats.map((f) => f.key).join(' '))}" onsubmit="return false">
    <p class="hint">Общие свойства ${feats.length} объектов. Для чисел формула: =+1, =-2, =*2, =/8 — к значению каждого.</p>${rows}</form>`;
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
    if (!ok) return;
    const keys = form.dataset.keys ? form.dataset.keys.split(' ') : [form.dataset.key!];
    const edits = keys.flatMap((key) => {
      const f = s.get(key);
      if (!f) return [];
      const v = applyFormula(type as FieldType, input.value, f.tags[tag]);
      if (v === undefined) return [];
      const tags = { ...f.tags };
      if (v.trim()) tags[tag] = v.trim(); else delete tags[tag];
      return tags[tag] === f.tags[tag] ? [] : [{ key, tags }];
    });
    if (edits.length === 1 && keys.length === 1) s.setTags(edits[0].key, { [tag]: edits[0].tags[tag] });
    else if (edits.length) s.editMany(edits);
    // Формула применена — поле покажет новое значение после перерисовки; если ничего не поменялось — очистить
    if (!edits.length && FORMULA.test(input.value.trim())) input.value = '';
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

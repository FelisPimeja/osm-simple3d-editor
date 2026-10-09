import { INHERITABLE, inheritedValue } from '../osm/inherit';
import type { EditSession } from './session';

type FieldType = 'length' | 'int' | 'select' | 'direction' | 'colour' | 'combo';

interface Field {
  tag: string;
  label: string;
  type: FieldType;
  options?: string[];
  /** combo: подписи вариантов (значение → подпись). */
  labels?: Record<string, string>;
  /** combo: иконки вариантов (SVG). */
  icons?: Record<string, string>;
  /** combo: значение вместо пустого (иначе пустое удаляет тег). */
  empty?: string;
  placeholder?: string;
}

/** Частые значения building:part (taginfo) с подписями; можно ввести и своё. */
const PART_VALUES: Record<string, string> = {
  yes: 'Часть', roof: 'Крыша', steps: 'Ступени', balcony: 'Балкон', deck: 'Настил', terrace: 'Терраса',
  column: 'Колонна', tower: 'Башня', bell_tower: 'Колокольня', porch: 'Крыльцо', veranda: 'Веранда',
  canopy: 'Навес', elevator: 'Лифт', mast: 'Мачта', dome: 'Купол', chimney: 'Труба', base: 'Основание',
  wall: 'Стена', corridor: 'Переход', construction: 'Строится',
};

const ROOF_SHAPE_LABELS: Record<string, string> = {
  flat: 'Плоская', gabled: 'Двускатная', hipped: 'Вальмовая', pyramidal: 'Шатровая', skillion: 'Односкатная',
  dome: 'Купол', onion: 'Луковица', round: 'Сводчатая', gambrel: 'Ломаная двускатная', mansard: 'Мансардная',
  'half-hipped': 'Полувальмовая', saltbox: 'Несимметричная двускатная',
};
const ROOF_SHAPES = Object.keys(ROOF_SHAPE_LABELS);

/**
 * Иконки форм крыши (по рисункам Simple 3D Buildings в вики): грани 3D-моделей в ортопроекции, заливка
 * по освещению (fill-opacity), криволинейные поверхности — тонкой сеткой (класс c). Сгенерированы скриптом.
 */
const roofIcon = (paths: string) => `<svg class="roof-icon" viewBox="0 0 22 19">${paths}</svg>`;
const ROOF_ICONS: Record<string, string> = {
  'flat': roofIcon('<path d="M1.0 7.2L6.6 11.4L21.0 7.2L15.4 3.0Z" fill-opacity="0.25"/><path d="M6.6 11.4L6.6 16.0L21.0 11.8L21.0 7.2Z" fill-opacity="0.33"/><path d="M6.6 11.4L1.0 7.2L1.0 11.8L6.6 16.0Z" fill-opacity="0.45"/>'),
  'gabled': roofIcon('<path d="M6.6 12.9L6.6 17.5L21.0 13.3L21.0 8.7Z" fill-opacity="0.33"/><path d="M3.8 5.7L6.6 12.9L21.0 8.7L18.2 1.5Z" fill-opacity="0.16"/><path d="M6.6 12.9L3.8 5.7L1.0 8.7L1.0 13.3L6.6 17.5Z" fill-opacity="0.45"/>'),
  'gambrel': roofIcon('<path d="M2.1 5.8L3.8 5.7L18.2 1.5L16.5 1.6Z" fill-opacity="0.41"/><path d="M6.6 12.9L6.6 17.5L21.0 13.3L21.0 8.7Z" fill-opacity="0.33"/><path d="M3.8 5.7L5.5 8.4L19.9 4.2L18.2 1.5Z" fill-opacity="0.16"/><path d="M5.5 8.4L6.6 12.9L21.0 8.7L19.9 4.2Z" fill-opacity="0.20"/><path d="M6.6 12.9L5.5 8.4L3.8 5.7L2.1 5.8L1.0 8.7L1.0 13.3L6.6 17.5Z" fill-opacity="0.45"/>'),
  'saltbox': roofIcon('<path d="M2.8 5.3L6.6 13.3L21.0 9.0L17.2 1.1Z" fill-opacity="0.15"/><path d="M6.6 13.3L6.6 17.9L21.0 13.7L21.0 9.0Z" fill-opacity="0.33"/><path d="M6.6 13.3L2.8 5.3L1.0 9.1L1.0 13.7L6.6 17.9Z" fill-opacity="0.45"/>'),
  'skillion': roofIcon('<path d="M1.6 5.0L6.9 13.6L20.4 9.7L15.1 1.0Z" fill-opacity="0.15"/><path d="M6.9 13.6L6.9 18.0L20.4 14.0L20.4 9.7Z" fill-opacity="0.33"/><path d="M6.9 13.6L1.6 5.0L1.6 14.1L6.9 18.0Z" fill-opacity="0.45"/>'),
  'round': roofIcon('<path d="M2.2 5.6L2.9 5.5L17.3 1.3L16.6 1.4Z" fill-opacity="0.44" class="c"/><path d="M2.9 5.5L3.8 5.9L18.2 1.7L17.3 1.3Z" fill-opacity="0.30" class="c"/><path d="M6.6 13.1L6.6 17.7L21.0 13.5L21.0 8.9Z" fill-opacity="0.33"/><path d="M3.8 5.9L4.7 6.8L19.1 2.6L18.2 1.7Z" fill-opacity="0.20" class="c"/><path d="M4.7 6.8L5.4 8.1L19.8 3.9L19.1 2.6Z" fill-opacity="0.15" class="c"/><path d="M6.4 11.4L6.6 13.1L21.0 8.9L20.9 7.2Z" fill-opacity="0.28" class="c"/><path d="M5.4 8.1L6.1 9.7L20.5 5.5L19.8 3.9Z" fill-opacity="0.16" class="c"/><path d="M6.1 9.7L6.4 11.4L20.9 7.2L20.5 5.5Z" fill-opacity="0.20" class="c"/><path d="M6.6 13.1L6.4 11.4L6.1 9.7L5.4 8.1L4.7 6.8L3.8 5.9L2.9 5.5L2.2 5.6L1.5 6.3L1.1 7.4L1.0 8.9L1.0 13.5L6.6 17.7Z" fill-opacity="0.45"/>'),
  'hipped': roofIcon('<path d="M6.6 16.9L21.0 12.7L21.0 8.0L6.6 12.3Z" fill-opacity="0.33"/><path d="M1.0 12.7L6.6 16.9L6.6 12.3L1.0 8.1Z" fill-opacity="0.45"/><path d="M6.6 12.3L21.0 8.0L14.0 2.1L8.0 3.8Z" fill-opacity="0.16"/><path d="M1.0 8.1L6.6 12.3L8.0 3.8Z" fill-opacity="0.25"/>'),
  'pyramidal': roofIcon('<path d="M21.0 7.6L15.4 3.4L11.0 2.5Z" fill-opacity="0.41"/><path d="M6.6 16.5L21.0 12.3L21.0 7.6L6.6 11.8Z" fill-opacity="0.33"/><path d="M1.0 12.3L6.6 16.5L6.6 11.8L1.0 7.6Z" fill-opacity="0.45"/><path d="M6.6 11.8L21.0 7.6L11.0 2.5Z" fill-opacity="0.16"/><path d="M1.0 7.6L6.6 11.8L11.0 2.5Z" fill-opacity="0.22"/>'),
  'mansard': roofIcon('<path d="M18.7 4.6L14.9 1.7L14.2 2.4Z" fill-opacity="0.38"/><path d="M14.9 1.7L3.3 5.1L7.8 4.3L14.2 2.4Z" fill-opacity="0.41"/><path d="M6.6 17.3L21.0 13.0L21.0 8.4L6.6 12.6Z" fill-opacity="0.33"/><path d="M1.0 13.1L6.6 17.3L6.6 12.6L1.0 8.4Z" fill-opacity="0.45"/><path d="M7.1 8.0L18.7 4.6L14.2 2.4L7.8 4.3Z" fill-opacity="0.16"/><path d="M6.6 12.6L21.0 8.4L18.7 4.6L7.1 8.0Z" fill-opacity="0.21"/><path d="M1.0 8.4L6.6 12.6L7.1 8.0L3.3 5.1Z" fill-opacity="0.32"/><path d="M3.3 5.1L7.1 8.0L7.8 4.3Z" fill-opacity="0.21"/>'),
  'half-hipped': roofIcon('<path d="M6.6 17.2L21.0 13.0L21.0 8.4L6.6 12.6Z" fill-opacity="0.33"/><path d="M1.0 13.0L6.6 17.2L6.6 12.6L1.0 8.4Z" fill-opacity="0.45"/><path d="M6.6 12.6L21.0 8.4L19.5 4.4L16.2 1.8L5.8 4.8L5.0 8.6Z" fill-opacity="0.16"/><path d="M1.0 8.4L6.6 12.6L5.0 8.6L2.5 6.7Z" fill-opacity="0.45"/><path d="M2.5 6.7L5.0 8.6L5.8 4.8Z" fill-opacity="0.25"/>'),
  'dome': roofIcon('<path d="M6.6 11.8L21.0 7.6L15.4 3.4L1.0 7.6Z" fill-opacity="0.25"/><path d="M12.4 2.7L10.9 2.5L10.9 2.6L11.7 2.7Z" fill-opacity="0.44" class="c"/><path d="M6.7 5.1L6.2 6.3L6.9 5.0L7.4 4.0Z" fill-opacity="0.53" class="c"/><path d="M10.9 2.5L9.4 2.8L10.2 2.7L10.9 2.6Z" fill-opacity="0.44" class="c"/><path d="M13.5 3.2L12.4 2.7L11.7 2.7L12.3 2.9Z" fill-opacity="0.40" class="c"/><path d="M9.4 2.8L8.4 3.3L9.6 3.0L10.2 2.7Z" fill-opacity="0.40" class="c"/><path d="M15.1 4.9L14.5 3.9L13.5 3.2L14.0 3.9Z" fill-opacity="0.42" class="c"/><path d="M7.4 4.0L6.9 5.0L8.0 4.0L8.4 3.3Z" fill-opacity="0.42" class="c"/><path d="M15.5 8.7L16.1 7.5L15.8 6.1L15.3 7.3Z" fill-opacity="0.48" class="c"/><path d="M11.7 2.7L10.9 2.6L11.0 3.1Z" fill-opacity="0.30" class="c"/><path d="M10.9 2.6L10.2 2.7L11.0 3.1Z" fill-opacity="0.30" class="c"/><path d="M14.0 3.9L13.5 3.2L12.3 2.9L12.6 3.3Z" fill-opacity="0.33" class="c"/><path d="M5.9 7.7L6.7 8.9L6.9 7.4L6.2 6.3Z" fill-opacity="0.48" class="c"/><path d="M12.3 2.9L11.7 2.7L11.0 3.1Z" fill-opacity="0.29" class="c"/><path d="M8.4 3.3L8.0 4.0L9.4 3.3L9.6 3.0Z" fill-opacity="0.33" class="c"/><path d="M10.2 2.7L9.6 3.0L11.0 3.1Z" fill-opacity="0.29" class="c"/><path d="M15.3 7.3L15.8 6.1L15.1 4.9L14.6 5.9Z" fill-opacity="0.38" class="c"/><path d="M12.6 3.3L12.3 2.9L11.0 3.1Z" fill-opacity="0.27" class="c"/><path d="M9.6 3.0L9.4 3.3L11.0 3.1Z" fill-opacity="0.27" class="c"/><path d="M6.2 6.3L6.9 7.4L7.5 6.0L6.9 5.0Z" fill-opacity="0.38" class="c"/><path d="M14.6 5.9L15.1 4.9L14.0 3.9L13.6 4.6Z" fill-opacity="0.30" class="c"/><path d="M12.4 3.7L12.6 3.3L11.0 3.1Z" fill-opacity="0.24" class="c"/><path d="M13.6 4.6L14.0 3.9L12.6 3.3L12.4 3.7Z" fill-opacity="0.25" class="c"/><path d="M6.9 5.0L7.5 6.0L8.5 4.7L8.0 4.0Z" fill-opacity="0.30" class="c"/><path d="M9.4 3.3L9.7 3.7L11.0 3.1Z" fill-opacity="0.24" class="c"/><path d="M8.0 4.0L8.5 4.7L9.7 3.7L9.4 3.3Z" fill-opacity="0.25" class="c"/><path d="M6.6 16.5L21.0 12.2L21.0 7.6L6.6 11.8Z" fill-opacity="0.33"/><path d="M1.0 12.3L6.6 16.5L6.6 11.8L1.0 7.6Z" fill-opacity="0.45"/><path d="M11.8 3.9L12.4 3.7L11.0 3.1Z" fill-opacity="0.21" class="c"/><path d="M9.7 3.7L10.3 4.0L11.0 3.1Z" fill-opacity="0.21" class="c"/><path d="M11.1 4.0L11.8 3.9L11.0 3.1Z" fill-opacity="0.20" class="c"/><path d="M10.3 4.0L11.1 4.0L11.0 3.1Z" fill-opacity="0.20" class="c"/><path d="M13.7 9.6L15.5 8.7L15.3 7.3L13.6 8.1Z" fill-opacity="0.33" class="c"/><path d="M12.6 5.1L13.6 4.6L12.4 3.7L11.8 3.9Z" fill-opacity="0.18" class="c"/><path d="M6.7 8.9L8.6 9.7L8.7 8.2L6.9 7.4Z" fill-opacity="0.33" class="c"/><path d="M8.5 4.7L9.6 5.2L10.3 4.0L9.7 3.7Z" fill-opacity="0.18" class="c"/><path d="M13.6 8.1L15.3 7.3L14.6 5.9L13.2 6.6Z" fill-opacity="0.24" class="c"/><path d="M13.2 6.6L14.6 5.9L13.6 4.6L12.6 5.1Z" fill-opacity="0.19" class="c"/><path d="M6.9 7.4L8.7 8.2L9.1 6.7L7.5 6.0Z" fill-opacity="0.24" class="c"/><path d="M7.5 6.0L9.1 6.7L9.6 5.2L8.5 4.7Z" fill-opacity="0.19" class="c"/><path d="M11.1 5.4L12.6 5.1L11.8 3.9L11.1 4.0Z" fill-opacity="0.14" class="c"/><path d="M9.6 5.2L11.1 5.4L11.1 4.0L10.3 4.0Z" fill-opacity="0.14" class="c"/><path d="M11.2 10.0L13.7 9.6L13.6 8.1L11.2 8.5Z" fill-opacity="0.24" class="c"/><path d="M8.6 9.7L11.2 10.0L11.2 8.5L8.7 8.2Z" fill-opacity="0.25" class="c"/><path d="M11.1 6.9L13.2 6.6L12.6 5.1L11.1 5.4Z" fill-opacity="0.13" class="c"/><path d="M9.1 6.7L11.1 6.9L11.1 5.4L9.6 5.2Z" fill-opacity="0.13" class="c"/><path d="M11.2 8.5L13.6 8.1L13.2 6.6L11.1 6.9Z" fill-opacity="0.17" class="c"/><path d="M8.7 8.2L11.2 8.5L11.1 6.9L9.1 6.7Z" fill-opacity="0.17" class="c"/>'),
  'onion': roofIcon('<path d="M6.6 13.2L21.0 9.0L15.4 4.8L1.0 9.0Z" fill-opacity="0.25"/><path d="M15.8 6.1L15.0 5.0L13.9 3.8L14.4 4.6Z" fill-opacity="0.46" class="c"/><path d="M6.8 5.1L6.2 6.2L7.6 4.7L8.0 3.9Z" fill-opacity="0.46" class="c"/><path d="M15.2 8.6L15.8 7.4L15.8 6.1L15.2 7.2Z" fill-opacity="0.53" class="c"/><path d="M14.4 4.6L13.9 3.8L12.2 2.7L12.4 3.0Z" fill-opacity="0.41" class="c"/><path d="M8.0 3.9L7.6 4.7L9.6 3.0L9.8 2.7Z" fill-opacity="0.41" class="c"/><path d="M6.2 7.6L7.0 8.7L7.0 7.3L6.2 6.2Z" fill-opacity="0.54" class="c"/><path d="M12.6 10.2L13.7 9.7L15.2 8.6L13.5 9.4Z" fill-opacity="0.62" class="c"/><path d="M15.2 7.2L15.8 6.1L14.4 4.6L14.0 5.4Z" fill-opacity="0.32" class="c"/><path d="M6.6 17.9L21.0 13.6L21.0 9.0L6.6 13.2Z" fill-opacity="0.33"/><path d="M1.0 13.7L6.6 17.9L6.6 13.2L1.0 9.0Z" fill-opacity="0.45"/><path d="M8.4 9.8L9.6 10.3L8.8 9.5L7.0 8.7Z" fill-opacity="0.62" class="c"/><path d="M6.2 6.2L7.0 7.3L8.1 5.5L7.6 4.7Z" fill-opacity="0.33" class="c"/><path d="M14.0 5.4L14.4 4.6L12.4 3.0L12.2 3.3Z" fill-opacity="0.29" class="c"/><path d="M12.4 3.0L12.2 2.7L11.0 1.1Z" fill-opacity="0.50" class="c"/><path d="M7.6 4.7L8.1 5.5L9.8 3.3L9.6 3.0Z" fill-opacity="0.29" class="c"/><path d="M9.8 2.7L9.6 3.0L11.0 1.1Z" fill-opacity="0.50" class="c"/><path d="M11.1 10.4L12.6 10.2L13.5 9.4L11.2 9.7Z" fill-opacity="0.62" class="c"/><path d="M9.6 10.3L11.1 10.4L11.2 9.7L8.8 9.5Z" fill-opacity="0.62" class="c"/><path d="M12.2 3.3L12.4 3.0L11.0 1.1Z" fill-opacity="0.35" class="c"/><path d="M9.6 3.0L9.8 3.3L11.0 1.1Z" fill-opacity="0.35" class="c"/><path d="M13.5 9.4L15.2 8.6L15.2 7.2L13.5 8.1Z" fill-opacity="0.38" class="c"/><path d="M11.7 3.5L12.2 3.3L11.0 1.1Z" fill-opacity="0.22" class="c"/><path d="M9.8 3.3L10.4 3.6L11.0 1.1Z" fill-opacity="0.22" class="c"/><path d="M7.0 8.7L8.8 9.5L8.8 8.1L7.0 7.3Z" fill-opacity="0.39" class="c"/><path d="M12.8 6.0L14.0 5.4L12.2 3.3L11.7 3.5Z" fill-opacity="0.19" class="c"/><path d="M8.1 5.5L9.4 6.1L10.4 3.6L9.8 3.3Z" fill-opacity="0.19" class="c"/><path d="M11.0 3.6L11.7 3.5L11.0 1.1Z" fill-opacity="0.15" class="c"/><path d="M10.4 3.6L11.0 3.6L11.0 1.1Z" fill-opacity="0.15" class="c"/><path d="M13.5 8.1L15.2 7.2L14.0 5.4L12.8 6.0Z" fill-opacity="0.20" class="c"/><path d="M7.0 7.3L8.8 8.1L9.4 6.1L8.1 5.5Z" fill-opacity="0.21" class="c"/><path d="M11.1 6.2L12.8 6.0L11.7 3.5L11.0 3.6Z" fill-opacity="0.13" class="c"/><path d="M9.4 6.1L11.1 6.2L11.0 3.6L10.4 3.6Z" fill-opacity="0.13" class="c"/><path d="M11.2 9.7L13.5 9.4L13.5 8.1L11.2 8.4Z" fill-opacity="0.30" class="c"/><path d="M8.8 9.5L11.2 9.7L11.2 8.4L8.8 8.1Z" fill-opacity="0.30" class="c"/><path d="M11.2 8.4L13.5 8.1L12.8 6.0L11.1 6.2Z" fill-opacity="0.14" class="c"/><path d="M8.8 8.1L11.2 8.4L11.1 6.2L9.4 6.1Z" fill-opacity="0.14" class="c"/>'),
};

const FIELDS: Field[] = [
  { tag: 'building:part', label: 'Часть здания', type: 'combo', options: Object.keys(PART_VALUES), labels: PART_VALUES, placeholder: 'yes', empty: 'yes' },
  { tag: 'height', label: 'Высота, м', type: 'length', placeholder: 'до верха крыши' },
  { tag: 'min_height', label: 'Низ, м', type: 'length' },
  { tag: 'building:levels', label: 'Этажей', type: 'int' },
  { tag: 'building:min_level', label: 'Нижний этаж', type: 'int' },
  { tag: 'roof:shape', label: 'Форма крыши', type: 'combo', options: ROOF_SHAPES, labels: ROOF_SHAPE_LABELS, icons: ROOF_ICONS },
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
    if (field.tag === 'building:part' && f.tags['building:part'] === undefined) return false; // только у частей
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
    } else if (field.type === 'combo') {
      control = withBadge(combo(field, common, value, inherited ?? field.placeholder ?? '—', inherited ? ' class="inherited"' : '', inherited), hint);
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
    if (field.tag === 'building:part' && !feats.every((f) => f.tags['building:part'] !== undefined)) return false;
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
    } else if (field.type === 'combo') {
      control = combo(field, common, value, mixed ? 'разные' : field.placeholder ?? '—', cls);
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

/**
 * Поле со списком частых значений и своим вводом. Свой список вместо datalist: тот прячет варианты,
 * не совпадающие с введённым, и стрелку показывает только при наведении.
 */
function combo(field: Field, common: string, value: string, placeholder: string, cls: string, inherited?: string): string {
  // Нестандартное значение из данных — тоже в списке, чтобы его было видно
  const options = [...new Set([...(value && !field.options!.includes(value) ? [value] : []), ...field.options!])];
  const icon = (o: string) => (field.icons ? `<i class="combo-icon">${field.icons[o] ?? ''}</i>` : '');
  const items = options.map((o) => `<li data-value="${esc(o)}"${o === value ? ' class="current"' : ''}>${icon(o)}<b>${esc(field.labels?.[o] ?? o)}</b><span>${esc(o)}</span></li>`).join('');
  // Иконка выбранного (или унаследованного) значения — слева в поле
  const shown = field.icons?.[value || inherited || ''];
  const lead = field.icons ? `<i class="combo-icon combo-lead${!value && inherited ? ' inherited' : ''}">${shown ?? ''}</i>` : '';
  return `<span class="combo-field${field.icons ? ' with-icons' : ''}">${lead}<input type="text" autocomplete="off" ${common}${cls} value="${esc(value)}" placeholder="${esc(placeholder)}" />`
    + `<button type="button" class="combo-btn" tabindex="-1" title="Выбрать из списка"></button><ul class="combo-list" hidden>${items}</ul></span>`;
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
      // Пустая «Часть здания» — по умолчанию yes (без тега объект перестал бы быть частью)
      const empty = FIELDS.find((x) => x.tag === tag)?.empty;
      if (v.trim()) tags[tag] = v.trim(); else if (empty) tags[tag] = empty; else delete tags[tag];
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
  // Список «Части здания»: стрелка открывает и закрывает, выбор пишет значение и применяет
  const closeCombos = (except?: Element) => {
    for (const ul of container.querySelectorAll<HTMLElement>('.combo-list')) if (ul !== except) ul.hidden = true;
  };
  container.addEventListener('mousedown', (e) => {
    const t = e.target as HTMLElement;
    const btn = t.closest('.combo-btn');
    const li = t.closest<HTMLElement>('.combo-list li');
    if (!btn && !li) return;
    e.preventDefault(); // фокус остаётся в поле, change не срабатывает раньше выбора
    const field = t.closest('.combo-field')!;
    const ul = field.querySelector<HTMLElement>('.combo-list')!;
    const input = field.querySelector<HTMLInputElement>('input')!;
    if (btn) { closeCombos(ul); filterCombo(ul, ''); ul.hidden = !ul.hidden; if (!ul.hidden) input.focus(); return; }
    ul.hidden = true;
    input.value = li!.dataset.value!;
    commit(input);
  });
  document.addEventListener('mousedown', (e) => { if (!(e.target as Element).closest?.('.combo-field')) closeCombos(); });
  // Подстановка при вводе: варианты, где значение или подпись содержат введённое (сначала — начинающиеся с него);
  // ↑/↓ — выбор, Enter — подставить вариант, Esc — закрыть
  const filterCombo = (ul: HTMLElement, q: string) => {
    q = q.trim().toLowerCase();
    // Исходный порядок (поднятый наверх вариант прошлого ввода возвращаем на место)
    const lis = [...ul.querySelectorAll<HTMLElement>('li')];
    lis.forEach((li, i) => { li.dataset.i ??= String(i); });
    lis.sort((a, b) => Number(a.dataset.i) - Number(b.dataset.i));
    for (const li of lis) ul.appendChild(li);
    for (const li of lis) {
      const text = `${li.dataset.value} ${li.querySelector('b')?.textContent ?? ''}`.toLowerCase();
      li.classList.toggle('nomatch', !!q && !text.includes(q));
      li.classList.remove('active');
    }
    const starts = lis.find((li) => !li.classList.contains('nomatch') && q && (li.dataset.value!.startsWith(q) || li.querySelector('b')!.textContent!.toLowerCase().startsWith(q)));
    if (starts) ul.insertBefore(starts, ul.firstChild);
    return lis.filter((li) => !li.classList.contains('nomatch'));
  };
  container.addEventListener('input', (e) => {
    const input = e.target as HTMLInputElement;
    const ul = input.closest('.combo-field')?.querySelector<HTMLElement>('.combo-list');
    if (!ul) return;
    const shown = filterCombo(ul, input.value);
    ul.hidden = !input.value.trim() || !shown.length || (shown.length === 1 && shown[0].dataset.value === input.value.trim());
    shown[0]?.classList.toggle('active', !!input.value.trim());
  });
  container.addEventListener('keydown', (e) => {
    const field = (e.target as Element).closest('.combo-field');
    if (!field) return;
    const ul = field.querySelector<HTMLElement>('.combo-list')!;
    if (e.key === 'Escape') { closeCombos(); return; }
    const shown = [...ul.querySelectorAll<HTMLElement>('li:not(.nomatch)')];
    const i = shown.findIndex((li) => li.classList.contains('active'));
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (ul.hidden) { filterCombo(ul, ''); ul.hidden = false; }
      const list = [...ul.querySelectorAll<HTMLElement>('li:not(.nomatch)')];
      const j = e.key === 'ArrowDown' ? Math.min(list.length - 1, i + 1) : Math.max(0, i - 1);
      for (const li of list) li.classList.toggle('active', li === list[j]);
      list[j]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && !ul.hidden && i >= 0) {
      e.preventDefault();
      const input = field.querySelector<HTMLInputElement>('input')!;
      input.value = shown[i].dataset.value!;
      ul.hidden = true;
      commit(input);
    } else if (e.key === 'Enter') ul.hidden = true;
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

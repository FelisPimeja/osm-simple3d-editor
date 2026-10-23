import { INHERITABLE, inheritedTags, inheritedValue } from '../osm/inherit';
import { computeHeights, LEVEL_HEIGHT, parseLength, roofHeightOf, roofShapeOf } from '../osm/heights';
import type { EditSession } from './session';
import { tr, trn } from '../i18n';
import { idFieldLabel, idOptions, valueLabels } from '../osm/presets';
import { parseDate } from '../osm/dates';

type FieldType = 'length' | 'int' | 'select' | 'direction' | 'colour' | 'combo' | 'date' | 'edtf';

interface Field {
  tag: string;
  /** Нет — название поля из iD (src/osm/presets.ts). */
  label?: string;
  type: FieldType;
  options?: string[];
  /** combo: подписи вариантов (значение → подпись), поверх подписей iD. */
  labels?: Record<string, string>;
  /** combo: иконки вариантов (SVG). */
  icons?: Record<string, string>;
  /** combo: значение вместо пустого (иначе пустое удаляет тег). */
  empty?: string;
  placeholder?: string;
  /** Только на OpenHistoricalMap (setDateFields); заданное значение показываем везде. */
  dated?: boolean;
  /** Пустое поле подсказывает значение здания (контура/отношения): серым, Tab — подставить. */
  suggest?: boolean;
}

/** Частые значения building:part (taginfo) с подписями; можно ввести и своё. */
/** Значение в списке, означающее «удалить тег». */
const REMOVE_VALUE = '-';

const PART_VALUES: Record<string, string> = {
  yes: tr('Часть'), roof: tr('Крыша'), steps: tr('Ступени'), balcony: tr('Балкон'), deck: tr('Настил'), terrace: tr('Терраса'),
  column: tr('Колонна'), tower: tr('Башня'), bell_tower: tr('Колокольня'), porch: tr('Крыльцо'), veranda: tr('Веранда'),
  canopy: tr('Навес'), elevator: tr('Лифт'), mast: tr('Мачта'), dome: tr('Купол'), chimney: tr('Труба'), base: tr('Основание'),
  wall: tr('Стена'), corridor: tr('Переход'), construction: tr('Строится'),
};

const ROOF_SHAPE_LABELS: Record<string, string> = {
  flat: tr('Плоская'), gabled: tr('Двускатная'), hipped: tr('Вальмовая'), pyramidal: tr('Шатровая'), skillion: tr('Односкатная'),
  dome: tr('Купол'), onion: tr('Луковица'), round: tr('Сводчатая'), gambrel: tr('Ломаная двускатная'), mansard: tr('Мансардная'),
  'half-hipped': tr('Полувальмовая'), saltbox: tr('Несимметричная двускатная'),
  side_hipped: tr('Двускатная с вальмой с одной стороны'), 'side_half-hipped': tr('Двускатная с полувальмой с одной стороны'),
  'hipped-and-gabled': tr('Голландская (вальмовая с фронтоном)'), bellcast_gable: tr('Двускатная с отгибом у карниза'),
  crosspitched: tr('Крестовая'), sawtooth: tr('Шедовая (пилообразная)'), butterfly: tr('Бабочка (обратная двускатная)'), cone: tr('Коническая'),
  gabled_row: tr('Ряд двускатных'), double_saltbox: tr('Двускатная с плоским верхом'), quadruple_saltbox: tr('Вальмовая с плоским верхом'),
  apse_gabled: tr('Апсида (полуконус)'),
};
export const ROOF_SHAPES = Object.keys(ROOF_SHAPE_LABELS);

/**
 * Иконки форм крыши (по рисункам Simple 3D Buildings в вики): грани 3D-моделей в ортопроекции, заливка
 * по освещению (fill-opacity), криволинейные поверхности — тонкой сеткой (класс c). Генерирует scripts/roof-icons.mjs.
 */
const roofIcon = (paths: string) => `<svg class="roof-icon" viewBox="0 0 22 19">${paths}</svg>`;
const ROOF_ICONS: Record<string, string> = {
  'flat': roofIcon('<path d="M1.0 7.2L6.6 11.4L21.0 7.2L15.4 3.0Z" fill-opacity="0.25"/><path d="M6.6 11.4L6.6 16.0L21.0 11.8L21.0 7.2Z" fill-opacity="0.33"/><path d="M6.6 11.4L1.0 7.2L1.0 11.8L6.6 16.0Z" fill-opacity="0.45"/>'),
  'gabled': roofIcon('<path d="M6.6 12.9L6.6 17.5L21.0 13.3L21.0 8.7Z" fill-opacity="0.33"/><path d="M3.8 5.7L6.6 12.9L21.0 8.7L18.2 1.5Z" fill-opacity="0.16"/><path d="M6.6 12.9L3.8 5.7L1.0 8.7L1.0 13.3L6.6 17.5Z" fill-opacity="0.45"/>'),
  'gambrel': roofIcon('<path d="M2.1 5.8L3.8 5.7L18.2 1.5L16.5 1.6Z" fill-opacity="0.41"/><path d="M6.6 12.9L6.6 17.5L21.0 13.3L21.0 8.7Z" fill-opacity="0.33"/><path d="M3.8 5.7L5.5 8.4L19.9 4.2L18.2 1.5Z" fill-opacity="0.16"/><path d="M5.5 8.4L6.6 12.9L21.0 8.7L19.9 4.2Z" fill-opacity="0.20"/><path d="M6.6 12.9L5.5 8.4L3.8 5.7L2.1 5.8L1.0 8.7L1.0 13.3L6.6 17.5Z" fill-opacity="0.45"/>'),
  'saltbox': roofIcon('<path d="M6.6 13.2L17.3 1.2L21.0 9.0Z" fill-opacity="0.15"/><path d="M6.6 13.2L21.0 9.0L21.0 13.6L6.6 17.8Z" fill-opacity="0.33"/><path d="M2.9 5.4L17.3 1.2L6.6 13.2Z" fill-opacity="0.15"/><path d="M1.0 6.5L2.9 5.4L6.6 13.2L6.6 17.8L1.0 13.6Z" fill-opacity="0.45"/>'),
  'skillion': roofIcon('<path d="M1.6 5.0L6.9 13.6L20.4 9.7L15.1 1.0Z" fill-opacity="0.15"/><path d="M6.9 13.6L6.9 18.0L20.4 14.0L20.4 9.7Z" fill-opacity="0.33"/><path d="M6.9 13.6L1.6 5.0L1.6 14.1L6.9 18.0Z" fill-opacity="0.45"/>'),
  'round': roofIcon('<path d="M2.2 5.6L2.9 5.5L17.3 1.3L16.6 1.4Z" fill-opacity="0.44" class="c"/><path d="M2.9 5.5L3.8 5.9L18.2 1.7L17.3 1.3Z" fill-opacity="0.30" class="c"/><path d="M6.6 13.1L6.6 17.7L21.0 13.5L21.0 8.9Z" fill-opacity="0.33"/><path d="M3.8 5.9L4.7 6.8L19.1 2.6L18.2 1.7Z" fill-opacity="0.20" class="c"/><path d="M4.7 6.8L5.4 8.1L19.8 3.9L19.1 2.6Z" fill-opacity="0.15" class="c"/><path d="M6.4 11.4L6.6 13.1L21.0 8.9L20.9 7.2Z" fill-opacity="0.28" class="c"/><path d="M5.4 8.1L6.1 9.7L20.5 5.5L19.8 3.9Z" fill-opacity="0.16" class="c"/><path d="M6.1 9.7L6.4 11.4L20.9 7.2L20.5 5.5Z" fill-opacity="0.20" class="c"/><path d="M6.6 13.1L6.4 11.4L6.1 9.7L5.4 8.1L4.7 6.8L3.8 5.9L2.9 5.5L2.2 5.6L1.5 6.3L1.1 7.4L1.0 8.9L1.0 13.5L6.6 17.7Z" fill-opacity="0.45"/>'),
  'hipped': roofIcon('<path d="M6.6 16.9L21.0 12.7L21.0 8.0L6.6 12.3Z" fill-opacity="0.33"/><path d="M1.0 12.7L6.6 16.9L6.6 12.3L1.0 8.1Z" fill-opacity="0.45"/><path d="M6.6 12.3L21.0 8.0L14.0 2.1L8.0 3.8Z" fill-opacity="0.16"/><path d="M1.0 8.1L6.6 12.3L8.0 3.8Z" fill-opacity="0.25"/>'),
  'pyramidal': roofIcon('<path d="M21.0 7.6L15.4 3.4L11.0 2.5Z" fill-opacity="0.41"/><path d="M6.6 16.5L21.0 12.3L21.0 7.6L6.6 11.8Z" fill-opacity="0.33"/><path d="M1.0 12.3L6.6 16.5L6.6 11.8L1.0 7.6Z" fill-opacity="0.45"/><path d="M6.6 11.8L21.0 7.6L11.0 2.5Z" fill-opacity="0.16"/><path d="M1.0 7.6L6.6 11.8L11.0 2.5Z" fill-opacity="0.22"/>'),
  'mansard': roofIcon('<path d="M18.7 4.6L14.9 1.7L14.2 2.4Z" fill-opacity="0.38"/><path d="M14.9 1.7L3.3 5.1L7.8 4.3L14.2 2.4Z" fill-opacity="0.41"/><path d="M6.6 17.3L21.0 13.0L21.0 8.4L6.6 12.6Z" fill-opacity="0.33"/><path d="M1.0 13.1L6.6 17.3L6.6 12.6L1.0 8.4Z" fill-opacity="0.45"/><path d="M7.1 8.0L18.7 4.6L14.2 2.4L7.8 4.3Z" fill-opacity="0.16"/><path d="M6.6 12.6L21.0 8.4L18.7 4.6L7.1 8.0Z" fill-opacity="0.21"/><path d="M1.0 8.4L6.6 12.6L7.1 8.0L3.3 5.1Z" fill-opacity="0.32"/><path d="M3.3 5.1L7.1 8.0L7.8 4.3Z" fill-opacity="0.21"/>'),
  'half-hipped': roofIcon('<path d="M6.6 17.2L21.0 13.0L21.0 8.4L6.6 12.6Z" fill-opacity="0.33"/><path d="M1.0 13.0L6.6 17.2L6.6 12.6L1.0 8.4Z" fill-opacity="0.45"/><path d="M6.6 12.6L21.0 8.4L19.5 4.4L16.2 1.8L5.8 4.8L5.0 8.6Z" fill-opacity="0.16"/><path d="M1.0 8.4L6.6 12.6L5.0 8.6L2.5 6.7Z" fill-opacity="0.45"/><path d="M2.5 6.7L5.0 8.6L5.8 4.8Z" fill-opacity="0.25"/>'),
  'dome': roofIcon('<path d="M6.6 11.8L21.0 7.6L15.4 3.4L1.0 7.6Z" fill-opacity="0.25"/><path d="M12.4 2.7L10.9 2.5L10.9 2.6L11.7 2.7Z" fill-opacity="0.44" class="c"/><path d="M6.7 5.1L6.2 6.3L6.9 5.0L7.4 4.0Z" fill-opacity="0.53" class="c"/><path d="M10.9 2.5L9.4 2.8L10.2 2.7L10.9 2.6Z" fill-opacity="0.44" class="c"/><path d="M13.5 3.2L12.4 2.7L11.7 2.7L12.3 2.9Z" fill-opacity="0.40" class="c"/><path d="M9.4 2.8L8.4 3.3L9.6 3.0L10.2 2.7Z" fill-opacity="0.40" class="c"/><path d="M15.1 4.9L14.5 3.9L13.5 3.2L14.0 3.9Z" fill-opacity="0.42" class="c"/><path d="M7.4 4.0L6.9 5.0L8.0 4.0L8.4 3.3Z" fill-opacity="0.42" class="c"/><path d="M15.5 8.7L16.1 7.5L15.8 6.1L15.3 7.3Z" fill-opacity="0.48" class="c"/><path d="M11.7 2.7L10.9 2.6L11.0 3.1Z" fill-opacity="0.30" class="c"/><path d="M10.9 2.6L10.2 2.7L11.0 3.1Z" fill-opacity="0.30" class="c"/><path d="M14.0 3.9L13.5 3.2L12.3 2.9L12.6 3.3Z" fill-opacity="0.33" class="c"/><path d="M5.9 7.7L6.7 8.9L6.9 7.4L6.2 6.3Z" fill-opacity="0.48" class="c"/><path d="M12.3 2.9L11.7 2.7L11.0 3.1Z" fill-opacity="0.29" class="c"/><path d="M8.4 3.3L8.0 4.0L9.4 3.3L9.6 3.0Z" fill-opacity="0.33" class="c"/><path d="M10.2 2.7L9.6 3.0L11.0 3.1Z" fill-opacity="0.29" class="c"/><path d="M15.3 7.3L15.8 6.1L15.1 4.9L14.6 5.9Z" fill-opacity="0.38" class="c"/><path d="M12.6 3.3L12.3 2.9L11.0 3.1Z" fill-opacity="0.27" class="c"/><path d="M9.6 3.0L9.4 3.3L11.0 3.1Z" fill-opacity="0.27" class="c"/><path d="M6.2 6.3L6.9 7.4L7.5 6.0L6.9 5.0Z" fill-opacity="0.38" class="c"/><path d="M14.6 5.9L15.1 4.9L14.0 3.9L13.6 4.6Z" fill-opacity="0.30" class="c"/><path d="M12.4 3.7L12.6 3.3L11.0 3.1Z" fill-opacity="0.24" class="c"/><path d="M13.6 4.6L14.0 3.9L12.6 3.3L12.4 3.7Z" fill-opacity="0.25" class="c"/><path d="M6.9 5.0L7.5 6.0L8.5 4.7L8.0 4.0Z" fill-opacity="0.30" class="c"/><path d="M9.4 3.3L9.7 3.7L11.0 3.1Z" fill-opacity="0.24" class="c"/><path d="M8.0 4.0L8.5 4.7L9.7 3.7L9.4 3.3Z" fill-opacity="0.25" class="c"/><path d="M6.6 16.5L21.0 12.2L21.0 7.6L6.6 11.8Z" fill-opacity="0.33"/><path d="M1.0 12.3L6.6 16.5L6.6 11.8L1.0 7.6Z" fill-opacity="0.45"/><path d="M11.8 3.9L12.4 3.7L11.0 3.1Z" fill-opacity="0.21" class="c"/><path d="M9.7 3.7L10.3 4.0L11.0 3.1Z" fill-opacity="0.21" class="c"/><path d="M11.1 4.0L11.8 3.9L11.0 3.1Z" fill-opacity="0.20" class="c"/><path d="M10.3 4.0L11.1 4.0L11.0 3.1Z" fill-opacity="0.20" class="c"/><path d="M13.7 9.6L15.5 8.7L15.3 7.3L13.6 8.1Z" fill-opacity="0.33" class="c"/><path d="M12.6 5.1L13.6 4.6L12.4 3.7L11.8 3.9Z" fill-opacity="0.18" class="c"/><path d="M6.7 8.9L8.6 9.7L8.7 8.2L6.9 7.4Z" fill-opacity="0.33" class="c"/><path d="M8.5 4.7L9.6 5.2L10.3 4.0L9.7 3.7Z" fill-opacity="0.18" class="c"/><path d="M13.6 8.1L15.3 7.3L14.6 5.9L13.2 6.6Z" fill-opacity="0.24" class="c"/><path d="M13.2 6.6L14.6 5.9L13.6 4.6L12.6 5.1Z" fill-opacity="0.19" class="c"/><path d="M6.9 7.4L8.7 8.2L9.1 6.7L7.5 6.0Z" fill-opacity="0.24" class="c"/><path d="M7.5 6.0L9.1 6.7L9.6 5.2L8.5 4.7Z" fill-opacity="0.19" class="c"/><path d="M11.1 5.4L12.6 5.1L11.8 3.9L11.1 4.0Z" fill-opacity="0.14" class="c"/><path d="M9.6 5.2L11.1 5.4L11.1 4.0L10.3 4.0Z" fill-opacity="0.14" class="c"/><path d="M11.2 10.0L13.7 9.6L13.6 8.1L11.2 8.5Z" fill-opacity="0.24" class="c"/><path d="M8.6 9.7L11.2 10.0L11.2 8.5L8.7 8.2Z" fill-opacity="0.25" class="c"/><path d="M11.1 6.9L13.2 6.6L12.6 5.1L11.1 5.4Z" fill-opacity="0.13" class="c"/><path d="M9.1 6.7L11.1 6.9L11.1 5.4L9.6 5.2Z" fill-opacity="0.13" class="c"/><path d="M11.2 8.5L13.6 8.1L13.2 6.6L11.1 6.9Z" fill-opacity="0.17" class="c"/><path d="M8.7 8.2L11.2 8.5L11.1 6.9L9.1 6.7Z" fill-opacity="0.17" class="c"/>'),
  'onion': roofIcon('<path d="M6.6 13.2L21.0 9.0L15.4 4.8L1.0 9.0Z" fill-opacity="0.25"/><path d="M15.8 6.1L15.0 5.0L13.9 3.8L14.4 4.6Z" fill-opacity="0.46" class="c"/><path d="M6.8 5.1L6.2 6.2L7.6 4.7L8.0 3.9Z" fill-opacity="0.46" class="c"/><path d="M15.2 8.6L15.8 7.4L15.8 6.1L15.2 7.2Z" fill-opacity="0.53" class="c"/><path d="M14.4 4.6L13.9 3.8L12.2 2.7L12.4 3.0Z" fill-opacity="0.41" class="c"/><path d="M8.0 3.9L7.6 4.7L9.6 3.0L9.8 2.7Z" fill-opacity="0.41" class="c"/><path d="M6.2 7.6L7.0 8.7L7.0 7.3L6.2 6.2Z" fill-opacity="0.54" class="c"/><path d="M12.6 10.2L13.7 9.7L15.2 8.6L13.5 9.4Z" fill-opacity="0.62" class="c"/><path d="M15.2 7.2L15.8 6.1L14.4 4.6L14.0 5.4Z" fill-opacity="0.32" class="c"/><path d="M6.6 17.9L21.0 13.6L21.0 9.0L6.6 13.2Z" fill-opacity="0.33"/><path d="M1.0 13.7L6.6 17.9L6.6 13.2L1.0 9.0Z" fill-opacity="0.45"/><path d="M8.4 9.8L9.6 10.3L8.8 9.5L7.0 8.7Z" fill-opacity="0.62" class="c"/><path d="M6.2 6.2L7.0 7.3L8.1 5.5L7.6 4.7Z" fill-opacity="0.33" class="c"/><path d="M14.0 5.4L14.4 4.6L12.4 3.0L12.2 3.3Z" fill-opacity="0.29" class="c"/><path d="M12.4 3.0L12.2 2.7L11.0 1.1Z" fill-opacity="0.50" class="c"/><path d="M7.6 4.7L8.1 5.5L9.8 3.3L9.6 3.0Z" fill-opacity="0.29" class="c"/><path d="M9.8 2.7L9.6 3.0L11.0 1.1Z" fill-opacity="0.50" class="c"/><path d="M11.1 10.4L12.6 10.2L13.5 9.4L11.2 9.7Z" fill-opacity="0.62" class="c"/><path d="M9.6 10.3L11.1 10.4L11.2 9.7L8.8 9.5Z" fill-opacity="0.62" class="c"/><path d="M12.2 3.3L12.4 3.0L11.0 1.1Z" fill-opacity="0.35" class="c"/><path d="M9.6 3.0L9.8 3.3L11.0 1.1Z" fill-opacity="0.35" class="c"/><path d="M13.5 9.4L15.2 8.6L15.2 7.2L13.5 8.1Z" fill-opacity="0.38" class="c"/><path d="M11.7 3.5L12.2 3.3L11.0 1.1Z" fill-opacity="0.22" class="c"/><path d="M9.8 3.3L10.4 3.6L11.0 1.1Z" fill-opacity="0.22" class="c"/><path d="M7.0 8.7L8.8 9.5L8.8 8.1L7.0 7.3Z" fill-opacity="0.39" class="c"/><path d="M12.8 6.0L14.0 5.4L12.2 3.3L11.7 3.5Z" fill-opacity="0.19" class="c"/><path d="M8.1 5.5L9.4 6.1L10.4 3.6L9.8 3.3Z" fill-opacity="0.19" class="c"/><path d="M11.0 3.6L11.7 3.5L11.0 1.1Z" fill-opacity="0.15" class="c"/><path d="M10.4 3.6L11.0 3.6L11.0 1.1Z" fill-opacity="0.15" class="c"/><path d="M13.5 8.1L15.2 7.2L14.0 5.4L12.8 6.0Z" fill-opacity="0.20" class="c"/><path d="M7.0 7.3L8.8 8.1L9.4 6.1L8.1 5.5Z" fill-opacity="0.21" class="c"/><path d="M11.1 6.2L12.8 6.0L11.7 3.5L11.0 3.6Z" fill-opacity="0.13" class="c"/><path d="M9.4 6.1L11.1 6.2L11.0 3.6L10.4 3.6Z" fill-opacity="0.13" class="c"/><path d="M11.2 9.7L13.5 9.4L13.5 8.1L11.2 8.4Z" fill-opacity="0.30" class="c"/><path d="M8.8 9.5L11.2 9.7L11.2 8.4L8.8 8.1Z" fill-opacity="0.30" class="c"/><path d="M11.2 8.4L13.5 8.1L12.8 6.0L11.1 6.2Z" fill-opacity="0.14" class="c"/><path d="M8.8 8.1L11.2 8.4L11.1 6.2L9.4 6.1Z" fill-opacity="0.14" class="c"/>'),
  // Новые формы — тем же способом: модель из building-geometry, ортопроекция, заливка по освещению
  'side_hipped': roofIcon('<path d="M6.6 12.9L21.0 8.7L21.0 13.3L6.6 17.5Z" fill-opacity="0.33"/><path d="M6.6 12.9L7.4 4.7L18.2 1.5L21.0 8.7Z" fill-opacity="0.16"/><path d="M1.0 8.7L6.6 12.9L6.6 17.5L1.0 13.3Z" fill-opacity="0.45"/><path d="M1.0 8.7L7.4 4.7L6.6 12.9Z" fill-opacity="0.25"/>'),
  'side_half-hipped': roofIcon('<path d="M6.6 12.9L21.0 8.7L21.0 13.3L6.6 17.5Z" fill-opacity="0.33"/><path d="M5.2 5.3L18.2 1.5L21.0 8.7L6.6 12.9Z" fill-opacity="0.16"/><path d="M1.0 8.7L2.7 6.9L3.8 7.7L4.9 8.6L6.6 12.9L6.6 17.5L1.0 13.3Z" fill-opacity="0.45"/><path d="M2.7 6.9L5.2 5.3L4.9 8.6Z" fill-opacity="0.25"/><path d="M4.9 8.6L5.2 5.3L6.6 12.9Z" fill-opacity="0.16"/>'),
  'hipped-and-gabled': roofIcon('<path d="M6.6 12.6L21.0 8.4L21.0 13.0L6.6 17.2Z" fill-opacity="0.33"/><path d="M5.6 4.9L16.4 1.8L17.8 5.4L21.0 8.4L19.2 8.9L8.4 12.1L6.6 12.6L7.0 8.5Z" fill-opacity="0.16"/><path d="M1.0 8.4L6.6 12.6L6.6 17.2L1.0 13.0Z" fill-opacity="0.45"/><path d="M1.0 8.4L4.2 6.4L7.0 8.5L6.6 12.6Z" fill-opacity="0.25"/><path d="M4.2 6.4L5.6 4.9L7.0 8.5L5.6 7.5Z" fill-opacity="0.45"/>'),
  'bellcast_gable': roofIcon('<path d="M1.0 8.7L15.4 4.5L16.1 4.5L1.7 8.7Z" fill-opacity="0.39"/><path d="M6.6 12.9L21.0 8.7L21.0 13.3L6.6 17.5Z" fill-opacity="0.33"/><path d="M3.8 5.7L18.2 1.5L20.3 7.6L5.9 11.8Z" fill-opacity="0.17"/><path d="M5.9 11.8L20.3 7.6L21.0 8.7L6.6 12.9Z" fill-opacity="0.17"/><path d="M1.0 8.7L1.7 8.7L3.8 5.7L5.9 11.8L6.6 12.9L6.6 17.5L1.0 13.3Z" fill-opacity="0.45"/>'),
  'crosspitched': roofIcon('<path d="M7.9 1.0L13.5 5.0L11.0 3.3ZM11.0 3.3L19.7 9.6L14.1 5.7Z" fill-opacity="0.43"/><path d="M5.4 5.0L11.0 3.3L8.5 12.9ZM11.0 3.3L16.6 1.7L19.7 9.6Z" fill-opacity="0.16"/><path d="M2.3 8.2L7.9 1.0L11.0 3.3ZM8.5 12.9L11.0 3.3L14.1 5.7Z" fill-opacity="0.23"/><path d="M8.5 12.9L14.1 5.7L19.7 9.6L19.7 14.7L8.5 18.0Z" fill-opacity="0.33"/><path d="M2.3 8.2L5.4 5.0L8.5 12.9L8.5 18.0L2.3 13.3Z" fill-opacity="0.45"/>'),
  'sawtooth': roofIcon('<path d="M1.0 6.2L15.4 2.0L18.2 6.1L3.8 10.3Z" fill-opacity="0.17"/><path d="M3.8 8.3L18.2 4.1L21.0 8.2L6.6 12.4Z" fill-opacity="0.17"/><path d="M6.6 12.4L21.0 8.2L21.0 12.8L6.6 17.0Z" fill-opacity="0.33"/><path d="M1.0 6.2L3.8 10.3L3.8 8.3L6.6 12.4L6.6 17.0L1.0 12.8Z" fill-opacity="0.45"/>'),
  'butterfly': roofIcon('<path d="M1.0 6.5L15.4 2.3L18.2 5.8Z" fill-opacity="0.18"/><path d="M1.0 6.5L18.2 5.8L3.8 10.0Z" fill-opacity="0.18"/><path d="M3.8 10.0L18.2 5.8L21.0 6.5L6.6 10.7Z" fill-opacity="0.35"/><path d="M6.6 10.7L21.0 6.5L21.0 12.5L6.6 16.7Z" fill-opacity="0.33"/><path d="M1.0 6.5L3.8 10.0L6.6 10.7L6.6 16.7L1.0 12.5Z" fill-opacity="0.45"/>'),
  'cone': roofIcon('<path d="M5.1 14.0L5.1 9.8L5.1 14.8Z" fill-opacity="0.60" class="c"/><path d="M5.1 9.0L5.1 9.8L5.1 14.0Z" fill-opacity="0.60" class="c"/><path d="M16.5 16.6L16.9 10.9L16.9 15.9Z" fill-opacity="0.49" class="c"/><path d="M5.1 14.8L5.5 10.6L5.5 15.6Z" fill-opacity="0.57" class="c"/><path d="M11.0 1.0L16.5 9.4L16.9 10.2Z" fill-opacity="0.45" class="c"/><path d="M5.1 9.8L5.5 10.6L5.1 14.8Z" fill-opacity="0.57" class="c"/><path d="M5.1 9.0L5.5 8.3L11.0 1.0Z" fill-opacity="0.52" class="c"/><path d="M16.5 11.7L16.9 10.9L16.5 16.6Z" fill-opacity="0.49" class="c"/><path d="M15.7 17.2L16.5 11.7L16.5 16.6Z" fill-opacity="0.41" class="c"/><path d="M11.0 1.0L16.9 10.2L16.9 10.9Z" fill-opacity="0.38" class="c"/><path d="M5.1 9.0L11.0 1.0L5.1 9.8Z" fill-opacity="0.45" class="c"/><path d="M5.5 15.6L6.3 11.3L6.3 16.3Z" fill-opacity="0.49" class="c"/><path d="M5.5 10.6L6.3 11.3L5.5 15.6Z" fill-opacity="0.49" class="c"/><path d="M14.6 17.7L15.7 12.3L15.7 17.2Z" fill-opacity="0.35" class="c"/><path d="M15.7 12.3L16.5 11.7L15.7 17.2Z" fill-opacity="0.41" class="c"/><path d="M11.0 1.0L16.9 10.9L16.5 11.7Z" fill-opacity="0.31" class="c"/><path d="M5.1 9.8L11.0 1.0L5.5 10.6Z" fill-opacity="0.38" class="c"/><path d="M6.3 16.3L7.4 12.0L7.4 17.0Z" fill-opacity="0.41" class="c"/><path d="M6.3 11.3L7.4 12.0L6.3 16.3Z" fill-opacity="0.41" class="c"/><path d="M13.3 17.9L14.6 12.7L14.6 17.7Z" fill-opacity="0.31" class="c"/><path d="M11.0 1.0L16.5 11.7L15.7 12.3Z" fill-opacity="0.25" class="c"/><path d="M5.5 10.6L11.0 1.0L6.3 11.3Z" fill-opacity="0.31" class="c"/><path d="M14.6 12.7L15.7 12.3L14.6 17.7Z" fill-opacity="0.35" class="c"/><path d="M7.4 17.0L8.8 12.5L8.8 17.5Z" fill-opacity="0.35" class="c"/><path d="M11.8 18.0L13.3 13.0L13.3 17.9Z" fill-opacity="0.29" class="c"/><path d="M8.8 17.5L10.3 12.9L10.3 17.8Z" fill-opacity="0.31" class="c"/><path d="M7.4 12.0L8.8 12.5L7.4 17.0Z" fill-opacity="0.35" class="c"/><path d="M10.3 17.8L11.8 13.0L11.8 18.0Z" fill-opacity="0.29" class="c"/><path d="M11.0 1.0L15.7 12.3L14.6 12.7Z" fill-opacity="0.20" class="c"/><path d="M6.3 11.3L11.0 1.0L7.4 12.0Z" fill-opacity="0.25" class="c"/><path d="M13.3 13.0L14.6 12.7L13.3 17.9Z" fill-opacity="0.31" class="c"/><path d="M8.8 12.5L10.3 12.9L8.8 17.5Z" fill-opacity="0.31" class="c"/><path d="M11.0 1.0L14.6 12.7L13.3 13.0Z" fill-opacity="0.16" class="c"/><path d="M7.4 12.0L11.0 1.0L8.8 12.5Z" fill-opacity="0.20" class="c"/><path d="M11.8 13.0L13.3 13.0L11.8 18.0Z" fill-opacity="0.29" class="c"/><path d="M10.3 12.9L11.8 13.0L10.3 17.8Z" fill-opacity="0.29" class="c"/><path d="M11.0 1.0L13.3 13.0L11.8 13.0Z" fill-opacity="0.14" class="c"/><path d="M8.8 12.5L11.0 1.0L10.3 12.9Z" fill-opacity="0.16" class="c"/><path d="M10.3 12.9L11.0 1.0L11.8 13.0Z" fill-opacity="0.14" class="c"/>'),
  'gabled_row': roofIcon('<path d="M10.6 5.4L13.0 2.0L18.6 6.2L16.2 9.6Z" fill-opacity="0.23"/><path d="M5.8 6.8L8.2 3.4L13.8 7.6L11.4 11.0Z" fill-opacity="0.23"/><path d="M6.6 12.4L9.0 9.0L11.4 11.0L16.2 9.6L18.6 6.2L21.0 8.2L21.0 12.8L6.6 17.0ZM11.4 11.0L13.8 7.6L16.2 9.6L13.8 10.3Z" fill-opacity="0.33"/><path d="M1.0 8.2L3.4 4.8L6.6 12.4Z" fill-opacity="0.23"/><path d="M1.0 8.2L6.6 12.4L6.6 17.0L1.0 12.8Z" fill-opacity="0.45"/><path d="M3.4 4.8L9.0 9.0L6.6 12.4Z" fill-opacity="0.23"/>'),
  'double_saltbox': roofIcon('<path d="M6.6 13.4L21.0 9.2L21.0 13.8L6.6 18.0Z" fill-opacity="0.33"/><path d="M2.4 5.2L16.8 1.0L18.2 2.0L19.6 3.1L5.2 7.3L3.8 6.2Z" fill-opacity="0.25"/><path d="M5.2 7.3L19.6 3.1L21.0 9.2L6.6 13.4Z" fill-opacity="0.21"/><path d="M1.0 9.2L2.4 5.2L3.8 6.2L5.2 7.3L6.6 13.4L6.6 18.0L1.0 13.8Z" fill-opacity="0.45"/>'),
  'quadruple_saltbox': roofIcon('<path d="M4.2 4.4L15.0 1.3L17.8 3.4L7.0 6.5Z" fill-opacity="0.25"/><path d="M6.6 13.1L21.0 8.9L21.0 13.5L6.6 17.7Z" fill-opacity="0.33"/><path d="M6.6 13.1L7.0 6.5L17.8 3.4L21.0 8.9Z" fill-opacity="0.21"/><path d="M1.0 8.9L6.6 13.1L6.6 17.7L1.0 13.5Z" fill-opacity="0.45"/><path d="M1.0 8.9L4.2 4.4L7.0 6.5L6.6 13.1Z" fill-opacity="0.31"/>'),
  'apse_gabled': roofIcon('<path d="M5.2 13.1L5.2 8.0L5.2 14.1Z" fill-opacity="0.60" class="c"/><path d="M5.2 7.1L5.2 8.0L5.2 13.1Z" fill-opacity="0.60" class="c"/><path d="M5.7 6.2L6.6 5.5L12.4 1.0Z" fill-opacity="0.50" class="c"/><path d="M5.2 7.1L5.7 6.2L12.4 1.0Z" fill-opacity="0.45" class="c"/><path d="M5.2 14.1L5.7 9.0L5.7 15.0Z" fill-opacity="0.57" class="c"/><path d="M5.2 8.0L5.7 9.0L5.2 14.1Z" fill-opacity="0.57" class="c"/><path d="M5.2 7.1L12.4 1.0L5.2 8.0Z" fill-opacity="0.39" class="c"/><path d="M5.7 15.0L6.7 9.9L6.7 16.0Z" fill-opacity="0.49" class="c"/><path d="M5.7 9.0L6.7 9.9L5.7 15.0Z" fill-opacity="0.49" class="c"/><path d="M5.2 8.0L12.4 1.0L5.7 9.0Z" fill-opacity="0.33" class="c"/><path d="M6.7 16.0L8.0 10.7L8.0 16.8Z" fill-opacity="0.41" class="c"/><path d="M5.7 9.0L12.4 1.0L6.7 9.9Z" fill-opacity="0.27" class="c"/><path d="M6.7 9.9L8.0 10.7L6.7 16.0Z" fill-opacity="0.41" class="c"/><path d="M15.2 17.9L16.8 11.6L16.8 17.6Z" fill-opacity="0.31" class="c"/><path d="M8.0 16.8L9.7 11.3L9.7 17.4Z" fill-opacity="0.35" class="c"/><path d="M6.7 9.9L12.4 1.0L8.0 10.7Z" fill-opacity="0.22" class="c"/><path d="M13.3 18.0L15.2 11.9L15.2 17.9Z" fill-opacity="0.29" class="c"/><path d="M9.7 17.4L11.5 11.8L11.5 17.8Z" fill-opacity="0.31" class="c"/><path d="M8.0 10.7L9.7 11.3L8.0 16.8Z" fill-opacity="0.35" class="c"/><path d="M11.5 17.8L13.3 12.0L13.3 18.0Z" fill-opacity="0.29" class="c"/><path d="M12.4 1.0L16.8 11.6L15.2 11.9Z" fill-opacity="0.14" class="c"/><path d="M15.2 11.9L16.8 11.6L15.2 17.9Z" fill-opacity="0.31" class="c"/><path d="M8.0 10.7L12.4 1.0L9.7 11.3Z" fill-opacity="0.17" class="c"/><path d="M12.4 1.0L15.2 11.9L13.3 12.0Z" fill-opacity="0.13" class="c"/><path d="M9.7 11.3L12.4 1.0L11.5 11.8Z" fill-opacity="0.14" class="c"/><path d="M9.7 11.3L11.5 11.8L9.7 17.4Z" fill-opacity="0.31" class="c"/><path d="M11.5 11.8L12.4 1.0L13.3 12.0Z" fill-opacity="0.13" class="c"/><path d="M13.3 12.0L15.2 11.9L13.3 18.0Z" fill-opacity="0.29" class="c"/><path d="M11.5 11.8L13.3 12.0L11.5 17.8Z" fill-opacity="0.29" class="c"/>'),
};

/** Поля формы; чего не задано — из схемы iD: название, варианты, подписи вариантов. */
const FIELDS = ([
  // «-» — удалить ключ (объект перестаёт быть частью), no — явно не часть
  { tag: 'building:part', type: 'combo', options: [...Object.keys(PART_VALUES), 'no', REMOVE_VALUE],
    labels: { ...PART_VALUES, no: tr('Не часть'), [REMOVE_VALUE]: tr('Без ключа — удалить тег') }, placeholder: 'yes', empty: 'yes' },
  { tag: 'height', label: tr('Высота, м'), type: 'length', placeholder: tr('до верха крыши') },
  { tag: 'min_height', label: tr('Низ, м'), type: 'length' },
  { tag: 'building:levels', label: tr('Этажей'), type: 'int' },
  { tag: 'building:min_level', label: tr('Нижний этаж'), type: 'int' },
  { tag: 'roof:shape', label: tr('Форма крыши'), type: 'combo', options: ROOF_SHAPES, labels: ROOF_SHAPE_LABELS, icons: ROOF_ICONS },
  { tag: 'roof:height', label: tr('Высота крыши, м'), type: 'length' },
  { tag: 'roof:levels', label: tr('Этажей в крыше'), type: 'int' },
  { tag: 'roof:direction', label: tr('Направление ската'), type: 'direction', placeholder: tr('0–360 или N, SE…') },
  { tag: 'roof:orientation', label: tr('Конёк'), type: 'select', options: ['along', 'across'] },
  { tag: 'building:colour', label: tr('Цвет стен'), type: 'colour' },
  { tag: 'roof:colour', type: 'colour' },
  { tag: 'start_date', label: tr('Существует с'), type: 'date', placeholder: tr('ГГГГ-ММ-ДД'), dated: true, suggest: true },
  { tag: 'start_date:edtf', label: tr('Существует с (EDTF)'), type: 'edtf', placeholder: tr('1850~, 1850/1855, 185X'), dated: true, suggest: true },
  { tag: 'end_date', label: tr('Существует до'), type: 'date', placeholder: tr('ГГГГ-ММ-ДД'), dated: true, suggest: true },
  { tag: 'end_date:edtf', label: tr('Существует до (EDTF)'), type: 'edtf', placeholder: tr('1850~, 1850/1855, 185X'), dated: true, suggest: true },
] as Field[]).map((f) => ({
  ...f,
  label: f.label ?? idFieldLabel(f.tag) ?? f.tag,
  options: f.options ?? idOptions(f.tag),
  labels: f.type === 'combo' ? valueLabels(f.tag, f.labels) : f.labels,
}));

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
/** Поля дат (start_date / end_date) — для серверов с историей (OpenHistoricalMap). */
let dateFields = false;
export function setDateFields(on: boolean) { dateFields = on; }

function isValid(type: FieldType, v: string): boolean {
  v = v.trim();
  if (!v) return true;
  if (NUMERIC.has(type) && FORMULA.test(v)) return true;
  switch (type) {
    case 'length': return /^-?\d+(\.\d+)?( ?m)?$/.test(v);
    case 'int': return /^-?\d+$/.test(v);
    case 'direction': return CARDINALS.has(v.toUpperCase()) || (/^\d+(\.\d+)?$/.test(v) && Number(v) <= 360);
    case 'colour': return CSS.supports('color', v.split(';')[0].trim());
    // Даты OSM: год (до н. э. — с минусом), ГГГГ-ММ, ГГГГ-ММ-ДД, ~1850 (примерно), 1850s (десятилетие)
    case 'date': return /^(~?-?\d{1,4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?)?|\d{3}0s)$/.test(v) && !!parseDate(v);
    // EDTF (ISO 8601-2): 1850~, 1850?, 1850%, 185X, 1850/1855, ../1900, [1850,1860], 1850-21 (весна) — проверяем только алфавит
    case 'edtf': return /^[-+0-9XYSEu~?%/.,\[\]{}:T ]+$/.test(v) && /\d/.test(v);
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
  'roof:direction': ['skillion', 'saltbox', 'side_hipped', 'side_half-hipped', 'apse_gabled'],
  'roof:orientation': ['gabled', 'hipped', 'half-hipped', 'gambrel', 'round', 'saltbox', 'bellcast_gable', 'side_hipped',
    'side_half-hipped', 'hipped-and-gabled', 'crosspitched', 'sawtooth', 'butterfly', 'gabled_row', 'double_saltbox'],
};

/** Откуда наследуются значения: контур (outline) и/или само отношение здания. */
export interface InheritSource { label: string; tags: Record<string, string> }

/** Значок «унаследовано» — стрелка вниз из рамки. */
const ICON_INHERIT = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2.5h10"/><path d="M8 5v8.5M5 10.5l3 3 3-3"/></svg>';

/** Значок «по умолчанию» — пунктирный круг. */
const ICON_DEFAULT = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-dasharray="2 2.2"><circle cx="8" cy="8" r="5.5"/></svg>';

/** Значок «подсказка: Tab — подставить» — стрелка к упору. */
const ICON_SUGGEST = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2 8h9M8 5l3 3-3 3"/><path d="M13.5 4v8"/></svg>';

/** Подсказка значения тега из источников (дата здания у части): первое заданное. */
function suggestion(tag: string, sources: InheritSource[]): { value: string; from: InheritSource } | undefined {
  const from = sources.find((s) => s.tags[tag]?.trim());
  return from && { value: from.tags[tag].trim(), from };
}

const num = (v: number) => String(Math.round(v * 100) / 100);

/**
 * Значения, которые редактор подставляет при рисовании, когда тега нет (ни своего, ни унаследованного):
 * тег → значение и откуда оно. Повторяет умолчания computeHeights и раскраски.
 */
function defaultValues(effective: Record<string, string>): Record<string, { value: string; why: string }> {
  const out: Record<string, { value: string; why: string }> = {};
  const h = computeHeights(effective);
  const roofLevels = Number(effective['roof:levels']);
  const nominal = roofLevels > 0 ? roofLevels * LEVEL_HEIGHT : 3;
  const roofWhy = h.roofHeight < nominal - 1e-6 ? tr('не выше высоты части')
    : roofLevels > 0 ? tr('roof:levels × {m} м', { m: LEVEL_HEIGHT }) : tr('по умолчанию {m} м', { m: 3 });
  if (effective.height === undefined) {
    const roof = h.roofHeight ? tr(' + крыша {m} м', { m: num(h.roofHeight) }) : '';
    out.height = { value: num(h.top), why: h.source === 'levels'
      ? tr('building:levels × {m} м', { m: LEVEL_HEIGHT }) + roof
      : tr('стены по умолчанию {m} м', { m: num(h.wallTop - h.min) }) + roof };
  }
  if (effective.min_height === undefined && h.min > 0) {
    out.min_height = { value: num(h.min), why: effective['building:min_level'] !== undefined
      ? tr('building:min_level × {m} м', { m: LEVEL_HEIGHT }) : tr('у части-кровли — чуть ниже крыши') };
  }
  if (effective['roof:height'] === undefined && h.roofShape !== 'flat') {
    out['roof:height'] = { value: num(h.roofHeight), why: roofWhy };
  }
  if (effective['roof:shape'] === undefined) out['roof:shape'] = { value: 'flat', why: tr('без формы крыша плоская') };
  if (effective['roof:orientation'] === undefined && effective['roof:direction'] === undefined) out['roof:orientation'] = { value: 'along', why: tr('конёк вдоль длинной стороны') };
  if (effective['building:colour'] === undefined && effective.colour === undefined) out['building:colour'] = { value: '#ffffff', why: tr('белый по умолчанию') };
  if (effective['roof:colour'] === undefined) {
    const pitched = h.roofShape !== 'flat';
    out['roof:colour'] = pitched
      ? { value: '#ffffff', why: tr('белый по умолчанию') }
      : { value: effective['building:colour'] ?? effective.colour ?? '#ffffff', why: tr('у плоской крыши — цвет стен') };
  }
  return out;
}

/**
 * HTML формы тегов для объекта. sources — откуда показывать унаследованные значения (по порядку);
 * suggest — откуда подсказывать значения полей с suggest (даты здания); only — показать только эти поля.
 */
export function renderTagForm(key: string, session: EditSession, sources: InheritSource[] = [],
  opts: { suggest?: InheritSource[]; only?: (tag: string) => boolean; outline?: boolean } = {}): string {
  const f = session.get(key);
  if (!f) return '';
  const orig = session.originalTags(key) ?? {};
  const inheritedAny: string[] = [];
  // Форма крыши (не наследуется): от неё зависит, нужны ли направление ската и конёк
  const shape = f.tags['roof:shape'];
  const defaults = defaultValues({ ...f.tags, ...inheritedTags(f.tags, sources.map((s) => s.tags)) });
  const rows = FIELDS.filter((field) => {
    if (opts.only && !opts.only(field.tag)) return false;
    // Только у частей; у контура здания (outline) — всегда: building:part делает его и частью (рисуется объёмом)
    if (field.tag === 'building:part' && f.tags['building:part'] === undefined && !opts.outline) return false;
    if (field.dated && !dateFields && f.tags[field.tag] === undefined) return false;
    const only = SHAPE_ONLY[field.tag];
    // Уже заданное значение показываем всегда — чтобы его было видно и можно было удалить
    return !only || f.tags[field.tag] !== undefined || (!!shape && only.includes(shape));
  }).map((field) => {
    const value = f.tags[field.tag] ?? '';
    const changed = session.isChanged(key, field.tag);
    const was = changed ? tr('было: {value}', { value: orig[field.tag] ?? '—' }) : '';
    // Своего значения нет — показываем унаследованное серым (placeholder) со значком и пояснением
    const from = !value && INHERITABLE_SET.has(field.tag) ? sources.find((src) => inheritedValue(src.tags, field.tag)) : undefined;
    const inherited = from ? inheritedValue(from.tags, field.tag) : undefined;
    const hint = from ? tr('Не задано у объекта — унаследовано из {source}: {tag}. Модель рисуется с ним, но в OSM лучше задать значение на самой части.',
      { source: from.label, tag: `${field.tag}=${inherited}` }) : '';
    // Нет ни своего, ни унаследованного — значение, с которым редактор рисует по умолчанию (серым, с пояснением)
    const def = !value && !from ? defaults[field.tag] : undefined;
    const outlinePart = opts.outline && field.tag === 'building:part';
    const defHint = def ? tr('Не задано — редактор рисует со значением по умолчанию {value} ({why}). В OSM ничего не записывается: чтобы закрепить, введите значение.',
      { value: def.value, why: def.why }) : '';
    if (from) inheritedAny.push(field.label!.replace(/,.*$/, '').toLowerCase());
    // Подсказка (дата здания): не наследуется, а предлагается — Tab подставляет
    const sug = !value && field.suggest ? suggestion(field.tag, opts.suggest ?? []) : undefined;
    const sugHint = sug ? tr('Не задано — у {source}: {value}. Tab — подставить.', { source: sug.from.label, value: sug.value }) : '';
    const common = `data-tag="${esc(field.tag)}" data-type="${field.type}" title="${esc(hint || defHint || sugHint || was || field.tag)}"${
      sug ? ` data-suggest="${esc(sug.value)}"` : ''}`;
    const shown = inherited ?? def?.value ?? sug?.value;
    const grey = inherited ? ' class="inherited"' : def ? ' class="inherited defaulted"' : sug ? ' class="suggested"' : '';
    const badge = (input: string) => withBadge(input, hint || defHint || sugHint, def ? ICON_DEFAULT : sug ? ICON_SUGGEST : ICON_INHERIT);
    let control: string;
    if (field.type === 'select') {
      // Нестандартное значение из данных тоже показываем, чтобы не потерять его
      const options = [...new Set([...(value && !field.options!.includes(value) ? [value] : []), ...field.options!])];
      // Унаследованное или умолчание — серым в пустом варианте
      control = badge(`<select ${common}${grey}><option value="">${esc(shown ?? '—')}</option>${options
        .map((o) => `<option value="${esc(o)}"${o === value ? ' selected' : ''}>${esc(o)}</option>`)
        .join('')}</select>`);
    } else if (outlinePart) {
      // Пусто у контура — тег удаляется (контур без объёма), а не building:part=yes, как у части
      const tip = tr('Контур здания с building:part — ещё и часть: рисуется объёмом. Пусто — только контур, без объёма.');
      control = combo(field, `${common.replace(/title="[^"]*"/, `title="${esc(tip)}"`)} data-empty-removes`, value, tr('нет — только контур'), '', undefined);
    } else if (field.type === 'combo') {
      control = badge(combo(field, common, value, shown ?? field.placeholder ?? '—', grey, shown));
    } else if (field.type === 'colour') {
      control = `<span class="colour-field"><input type="color" value="${toHex(value || shown)}" data-picker-for="${esc(field.tag)}"${grey} />
        ${badge(`<input type="text" ${common} value="${esc(value)}" placeholder="${esc(shown ?? tr('#rrggbb или имя'))}" />`)}</span>`;
    } else {
      control = badge(`<input type="text" inputmode="${field.type === 'int' ? 'numeric' : 'text'}" ${common}${sug ? grey : ''} value="${esc(value)}" placeholder="${esc(shown ?? field.placeholder ?? '')}" />`);
      if (field.type === 'direction') control = directionField(control);
      if (field.type === 'int') control = stepper(control);
    }
    return `<label class="tag-row${changed ? ' changed' : ''}"><span>${esc(field.label)}</span>${control}</label>`;
  }).join('');
  // У нового объекта «как было» — нет (отменить создание — undo)
  const revert = session.isChanged(key) && !session.isCreated(key) ? `<button type="button" data-revert>${tr('Вернуть как было')}</button>` : '';
  // Наследование — соглашение рендереров, а не схемы: советуем задать свойства на самой части
  const warn = inheritedAny.length
    ? `<p class="warn inherit-warn">⚠ ${tr('{fields} — взято у здания (серым в полях). Другие программы могут не наследовать: лучше задать на самой части.', { fields: esc(inheritedAny.join(', ')) })}</p>`
    : '';
  // material на здании — устаревший вариант building:material (вики: Key:material): предлагаем замену
  const legacy = f.tags.material !== undefined
    ? `<p class="warn">⚠ ${f.tags['building:material']
      ? tr('{tag} — для зданий устарел, фасад описывает building:material (уже задан — material можно удалить).', { tag: `material=${esc(f.tags.material)}` })
      : tr('{tag} — для зданий устарел, фасад описывает building:material.', { tag: `material=${esc(f.tags.material)}` })}
        <button type="button" data-fix-material>${f.tags['building:material'] ? tr('Удалить material') : tr('Заменить на building:material')}</button></p>`
    : '';
  return `<form class="tag-form" data-key="${esc(key)}" onsubmit="return false">${legacy}${warn}${rows}${revert}</form>`;
}

/**
 * Форма тегов для нескольких объектов: общее значение или «разные» серым; правка — сразу для всех.
 * suggestFor — откуда подсказывать даты каждому объекту (см. renderTagForm).
 */
export function renderMultiTagForm(keys: string[], session: EditSession, suggestFor: (key: string) => InheritSource[] = () => []): string {
  const feats = keys.map((k) => session.get(k)).filter((f): f is NonNullable<typeof f> => !!f);
  if (!feats.length) return '';
  const values = (tag: string) => [...new Set(feats.map((f) => f.tags[tag] ?? ''))];
  const shapes = values('roof:shape');
  const rows = FIELDS.filter((field) => {
    if (field.tag === 'building:part' && !feats.every((f) => f.tags['building:part'] !== undefined)) return false;
    if (field.dated && !dateFields && !values(field.tag).some(Boolean)) return false;
    const only = SHAPE_ONLY[field.tag];
    return !only || values(field.tag).some(Boolean) || shapes.some((v) => only.includes(v));
  }).map((field) => {
    const vs = values(field.tag);
    const mixed = vs.length > 1;
    const value = mixed ? '' : vs[0];
    const changed = feats.some((f) => session.isChanged(f.key, field.tag));
    // Подсказка — если у всех пустых одна и та же, а заданные с ней совпадают; Tab заполнит пустые
    const empty = field.suggest ? feats.filter((f) => !f.tags[field.tag]) : [];
    const sugs = [...new Set(empty.map((f) => suggestion(field.tag, suggestFor(f.key))?.value ?? ''))];
    const sug = sugs.length === 1 && sugs[0] && vs.every((v) => !v || v === sugs[0]) ? sugs[0] : undefined;
    if (sug) {
      const tip = tr('Не задано у {n} из {total} — у здания: {value}. Tab — подставить.', { n: empty.length, total: feats.length, value: sug });
      const control = withBadge(`<input type="text" data-tag="${esc(field.tag)}" data-type="${field.type}" title="${esc(tip)}" data-suggest="${esc(sug)}" class="suggested" value="" placeholder="${esc(sug)}" />`, tip, ICON_SUGGEST);
      return `<label class="tag-row${changed ? ' changed' : ''}"><span>${esc(field.label)}</span>${control}</label>`;
    }
    const shown = mixed ? tr('разные: {values}', { values: `${vs.map((v) => v || '—').slice(0, 6).join(', ')}${vs.length > 6 ? '…' : ''}` }) : '';
    const tip = mixed ? `${shown}${NUMERIC.has(field.type) ? tr('. Число — всем одно значение; =+1, =-2, =*2, =/8 — к значению каждого') : ''}` : field.tag;
    const common = `data-tag="${esc(field.tag)}" data-type="${field.type}" title="${esc(tip)}"`;
    const cls = mixed ? ' class="mixed"' : '';
    let control: string;
    if (field.type === 'select') {
      const extra = vs.filter((v) => v && !field.options!.includes(v));
      const options = [...new Set([...extra, ...field.options!])];
      control = `<select ${common}${cls}><option value="">${mixed ? tr('разные') : '—'}</option>${options
        .map((o) => `<option value="${esc(o)}"${o === value ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    } else if (field.type === 'combo') {
      control = combo(field, common, value, mixed ? tr('разные') : field.placeholder ?? '—', cls);
    } else if (field.type === 'colour') {
      control = `<span class="colour-field"><input type="color" value="${toHex(value || vs.find(Boolean))}" data-picker-for="${esc(field.tag)}"${cls} />
        <input type="text" ${common}${cls} value="${esc(value)}" placeholder="${mixed ? tr('разные') : tr('#rrggbb или имя')}" /></span>`;
    } else {
      control = `<input type="text" inputmode="${field.type === 'int' ? 'numeric' : 'text'}" ${common}${cls} value="${esc(value)}" placeholder="${esc(mixed ? tr('разные') : field.placeholder ?? '')}" />`;
      if (field.type === 'direction') control = directionField(control);
      if (field.type === 'int') control = stepper(control);
    }
    return `<label class="tag-row${changed ? ' changed' : ''}"><span>${esc(field.label)}</span>${control}</label>`;
  }).join('');
  return `<form class="tag-form" data-keys="${esc(feats.map((f) => f.key).join(' '))}" onsubmit="return false">
    <p class="hint">${trn(feats.length, 'Общие свойства {n} объекта. Для чисел формула: =+1, =-2, =*2, =/8 — к значению каждого.|Общие свойства {n} объектов. Для чисел формула: =+1, =-2, =*2, =/8 — к значению каждого.|Общие свойства {n} объектов. Для чисел формула: =+1, =-2, =*2, =/8 — к значению каждого.')}</p>${rows}</form>`;
}

/**
 * Поле со списком частых значений и своим вводом. Свой список вместо datalist: тот прячет варианты,
 * не совпадающие с введённым, и стрелку показывает только при наведении.
 */
function combo(field: Field, common: string, value: string, placeholder: string, cls: string, inherited?: string): string {
  // Нестандартное значение из данных — тоже в списке, чтобы его было видно
  const options = [...new Set([...(value && !field.options!.includes(value) ? [value] : []), ...field.options!])];
  const icon = (o: string) => (field.icons ? `<i class="combo-icon">${field.icons[o] ?? ''}</i>` : '');
  const items = options.map((o) => {
    const label = field.labels?.[o] ?? o;
    const raw = label.toLowerCase() === o.toLowerCase() ? '' : `<span>${esc(o)}</span>`;
    return `<li data-value="${esc(o)}"${o === value ? ' class="current"' : ''}>${icon(o)}<b>${esc(label)}</b>${raw}</li>`;
  }).join('');
  // Иконка выбранного (или унаследованного) значения — слева в поле
  const shown = field.icons?.[value || inherited || ''];
  const lead = field.icons ? `<i class="combo-icon combo-lead${!value && inherited ? ' inherited' : ''}">${shown ?? ''}</i>` : '';
  return `<span class="combo-field${field.icons ? ' with-icons' : ''}">${lead}<input type="text" autocomplete="off" ${common}${cls} value="${esc(value)}" placeholder="${esc(placeholder)}" />`
    + `<button type="button" class="combo-btn" tabindex="-1" title="${tr('Выбрать из списка')}"></button><ul class="combo-list" hidden>${items}</ul></span>`;
}

/** Свободный ввод с тем же полным списком вариантов для indoor-форм; key — ключ OSM для подписей iD. */
export function renderValueCombo(options: string[], attributes: string, value: string, placeholder: string, labels?: Record<string, string>, key = ''): string {
  return combo({ tag: key, label: '', type: 'combo', options, labels: key ? valueLabels(key, labels) : labels }, attributes, value, placeholder, '');
}

/** Значок «задать направление двумя точками» — стрелка из точки. */
const ICON_DIRECTION = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><g transform="translate(.5 -.5)"><circle cx="3.5" cy="12.5" r="1.5"/><path d="M5 11l1.5-1.5M8 8l1.5-1.5"/><path d="M13 3l-4.5 1M13 3l-1 4.5M13 3l-2 2"/></g></svg>';

/** Поле направления с кнопкой инструмента «две точки в 3D». */
function directionField(input: string): string {
  return `<span class="direction-field">${input}<button type="button" class="direction-pick" data-pick-direction title="${esc(tr('Задать направление двумя точками в 3D (D)'))}">${ICON_DIRECTION}</button></span>`;
}

/** Поле со значком «унаследовано» справа (только если есть пояснение). */
function withBadge(input: string, hint: string, icon = ICON_INHERIT): string {
  if (!hint) return input;
  return `<span class="inherit-field" title="${esc(hint)}">${input}<span class="inherit-badge">${icon}</span></span>`;
}

/** Целое (этажи): стрелки ±1 справа в поле. */
function stepper(input: string): string {
  return `<span class="step-field">${input}<span class="step-btns"><button type="button" class="step-btn" data-step="1" tabindex="-1" title="${tr('Больше на 1')}"></button>`
    + `<button type="button" class="step-btn" data-step="-1" tabindex="-1" title="${tr('Меньше на 1')}"></button></span></span>`;
}

/**
 * Крыша — поверх фасада: при выборе скатной формы вместо плоской и при смене roof:height верх стен остаётся
 * на месте, а height растёт на высоту крыши (по схеме height — до конька, и крыша иначе съедала бы фасад).
 * Без height, но с этажами — при выборе формы height записываем: этажи плюс крыша (дальше правки идут как с height).
 */
function roofOnTop(before: Record<string, string>, after: Record<string, string>, tag: string) {
  if (before['building:part'] === 'roof' || before.building === 'roof') return;
  const height = parseLength(before.height) !== undefined;
  if (!height && before['building:levels'] === undefined) return;
  const pitched = roofShapeOf(after) !== 'flat';
  const apply = tag === 'roof:shape' ? pitched && roofShapeOf(before) === 'flat' : tag === 'roof:height' && pitched && height;
  if (apply) after.height = num(computeHeights(before).wallTop + roofHeightOf(after));
}

/** Обработчики формы (делегирование на контейнер; вешается один раз). */
export function bindTagForms(container: HTMLElement, session: () => EditSession | undefined) {
  const commit = (input: HTMLInputElement | HTMLSelectElement) => {
    if (input.dataset.indoorTag) {
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
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
      if (v.trim() === REMOVE_VALUE && tag === 'building:part') delete tags[tag];
      else if (v.trim()) tags[tag] = v.trim(); else if (empty && !('emptyRemoves' in input.dataset)) tags[tag] = empty; else delete tags[tag];
      if (tags[tag] === f.tags[tag]) return [];
      roofOnTop(f.tags, tags, tag);
      return [{ key, tags }];
    });
    if (edits.length === 1 && keys.length === 1) {
      const { key, tags } = edits[0];
      s.setTags(key, { [tag]: tags[tag], ...(tags.height !== s.get(key)!.tags.height ? { height: tags.height } : {}) });
    }
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
    // Выбор из списка завершает ввод: фокус снимаем, чтобы горячие клавиши (W, …) не печатались в поле
    input.blur();
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
  // Tab в пустом поле с подсказкой — подставить её; фокус уходит дальше обычным Tab
  // (перерисовка формы после правки возвращает его в поле с тем же тегом)
  container.addEventListener('keydown', (e) => {
    const input = e.target as HTMLInputElement;
    if (e.key !== 'Tab' || e.shiftKey || !input.dataset.suggest || input.value) return;
    input.value = input.dataset.suggest;
    setTimeout(() => commit(input)); // после перехода фокуса: перерисовка вернёт его в следующее поле
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
      input.blur();
      commit(input);
    } else if (e.key === 'Enter') ul.hidden = true;
  });
  container.addEventListener('click', (e) => {
    // Стрелки целого поля: ±1 от своего значения, а без него — от показанного серым (унаследованного, по умолчанию);
    // у нескольких объектов — формула =+1 / =-1 к значению каждого
    const step = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-step]');
    const stepInput = step?.closest('.step-field')?.querySelector<HTMLInputElement>('input[data-tag]');
    if (step && stepInput) {
      e.preventDefault();
      const d = Number(step.dataset.step);
      if (stepInput.closest<HTMLFormElement>('.tag-form')?.dataset.keys) stepInput.value = d > 0 ? '=+1' : '=-1';
      else {
        const base = Number.parseInt(stepInput.value || stepInput.placeholder, 10);
        const next = (Number.isFinite(base) ? base : 0) + d;
        // Этажей и этажей в крыше меньше нуля не бывает; нижний этаж бывает подземным
        if (next < 0 && stepInput.dataset.tag !== 'building:min_level') return;
        stepInput.value = String(next);
      }
      commit(stepInput);
      return;
    }
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

export const LEVEL_HEIGHT = 3;
const DEFAULT_ROOF_HEIGHT = 3;
/** Высота стен без height и building:levels — один этаж: 3 м, как в вики Key:building:levels. */
const DEFAULT_WALL_HEIGHT = 3;

export interface Heights {
  min: number;
  /** Верх стен = низ крыши. */
  wallTop: number;
  top: number;
  roofShape: string;
  roofHeight: number;
  /** Откуда взята высота — для подсказок в UI. */
  source: 'height' | 'levels' | 'default';
}

export const FOOT = 0.3048;
const INCH = 0.0254;
/** Единицы длины из вики Map_features/Units с их псевдонимами, в метрах. */
const LENGTH_UNITS: Record<string, number> = {
  m: 1, metre: 1, metres: 1, meter: 1, meters: 1,
  km: 1000, kilometre: 1000, kilometres: 1000, kilometer: 1000, kilometers: 1000,
  mi: 1609.344, mile: 1609.344, miles: 1609.344, nmi: 1852,
  ft: FOOT, feet: FOOT, foot: FOOT, "'": FOOT, yd: 0.9144, yds: 0.9144,
};

/** Разбирает '12', '12 m', '0.2 km', '40 ft', "40'", `7'4"` (футы и дюймы); результат в метрах. */
export function parseLength(v?: string): number | undefined {
  const fi = v?.trim().match(/^(\d+)'\s*(\d+(?:\.\d+)?)"$/);
  if (fi) return Number(fi[1]) * FOOT + Number(fi[2]) * INCH;
  const m = v?.trim().match(/^(-?\d+(?:\.\d+)?)\s*([a-z]+|')?$/i);
  if (!m) return;
  const k = m[2] ? LENGTH_UNITS[m[2].toLowerCase()] : 1;
  return k === undefined ? undefined : Number(m[1]) * k;
}

/** Как parseLength, но из нестрогого значения ('3;4', '3-4') берёт первое число; нет числа — NaN. */
export const looseLength = (v?: string): number => parseLength(v) ?? parseFloat(v ?? '');

function parseNum(v?: string): number | undefined {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Синонимы и устаревшие значения roof:shape (wiki Key:roof:shape, «Values with problems») → основное значение.
 * many (несколько форм) честно моделируется частями — сами рисуем плоской.
 */
const ROOF_SYNONYMS: Record<string, string> = {
  pitched: 'gabled', lean_to: 'skillion', monopitch: 'skillion', shed: 'skillion', sloped: 'skillion',
  gabled_height_moved: 'saltbox', many: 'flat', mixed: 'flat', mix: 'flat', multi: 'flat',
  equal_hipped: 'hipped', cross_gabled: 'crosspitched',
  // Импорт GSI (Япония): категории числа скатов вместо формы
  '2 faces (pitched)': 'gabled', '2 face (pitched)': 'gabled', '4 faces (hipped)': 'hipped', '4 face (hipped)': 'hipped',
  'more than 4 faces': 'hipped', 'more than 4 faces (hipped)': 'hipped', more_than_4_faces: 'hipped',
};

/** Значение roof:shape, приведённое к основному (регистр, синонимы); без тега — flat. */
export function roofShapeOf(tags: Record<string, string>): string {
  const v = (tags['roof:shape'] ?? 'flat').trim().toLowerCase();
  return ROOF_SYNONYMS[v] ?? v;
}

/** Высота скатной крыши по тегам (roof:height, иначе roof:levels, иначе типичная) — без поправок на высоту объекта. */
export function roofHeightOf(tags: Record<string, string>): number {
  const roofLevels = parseNum(tags['roof:levels']);
  return parseLength(tags['roof:height']) ?? (roofLevels !== undefined && roofLevels > 0 ? roofLevels * LEVEL_HEIGHT : DEFAULT_ROOF_HEIGHT);
}

export function computeHeights(tags: Record<string, string>): Heights {
  const roofShape = roofShapeOf(tags);
  const levels = parseNum(tags['building:levels']);
  const minLevel = parseNum(tags['building:min_level']);
  const roofLevels = parseNum(tags['roof:levels']);

  let roofHeight = roofShape === 'flat' ? 0 : roofHeightOf(tags);
  let min = parseLength(tags.min_height) ?? (minLevel !== undefined ? minLevel * LEVEL_HEIGHT : 0);

  const height = parseLength(tags.height);
  let top: number;
  let source: Heights['source'];
  if (height !== undefined) { top = height; source = 'height'; }
  else if (levels !== undefined) { top = levels * LEVEL_HEIGHT + roofHeight; source = 'levels'; }
  else { top = Math.max(min, DEFAULT_WALL_HEIGHT) + roofHeight; source = 'default'; }

  top = Math.max(top, min);
  // У части-кровли без указанного низа оставляем короткую стенку под крышей.
  const roofOnly = tags['building:part'] === 'roof' || tags.building === 'roof';
  if (roofOnly && levels === undefined && tags.min_height === undefined && minLevel === undefined) {
    min = Math.max(0, top - roofHeight - 0.3);
  }
  if (roofOnly && roofShape !== 'flat' && tags['roof:height'] === undefined && roofLevels === undefined
      && height !== undefined && (tags.min_height !== undefined || minLevel !== undefined) && min > 0) {
    roofHeight = top - min;
  }
  roofHeight = Math.min(roofHeight, top - min);
  return { min, wallTop: top - roofHeight, top, roofShape, roofHeight, source };
}

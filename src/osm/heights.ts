export const LEVEL_HEIGHT = 3;
const DEFAULT_ROOF_HEIGHT = 3;
/** Высота стен без height и building:levels — один этаж (официального значения в Simple 3D нет). */
const DEFAULT_WALL_HEIGHT = 3.5;

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

/** Разбирает '12', '12 m', '40 ft', "40'", `7'4"` (футы и дюймы). */
export function parseLength(v?: string): number | undefined {
  const fi = v?.trim().match(/^(\d+)'(\d+(?:\.\d+)?)"$/);
  if (fi) return Number(fi[1]) * 0.3048 + Number(fi[2]) * 0.0254;
  const m = v?.trim().match(/^(-?\d+(?:\.\d+)?)\s*(m|ft|')?$/);
  if (!m) return;
  const n = Number(m[1]);
  return m[2] === 'ft' || m[2] === "'" ? n * 0.3048 : n;
}

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
};

/** Значение roof:shape, приведённое к основному (регистр, синонимы); без тега — flat. */
export function roofShapeOf(tags: Record<string, string>): string {
  const v = (tags['roof:shape'] ?? 'flat').trim().toLowerCase();
  return ROOF_SYNONYMS[v] ?? v;
}

export function computeHeights(tags: Record<string, string>): Heights {
  const roofShape = roofShapeOf(tags);
  const levels = parseNum(tags['building:levels']);
  const minLevel = parseNum(tags['building:min_level']);
  const roofLevels = parseNum(tags['roof:levels']);

  let roofHeight = roofShape === 'flat'
    ? 0
    : parseLength(tags['roof:height']) ?? (roofLevels !== undefined ? roofLevels * LEVEL_HEIGHT : DEFAULT_ROOF_HEIGHT);
  const min = parseLength(tags.min_height) ?? (minLevel !== undefined ? minLevel * LEVEL_HEIGHT : 0);

  const height = parseLength(tags.height);
  let top: number;
  let source: Heights['source'];
  if (height !== undefined) { top = height; source = 'height'; }
  else if (levels !== undefined) { top = levels * LEVEL_HEIGHT + roofHeight; source = 'levels'; }
  else { top = Math.max(min, DEFAULT_WALL_HEIGHT) + roofHeight; source = 'default'; }

  top = Math.max(top, min);
  // Навес/крыша на опорах (building:part=roof, building=roof) без roof:height и roof:levels: стен у него нет —
  // крыша занимает всю высоту от min_height до верха (иначе под ней вырастал бы фасад высотой top − min − 3 м)
  const roofOnly = tags['building:part'] === 'roof' || tags.building === 'roof';
  if (roofOnly && roofShape !== 'flat' && tags['roof:height'] === undefined && roofLevels === undefined && height !== undefined && min > 0) {
    roofHeight = top - min;
  }
  roofHeight = Math.min(roofHeight, top - min);
  return { min, wallTop: top - roofHeight, top, roofShape, roofHeight, source };
}

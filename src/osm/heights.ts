const LEVEL_HEIGHT = 3;
const DEFAULT_ROOF_HEIGHT = 3;
const DEFAULT_LEVELS = 2;

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

/** Разбирает '12', '12 m', '40 ft', "40'". */
export function parseLength(v?: string): number | undefined {
  const m = v?.trim().match(/^(-?\d+(?:\.\d+)?)\s*(m|ft|')?$/);
  if (!m) return;
  const n = Number(m[1]);
  return m[2] === 'ft' || m[2] === "'" ? n * 0.3048 : n;
}

function parseNum(v?: string): number | undefined {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function computeHeights(tags: Record<string, string>): Heights {
  const roofShape = tags['roof:shape'] ?? 'flat';
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
  else { top = Math.max(min, DEFAULT_LEVELS * LEVEL_HEIGHT) + roofHeight; source = 'default'; }

  top = Math.max(top, min);
  roofHeight = Math.min(roofHeight, top - min);
  return { min, wallTop: top - roofHeight, top, roofShape, roofHeight, source };
}

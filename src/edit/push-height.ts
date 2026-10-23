import { computeHeights, LEVEL_HEIGHT, type Heights } from '../osm/heights';
import { tr } from '../i18n';
import type { PushFace, PushUnits } from './push-tool';

/** Drawn contours carry a temporary height at their drawing plane. */
export function isFreshFlat(tags: Record<string, string>, version: number, h: Heights = computeHeights(tags)): boolean {
  // Нарисованный только что — или нарисованный плоским (часть без высоты в режиме здания)
  return (version === 0 || h.source === 'default') && Math.abs(h.top - h.min) < 1e-6;
}

export function lockedPushUnits(tags: Record<string, string>, version: number): PushUnits | undefined {
  if (isFreshFlat(tags, version)) return;
  const meters = !!tags.height, levels = !!tags['building:levels'];
  return meters === levels ? undefined : meters ? 'm' : 'levels';
}

/** h — высоты, как объект нарисован (часть без высоты в режиме здания — плоская), по умолчанию — по тегам. */
export function pushHeightTags(tags: Record<string, string>, face: PushFace, dz: number, units: PushUnits, fresh = false, h: Heights = computeHeights(tags)): Record<string, string> {
  const out = { ...tags };
  const fmt = (n: number) => String(Math.round(n * 100) / 100);
  const levels = units === 'levels';
  if (face === 'top') {
    if (levels || tags['building:levels']) {
      out['building:levels'] = fmt(Number(tags['building:levels'] ?? h.wallTop / LEVEL_HEIGHT) + dz / LEVEL_HEIGHT);
    }
    if (!levels || (tags.height && !fresh)) out.height = fmt(h.top + dz);
    else if (fresh) {
      delete out.height;
      if (tags.min_height) {
        out['building:min_level'] = fmt(h.min / LEVEL_HEIGHT);
        delete out.min_height;
      }
    }
  } else if (face === 'bottom') {
    const min = h.min + dz;
    if (levels || tags['building:min_level']) {
      if (min > 1e-4) out['building:min_level'] = fmt(min / LEVEL_HEIGHT);
      else delete out['building:min_level'];
    }
    if (!levels || tags.min_height) {
      if (min > 1e-4) out.min_height = fmt(min);
      else delete out.min_height;
    }
  }
  return out;
}

/** Ниже этого крыша ручкой не опускается: до нуля можно — крыша той же формы, но плоская. */
export const MIN_ROOF_HEIGHT = 0;

/**
 * Высота крыши на dz (ручка крыши «Формы»): верх стен стоит, height (если задан) растёт вместе с крышей.
 * roof:height — в метрах; крыша, размеченная только roof:levels, — целыми этажами (до нуля).
 */
export function roofHeightTags(tags: Record<string, string>, dz: number): Record<string, string> {
  const h = computeHeights(tags), out = { ...tags };
  const fmt = (n: number) => String(Math.round(n * 100) / 100);
  let roof = Math.max(MIN_ROOF_HEIGHT, h.roofHeight + dz);
  if (tags['roof:levels'] !== undefined && tags['roof:height'] === undefined) {
    const n = Math.max(0, Math.round(roof / LEVEL_HEIGHT));
    out['roof:levels'] = String(n);
    // roof:levels=0 высоту не задаёт (рисуется высота по умолчанию) — ноль ставим явно
    if (!n) out['roof:height'] = '0';
    roof = n * LEVEL_HEIGHT;
  } else out['roof:height'] = fmt(roof);
  if (tags.height !== undefined) out.height = fmt(h.wallTop + roof);
  return out;
}

/** Пояснение: высота задана только этажами (levelsTag) — меняется целыми этажами; чтобы в метрах — задать metresTag. */
export function levelsNote(levelsTag: string, metresTag: string): string {
  return tr('Высота задана этажами ({levels}) — меняется только целыми этажами. Чтобы менять в метрах, задайте высоту в метрах ({metres}).',
    { levels: levelsTag, metres: metresTag });
}

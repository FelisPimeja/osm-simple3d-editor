import type { OsmElement } from './api';
import type { LonLat } from './model';
import { parseLength } from './heights';

/** Отдельностоящее ограждение: стена, забор, живая изгородь (линия на земле, не indoor). */
export interface BarrierWay { id: number; tags: Record<string, string>; nodes: number[]; coords: LonLat[] }

/** Виды barrier, которые рисуем объёмом. city_wall и retaining_wall — позже (зубцы, рельеф). */
export const BARRIER_KINDS = new Set(['wall', 'fence', 'hedge']);

export function isBarrierTags(tags?: Record<string, string>): boolean {
  if (!tags || !BARRIER_KINDS.has(tags.barrier)) return false;
  // Стены и перила внутри здания — это план этажа (indoor), там они уже есть
  if ((tags.indoor && tags.indoor !== 'no') || tags.level !== undefined || tags.repeat_on !== undefined) return false;
  if (tags.area === 'yes' || tags.location === 'underground' || Number(tags.layer) < 0) return false;
  return true;
}

/** Ограждения из ответа API или Overpass. */
export function parseBarriers(elements: OsmElement[]): BarrierWay[] {
  const nodes = new Map<number, LonLat>();
  for (const e of elements) if (e.type === 'node') nodes.set(e.id, [e.lon, e.lat]);
  const out: BarrierWay[] = [];
  for (const e of elements) {
    if (e.type !== 'way' || !isBarrierTags(e.tags)) continue;
    const coords = e.nodes.map((n) => nodes.get(n));
    if (coords.length >= 2 && coords.every(Boolean)) out.push({ id: e.id, tags: e.tags!, nodes: e.nodes.slice(), coords: coords as LonLat[] });
  }
  return out;
}

/** Ограждения без сплошного полотна: сетка, решётка, штакетник — полупрозрачные. */
const SEE_THROUGH = new Set(['chain_link', 'metal_bars', 'railing', 'pole', 'barbed_wire', 'electric', 'wire', 'split_rail', 'post_and_rail', 'hedge_bank', 'net', 'mesh']);

/** width 0 — плоскость без толщины (забор без width). */
export interface BarrierShape { min: number; top: number; width: number; colour: string; seeThrough: boolean }

/** Высота, толщина и цвет ограждения: теги, без них — типичные для вида. */
export function barrierShape(tags: Record<string, string>): BarrierShape {
  const kind = tags.barrier, ft = tags.fence_type, mat = tags.material ?? tags.wall;
  const defH = kind === 'wall' ? 3 : kind === 'hedge' ? 1.5 : ft === 'railing' ? 1 : 2.5;
  // Забор без width — плоскость: толщина сетки или штакетника не видна и не размечена
  const defW = kind === 'hedge' ? 0.8 : kind === 'wall' ? (mat === 'dry_stone' ? 0.5 : 0.3) : 0;
  const min = parseLength(tags.min_height) ?? 0;
  const h = parseLength(tags.height);
  const top = h !== undefined && h > 0 ? h : min + defH;
  const tagged = parseLength(tags.width);
  const width = tagged !== undefined && tagged > 0 ? Math.max(0.03, Math.min(5, tagged)) : defW;
  const colour = tags.colour ?? (kind === 'hedge' ? '#55773a'
    : kind === 'wall' ? (mat === 'brick' ? '#a65a43' : mat === 'stone' || mat === 'dry_stone' ? '#a39c8f' : mat === 'concrete' ? '#bdbab3' : '#c8c2b6')
    : ft === 'wood' || mat === 'wood' ? '#9a7650' : ft === 'concrete' || mat === 'concrete' ? '#bdbab3' : ft === 'stone' ? '#a39c8f' : ft === 'brick' ? '#a65a43' : '#8a8f94');
  return { min, top: Math.max(top, min + 0.1), width, colour, seeThrough: kind === 'fence' && (SEE_THROUGH.has(ft ?? '') || !ft) };
}

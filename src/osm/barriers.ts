import type { OsmElement } from './api';
import type { LonLat } from './model';
import { parseLength } from './heights';

/** Отдельностоящее ограждение: стена, забор, живая изгородь (линия на земле, не indoor). */
export interface BarrierWay { id: number; tags: Record<string, string>; nodes: number[]; coords: LonLat[]; gates?: BarrierGate[] }

/** Ворота, калитка, проход и т. п. — узел на линии ограждения (barrier=gate/entrance/…). */
export interface BarrierGate { id: number; tags: Record<string, string> }

/** Проёмы в ограждении: узлы с этими barrier на его линии. */
export const GATE_KINDS = new Set(['gate', 'entrance', 'wicket_gate', 'swing_gate', 'sliding_gate', 'lift_gate', 'kissing_gate', 'turnstile', 'full-height_turnstile', 'stile', 'chain', 'rope']);
export const isGateTags = (tags?: Record<string, string>) => !!tags && GATE_KINDS.has(tags.barrier);

/** Ширина проёма, м: width / maxwidth, без них — типичная для вида. */
export function gateWidth(tags: Record<string, string>): number {
  const w = parseLength(tags.width) ?? parseLength(tags['maxwidth:physical']) ?? parseLength(tags.maxwidth);
  if (w !== undefined && w > 0.2) return Math.min(w, 30);
  const b = tags.barrier;
  return b === 'gate' || b === 'swing_gate' ? 3.5 : b === 'sliding_gate' ? 4 : b === 'lift_gate' || b === 'chain' || b === 'rope' ? 3.5
    : b === 'turnstile' || b === 'stile' ? 0.8 : b === 'wicket_gate' || b === 'full-height_turnstile' || b === 'kissing_gate' ? 1 : 1.5;
}

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
  const nodes = new Map<number, LonLat>(), gateTags = new Map<number, Record<string, string>>();
  for (const e of elements) if (e.type === 'node') { nodes.set(e.id, [e.lon, e.lat]); if (isGateTags(e.tags)) gateTags.set(e.id, e.tags!); }
  const out: BarrierWay[] = [];
  for (const e of elements) {
    if (e.type !== 'way' || !isBarrierTags(e.tags)) continue;
    const coords = e.nodes.map((n) => nodes.get(n));
    const gates = [...new Set(e.nodes)].filter((n) => gateTags.has(n)).map((n) => ({ id: n, tags: gateTags.get(n)! }));
    if (coords.length >= 2 && coords.every(Boolean)) out.push({ id: e.id, tags: e.tags!, nodes: e.nodes.slice(), coords: coords as LonLat[], ...(gates.length ? { gates } : {}) });
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
  // Без colour и material (fence_type) — белый, как здания без цвета; живая изгородь — зелёная
  const colour = tags.colour ?? (kind === 'hedge' ? '#55773a'
    : kind === 'wall' ? (mat === 'brick' ? '#a65a43' : mat === 'stone' || mat === 'dry_stone' ? '#a39c8f' : mat === 'concrete' ? '#bdbab3' : '#ffffff')
    : ft === 'wood' || mat === 'wood' ? '#9a7650' : ft === 'concrete' || mat === 'concrete' ? '#bdbab3' : ft === 'stone' ? '#a39c8f' : ft === 'brick' ? '#a65a43' : '#ffffff');
  return { min, top: Math.max(top, min + 0.1), width, colour, seeThrough: kind === 'fence' && (SEE_THROUGH.has(ft ?? '') || !ft) };
}

/** Цвет створки ворот: colour, иначе по material (дерево, металл…), без них — белый. */
export function gateColour(tags: Record<string, string>): string {
  const m = tags.material;
  return tags.colour ?? (m === 'wood' ? '#9a7650' : m === 'metal' || m === 'steel' || m === 'iron' ? '#8a8f94' : m === 'concrete' ? '#bdbab3' : '#ffffff');
}

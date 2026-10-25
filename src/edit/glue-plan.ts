import type { Feature3D, LonLat } from '../osm/model';
import type { Pt } from '../render/building-geometry';
import { computeHeights } from '../osm/heights';

/**
 * План преобразования объектов в плане (перемещение, поворот, масштаб) в режиме «с соседями»:
 * - соседи, чей объём по высоте пересекается с нашими, тянутся следом: общие узлы едут вместе с нами, их узлы на
 *   наших сторонах (Т-образные стыки) — туда же, куда точки сторон;
 * - соседи выше или ниже (касание по высоте — не пересечение) не трогаются: общие с ними узлы у нас заменяются
 *   новыми (split), как в режиме «отдельно».
 * Чистая геометрия: правки из плана собирает вызывающий.
 */
export interface GluePlan {
  /** Узел → новые координаты (наши узлы, кроме split, и чужие узлы на наших сторонах). */
  moves: Map<number, LonLat>;
  /** Наши узлы, общие с соседями выше/ниже: у нас — новые узлы, соседям — старые. */
  split: Set<number>;
  /** Соседи выше/ниже: их не трогаем. */
  apart: Set<string>;
}

type Ring = readonly [LonLat[], number[] | undefined];
const rings = (f: Feature3D): Ring[] =>
  f.polygons.flatMap((p) => [[p.outer, p.outerIds] as const, ...p.inners.map((c, k) => [c, p.innerIds?.[k]] as const)]);

export function gluePlan(features: Feature3D[], live: Feature3D[], fn: (c: LonLat) => LonLat, toLocal: (c: LonLat) => Pt): GluePlan {
  const mine = new Set(features.map((f) => f.key));
  const spans = features.map((f) => computeHeights(f.tags));
  const apart = new Set<string>();
  for (const g of live) {
    if (mine.has(g.key)) continue;
    const h = computeHeights(g.tags);
    if (!spans.some((s) => h.min < s.top - 1e-3 && s.min < h.top - 1e-3)) apart.add(g.key);
  }
  const own = new Set<number>();
  const sides: [Pt, Pt][] = [];
  for (const f of features) for (const [ring, ids] of rings(f)) ids?.forEach((id, k) => {
    own.add(id);
    sides.push([toLocal(ring[k]), toLocal(ring[(k + 1) % ring.length])]);
  });
  // Узлы соседей выше/ниже не двигаем никогда: ни наши общие с ними (split), ни их узлы на наших сторонах, даже
  // если узел заодно и у соседа того же уровня (иначе стык потянул бы часть сверху)
  const fixed = new Set<number>();
  for (const g of live) if (apart.has(g.key)) for (const [, ids] of rings(g)) ids?.forEach((id) => fixed.add(id));
  const split = new Set([...own].filter((id) => fixed.has(id)));
  const moves = new Map<number, LonLat>();
  for (const f of features) for (const [ring, ids] of rings(f)) ids?.forEach((id, k) => { if (!split.has(id)) moves.set(id, fn(ring[k])); });
  for (const g of live) {
    if (mine.has(g.key) || apart.has(g.key)) continue;
    for (const [ring, ids] of rings(g)) ids?.forEach((id, k) => {
      if (own.has(id) || moves.has(id) || fixed.has(id)) return;
      const [px, py] = toLocal(ring[k]);
      for (const [a, b] of sides) {
        const ex = b[0] - a[0], ey = b[1] - a[1], len = Math.hypot(ex, ey);
        if (len < 1e-6) continue;
        const t = ((px - a[0]) * ex + (py - a[1]) * ey) / (len * len);
        if (Math.abs((px - a[0]) * ey - (py - a[1]) * ex) / len >= 1e-3 || t <= 1e-6 || t >= 1 - 1e-6) continue;
        moves.set(id, fn(ring[k]));
        break;
      }
    });
  }
  return { moves, split, apart };
}

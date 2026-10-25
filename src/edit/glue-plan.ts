import type { Feature3D, LonLat } from '../osm/model';
import type { Pt } from '../render/building-geometry';
import { computeHeights } from '../osm/heights';

/**
 * Режим «с соседями» (attached) — общие правила для всех инструментов, меняющих контур:
 * - соседи тянутся следом: общие узлы едут вместе с нами, их узлы на наших сторонах и у наших углов (в пределах
 *   ON_SIDE_M) — так же, как ближайшая точка стороны;
 * - уровни: тянутся только соседи, чей объём по высоте пересекается с нашим; соседи выше или ниже (касание по
 *   высоте — не пересечение) не меняются никогда — общие с ними узлы у нас и у соседей того же уровня заменяются
 *   новым узлом, который и едет (сборка правок — levelSafeEdits в main.ts);
 * - контур здания (outline) — след всех частей: он всегда «того же уровня», какой бы ни была его высота.
 */

/**
 * Чужой узел ближе этого к нашей стороне — на ней (Т-стык): едет вместе с ней. Шаг координат OSM (1e-7°) — около
 * 1 см, поэтому миллиметровый допуск не ловил узлы, лежащие на стороне с точностью до округления.
 */
export const ON_SIDE_M = 0.05;

type Ring = readonly [LonLat[], number[] | undefined];
export const featureRings = (f: Feature3D): Ring[] =>
  f.polygons.flatMap((p) => [[p.outer, p.outerIds] as const, ...p.inners.map((c, k) => [c, p.innerIds?.[k]] as const)]);

/** Соседи выше или ниже features (не пересекаются с ними по высоте; контуры здания — никогда). */
export function levelApart(features: Feature3D[], live: Feature3D[]): Set<string> {
  const mine = new Set(features.map((f) => f.key));
  const spans = features.map((f) => computeHeights(f.tags));
  const apart = new Set<string>();
  for (const g of live) {
    if (mine.has(g.key) || g.kind === 'building') continue;
    const h = computeHeights(g.tags);
    if (!spans.some((s) => h.min < s.top - 1e-3 && s.min < h.top - 1e-3)) apart.add(g.key);
  }
  return apart;
}

/**
 * Узлы, которые едут при плановом преобразовании fn объектов features «с соседями»: все наши и чужие на наших
 * сторонах или у углов. Узел → новые координаты (уровни — потом, в levelSafeEdits).
 */
export function glueMoves(features: Feature3D[], live: Feature3D[], fn: (c: LonLat) => LonLat, toLocal: (c: LonLat) => Pt): Map<number, LonLat> {
  const mine = new Set(features.map((f) => f.key));
  const moves = new Map<number, LonLat>();
  const sides: [Pt, Pt][] = [];
  for (const f of features) for (const [ring, ids] of featureRings(f)) ids?.forEach((id, k) => {
    moves.set(id, fn(ring[k]));
    sides.push([toLocal(ring[k]), toLocal(ring[(k + 1) % ring.length])]);
  });
  for (const g of live) {
    if (mine.has(g.key)) continue;
    for (const [ring, ids] of featureRings(g)) ids?.forEach((id, k) => {
      if (moves.has(id)) return;
      const [px, py] = toLocal(ring[k]);
      for (const [a, b] of sides) {
        const ex = b[0] - a[0], ey = b[1] - a[1], len = Math.hypot(ex, ey);
        if (len < 1e-6) continue;
        // На стороне или у её конца (почти совпадающий угол соседа): преобразование одно на всех — fn своей точки
        const t = Math.min(1, Math.max(0, ((px - a[0]) * ex + (py - a[1]) * ey) / (len * len)));
        if (Math.hypot(px - a[0] - t * ex, py - a[1] - t * ey) >= ON_SIDE_M) continue;
        moves.set(id, fn(ring[k]));
        break;
      }
    });
  }
  return moves;
}

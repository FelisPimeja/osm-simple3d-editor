import { computeHeights } from './heights';
import { pointInRing, type Feature3D, type LonLat } from './model';

/**
 * Висящая часть: без min_height и building:min_level (значит, от земли), а в плане целиком внутри другой части,
 * которая начинается выше земли и ниже её верха. Выходит столб от земли, проходящий сквозь висящий объём, —
 * в зданиях так почти не бывает, это забытый min_height (кокошники и главки на ярусе, relation/3224486).
 */
export interface Floating {
  /** Низ самой низкой из охватывающих частей: ниже него в режиме этажей части нет. */
  lift: number;
  /** Верх самой высокой из охватывающих частей не выше верха этой — вероятный min_height. */
  seat: number;
  /** Охватывающая часть с этим верхом. */
  on: string;
}

/** Охватывающая часть должна начинаться хотя бы на столько выше земли и ниже верха висящей, м. */
const GAP = 0.5;
/** Пробные точки — вершины, сдвинутые к центру на эту долю (общие с охватывающей частью узлы — на её границе). */
const SHRINK = 0.02;
/**
 * Карниз/пояс: охватывающая часть не толще этого, м. Если все висящие охватывающие — такие тонкие плиты, а часть
 * выходит выше них, это стена от земли, проходящая сквозь карнизы (relation/3224486), а не забытый min_height.
 */
const SLAB = 1.5;

/** Висящие части среди features: ключ → куда её посадить. Сравнение в lon/lat: «точка в контуре» от масштаба не зависит. */
export function floatingParts(features: Feature3D[]): Map<string, Floating> {
  const parts = features.filter((f) => f.kind === 'part' && f.polygons.length).map((f) => {
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const p of f.polygons) for (const [x, y] of p.outer) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }
    return { f, h: computeHeights(f.tags), w, s, e, n };
  });
  const inside = (f: Feature3D, c: LonLat) => f.polygons.some((q) => pointInRing(c, q.outer) && !q.inners.some((r) => pointInRing(c, r)));
  const out = new Map<string, Floating>();
  // Низ с учётом уже найденных висящих: гребень внутри висящего гребня — тоже висит (повторяем до неподвижной точки)
  const minOf = (e: (typeof parts)[number]) => out.get(e.f.key)?.lift ?? e.h.min;
  const around = new Map(parts.map((p) => [p, [] as typeof parts]));
  for (const p of parts) {
    const t = p.f.tags;
    if (t.min_height !== undefined || t['building:min_level'] !== undefined || t['building:part'] === 'roof') continue;
    const probes: LonLat[] = p.f.polygons.flatMap((q) => {
      const ring = q.outer.length > 1 && q.outer[0][0] === q.outer.at(-1)![0] && q.outer[0][1] === q.outer.at(-1)![1] ? q.outer.slice(0, -1) : q.outer;
      const cx = ring.reduce((a, v) => a + v[0], 0) / ring.length, cy = ring.reduce((a, v) => a + v[1], 0) / ring.length;
      return ring.map(([x, y]): LonLat => [x + (cx - x) * SHRINK, y + (cy - y) * SHRINK]);
    });
    if (!probes.length) continue;
    around.set(p, parts.filter((e) => e !== p && e.f.tags['building:part'] !== 'roof'
      && e.w <= p.w && e.e >= p.e && e.s <= p.s && e.n >= p.n && probes.every((c) => inside(e.f, c))));
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const p of parts) {
      const near = around.get(p)!;
      if (out.has(p.f.key) || !near.length) continue;
      const hanging = near.filter((e) => minOf(e) >= GAP && minOf(e) < p.h.top - GAP);
      if (!hanging.length) continue;
      if (near.some((e) => minOf(e) < GAP)) {
        // Внутри части от земли — обычная башня внутри основания. Кроме случая, когда охватывающие части сплошь,
        // без просвета, закрывают её от земли до низа толстой висящей (кокошники на шатре над основанием): видна
        // только верхушка, а низ — забытый min_height
        const top = hanging.filter((e) => e.h.top - minOf(e) > SLAB).reduce((m, e) => Math.max(m, minOf(e)), -Infinity);
        let reach = 0;
        for (const e of [...near].sort((a, b) => minOf(a) - minOf(b))) if (minOf(e) <= reach + 0.01 && minOf(e) < top) reach = Math.max(reach, e.h.top);
        if (!(reach >= top - 0.01)) continue;
      } else if (hanging.every((e) => e.h.top - e.h.min <= SLAB && e.h.top < p.h.top)) continue;
      const lift = Math.min(...hanging.map(minOf));
      // Опора — не соседний ярус кокошников (такая же часть от земли выше низа висящих): её саму ещё посадят
      const seats = near.filter((e) => e.h.top <= p.h.top + 0.01 && !out.has(e.f.key)
        && !(e.f.tags.min_height === undefined && e.h.min < GAP && e.h.top > lift));
      const seat = seats.length ? seats.reduce((a, e) => (e.h.top > a.h.top ? e : a)) : undefined;
      out.set(p.f.key, seat ? { lift, seat: seat.h.top, on: seat.f.key } : { lift, seat: lift, on: hanging.find((e) => minOf(e) === lift)!.f.key });
      changed = true;
    }
  }
  return out;
}

/**
 * Узлы участка стены, который этаж забирает себе: от узлов anchors в обе стороны по кольцам этажа, пока узлы общие с
 * другими этажами (shared). Узел pinned (своя точка этажа) участок обрывает: он остаётся на месте вместе с точкой.
 */
export function levelDetachNodes(rings: { ids: number[]; closed: boolean }[], anchors: number[], shared: ReadonlySet<number>, pinned: ReadonlySet<number>): Set<number> {
  const out = new Set<number>();
  const usable = (id: number) => shared.has(id) && !pinned.has(id);
  for (const { ids, closed } of rings) {
    const n = ids.length;
    ids.forEach((id, start) => {
      if (!anchors.includes(id) || !usable(id)) return;
      out.add(id);
      for (const step of [1, -1]) for (let k = 1; k < n; k++) {
        const i = start + step * k;
        if (!closed && (i < 0 || i >= n)) break;
        const next = ids[(i + n) % n];
        if (!usable(next) || (out.has(next) && !anchors.includes(next))) break;
        out.add(next);
      }
    });
  }
  return out;
}

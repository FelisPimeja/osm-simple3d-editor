import { pointInRing, type IndoorFeature, type LonLat } from '../osm/model';

/** Связь по геометрии: сохраняется даже после рассогласования level оси и контура. */
export function escalatorAreaMatches(axis: IndoorFeature, area: IndoorFeature): boolean {
  if (!axis.escalator || area.line || !area.polygons.length
    || !isStairsAreaTags(area.tags)) return false;
  const line = axis.polygons[0]?.outer ?? [];
  return line.slice(1).some((b, i) => {
    const a = line[i], mid: LonLat = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    return area.polygons.some((p) => pointInRing(mid, p.outer) && !p.inners.some((h) => pointInRing(mid, h)));
  });
}

type TagsEdit = { key: string; tags: Record<string, string> };
/** Дополнить изменение уровня оси тегами связанных контуров, сохранив остальные теги. */
export function syncEscalatorLevels(edits: TagsEdit[], indoor: IndoorFeature[], force = false): TagsEdit[] {
  const out = new Map(edits.map((e) => [e.key, e]));
  for (const edit of edits) {
    const axis = indoor.find((f) => f.key === edit.key && f.escalator);
    if (!axis || (!force && axis.tags.level === edit.tags.level)) continue;
    for (const area of indoor) {
      if (!escalatorAreaMatches(axis, area)) continue;
      const tags = { ...(out.get(area.key)?.tags ?? area.tags) };
      if (edit.tags.level?.trim()) tags.level = edit.tags.level.trim(); else delete tags.level;
      out.set(area.key, { key: area.key, tags });
    }
  }
  return [...out.values()];
}

/** Теги площади лестницы/эскалатора. */
export const isStairsAreaTags = (t: Record<string, string>) => t.room === 'stairs' || t.stairs === 'yes' || !!t.conveying
  || t.highway === 'steps' || t['area:highway'] === 'steps';

const sameLevels = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => v === b[i]);
/**
 * Контур площади лестницы для модели: площадь с тегами лестницы, те же этажи, линия проходит через неё
 * от стороны до стороны (концы на контуре, середина внутри), и других лестниц в ней нет.
 */
export function stairsOutline(axis: IndoorFeature, all: IndoorFeature[]): LonLat[] | undefined {
  const line = axis.polygons[0]?.outer;
  if (!axis.stairs || !line || line.length < 2) return;
  const a = line[0], b = line[line.length - 1];
  const kx = Math.cos(a[1] * Math.PI / 180) * 111320, ky = 111320;
  const nearRing = (p: LonLat, ring: LonLat[], tol: number) => ring.some((q, i) => {
    const r = ring[(i + 1) % ring.length];
    const ux = (r[0] - q[0]) * kx, uy = (r[1] - q[1]) * ky, px = (p[0] - q[0]) * kx, py = (p[1] - q[1]) * ky;
    const l2 = ux * ux + uy * uy, t = l2 ? Math.max(0, Math.min(1, (px * ux + py * uy) / l2)) : 0;
    return Math.hypot(px - ux * t, py - uy * t) <= tol;
  });
  const inside = (p: LonLat, poly: IndoorFeature['polygons'][number]) => pointInRing(p, poly.outer) && !poly.inners.some((h) => pointInRing(p, h));
  const crosses = (l: LonLat[], poly: IndoorFeature['polygons'][number]) => {
    const s = l[0], e = l[l.length - 1], mid: LonLat = [(s[0] + e[0]) / 2, (s[1] + e[1]) / 2];
    return inside(mid, poly) && nearRing(s, poly.outer, 0.4) && nearRing(e, poly.outer, 0.4);
  };
  for (const area of all) {
    if (area.line || area.point || area.polygons.length !== 1 || area.polygons[0].inners.length || !isStairsAreaTags(area.tags)) continue;
    if (!sameLevels(area.levels, axis.levels) || !crosses(line, area.polygons[0])) continue;
    const others = all.filter((f) => f.stairs && f.key !== axis.key && f.polygons[0]?.outer.length >= 2
      && (() => { const o = f.polygons[0].outer, m: LonLat = [(o[0][0] + o[o.length - 1][0]) / 2, (o[0][1] + o[o.length - 1][1]) / 2]; return inside(m, area.polygons[0]); })());
    if (others.length) return;
    return area.polygons[0].outer;
  }
}

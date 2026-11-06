import polygonClipping from 'polygon-clipping';
import { pointInRing, type IndoorFeature, type LonLat } from '../osm/model';
import { isStairsAreaTags, pairedArea } from './stairs-pair';

/**
 * Полигон area — пара оси axis (единое правило pairedArea). anyLevels — по геометрии и тегам без level: связь
 * сохраняется после рассогласования level оси и контура.
 */
export function escalatorAreaMatches(axis: IndoorFeature, area: IndoorFeature, all: IndoorFeature[], anyLevels = false): boolean {
  return pairedArea(axis, all, anyLevels)?.key === area.key;
}

type TagsEdit = { key: string; tags: Record<string, string> };
/** Дополнить изменение уровня оси тегами связанных контуров, сохранив остальные теги. */
export function syncEscalatorLevels(edits: TagsEdit[], indoor: IndoorFeature[], force = false): TagsEdit[] {
  const out = new Map(edits.map((e) => [e.key, e]));
  for (const edit of edits) {
    const axis = indoor.find((f) => f.key === edit.key && f.escalator);
    if (!axis || (!force && axis.tags.level === edit.tags.level)) continue;
    for (const area of indoor) {
      if (!escalatorAreaMatches(axis, area, indoor, true)) continue;
      const tags = { ...(out.get(area.key)?.tags ?? area.tags) };
      if (edit.tags.level?.trim()) tags.level = edit.tags.level.trim(); else delete tags.level;
      out.set(area.key, { key: area.key, tags });
    }
  }
  return [...out.values()];
}

export { isStairsAreaTags } from './stairs-pair';

/** Контур площади лестницы для модели: полигон пары оси (pairedArea, docs/indoor-stairs.md). */
export function stairsOutline(axis: IndoorFeature, all: IndoorFeature[]): LonLat[] | undefined {
  return axis.stairs ? pairedArea(axis, all)?.polygons[0].outer : undefined;
}

/**
 * Марш без своей площади: прямоугольник ширины width по линии, обрезанный помещениями (room/corridor) её этажей,
 * в которых лежит середина линии, — иначе у стены марш уходит в неё и просвечивает с другой стороны.
 */
export function stairsRoomClip(axis: IndoorFeature, all: IndoorFeature[], width: number): LonLat[] | undefined {
  const line = axis.polygons[0]?.outer;
  if (!axis.stairs || !line || line.length < 2) return;
  const o = line[0], kx = Math.cos(o[1] * Math.PI / 180) * 111320, ky = 111320;
  const to = (p: LonLat): [number, number] => [(p[0] - o[0]) * kx, (p[1] - o[1]) * ky];
  const back = (p: number[]): LonLat => [o[0] + p[0] / kx, o[1] + p[1] / ky];
  const a = to(line[0]), b = to(line[line.length - 1]), L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (L < 1e-3) return;
  const nx = -(b[1] - a[1]) / L * width / 2, ny = (b[0] - a[0]) / L * width / 2;
  const mid: LonLat = [(line[0][0] + line[line.length - 1][0]) / 2, (line[0][1] + line[line.length - 1][1]) / 2];
  const rooms = all.filter((f) => !f.line && !f.point && (f.kind === 'room' || f.kind === 'corridor') && !isStairsAreaTags(f.tags)
    && f.levels.some((l) => axis.levels.includes(l))
    && f.polygons.some((p) => pointInRing(mid, p.outer) && !p.inners.some((h) => pointInRing(mid, h))));
  if (!rooms.length) return;
  type Geom = [number, number][][][];
  let cur: Geom = [[[[a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny], [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny], [a[0] + nx, a[1] + ny]]]];
  try {
    for (const r of rooms) cur = polygonClipping.intersection(cur, r.polygons.map((p) => [p.outer, ...p.inners].map((ring) => [...ring.map(to), to(ring[0])]))) as Geom;
  } catch { return; }
  const m = to(mid);
  const best = cur.find((poly) => pointInRing(m as LonLat, poly[0] as LonLat[])) ?? cur[0];
  return best?.[0].slice(0, -1).map(back);
}

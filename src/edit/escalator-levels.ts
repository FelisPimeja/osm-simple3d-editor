import { pointInRing, type IndoorFeature, type LonLat } from '../osm/model';

/** Связь по геометрии: сохраняется даже после рассогласования level оси и контура. */
export function escalatorAreaMatches(axis: IndoorFeature, area: IndoorFeature): boolean {
  if (!axis.escalator || area.line || !area.polygons.length
    || !(area.tags.room === 'stairs' || area.tags.stairs === 'yes' || area.tags.conveying)) return false;
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

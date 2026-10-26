import type { OsmElement } from './api';
import type { BuildingGroup, ParseResult } from './model';

/** A loaded relation member need not be a renderable building volume (e.g. roof lines or a courtyard). */
export function buildingRefreshMembers(group: BuildingGroup, parsed: ParseResult, elements: OsmElement[]) {
  const loaded = new Map(elements.map((e) => [`${e.type}/${e.id}`, e]));
  const missing = group.members.filter((key) => !loaded.has(key));
  if (missing.length) throw new Error(`OSM: missing relation members: ${missing.join(', ')}`);
  const features = parsed.features.filter((f) => group.members.includes(f.key));
  const rendered = new Set(features.map((f) => f.key));
  const unrendered = [...new Set(group.members)].filter((key) => !rendered.has(key)).map((key) => {
    const element = loaded.get(key)!;
    return { key, role: group.roles[group.members.indexOf(key)] ?? '',
      type: element.tags?.type, reason: parsed.skipped.find((f) => f.key === key)?.reason };
  });
  return { features, unrendered };
}

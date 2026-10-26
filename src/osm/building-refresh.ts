import type { EditSession } from '../edit/session';
import type { OsmElement } from './api';
import type { BuildingGroup, Feature3D, ParseResult } from './model';

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

/** Update tracked copies independently of whether the tile cache already contains this API response. */
export function refreshBuildingFeatures(session: EditSession, features: Feature3D[]) {
  for (const f of features) if (session.has(f.key)) session.refresh({ ...f, tags: { ...f.tags },
    ...(f.ways ? { relMembers: f.ways.map((w) => ({ type: 'way' as const, ref: w.id, role: w.role })) } : {}) });
}

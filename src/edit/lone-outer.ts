import type { OsmMember } from '../osm/api';

type Tags = Record<string, string>;

/** Мультиполигон без дыр из одного внешнего пути — путь, который может нести теги сам; иначе undefined. */
export function loneOuterWay(tags: Tags, members: OsmMember[] | undefined): string | undefined {
  if (tags.type !== 'multipolygon' || members?.length !== 1) return undefined;
  const [m] = members;
  return m.type === 'way' && m.role === 'outer' ? `way/${m.ref}` : undefined;
}

/** Теги отношения для пути: type относится к самому отношению. */
export function wayTagsOf(tags: Tags): Tags {
  const { type: _, ...rest } = tags;
  return rest;
}

/** Состав родителя: отношение заменено своим путём с той же ролью. */
export function replaceMember(members: OsmMember[], relationId: number, wayId: number): OsmMember[] {
  return members.map((m) => (m.type === 'relation' && m.ref === relationId ? { type: 'way', ref: wayId, role: m.role } : m));
}

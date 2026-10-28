import type { IndoorFeature, LonLat } from '../osm/model';
/** Closed line walls have a filled cap and are polygonal for union purposes. */
export const isClosedIndoorWall = (f: IndoorFeature) => f.kind === 'wall' && !!f.line && f.polygons.length === 1
  && !!f.polygons[0].outerIds && f.polygons[0].outerIds.length >= 4
  && f.polygons[0].outerIds[0] === f.polygons[0].outerIds.at(-1);
export const isIndoorUnionPolygon = (f: IndoorFeature) => (!f.line || isClosedIndoorWall(f)) && !f.point && !f.escalator && !f.escalatorArea && !f.key.endsWith('#poi')
  && ['room', 'area', 'corridor', 'level', 'wall'].includes(f.kind);
export function indoorUnionSignature(f: IndoorFeature): string {
  const keys = ['indoor', 'room', 'level', 'repeat_on', ...(f.kind === 'wall' ? ['height', 'min_height', 'min_level'] : [])];
  return JSON.stringify(keys.map(k => f.tags[k] ?? ''));
}

/** Preserve a line wall's closed node list in the edit session and upload payload. */
export function indoorUnionGeometry(keep: IndoorFeature, ring: {p: LonLat; id: number}[]) {
  const nodes = keep.line ? [...ring, ring[0]] : ring;
  const outer = nodes.map(q => q.p), outerIds = nodes.map(q => q.id);
  return { polygons: [{ outer, outerIds, inners: [], innerIds: [] }],
    ...(keep.line ? { line: { ids: outerIds, coords: outer } } : {}) };
}

/** Keep the largest original way as the outer member; move its tags onto a new relation. */
export function indoorUnionHoleEdits(keep: IndoorFeature, tags: Record<string,string>, rings: {p: LonLat; id: number}[][], nextId: () => number) {
  const polygons = [{ outer: rings[0].map(n=>n.p), outerIds: rings[0].map(n=>n.id),
    inners: rings.slice(1).map(r=>r.map(n=>n.p)), innerIds: rings.slice(1).map(r=>r.map(n=>n.id)) }];
  const members = [{type:'way' as const,ref:Number(keep.key.split('/')[1]),role:'outer'}];
  const closed = (r: typeof rings[number]) => ({ids:[...r.map(n=>n.id),r[0].id],coords:[...r.map(n=>n.p),r[0].p]});
  const edits: import('./session').ObjectEdit[] = [{key:keep.key,tags:{},polygons:[],line:closed(rings[0])}];
  for (const r of rings.slice(1)) {
    const id=nextId(),key=`way/${id}`;
    edits.push({key,create:{key,version:0,tags:{},line:closed(r)}});
    members.push({type:'way',ref:id,role:'inner'});
  }
  const key=`relation/${nextId()}`;
  const relationTags={...tags,type:'multipolygon'};
  edits.push({key,create:{key,version:0,tags:relationTags,polygons,relMembers:members}});
  return {key,edits,feature:{...keep,key,line:false,polygons,tags:relationTags}};
}

/** Floor Split edits occupied polygons, including closed line walls, rather than the void below them. */
export const isIndoorCutPolygon = (f: IndoorFeature) => isIndoorUnionPolygon(f) && f.kind !== 'level';

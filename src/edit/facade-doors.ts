import type { Feature3D, IndoorFeature, LonLat } from '../osm/model';
import { parseLevels } from '../osm/model';
/** Entrances without level=* still belong to the ground-floor plan. Explicit indoor data wins. */
export function addFacadeDoors(all: Map<string,IndoorFeature>, features: Feature3D[]) {
  for (const f of features) {
    const tagsById = new Map((f.entrances ?? []).filter(e => e.tags.entrance && e.tags.entrance !== 'no').map(e=>[e.id,e.tags]));
    for (const p of f.polygons) for (const [ring,ids] of [[p.outer,p.outerIds],...p.inners.map((r,i)=>[r,p.innerIds?.[i]] as const)] as [LonLat[],number[]|undefined][]) {
      ids?.forEach((id,i)=>{
        const key=`node/${id}`,tags=tagsById.get(id);
        if (!tags || all.has(key)) return;
        const levels=[...new Set([...parseLevels(tags.level),...parseLevels(tags.repeat_on)])];
        all.set(key,{key,tags,kind:'poi',point:ring[i],polygons:[],levels:levels.length?levels:[0]});
      });
    }
  }
}

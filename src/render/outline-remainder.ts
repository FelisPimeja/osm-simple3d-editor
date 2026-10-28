import pc, {type MultiPolygon} from 'polygon-clipping';
import {pointInRing, pointOnSurface, isOutlinePart, type Feature3D, type Polygon} from '../osm/model';
import {computeHeights} from '../osm/heights';

/** Render-only footprint: retain OSM geometry and node IDs for selection and editing. */
export function outlineRemainders(features: Feature3D[]): Map<string, Polygon[]> {
  const result=new Map<string,Polygon[]>();
  const parts=features.filter(f=>f.kind==='part'&&computeHeights(f.tags).source!=='default');
  const clip=(ps:Polygon[]):MultiPolygon=>ps.map(p=>[p.outer,...p.inners].map(r=>[...r,r[0]]));
  for(const f of features){
    if(f.kind!=='building'||f.hasParts||isOutlinePart(f.tags))continue;
    const h=computeHeights(f.tags);
    const cutters=parts.filter(p=>{
      const ph=computeHeights(p.tags);
      return ph.min<=h.min+.5&&ph.min<h.top-1&&p.polygons.some(poly=>{
        const c=pointOnSurface(poly);
        return f.polygons.some(o=>pointInRing(c,o.outer)&&!o.inners.some(r=>pointInRing(c,r)));
      });
    }).flatMap(p=>clip(p.polygons));
    if(!cutters.length)continue;
    try{
      const rest=pc.difference(clip(f.polygons),...cutters);
      result.set(f.key,rest.map(([outer,...holes])=>({outer:outer.slice(0,-1),inners:holes.map(r=>r.slice(0,-1))})));
    }catch(err){console.warn('[outline-remainder]',f.key,err);}
  }
  return result;
}

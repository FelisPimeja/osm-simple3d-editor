import type {IndoorFeature,LonLat} from '../osm/model';
/** All editable wall boundaries; an open wall never gains an imaginary closing edge. */
export function pointWallRings(f:IndoorFeature){
 if(f.point||f.escalator||f.escalatorArea||!['wall','room','corridor','area','level'].includes(f.kind))return [];
 return f.polygons.flatMap((p,polygon)=>[p.outer,...p.inners].flatMap((coords,ring)=>{
  const ids=ring?p.innerIds?.[ring-1]:p.outerIds;
  return ids?.length===coords.length?[{polygon,ring,coords,ids,edges:f.line?coords.length-1:coords.length}]:[];
 }));
}
export function insertWallPoint(f:IndoorFeature,sides:{polygon:number;ring:number;edge:number}[],at:LonLat,id:number){
 const polygons=f.polygons.map((p,polygon)=>{
  const rings=[p.outer,...p.inners].map((coords,ring)=>{
   const ids=ring?p.innerIds?.[ring-1]:p.outerIds;
   if(!ids)throw new Error('Missing wall node IDs');
   const c=[...coords],ii=[...ids];
   for(const edge of [...new Set(sides.filter(s=>s.polygon===polygon&&s.ring===ring).map(s=>s.edge))].sort((a,b)=>b-a)){
    c.splice(edge+1,0,at);ii.splice(edge+1,0,id);
   }
   return {coords:c,ids:ii};
  });
  return {...p,outer:rings[0].coords,outerIds:rings[0].ids,inners:rings.slice(1).map(r=>r.coords),innerIds:rings.slice(1).map(r=>r.ids)};
 });
 return {polygons,...(f.line?{line:{coords:polygons[0].outer,ids:polygons[0].outerIds}}:{})};
}

import type {Feature3D,Entrance} from '../osm/model';
/** Session objects need not carry entrance metadata; retain the loaded node tags. */
export function withEntranceTags(f:Feature3D, nodeTags:Map<number,Record<string,string>>, data:Map<number,Record<string,string>>, fallback:Entrance[]=f.entrances??[]):Feature3D {
 const source=new Map(fallback.map(e=>[e.id,e.tags]));
 const out=new Map<number,Record<string,string>>();
 for(const p of f.polygons)for(const id of [...p.outerIds??[],...(p.innerIds??[]).flat()]){
  const tags=nodeTags.get(id)??data.get(id)??source.get(id);
  if(tags?.entrance)out.set(id,tags);
 }
 const was=f.entrances??[];
 if(was.length===out.size&&was.every(e=>out.get(e.id)===e.tags))return f;
 return {...f,entrances:out.size?[...out].map(([id,tags])=>({id,tags})):undefined};
}

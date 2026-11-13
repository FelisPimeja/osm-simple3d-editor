import type {Feature3D,Entrance} from '../osm/model';
/** Как entranceOf в osm/model (модуль без импортов — его грузят тесты в node): въезд на парковку — тоже вход. */
const entranceOf=(t?:Record<string,string>)=>t?.entrance??(t?.amenity==='parking_entrance'?'garage':undefined);
/** Session objects need not carry entrance metadata; retain the loaded node tags. */
export function withEntranceTags(f:Feature3D, nodeTags:Map<number,Record<string,string>>, data:Map<number,Record<string,string>>, fallback:Entrance[]=f.entrances??[]):Feature3D {
 const source=new Map(fallback.map(e=>[e.id,e.tags]));
 const out=new Map<number,Record<string,string>>();
 for(const p of f.polygons)for(const id of [...p.outerIds??[],...(p.innerIds??[]).flat()]){
  const tags=nodeTags.get(id)??data.get(id)??source.get(id);
  if(tags&&entranceOf(tags))out.set(id,tags);
 }
 // Входы на стене (не узлы контура) — по точке; теги — с правками
 const wall=fallback.filter(e=>e.at&&!out.has(e.id)).flatMap(e=>{const tags=nodeTags.get(e.id)??data.get(e.id)??e.tags;return entranceOf(tags)?[{...e,tags}]:[];});
 const was=f.entrances??[];
 if(was.length===out.size+wall.length&&was.every(e=>e.at?wall.some(w=>w.id===e.id&&w.tags===e.tags):out.get(e.id)===e.tags))return f;
 const all=[...[...out].map(([id,tags])=>({id,tags})),...wall];
 return {...f,entrances:all.length?all:undefined};
}

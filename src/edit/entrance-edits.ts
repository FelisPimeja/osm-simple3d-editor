import type {Feature3D,Entrance} from '../osm/model';
/** Как facadeEntranceOf в osm/model (модуль без импортов — его грузят тесты в node): въезд на парковку и indoor=door на стене — тоже вход. */
const entranceOf=(t?:Record<string,string>)=>t?.entrance??(t?.amenity==='parking_entrance'?'garage':t?.indoor==='door'?'yes':undefined);
/** Как isWallWindow в osm/model: окно в стене — window=*, кроме no и skylight, и не вход (window=yes на входе — дверь со стеклом). */
const isWallWindow=(t?:Record<string,string>)=>!!t?.window&&t.window!=='no'&&t.window!=='skylight'&&!entranceOf(t);
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
 // Окна по тегам (window=* на узлах контура) — тоже с правками сессии: форма, размеры, снятые и новые окна
 const winSource=new Map((f.windows??[]).map(e=>[e.id,e.tags]));
 const wins=new Map<number,Record<string,string>>();
 for(const p of f.polygons)for(const id of [...p.outerIds??[],...(p.innerIds??[]).flat()]){
  const tags=nodeTags.get(id)??winSource.get(id);
  if(tags&&isWallWindow(tags))wins.set(id,tags);
 }
 const wasW=f.windows??[];
 const sameW=wasW.length===wins.size&&wasW.every(e=>wins.get(e.id)===e.tags);
 const was=f.entrances??[];
 const sameE=was.length===out.size+wall.length&&was.every(e=>e.at?wall.some(w=>w.id===e.id&&w.tags===e.tags):out.get(e.id)===e.tags);
 if(sameE&&sameW)return f;
 const all=[...[...out].map(([id,tags])=>({id,tags})),...wall];
 const windows=[...wins].map(([id,tags])=>({id,tags}));
 return {...f,entrances:all.length?all:undefined,windows:windows.length?windows:undefined};
}

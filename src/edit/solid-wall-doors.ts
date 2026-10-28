import { tr } from '../i18n';
import pc from 'polygon-clipping';
import { parseLevels, type IndoorFeature, type IndoorKind, type LonLat } from '../osm/model';
import type { ObjectEdit } from './session';
type Pt = [number,number];
export type WallPolygon = Pt[][];
export const solidWall = (f: IndoorFeature) => f.kind === 'wall' && !f.point && f.polygons.length > 0 && f.polygons.every(p=>p.outer.length>=3) && (!f.line || f.polygons.every(p => !!p.outerIds && p.outerIds.length >= 4 && p.outerIds[0] === p.outerIds.at(-1)));
const cross=(a:Pt,b:Pt)=>a[0]*b[1]-a[1]*b[0];
const sub=(a:Pt,b:Pt):Pt=>[a[0]-b[0],a[1]-b[1]];
const plus=(a:Pt,b:Pt,t=1):Pt=>[a[0]+b[0]*t,a[1]+b[1]*t];
const dot=(a:Pt,b:Pt)=>a[0]*b[0]+a[1]*b[1];
export function wallLocalPolygons(f: IndoorFeature,local:(p:LonLat)=>Pt):WallPolygon[] {
 return f.polygons.map(p=>[p.outer,...p.inners].map(r=>{
  const q=r.map(local);if (q.length>1&&Math.hypot(...sub(q[0],q.at(-1)!))<1e-6) q.pop();return [...q,q[0]];
 }));
}
const insideRing=(p:Pt,r:Pt[])=>{
 let yes=false;
 for(let i=0,j=r.length-1;i<r.length;j=i++){
  const a=r[i],b=r[j];
  if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0]) yes=!yes;
 }return yes;
};
const inside=(p:Pt,polys:WallPolygon[])=>polys.some(poly=>insideRing(p,poly[0])&&!poly.slice(1).some(r=>insideRing(p,r)));
/** The jambs follow the normal of the clicked face, including tapered walls. */
export function cutSolidWall(polys:WallPolygon[],at:Pt,face:[Pt,Pt],width:number) {
 if(!Number.isFinite(width)||width<=0) throw new Error(tr('Ширина двери должна быть положительным числом.'));
 const v=sub(face[1],face[0]),length=Math.hypot(...v);
 if(length<1e-6) throw new Error(tr('Грань стены имеет нулевую длину.'));
 const tangent:Pt=[v[0]/length,v[1]/length];
 const t=dot(sub(at,face[0]),tangent);
 if(t<width/2+0.005||t>length-width/2-0.005) throw new Error(tr('Для проёма не хватает места на выбранной грани стены.'));
 // Match the centimetre-tolerant straight face recovered from rounded OSM nodes.
 // The cut and its connector must use exactly the same front boundary.
 polys=polys.map(poly=>poly.map(r=>r.map(p=>{
  const along=dot(sub(p,face[0]),tangent),distance=Math.abs(cross(sub(p,face[0]),tangent));
  return along>=-1e-6&&along<=length+1e-6&&distance<0.01?plus(face[0],tangent,along):p;
 })));
 const center=plus(face[0],tangent,t),a=plus(center,tangent,-width/2),b=plus(center,tangent,width/2);
 let normal:Pt=[-tangent[1],tangent[0]];
 if(!inside(plus(center,normal,0.005),polys)) normal=[-normal[0],-normal[1]];
 if(!inside(plus(center,normal,0.005),polys)) throw new Error(tr('Дверь не находится на грани полигональной стены.'));
 const reach=(p:Pt)=>{
  let best=Infinity;
  for(const poly of polys) for(const r of poly) for(let i=0;i+1<r.length;i++){
   const d=sub(r[i+1],r[i]),den=cross(normal,d);
   if(Math.abs(den)<1e-9) continue;
   const t=cross(sub(r[i],p),d)/den,u=cross(sub(r[i],p),normal)/den;
   if(t>0.001&&u>=-1e-7&&u<=1+1e-7) best=Math.min(best,t);
  }
  if(!Number.isFinite(best)) throw new Error(tr('Не удалось найти противоположную грань стены.'));
  return best;
 };
 const da=reach(a),db=reach(b),backA=plus(a,normal,da),backB=plus(b,normal,db);
 const gap=[a,b,backB,backA,a];
 // Extend a millimetre through the boundary to avoid numeric slivers in clipping.
 const cutter=[[plus(a,normal,-0.001),plus(b,normal,-0.001),plus(b,normal,db+0.001),plus(a,normal,da+0.001),plus(a,normal,-0.001)]];
 const pieces=pc.difference(polys,cutter);
 if(!pieces.length) throw new Error(tr('Проём удаляет стену целиком — уменьшите ширину двери.'));
 return {pieces,gap,front:[a,center,b] as [Pt,Pt,Pt],normal};
}

export interface SolidDoorBinding { connector:IndoorFeature; walls:IndoorFeature[]; gap:Pt[]; face:[Pt,Pt] }
/** Recover the connection using shared OSM nodes, without private tags or session-only metadata. */
export function findSolidDoorBinding(all:IndoorFeature[],door:IndoorFeature,local:(p:LonLat)=>Pt):SolidDoorBinding|undefined {
 if(!door.point) return;
 const id=Number(door.key.split('/')[1]);
 const connectors=all.filter(f=>f.kind==='wall'&&f.line&&!solidWall(f)&&f.levels.some(l=>door.levels.includes(l)));
 for(const connector of connectors){
  if(connector.polygons.length!==1) continue;
  const p=connector.polygons[0],ids=p.outerIds;
  if(!ids||ids.length<3||ids.indexOf(id)<=0||ids.indexOf(id)>=ids.length-1) continue;
  const a=local(p.outer[0]),b=local(p.outer.at(-1)!),v=sub(b,a),len=Math.hypot(...v);
  if(len<0.01) continue;
  const tangent:Pt=[v[0]/len,v[1]/len];
  const sides=(node:number,at:Pt)=>all.filter(f=>solidWall(f)&&f.levels.some(l=>door.levels.includes(l))).flatMap(f=>f.polygons.flatMap(poly=>[poly.outer,...poly.inners].flatMap((ring,ri)=>{
   const rids=ri?poly.innerIds?.[ri-1]:poly.outerIds;if(!rids) return [];
   const count=f.line?ring.length-1:ring.length;
   const out:{f:IndoorFeature;back:Pt;direction:Pt;length:number}[]=[];
   for(let i=0;i<count;i++) if(rids[i]===node) for(const j of [(i+count-1)%count,(i+1)%count]){
    const back=local(ring[j]),d=sub(back,at),length=Math.hypot(...d);
    if(length>0.005&&Math.abs(dot(d,tangent))/length<0.02) out.push({f,back,direction:[d[0]/length,d[1]/length],length});
   }
   return out;
  })));
  for(const sa of sides(ids[0],a).sort((x,y)=>x.length-y.length)){
   const sb=sides(ids.at(-1)!,b).find(s=>dot(s.direction,sa.direction)>0.999);
   if(!sb) continue;
   return {connector,walls:[...new Map([sa.f,sb.f].map(f=>[f.key,f])).values()],gap:[a,b,sb.back,sa.back,a],face:[a,b]};
  }
 }
}
export function restoreSolidDoor(binding:SolidDoorBinding,local:(p:LonLat)=>Pt):WallPolygon[] {
 const polys=binding.walls.flatMap(f=>wallLocalPolygons(f,local));
 return pc.union(polys,[binding.gap]);
}

export function nearestSolidFace(polys:WallPolygon[],at:Pt,maxDistance=0.4):{face:[Pt,Pt];at:Pt;distance:number}|undefined {
 let best:{face:[Pt,Pt];at:Pt;distance:number}|undefined;
 for(const poly of polys) for(const raw of poly){
  let ring=raw.slice(0,-1);
  for(let again=true;again&&ring.length>3;){again=false;for(let i=0;i<ring.length;i++){
   const a=ring[(i+ring.length-1)%ring.length],b=ring[i],c=ring[(i+1)%ring.length],d=sub(c,a),l=Math.hypot(...d);
   if(l>1e-8&&Math.abs(cross(sub(b,a),d))/l<0.01){ring=ring.filter((_,j)=>j!==i);again=true;break;}
  }}
  for(let i=0;i<ring.length;i++){
   const a=ring[i],b=ring[(i+1)%ring.length],d=sub(b,a),l2=dot(d,d);
   if(l2<1e-10)continue;
   const t=Math.max(0,Math.min(1,dot(sub(at,a),d)/l2)),p=plus(a,d,t),distance=Math.hypot(...sub(at,p));
   if(distance<=maxDistance&&(!best||distance<best.distance))best={face:[a,b],at:p,distance};
  }
 }
 return best;
}

export function normalizeSolidDoorEdits(edits:ObjectEdit[]):ObjectEdit[]{
  const out=new Map<string,ObjectEdit>();
  for(const e of edits){
    const prev=out.get(e.key);
    if(prev?.create){
      if(e.delete){out.delete(e.key);continue;}
      out.set(e.key,{key:e.key,create:{...prev.create,...(e.tags?{tags:e.tags}:{}),...(e.polygons?{polygons:e.polygons}:{}),...(e.line?{line:e.line}:{}),...(e.members?{relMembers:e.members}:{})}});
    }else out.set(e.key,{...prev,...e});
  }
  return [...out.values()];
}
export function projectedOpeningIndoor(all:IndoorFeature[],edits:ObjectEdit[]):IndoorFeature[]{
  const state=new Map(all.map(f=>[f.key,f]));
  for(const e of normalizeSolidDoorEdits(edits)){
    if(e.delete){state.delete(e.key);continue;}
    const old=state.get(e.key),data=e.create??e;
    const tags=data.tags??old?.tags??{};
    if(!tags.indoor&&!tags.door&&!tags.entrance){state.delete(e.key);continue;}
    const line=data.line,polygons=line?[{outer:line.coords,outerIds:line.ids,inners:[]}]:data.polygons??old?.polygons??[];
    const point=e.key.startsWith('node/')?polygons[0]?.outer[0]??old?.point:undefined;
    state.set(e.key,{key:e.key,tags,kind:point?'poi':(tags.indoor as IndoorKind)??old?.kind??'wall',line:!!line||old?.line,polygons,point,levels:(()=>{const levels=[...new Set([...parseLevels(tags.level),...parseLevels(tags.repeat_on)])];return levels.length?levels:[0];})()});
  }
  return [...state.values()];
}

/** Extend only the room behind the opening; its front edge shares the actual door node. */
export function roomDoorway(polys:WallPolygon[],gap:Pt[],door:Pt):WallPolygon[]|undefined {
 const back:Pt=[(gap[2][0]+gap[3][0])/2,(gap[2][1]+gap[3][1])/2];
 const direction=sub(back,door),length=Math.hypot(...direction);if(length<1e-6)return;
 const probe=plus(back,direction,0.01/length);
 if(!inside(probe,polys)||inside(door,polys))return;
 // Snap the room's almost coincident rear boundary before the boolean union.
 // Otherwise independently rounded coordinates leave two disconnected polygons.
 const a=gap[3],v=sub(gap[2],a),l2=dot(v,v),l=Math.sqrt(l2);
 if(l<1e-6)return;
 const aligned=polys.map(poly=>poly.map(r=>r.map(p=>{
  const distance=cross(v,sub(p,a))/l;
  if(Math.abs(distance)>0.002)return p;
  return plus(a,v,dot(sub(p,a),v)/l2);
 })));
 const merged=pc.union(aligned,[gap]);
 if(merged.length!==polys.length||!pc.difference(merged,aligned).length)return;
 // polygon-clipping removes collinear vertices. Reinsert the door into the front edge.
 for(const poly of merged)for(const ring of poly)for(let i=0;i+1<ring.length;i++){
  const a=ring[i],b=ring[i+1],v=sub(b,a),l2=dot(v,v),t=l2?dot(sub(door,a),v)/l2:-1;
  if(t>1e-6&&t<1-1e-6&&Math.abs(cross(sub(door,a),v))/Math.sqrt(l2)<1e-6){ring.splice(i+1,0,door);break;}
 }
 return merged;
}

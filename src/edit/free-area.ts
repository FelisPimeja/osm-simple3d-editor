import pc,{type MultiPolygon} from 'polygon-clipping';
import {finiteCutPieces} from './finite-cut';
type Pt=[number,number];
const same=(a:Pt,b:Pt)=>Math.hypot(a[0]-b[0],a[1]-b[1])<.001;
/** Join shared endpoints, keeping the actual finite extent of wall boundaries. */
export function joinedWalls(lines:Pt[][]):Pt[][]{
 const chains=lines.filter(l=>l.length>1).map(l=>[...l]);
 let changed=true;
 while(changed){changed=false;
  outer:for(let i=0;i<chains.length;i++)for(let j=i+1;j<chains.length;j++){
   let a=chains[i],b=chains[j];
   if(same(a[0],a.at(-1)!)||same(b[0],b.at(-1)!))continue;
   if(same(a[0],b[0]))a=[...a].reverse();
   else if(same(a[0],b.at(-1)!)){[a,b]=[b,a];}
   else if(same(a.at(-1)!,b.at(-1)!))b=[...b].reverse();
   if(!same(a.at(-1)!,b[0]))continue;
   chains[i]=[...a,...b.slice(1)];chains.splice(j,1);changed=true;break outer;
  }
 }
 return chains;
}
/** Partition empty floor space by real walls, including walls made from several ways. Metres, closed rings. */
export function freeAreaPieces(section:MultiPolygon,occupied:MultiPolygon[],walls:Pt[][], doors:{at:Pt;width:number}[]=[]):MultiPolygon{
 const chains=joinedWalls(walls);
 const ends=chains.flatMap(path=>same(path[0],path.at(-1)!)?[]:[path[0],path.at(-1)!]);
 const bridges:Pt[][]=[];
 for(const door of doors){
  let best:{a:Pt;b:Pt;d:number}|undefined;
  for(let i=0;i<ends.length;i++)for(let j=i+1;j<ends.length;j++){
   const a=ends[i],b=ends[j],dx=b[0]-a[0],dy=b[1]-a[1],len=Math.hypot(dx,dy);
   if(len<.01||len>door.width+.2)continue;
   const t=((door.at[0]-a[0])*dx+(door.at[1]-a[1])*dy)/(len*len);
   const d=Math.abs((door.at[0]-a[0])*dy-(door.at[1]-a[1])*dx)/len;
   if(t<0||t>1||d>.03||Math.max(t,1-t)*len>door.width/2+.1)continue;
   if(!best||d<best.d)best={a,b,d};
  }
  if(best)bridges.push([best.a,best.b]);
 }
 let pieces=pc.difference(section,...occupied);
 for(const path of joinedWalls([...chains,...bridges])){
  if(same(path[0],path.at(-1)!)){
   pieces=pieces.flatMap(face=>[...pc.intersection(face,[path]),...pc.difference(face,[path])]);continue;
  }
  const unit=(a:Pt,b:Pt):Pt=>{const x=b[0]-a[0],y=b[1]-a[1],l=Math.hypot(x,y)||1;return[x/l,y/l];};
  const d0=unit(path[1],path[0]),d1=unit(path.at(-2)!,path.at(-1)!);
  const first:Pt=[path[0][0]+d0[0]*1e5,path[0][1]+d0[1]*1e5],last:Pt=[path.at(-1)![0]+d1[0]*1e5,path.at(-1)![1]+d1[1]*1e5];
  const d=unit(first,last),n:Pt=[-d[1]*1e5,d[0]*1e5];
  const side:Pt[][]=[[first,...path,last,[last[0]+n[0],last[1]+n[1]],[first[0]+n[0],first[1]+n[1]],first]];
  pieces=pieces.flatMap(face=>finiteCutPieces([...pc.intersection(face,side),...pc.difference(face,side)],path,face,false));
 }
 return pieces.flatMap(poly=>cleanPiece(poly as Pt[][],0));
}
/** Клин уже этого, м, при остром угле — шип: узкий зазор между почти совпадающими сторонами (контур этажа и грань колонны). */
const SPIKE_WIDTH=.15;
/** Угол острее этого, рад (~10°), — клин, а не угол помещения. */
const SPIKE_ANGLE=.17;
/** Вершина cur — остриё узкого клина: стороны к prev и next почти назад друг к другу, ближний конец — у дальней стороны. */
function wedge(prev:Pt,cur:Pt,next:Pt):boolean{
 const a:Pt=[prev[0]-cur[0],prev[1]-cur[1]],b:Pt=[next[0]-cur[0],next[1]-cur[1]];
 const la=Math.hypot(...a),lb=Math.hypot(...b);
 if(la<1e-9||lb<1e-9)return true;
 const angle=Math.acos(Math.max(-1,Math.min(1,(a[0]*b[0]+a[1]*b[1])/(la*lb))));
 if(angle>SPIKE_ANGLE)return false;
 // Ширина клина у его основания — расстояние ближнего конца до луча дальней стороны
 return Math.abs(a[0]*b[1]-a[1]*b[0])/Math.max(la,lb)<SPIKE_WIDTH;
}
/**
 * Closed ring without zero-width slits: a wall or door bridge that ends inside a face leaves an A→B→A spike
 * (the ring runs along the cut and back). Such a polygon becomes a wall with a self-overlapping tail.
 * Narrow wedges too: a room or column edge almost along the level outline leaves a sliver a few cm wide.
 */
export function despike(ring:Pt[]):Pt[]{
 const pts=ring.slice(0,-1);
 for(let changed=true;changed&&pts.length>=3;){
  changed=false;
  for(let i=0;i<pts.length&&pts.length>=3;i++){
   const prev=pts[(i-1+pts.length)%pts.length],cur=pts[i],next=pts[(i+1)%pts.length];
   if(same(prev,cur)){pts.splice(i,1);changed=true;break;}
   if(same(prev,next)){pts.splice(i,1);pts.splice(i%pts.length,1);changed=true;break;}
   if(wedge(prev,cur,next)){pts.splice(i,1);changed=true;break;}
  }
 }
 return pts.length>=3?[...pts,pts[0]]:[];
}

/**
 * Кольцо, касающееся само себя в вершине (два куска, сшитые в точке, — после вычитания проёма у самой стены),
 * — отдельные кольца по таким вершинам. Closed rings in, closed rings out.
 */
export function splitPinched(ring:Pt[]):Pt[][]{
 const pts=ring.slice(0,-1);
 for(let i=0;i<pts.length;i++)for(let j=i+2;j<pts.length;j++){
  if(i===0&&j===pts.length-1)continue;
  if(!same(pts[i],pts[j]))continue;
  return [...splitPinched([...pts.slice(i,j),pts[i]]),...splitPinched([...pts.slice(j),...pts.slice(0,i),pts[j]])];
 }
 return [ring];
}
const inRing=(p:Pt,r:Pt[])=>{let yes=false;for(let i=0,j=r.length-1;i<r.length;j=i++){const a=r[i],b=r[j];if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])yes=!yes;}return yes;};
const area=(r:Pt[])=>{let a=0;for(let i=0;i<r.length-1;i++)a+=r[i][0]*r[i+1][1]-r[i+1][0]*r[i][1];return Math.abs(a/2);};
/** Вершина двора ближе этого к внешнему контуру, м, — на нём: двор касается контура. */
const TOUCH=.02;
/** Ближайшая точка контура (кольцо замкнуто) к p, если ближе TOUCH. */
function onRing(p:Pt,r:Pt[]):Pt|undefined{
 let best:Pt|undefined,bd=TOUCH;
 for(let i=0;i<r.length-1;i++){
  const a=r[i],b=r[i+1],dx=b[0]-a[0],dy=b[1]-a[1],l2=dx*dx+dy*dy||1;
  const t=Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/l2)),q:Pt=[a[0]+dx*t,a[1]+dy*t];
  const d=Math.hypot(p[0]-q[0],p[1]-q[1]);
  if(d<bd){bd=d;best=q;}
 }
 return best;
}
/**
 * Кусок без шипов и сшивок: внешний контур, касающийся себя в вершине, — несколько кусков (дворы — тому, в ком
 * лежат), у колец — без узких клиньев (despike). Двор, касающийся внешнего контура (проём лестницы у самой стены),
 * — не двор, а вырез: прижат к контуру и вычтен из него (кусок может распасться). Осколки меньше minArea, м², — прочь.
 */
export function cleanPiece(poly:Pt[][],minArea=.05,depth=0):Pt[][][]{
 const outers=splitPinched(poly[0]).map(despike).filter(r=>r.length>=4&&area(r)>=minArea);
 const inners=poly.slice(1).flatMap(splitPinched).map(despike).filter(r=>r.length>=4);
 return outers.flatMap(o=>{
  const mine=inners.filter(r=>inRing(r[0],o)||r.some(p=>onRing(p,o)));
  const touching=depth<2?mine.filter(r=>r.some(p=>onRing(p,o))):[];
  if(!touching.length)return [[o,...mine]];
  const cut=touching.map(r=>r.map(p=>onRing(p,o)??p));
  let res:Pt[][][];
  try{res=pc.difference([o] as never,...cut.map(r=>[r] as never)) as unknown as Pt[][][];}catch{return [[o,...mine.filter(r=>!touching.includes(r))]];}
  const rest=mine.filter(r=>!touching.includes(r));
  return res.flatMap(q=>cleanPiece([q[0],...q.slice(1),...rest.filter(r=>inRing(r[0],q[0]))],minArea,depth+1));
 });
}

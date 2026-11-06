import pc,{type MultiPolygon} from 'polygon-clipping';
import {finiteCutPieces} from './finite-cut';
type Pt=[number,number];
const same=(a:Pt,b:Pt)=>Math.hypot(a[0]-b[0],a[1]-b[1])<.001;
/** Join shared endpoints, keeping the actual finite extent of wall boundaries. */
/**
 * Тот же порядок склейки, что и полным перебором пар (наименьший i, затем наименьший j), но партнёры ищутся по
 * сетке концов: перебор пар с перезапуском после каждой склейки — O(n³), на этаже ГУМа (relation/3330565,
 * тысячи стен-линий) клик по пустому месту висел ~20 с.
 */
export function joinedWalls(lines:Pt[][]):Pt[][]{
 const chains:(Pt[]|null)[]=lines.filter(l=>l.length>1).map(l=>[...l]);
 const CELL=.001,index=new Map<string,Set<number>>();
 const cell=(p:Pt)=>[Math.round(p[0]/CELL),Math.round(p[1]/CELL)];
 const ends=(c:Pt[])=>same(c[0],c.at(-1)!)?[]:[c[0],c.at(-1)!];
 const add=(i:number)=>{for(const p of ends(chains[i]!)){const [x,y]=cell(p),k=`${x},${y}`;(index.get(k)??index.set(k,new Set()).get(k)!).add(i);}};
 const remove=(i:number)=>{for(const p of ends(chains[i]!)){const [x,y]=cell(p);index.get(`${x},${y}`)?.delete(i);}};
 const near=(p:Pt)=>{const [x,y]=cell(p),out:number[]=[];for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)for(const j of index.get(`${x+dx},${y+dy}`)??[])out.push(j);return out;};
 /** Склейка a и b, как в переборе пар; не сходятся — undefined. */
 const join=(a:Pt[],b:Pt[]):Pt[]|undefined=>{
  if(same(a[0],a.at(-1)!)||same(b[0],b.at(-1)!))return;
  // Те же варианты в том же порядке, что и раньше, но стык в развилке пропускаем и пробуем следующий
  const ra=[...a].reverse(),rb=[...b].reverse();
  for(const [x,y] of [[ra,b],[b,a],[a,rb],[a,b]] as [Pt[],Pt[]][])
   if(same(x.at(-1)!,y[0])&&!fork(y[0]))return [...x,...y.slice(1)];
  return;
 };
 // Развилка — точка, где сходятся 3+ концов стен (Т-образный стык, кольцо с отходящей стеной): через неё цепочки
 // не склеиваем. Иначе жадная склейка могла продолжить кольцо в отходящую стену — кольцо оставалось незамкнутым,
 // и пустота внутри него сливалась с соседней (way/1454788269 + way/274827885 у узла 13341539967)
 const degree=new Map<string,number>();
 const pkey=(p:Pt)=>{const [x,y]=cell(p);return `${x},${y}`;};
 for(const c of chains)for(const p of ends(c!))degree.set(pkey(p),(degree.get(pkey(p))??0)+1);
 const fork=(p:Pt)=>{const [x,y]=cell(p);let n=0;for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)n+=degree.get(`${x+dx},${y+dy}`)??0;return n>2;};
 chains.forEach((_,i)=>add(i));
 // Склейка не даёт партнёра цепочке с меньшим номером, которой его не было (её партнёр j был бы и раньше),
 // поэтому достаточно идти по i и доклеивать к i, пока есть с кем
 for(let i=0;i<chains.length;i++){
  if(!chains[i])continue; // уже приклеена к цепочке с меньшим номером
  for(;;){
   const a=chains[i]!;
   const cands=[...new Set(ends(a).flatMap(near))].filter(j=>j>i&&chains[j]).sort((x,y)=>x-y);
   let merged:Pt[]|undefined,jj=-1;
   for(const j of cands){merged=join(a,chains[j]!);if(merged){jj=j;break;}}
   if(!merged)break;
   remove(i);remove(jj);chains[i]=merged;chains[jj]=null;add(i);
  }
 }
 // Две цепочки с общими обоими концами — кольцо, даже если концы — развилки (кольцо из стен, к узлам которого
 // подходят другие стены): склеиваем в замкнутое, иначе ни одна из двух половин сама пространство не отсекает
 for(let i=0;i<chains.length;i++){
  const a=chains[i];
  if(!a||same(a[0],a.at(-1)!))continue;
  for(let j=i+1;j<chains.length;j++){
   const b=chains[j];
   if(!b||same(b[0],b.at(-1)!))continue;
   const direct=same(a.at(-1)!,b[0])&&same(b.at(-1)!,a[0]), back=same(a.at(-1)!,b.at(-1)!)&&same(b[0],a[0]);
   if(!direct&&!back)continue;
   chains[i]=[...a,...(direct?b:[...b].reverse()).slice(1)];chains[j]=null;break;
  }
 }
 return chains.filter((c):c is Pt[]=>!!c);
}
/**
 * Разрез куска стеной: polygon-clipping иногда не может собрать кольцо («Unable to complete output ring») на почти
 * совпадающих сторонах — тогда повтор по куску, округлённому до 1 мм, а не вышло и так — кусок остаётся целым.
 * Иначе одна неудачная стена отменяла разбиение всего этажа: пустые площади не выбирались (Казанский вокзал, этаж 0).
 */
function safeCut(face:Pt[][],cut:(f:Pt[][])=>Pt[][][]):Pt[][][]{
 try{return cut(face);}catch{}
 const r=(v:number)=>Math.round(v*1000)/1000;
 try{return cut(face.map(ring=>ring.map(([x,y])=>[r(x),r(y)] as Pt)));}catch{return [face];}
}
type Box=[number,number,number,number];
const bbox=(r:Pt[]):Box=>{let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;for(const [x,y] of r){if(x<x0)x0=x;if(x>x1)x1=x;if(y<y0)y0=y;if(y>y1)y1=y;}return [x0,y0,x1,y1];};
/** Рамки не пересекаются (с запасом 1 см): стена не может разрезать кусок. */
const apart=(a:Box,b:Box)=>a[2]<b[0]-.01||b[2]<a[0]-.01||a[3]<b[1]-.01||b[3]<a[1]-.01;
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
 const all=joinedWalls([...chains,...bridges]);
 // Кольца из нескольких цепочек между развилками — грани графа стен: замкнутые контуры для разреза
 const closed=[...all.filter(p=>same(p[0],p.at(-1)!)),...wallFaces(all.filter(p=>!same(p[0],p.at(-1)!)))];
 for(const path of closed){
  const pb=bbox(path);
  pieces=pieces.flatMap(face=>apart(bbox(face[0]),pb)?[face]:safeCut(face,f=>[...pc.intersection(f,[path]),...pc.difference(f,[path])]));
 }
 // Незамкнутые цепочки — проходами, пока режется: цепочка между развилками отсекает кусок, только когда соседние
 // цепочки кольца уже прорезали его границу (кольцо из трёх цепочек между тремя развилками, way/1455469261 и др.)
 let open=all.filter(p=>!same(p[0],p.at(-1)!));
 for(let pass=0;pass<4&&open.length;pass++){
  const rest:Pt[][]=[];
  for(const path of open){
   const before=pieces.length;
   pieces=openCut(pieces,path);
   if(pieces.length===before)rest.push(path);
  }
  if(rest.length===open.length)break;
  open=rest;
 }
 return pieces.flatMap(poly=>cleanPiece(poly as Pt[][],0));
}
/** Грани больше этого числа цепочек — не помещение (обход вокруг целого квартала стен), не режем ими. */
const MAX_FACE_CHAINS=24;
/**
 * Ограниченные грани планарного графа незамкнутых цепочек стен (узлы — концы цепочек): кольцо, распавшееся на
 * несколько цепочек между развилками, где ни одна цепочка сама не касается границы куска. Висячие цепочки (отростки)
 * в обход не идут. Кольца замкнуты (последняя точка = первая).
 */
export function wallFaces(open:Pt[][]):Pt[][]{
 const key=(p:Pt)=>`${Math.round(p[0]/.001)},${Math.round(p[1]/.001)}`;
 const edges=open.filter(c=>c.length>1).map(c=>({c,a:key(c[0]),b:key(c.at(-1)!)})).filter(e=>e.a!==e.b);
 // Отростки прочь: узел, к которому подходит одна цепочка, не на кольце
 let alive=edges.map(()=>true);
 for(let changed=true;changed;){
  changed=false;
  const deg=new Map<string,number>();
  edges.forEach((e,i)=>{if(alive[i]){deg.set(e.a,(deg.get(e.a)??0)+1);deg.set(e.b,(deg.get(e.b)??0)+1);}});
  edges.forEach((e,i)=>{if(alive[i]&&((deg.get(e.a)??0)<2||(deg.get(e.b)??0)<2)){alive[i]=false;changed=true;}});
 }
 type Half={pts:Pt[];from:string;to:string;id:number};
 const halves:Half[]=[];
 edges.forEach((e,i)=>{if(!alive[i])return;halves.push({pts:e.c,from:e.a,to:e.b,id:halves.length},{pts:[...e.c].reverse(),from:e.b,to:e.a,id:halves.length+1});});
 const out=new Map<string,Half[]>();
 for(const h of halves)(out.get(h.from)??out.set(h.from,[]).get(h.from)!).push(h);
 const ang=(a:Pt,b:Pt)=>Math.atan2(b[1]-a[1],b[0]-a[0]);
 const used=new Set<number>(),faces:Pt[][]=[];
 for(const start of halves){
  if(used.has(start.id))continue;
  const ring:Pt[]=[];let h:Half|undefined=start,steps=0,ok=false;
  while(h&&steps++<=MAX_FACE_CHAINS){
   used.add(h.id);ring.push(...h.pts.slice(0,-1));
   const end=h.pts.at(-1)!,back=ang(end,h.pts.at(-2)!);
   // Следующая — ближайшая против часовой стрелки от направления назад (обход грани слева)
   let best:Half|undefined,bd=Infinity;
   for(const n of out.get(h.to)??[]){
    if(n.id===(h.id^1))continue;
    let d=ang(n.pts[0],n.pts[1])-back;while(d<=1e-9)d+=2*Math.PI;
    if(d<bd){bd=d;best=n;}
   }
   h=best;
   if(h?.id===start.id){ok=true;break;}
   if(h&&used.has(h.id))break;
  }
  if(!ok||ring.length<3)continue;
  ring.push(ring[0]);
  let a=0;for(let i=0;i<ring.length-1;i++)a+=ring[i][0]*ring[i+1][1]-ring[i+1][0]*ring[i][1];
  // Ограниченная грань при таком обходе идёт по часовой стрелке; внешняя — против
  if(a<0)faces.push(ring);
 }
 return faces;
}
/** Незамкнутая цепочка стен режет куски, в рамку которых заходит: только конечный разрез (finiteCutPieces). */
function openCut(pieces:MultiPolygon,path:Pt[]):MultiPolygon{
  {
  const unit=(a:Pt,b:Pt):Pt=>{const x=b[0]-a[0],y=b[1]-a[1],l=Math.hypot(x,y)||1;return[x/l,y/l];};
  const d0=unit(path[1],path[0]),d1=unit(path.at(-2)!,path.at(-1)!);
  const first:Pt=[path[0][0]+d0[0]*1e5,path[0][1]+d0[1]*1e5],last:Pt=[path.at(-1)![0]+d1[0]*1e5,path.at(-1)![1]+d1[1]*1e5];
  const d=unit(first,last),n:Pt=[-d[1]*1e5,d[0]*1e5];
  const side:Pt[][]=[[first,...path,last,[last[0]+n[0],last[1]+n[1]],[first[0]+n[0],first[1]+n[1]],first]];
  // Стена режет только кусок, в рамку которого заходит: остальные кладём как есть (разрез каждого куска каждой
  // стеной — секунды на большом этаже, Казанский вокзал: ~300 цепочек стен × ~100 кусков)
  const pb=bbox(path);
  return pieces.flatMap(face=>apart(bbox(face[0]),pb)?[face]:safeCut(face,f=>finiteCutPieces([...pc.intersection(f,side),...pc.difference(f,side)],path,f,false)));
 }
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

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
 return pieces;
}

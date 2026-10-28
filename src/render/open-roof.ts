/** Boundary of an opened roof; triangulation diagonals are not architectural edges. */
export function openRoofOutline(roof: ArrayLike<number>, floor: number, walls?: ArrayLike<number>): number[] {
 const edges = new Map<string,{a:number[];b:number[];count:number}>();
 const key=(p:number[])=>p.map(v=>Math.round(v*1e4)).join(',');
 for(let i=0;i+8<roof.length;i+=9){
  const p=[[roof[i],roof[i+1],roof[i+2]],[roof[i+3],roof[i+4],roof[i+5]],[roof[i+6],roof[i+7],roof[i+8]]];
  for(let j=0;j<3;j++){
   const a=p[j],b=p[(j+1)%3],k=[key(a),key(b)].sort().join('|');
   const e=edges.get(k);if(e)e.count++;else edges.set(k,{a,b,count:1});
  }
 }
 // Only exposed wall tops need a heavy edge. A roof boundary against a
 // neighbouring building is not a cut in that neighbour's wall.
 const wallEdges:number[][]=[];
 if(walls)for(let i=0;i+8<walls.length;i+=9)for(let j=0;j<3;j++){
  const a=i+j*3,b=i+((j+1)%3)*3;
  wallEdges.push([walls[a],walls[a+1],walls[a+2],walls[b],walls[b+1],walls[b+2]]);
 }
 const exposed=(a:number[],b:number[])=>!walls||wallEdges.some(e=>{
  const d=[e[3]-e[0],e[4]-e[1],e[5]-e[2]],len=d.reduce((s,v)=>s+v*v,0);
  if(len<1e-12)return false;
  const r=b.map((v,i)=>v-a[i]),dot=r.reduce((s,v,i)=>s+v*d[i],0),rLen=r.reduce((s,v)=>s+v*v,0);
  if(dot*dot<len*rLen*(1-1e-6))return false;
  const q=a.map((v,i)=>(v+b[i])/2-e[i]),t=q.reduce((s,v,i)=>s+v*d[i],0)/len;
  return t>=-1e-5&&t<=1+1e-5&&q.reduce((s,v,i)=>s+(v-t*d[i])**2,0)<1e-6;
 });
 const out:number[]=[];
 for(const {a,b,count} of edges.values()){
  if(count!==1||Math.max(a[2],b[2])<=floor||!exposed(a,b))continue;
  if(Math.min(a[2],b[2])<floor){const t=(floor-a[2])/(b[2]-a[2]);const p=a.map((v,i)=>v+(b[i]-v)*t);if(a[2]<floor)out.push(...p,...b);else out.push(...a,...p);}
  else out.push(...a,...b);
 }
 return out;
}

import * as THREE from 'three';
/** Current-level edges only; lower-level plans retain visible edges, without x-ray clutter. */
export function wireframeEdges(roots: THREE.Object3D[], floor = -Infinity): Float32Array {
 const out:number[]=[];
 for(const root of roots)root.traverseVisible(o=>{
  for(let p:THREE.Object3D|null=o;p;p=p.parent)if(p.userData.indoorBelow||p.userData.silhouette)return;
  const g=(o as THREE.LineSegments).geometry;if(!g)return;
  const a=g.getAttribute('instanceStart'),b=g.getAttribute('instanceEnd'),p=g.getAttribute('position');
  const add=(a:THREE.Vector3,b:THREE.Vector3)=>{
   if(Math.max(a.z,b.z)<floor-1e-3)return;
   if(Math.min(a.z,b.z)<floor){const t=(floor-a.z)/(b.z-a.z),q=a.clone().lerp(b,t);if(a.z<floor)a=q;else b=q;}
   out.push(a.x,a.y,a.z,b.x,b.y,b.z);
  };
  if(a&&b)for(let i=0;i<a.count;i++)add(new THREE.Vector3().fromBufferAttribute(a,i),new THREE.Vector3().fromBufferAttribute(b,i));
  else if(o instanceof THREE.LineSegments&&p)for(let i=0;i+1<p.count;i+=2)add(new THREE.Vector3().fromBufferAttribute(p,i),new THREE.Vector3().fromBufferAttribute(p,i+1));
 });
 return mergeCollinear(out);
}
/** Lines of adjoining parts overlap: dashes out of phase would read as solid. One direction, one segment per overlap. */
export function mergeCollinear(segments:ArrayLike<number>):Float32Array{
 const lines=new Map<string,{p:number[];d:number[];spans:[number,number][]}>();
 for(let i=0;i+5<segments.length;i+=6){
  let a=[segments[i],segments[i+1],segments[i+2]],b=[segments[i+3],segments[i+4],segments[i+5]];
  if(a[2]>b[2]+1e-4||(Math.abs(a[2]-b[2])<=1e-4&&(a[0]>b[0]||(a[0]===b[0]&&a[1]>b[1]))))[a,b]=[b,a];
  const len=Math.hypot(b[0]-a[0],b[1]-a[1],b[2]-a[2]);if(len<1e-6)continue;
  const d=[(b[0]-a[0])/len,(b[1]-a[1])/len,(b[2]-a[2])/len];
  const t=a[0]*d[0]+a[1]*d[1]+a[2]*d[2];
  const p=[a[0]-d[0]*t,a[1]-d[1]*t,a[2]-d[2]*t];
  const key=[...d.map(v=>v.toFixed(3)),...p.map(v=>v.toFixed(2))].join();
  let line=lines.get(key);if(!line)lines.set(key,line={p,d,spans:[]});
  line.spans.push([t,t+len]);
 }
 const out:number[]=[];
 for(const {p,d,spans} of lines.values()){
  spans.sort((x,y)=>x[0]-y[0]);
  let [from,to]=spans[0];
  const flush=()=>out.push(p[0]+d[0]*from,p[1]+d[1]*from,p[2]+d[2]*from,p[0]+d[0]*to,p[1]+d[1]*to,p[2]+d[2]*to);
  for(const [s,e] of spans.slice(1)){if(s>to+1e-3){flush();from=s;to=e;}else to=Math.max(to,e);}
  flush();
 }
 return new Float32Array(out);
}

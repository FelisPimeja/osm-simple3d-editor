import { trimCoplanarWalls } from './shell-trim';
import polygonClipping, { type MultiPolygon } from 'polygon-clipping';
import type { Pt } from './building-geometry';
export interface EscalatorCut { line: Pt[]; bottom: number; top: number; width: number; incline?: string }
/** Intersect vertical wall planes with the escalator body and 2 m of headroom. */
export function escalatorOpeningMasks(positions: ArrayLike<number>, escalators: EscalatorCut[]): number[] {
  if (!escalators.length || !positions.length) return [];
  const bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i=0;i<positions.length;i+=3) for (let k=0;k<3;k++) {
    bounds[k]=Math.min(bounds[k],positions[i+k]); bounds[k+3]=Math.max(bounds[k+3],positions[i+k]);
  }
  escalators=escalators.filter(e=>{
    const pad=Math.max(.35,Math.min(2.5,e.width/2));
    const xs=e.line.map(p=>p[0]),ys=e.line.map(p=>p[1]);
    return Math.min(...xs)-pad<=bounds[3] && Math.max(...xs)+pad>=bounds[0]
      && Math.min(...ys)-pad<=bounds[4] && Math.max(...ys)+pad>=bounds[1]
      && e.bottom-.7<=bounds[5] && e.top+2.05>=bounds[2];
  });
  if (!escalators.length) return [];
  const masks: number[] = [], seen = new Set<string>();
  for(let i=0;i+8<positions.length;i+=9) {
    const a=[positions[i],positions[i+1],positions[i+2]],b=[positions[i+3],positions[i+4],positions[i+5]],c=[positions[i+6],positions[i+7],positions[i+8]];
    const u=b.map((v,k)=>v-a[k]),v=c.map((v,k)=>v-a[k]);
    let nx=u[1]*v[2]-u[2]*v[1],ny=u[2]*v[0]-u[0]*v[2];const nz=u[0]*v[1]-u[1]*v[0],n=Math.hypot(nx,ny);
    if(n<1e-8 || Math.abs(nz)>n*1e-6)continue;
    nx/=n;ny/=n;if(nx<0 || (Math.abs(nx)<1e-8&&ny<0)){nx=-nx;ny=-ny;}
    const d=nx*a[0]+ny*a[1],key=[nx,ny,d].map(v=>v.toFixed(6)).join(',');
    if(seen.has(key))continue;seen.add(key);
    for(const e of escalators) {
      const lengths=[0];for(let j=1;j<e.line.length;j++)lengths.push(lengths[j-1]+Math.hypot(e.line[j][0]-e.line[j-1][0],e.line[j][1]-e.line[j-1][1]));
      const length=lengths.at(-1)??0;if(length<2||e.top<=e.bottom)continue;
      const landing=Math.min(1,length*.12),ramp=length-2*landing,count=Math.max(1,Math.round(ramp/.42)),half=Math.max(.35,Math.min(2.5,e.width/2));
      const distances=[0,landing,...Array.from({length:count-1},(_,i)=>landing+ramp*(i+1)/count),length-landing,length,...lengths].sort((a,b)=>a-b);
      const at=(s:number):Pt=>{let j=1;while(j<lengths.length-1&&lengths[j]<s)j++;const t=(s-lengths[j-1])/(lengths[j]-lengths[j-1]||1);return [e.line[j-1][0]+(e.line[j][0]-e.line[j-1][0])*t,e.line[j-1][1]+(e.line[j][1]-e.line[j-1][1])*t];};
      for(let j=0;j+1<distances.length;j++) {
        const lo=distances[j],hi=distances[j+1];if(hi-lo<1e-6)continue;
        const A=at(lo),B=at(hi),dx=(B[0]-A[0])/(hi-lo),dy=(B[1]-A[1])/(hi-lo);
        const ring:Pt[]=[[A[0]-dy*half,A[1]+dx*half],[B[0]-dy*half,B[1]+dx*half],[B[0]+dy*half,B[1]-dx*half],[A[0]+dy*half,A[1]-dx*half]];
        const hits:Pt[]=[];
        for(let k=0;k<4;k++) {const p=ring[k],q=ring[(k+1)%4],P=nx*p[0]+ny*p[1]-d,Q=nx*q[0]+ny*q[1]-d;
          if(Math.abs(P)<1e-6)hits.push(p);
          if(P*Q<0){const t=P/(P-Q);hits.push([p[0]+(q[0]-p[0])*t,p[1]+(q[1]-p[1])*t]);}}
        if(hits.length<2)continue;
        hits.sort((p,q)=>(p[0]-q[0])*(-ny)+(p[1]-q[1])*nx);
        const p=hits[0],q=hits.at(-1)!;if(Math.hypot(p[0]-q[0],p[1]-q[1])<1e-6)continue;
        // The treads are horizontal; use the same discretization as the model.
        const s=(lo+hi)/2,step=Math.max(0,Math.min(count-1,Math.floor((s-landing)/ramp*count)));
        const tread=s<=landing?0:s>=length-landing?1:(e.incline==='up'?(step+1)/count:step/count);
        const z=e.bottom+(e.top-e.bottom)*(e.incline==='down'?1-tread:tread)+.05;
        const bodyBottom=(p:Pt)=>{
          const distance=lo+(p[0]-A[0])*dx+(p[1]-A[1])*dy;
          const rise=Math.max(0,Math.min(1,(distance-landing)/ramp));
          return e.bottom+(e.top-e.bottom)*(e.incline==='down'?1-rise:rise)+.05-.7;
        };
        const zp=bodyBottom(p),zq=bodyBottom(q),z1=z+2;
        masks.push(p[0],p[1],zp,q[0],q[1],zq,q[0],q[1],z1,p[0],p[1],zp,q[0],q[1],z1,p[0],p[1],z1);
      }
    }
  }
  return masks;
}
export function cutEscalatorOpenings(positions: Float32Array, escalators: EscalatorCut[]): Float32Array {
  if(!escalators.length)return positions;
  const masks=escalatorOpeningMasks(positions,escalators);
  return masks.length?new Float32Array(trimCoplanarWalls(positions,masks)):positions;
}
/**
 * Рёбра по контуру проёма в стене: (маски ∩ грань) без сторон, лежащих на краях грани, —
 * вертикали проёма обрываются на верху стены (этажа), низ и торцы стены не дублируются.
 * face — прямоугольник стены из двух треугольников: a низ, b низ, b верх, a низ, b верх, a верх.
 */
export function escalatorOpeningOutline(face: ArrayLike<number>, masks: ArrayLike<number>): number[] {
  if (!masks.length) return [];
  const ax=face[0],ay=face[1],z0=face[2],bx=face[3],by=face[4],z1b=face[8],z1a=face[17];
  const L=Math.hypot(bx-ax,by-ay);if(L<1e-6)return [];
  const ux=(bx-ax)/L,uy=(by-ay)/L;
  const top=(u:number)=>z1a+(z1b-z1a)*u/L;
  const tris:MultiPolygon=[];
  for(let i=0;i+8<masks.length;i+=9){
    const ring:[number,number][]=[];
    for(let k=0;k<3;k++)ring.push([(masks[i+k*3]-ax)*ux+(masks[i+k*3+1]-ay)*uy,masks[i+k*3+2]]);
    const area=(ring[1][0]-ring[0][0])*(ring[2][1]-ring[0][1])-(ring[2][0]-ring[0][0])*(ring[1][1]-ring[0][1]);
    if(Math.abs(area)<1e-9)continue;
    tris.push([[...ring,ring[0]]]);
  }
  if(!tris.length)return [];
  const faceRing:MultiPolygon=[[[[0,z0],[L,z0],[L,z1b],[0,z1a],[0,z0]]]];
  const open=polygonClipping.intersection(faceRing,polygonClipping.union(tris[0],...tris.slice(1)));
  const eps=1e-3,out:number[]=[];
  const onEdge=(p:[number,number],q:[number,number])=>
    (Math.abs(p[1]-z0)<eps&&Math.abs(q[1]-z0)<eps)||(Math.abs(p[0])<eps&&Math.abs(q[0])<eps)||
    (Math.abs(p[0]-L)<eps&&Math.abs(q[0]-L)<eps)||(Math.abs(p[1]-top(p[0]))<eps&&Math.abs(q[1]-top(q[0]))<eps);
  for(const poly of open)for(const ring of poly)for(let i=0;i+1<ring.length;i++){
    const p=ring[i] as [number,number],q=ring[i+1] as [number,number];
    if(Math.hypot(q[0]-p[0],q[1]-p[1])<eps||onEdge(p,q))continue;
    out.push(ax+ux*p[0],ay+uy*p[0],p[1],ax+ux*q[0],ay+uy*q[0],q[1]);
  }
  return out;
}
/** Глубина короба эскалатора под ступенями — как в модели (drawEscalators). */
const BODY_DEPTH = 0.7;
/**
 * Вырез в полу на высоте floorZ под моделью эскалатора: след модели (ширина ступеней) там, где её короб
 * проходит сквозь плоскость пола, — площадка у пола иначе ложится на пол, а короб торчит из него.
 * Профиль — как у модели: площадки по краям, между ними — прямой подъём.
 */
export function escalatorFloorHoles(escalators: EscalatorCut[], floorZ: number): MultiPolygon {
  const out: Pt[][] = [];
  for (const e of escalators) {
    if (e.top <= e.bottom || floorZ < e.bottom - .1 || floorZ > e.top + .1) continue;
    const lengths=[0];for(let j=1;j<e.line.length;j++)lengths.push(lengths[j-1]+Math.hypot(e.line[j][0]-e.line[j-1][0],e.line[j][1]-e.line[j-1][1]));
    const length=lengths.at(-1)??0;if(length<2)continue;
    const landing=Math.min(1,length*.12),half=Math.max(.35,Math.min(2.5,e.width/2));
    const zAt=(d:number)=>{const rise=Math.max(0,Math.min(1,(d-landing)/(length-2*landing)));return e.bottom+(e.top-e.bottom)*(e.incline==='down'?1-rise:rise)+.05;};
    // Короб от z−BODY_DEPTH до ступеней (с запасом на пол чуть выше уровня этажа)
    const crosses=(d:number)=>{const z=zAt(d);return z-BODY_DEPTH<floorZ+.08&&z>floorZ-.02;};
    const at=(s:number)=>{let j=1;while(j<lengths.length-1&&lengths[j]<s)j++;const t=(s-lengths[j-1])/(lengths[j]-lengths[j-1]||1);
      const dx=(e.line[j][0]-e.line[j-1][0])/(lengths[j]-lengths[j-1]||1),dy=(e.line[j][1]-e.line[j-1][1])/(lengths[j]-lengths[j-1]||1);
      return {x:e.line[j-1][0]+(e.line[j][0]-e.line[j-1][0])*t,y:e.line[j-1][1]+(e.line[j][1]-e.line[j-1][1])*t,nx:-dy,ny:dx};};
    const steps=Math.max(2,Math.ceil(length/.05)),ds=[...new Set([...Array.from({length:steps+1},(_,i)=>length*i/steps),...lengths])].sort((a,b)=>a-b);
    for(let i=1;i<ds.length;i++){
      const a=ds[i-1],b=ds[i];if(b-a<1e-6||!crosses((a+b)/2))continue;
      // Отрезок внутри одного звена ломаной: нормаль — по его середине
      const m=at((a+b)/2),pa=at(a),pb=at(b);
      out.push([[pa.x+m.nx*half,pa.y+m.ny*half],[pb.x+m.nx*half,pb.y+m.ny*half],[pb.x-m.nx*half,pb.y-m.ny*half],[pa.x-m.nx*half,pa.y-m.ny*half]]);
    }
  }
  if(!out.length)return [];
  const polys=out.map(r=>[[...r,r[0]]] as unknown as MultiPolygon);
  return polygonClipping.union(polys[0],...polys.slice(1));
}

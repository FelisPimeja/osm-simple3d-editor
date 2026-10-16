import polygonClipping, { type MultiPolygon } from 'polygon-clipping';
import type { Pt } from './building-geometry';
export interface FloorSurface { outer: Pt[]; inners: Pt[][]; z: number }
/** Partition coplanar floors: smaller, more specific rooms take precedence. */
export function partitionFloors(floors: FloorSurface[]): FloorSurface[][] {
  const ringArea=(r:Pt[])=>Math.abs(r.reduce((a,p,i)=>{const q=r[(i+1)%r.length];return a+p[0]*q[1]-q[0]*p[1];},0))/2;
  const entries=floors.map((f,i)=>({f,i,area:ringArea(f.outer)-f.inners.reduce((a,r)=>a+ringArea(r),0),
    box:f.outer.reduce((b,[x,y])=>[Math.min(b[0],x),Math.min(b[1],y),Math.max(b[2],x),Math.max(b[3],y)],[Infinity,Infinity,-Infinity,-Infinity]),
    clip:[f.outer,...f.inners].map(r=>[...r,r[0]]) }));
  return entries.map(e=>{
    const overlays=entries.filter(o=>o!==e && Math.abs(o.f.z-e.f.z)<1e-6 && (o.area<e.area || (o.area===e.area && o.i>e.i))
      && o.box[0]<e.box[2] && o.box[2]>e.box[0] && o.box[1]<e.box[3] && o.box[3]>e.box[1]);
    if(!overlays.length)return [e.f];
    const polygons=polygonClipping.difference([e.clip] as MultiPolygon,...overlays.map(o=>[o.clip] as MultiPolygon));
    return polygons.map(p=>({outer:p[0].slice(0,-1) as Pt[],inners:p.slice(1).map(r=>r.slice(0,-1) as Pt[]),z:e.f.z}));
  });
}

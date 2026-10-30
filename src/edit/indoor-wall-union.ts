import type { IndoorFeature, LonLat } from '../osm/model';

/** Join wall segments only when their graph is one chain (or one closed ring). */
export function joinedWallLine(walls: IndoorFeature[]): { ids: number[]; coords: LonLat[] } | undefined {
  const vertices = new Map<string, { id: number; p: LonLat; neighbours: Set<string> }>();
  const segments: [LonLat,LonLat][]=[];
  const key = (p: LonLat) => `${p[0].toFixed(9)},${p[1].toFixed(9)}`;
  for (const wall of walls) {
    if (!wall.line || wall.kind !== 'wall' || wall.polygons.length !== 1) return;
    const p = wall.polygons[0];
    if (!p.outerIds || p.outerIds.length !== p.outer.length || p.outer.length < 2) return;
    for (let i=0;i<p.outer.length;i++) {
      const k=key(p.outer[i]);
      if (!vertices.has(k)) vertices.set(k,{id:p.outerIds[i],p:p.outer[i],neighbours:new Set()});
      if (!i) continue;
      const prev=key(p.outer[i-1]);
      const a=p.outer[i-1], b=p.outer[i];
      for(const [c,d] of segments){
        const cross=(u:LonLat,v:LonLat,w:LonLat)=>(v[0]-u[0])*(w[1]-u[1])-(v[1]-u[1])*(w[0]-u[0]);
        const ac=cross(a,b,c),ad=cross(a,b,d),ca=cross(c,d,a),cb=cross(c,d,b);
        if(ac*ad<0 && ca*cb<0)return;
        if(Math.abs(ac)<1e-20 && Math.abs(ad)<1e-20){
          const axis=Math.abs(b[0]-a[0])>Math.abs(b[1]-a[1])?0:1;
          if(Math.min(Math.max(a[axis],b[axis]),Math.max(c[axis],d[axis]))-Math.max(Math.min(a[axis],b[axis]),Math.min(c[axis],d[axis]))>1e-12)return;
        }
      }
      segments.push([a,b]);
      if (prev===k || vertices.get(prev)!.neighbours.has(k)) return;
      vertices.get(prev)!.neighbours.add(k); vertices.get(k)!.neighbours.add(prev);
    }
  }
  if ([...vertices.values()].some(v=>v.neighbours.size>2)) return;
  const ends=[...vertices].filter(([,v])=>v.neighbours.size===1).map(([k])=>k);
  if (ends.length!==0 && ends.length!==2) return;
  const start=ends[0]??vertices.keys().next().value;
  if (!start) return;
  const ids:number[]=[],coords:LonLat[]=[],seen=new Set<string>();
  let current:string|undefined=start, previous:string|undefined;
  while (current!==undefined) {
    if (seen.has(current)) { if(current!==start)return; ids.push(vertices.get(current)!.id);coords.push(vertices.get(current)!.p);break; }
    seen.add(current);
    const v: {id:number;p:LonLat;neighbours:Set<string>}=vertices.get(current)!;ids.push(v.id);coords.push(v.p);
    const next: string|undefined=[...v.neighbours].find(k=>k!==previous);
    previous=current;current=next;
  }
  return seen.size===vertices.size ? {ids,coords} : undefined;
}

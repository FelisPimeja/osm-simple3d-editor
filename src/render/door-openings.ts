import { trimCoplanarWalls } from './shell-trim';

/** Half of the drum/wall intersection chord; ordinary doors still snap to the wall. */
export function doorOpeningHalfWidth(distance: number, diameter: number | undefined, width = 1, snap = 0.15): number {
  if (diameter !== undefined) {
    const radius = diameter / 2;
    return Math.abs(distance) < radius ? Math.sqrt(radius * radius - distance * distance) : 0;
  }
  return Math.abs(distance) <= snap ? width / 2 : 0;
}

/** Вырезать проёмы из вертикальных треугольников оболочки, сохранив скаты и перекрытия. */
export function cutDoorOpenings(positions: Float32Array, doors: { x: number; y: number; z: number; width?: number; diameter?: number }[], width = 1, height = 2.2, snap = 0.15): Float32Array {
  if (!doors.length) return positions;
  const holes: number[] = [];
  for (let i = 0; i + 8 < positions.length; i += 9) {
    const vs = [0, 3, 6].map(j => [positions[i+j], positions[i+j+1], positions[i+j+2]]);
    const [a,b,c] = vs;
    const ux = b[0]-a[0], uy = b[1]-a[1], uz = b[2]-a[2];
    const vx = c[0]-a[0], vy = c[1]-a[1], vz = c[2]-a[2];
    const nx = uy*vz-uz*vy, ny = uz*vx-ux*vz, nz = ux*vy-uy*vx, n = Math.hypot(nx,ny);
    if (n < 1e-8 || Math.abs(nz) > n*1e-6) continue;
    const dx = -ny/n, dy = nx/n;
    const ts = vs.map(p => (p[0]-a[0])*dx+(p[1]-a[1])*dy);
    for (const d of doors) {
      const distance = ((d.x-a[0])*nx+(d.y-a[1])*ny)/n;
      const halfWidth = doorOpeningHalfWidth(distance, d.diameter, d.width ?? width, snap);
      if (!halfWidth || d.z >= Math.max(...vs.map(p=>p[2])) || d.z+height <= Math.min(...vs.map(p=>p[2]))) continue;
      const t = (d.x-a[0])*dx+(d.y-a[1])*dy;
      if (t+halfWidth <= Math.min(...ts) || t-halfWidth >= Math.max(...ts)) continue;
      const x = a[0]+dx*(t-halfWidth), y = a[1]+dy*(t-halfWidth), X=x+dx*halfWidth*2, Y=y+dy*halfWidth*2, z=d.z, Z=z+height;
      holes.push(x,y,z,X,Y,z,X,Y,Z,x,y,z,X,Y,Z,x,y,Z);
    }
  }
  return holes.length ? new Float32Array(trimCoplanarWalls(positions, holes)) : positions;
}

/** Segment interval inside a convex doorway footprint, independent of the door's distance to the room wall. */
export function wallDoorwaySpan(a: [number,number], b: [number,number], polygon: [number,number][]): [number,number] | undefined {
  if(polygon.length<3)return;
  const cross=(x:[number,number],y:[number,number])=>x[0]*y[1]-x[1]*y[0];
  let area=0;
  for(let i=0;i<polygon.length;i++){const p=polygon[i],q=polygon[(i+1)%polygon.length];area+=cross(p,q);}
  if(Math.abs(area)<1e-10)return;
  const sign=Math.sign(area);let lo=0,hi=1;
  for(let i=0;i<polygon.length;i++){
    const p=polygon[i],q=polygon[(i+1)%polygon.length],edge:[number,number]=[q[0]-p[0],q[1]-p[1]];
    if(Math.hypot(...edge)<1e-9)continue;
    // Independently rounded OSM boundaries can be almost parallel and a fraction
    // of a millimetre outside the recovered back edge. Snap both signed distances,
    // not only exactly parallel segments, before clipping.
    const tolerance=0.002*Math.hypot(...edge);
    const snap=(value:number)=>Math.abs(value)<=tolerance?0:value;
    const value=snap(sign*cross(edge,[a[0]-p[0],a[1]-p[1]]));
    const end=snap(sign*cross(edge,[b[0]-p[0],b[1]-p[1]])),slope=end-value;
    if(Math.abs(slope)<1e-10){if(value<0)return;continue;}
    const t=-value/slope;
    if(slope>0)lo=Math.max(lo,t);else hi=Math.min(hi,t);
    if(hi-lo<1e-7)return;
  }
  return hi>lo?[Math.max(0,lo),Math.min(1,hi)]:undefined;
}

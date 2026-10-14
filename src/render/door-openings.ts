import { trimCoplanarWalls } from './shell-trim';

/** Вырезать проёмы из вертикальных треугольников оболочки, сохранив скаты и перекрытия. */
export function cutDoorOpenings(positions: Float32Array, doors: { x: number; y: number; z: number }[], width = 1, height = 2.2, snap = 0.15): Float32Array {
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
      if (Math.abs(distance) > snap || d.z >= Math.max(...vs.map(p=>p[2])) || d.z+height <= Math.min(...vs.map(p=>p[2]))) continue;
      const t = (d.x-a[0])*dx+(d.y-a[1])*dy;
      if (t+width/2 <= Math.min(...ts) || t-width/2 >= Math.max(...ts)) continue;
      const x = a[0]+dx*(t-width/2), y = a[1]+dy*(t-width/2), X=x+dx*width, Y=y+dy*width, z=d.z, Z=z+height;
      holes.push(x,y,z,X,Y,z,X,Y,Z,x,y,z,X,Y,Z,x,y,Z);
    }
  }
  return holes.length ? new Float32Array(trimCoplanarWalls(positions, holes)) : positions;
}

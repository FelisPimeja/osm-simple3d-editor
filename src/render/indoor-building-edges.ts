/** Hide building edges covered by actual indoor wall faces (including lintels).
 * The indoor layer supplies its own corners and jambs. Keep all uncovered heights.
 */
export function trimIndoorBuildingEdges(edges: Float32Array, walls: ArrayLike<number>): Float32Array {
  if (!walls.length) return edges;
  const cell = 4, eps = 0.02;
  // Данные треугольников — один раз: начало a, направление (dx, dy) в плане, вершины в осях (вдоль, z), габарит z
  const count = Math.floor(walls.length / 9);
  const tri = new Float64Array(count * 12);
  const ok = new Uint8Array(count);
  const grid = new Map<number, number[]>();
  const key = (x: number, y: number) => (x + 32768) * 65536 + (y + 32768);
  for (let t = 0; t < count; t++) {
    const i = t * 9;
    const ax = walls[i], ay = walls[i + 1];
    // Самая дальняя от первой вершины в плане — направление плоскости стены
    let bx = ax, by = ay, best = 0;
    for (const j of [3, 6]) {
      const d = Math.hypot(walls[i + j] - ax, walls[i + j + 1] - ay);
      if (d > best) { best = d; bx = walls[i + j]; by = walls[i + j + 1]; }
    }
    if (best < 1e-6) continue;
    const dx = (bx - ax) / best, dy = (by - ay) / best;
    const o = t * 12;
    tri[o] = ax; tri[o + 1] = ay; tri[o + 2] = dx; tri[o + 3] = dy;
    let zmin = Infinity, zmax = -Infinity;
    for (let j = 0; j < 3; j++) {
      const vx = walls[i + j * 3], vy = walls[i + j * 3 + 1], vz = walls[i + j * 3 + 2];
      tri[o + 4 + j * 2] = (vx - ax) * dx + (vy - ay) * dy;
      tri[o + 5 + j * 2] = vz;
      zmin = Math.min(zmin, vz); zmax = Math.max(zmax, vz);
    }
    const area = (tri[o + 6] - tri[o + 4]) * (tri[o + 9] - tri[o + 5]) - (tri[o + 7] - tri[o + 5]) * (tri[o + 8] - tri[o + 4]);
    if (Math.abs(area) < 1e-9) continue;
    tri[o + 10] = zmin; tri[o + 11] = zmax;
    ok[t] = 1;
    const xs = [walls[i], walls[i + 3], walls[i + 6]], ys = [walls[i + 1], walls[i + 4], walls[i + 7]];
    for (let x = Math.floor((Math.min(...xs) - eps) / cell); x <= Math.floor((Math.max(...xs) + eps) / cell); x++)
      for (let y = Math.floor((Math.min(...ys) - eps) / cell); y <= Math.floor((Math.max(...ys) + eps) / cell); y++) {
        const k = key(x, y);
        (grid.get(k) ?? grid.set(k, []).get(k)!).push(t);
      }
  }
  const out: number[] = [];
  const seen = new Int32Array(count).fill(-1);
  const cross = (ax: number, ay: number, bx: number, by: number) => ax * by - ay * bx;
  for (let i = 0; i + 5 < edges.length; i += 6) {
    const x = edges[i], y = edges[i + 1], z = edges[i + 2], X = edges[i + 3], Y = edges[i + 4], Z = edges[i + 5];
    const ez0 = Math.min(z, Z), ez1 = Math.max(z, Z);
    let spans: [number, number][] = [[0, 1]];
    done: for (let cx = Math.floor(Math.min(x, X) / cell); cx <= Math.floor(Math.max(x, X) / cell); cx++)
      for (let cy = Math.floor(Math.min(y, Y) / cell); cy <= Math.floor(Math.max(y, Y) / cell); cy++)
        for (const t of grid.get(key(cx, cy)) ?? []) {
          if (seen[t] === i) continue;
          seen[t] = i;
          if (!ok[t]) continue;
          const o = t * 12;
          if (tri[o + 10] > ez1 + 1e-6 || tri[o + 11] < ez0 - 1e-6) continue;
          const ax = tri[o], ay = tri[o + 1], dx = tri[o + 2], dy = tri[o + 3];
          if (Math.abs((x - ax) * dy - (y - ay) * dx) > eps || Math.abs((X - ax) * dy - (Y - ay) * dx) > eps) continue;
          const u = (x - ax) * dx + (y - ay) * dy, U = (X - ax) * dx + (Y - ay) * dy;
          const p0 = tri[o + 4], q0 = tri[o + 5], p1 = tri[o + 6], q1 = tri[o + 7], p2 = tri[o + 8], q2 = tri[o + 9];
          const sign = Math.sign(cross(p1 - p0, q1 - q0, p2 - p0, q2 - q0));
          let lo = 0, hi = 1;
          for (let j = 0; j < 3; j++) {
            const vx = j === 0 ? p0 : j === 1 ? p1 : p2, vz = j === 0 ? q0 : j === 1 ? q1 : q2;
            const wx = j === 0 ? p1 : j === 1 ? p2 : p0, wz = j === 0 ? q1 : j === 1 ? q2 : q0;
            const c = sign * cross(wx - vx, wz - vz, u - vx, z - vz);
            const d = sign * cross(wx - vx, wz - vz, U - u, Z - z);
            if (Math.abs(d) < 1e-10) { if (c < -1e-6) { hi = -1; break; } }
            else if (d > 0) lo = Math.max(lo, -c / d);
            else hi = Math.min(hi, -c / d);
          }
          if (hi <= lo) continue;
          spans = spans.flatMap(([a, b]): [number, number][] => {
            if (hi <= a || lo >= b) return [[a, b]];
            const rest: [number, number][] = [];
            if (lo > a) rest.push([a, lo]);
            if (hi < b) rest.push([hi, b]);
            return rest;
          });
          if (!spans.length) break done;
        }
    for (const [a, b] of spans) if ((b - a) * Math.hypot(X - x, Y - y, Z - z) > 1e-5)
      out.push(x + (X - x) * a, y + (Y - y) * a, z + (Z - z) * a, x + (X - x) * b, y + (Y - y) * b, z + (Z - z) * b);
  }
  return new Float32Array(out);
}

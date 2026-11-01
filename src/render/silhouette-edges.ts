/** Излом меньше этого (°) — стена одной плоскости: силуэта там не бывает. */
const MIN_TURN = 1;
const PRECISION = 1e3;

export interface SilhouetteEdges {
  /** Вертикальные отрезки: x, y, z, x, y, z. */
  lines: Float32Array;
  /** На вершину отрезка: нормали двух стен в плане — ax, ay, bx, by. */
  faces: Float32Array;
}

/**
 * Вертикальные стыки стен с изломом меньше maxTurn: сами рёбра скрыты порогом, иначе цилиндр превратился бы
 * в частокол, но край такой поверхности виден. Шейдер показывает стык там, где одна стена смотрит на камеру, другая — нет.
 */
export function silhouetteEdges(positions: Float32Array, wallVertices: number, maxTurn: number): SilhouetteEdges {
  const open = new Map<string, [number, number]>();
  const lines: number[] = [], faces: number[] = [];
  const minDot = Math.cos(maxTurn * Math.PI / 180), maxDot = Math.cos(MIN_TURN * Math.PI / 180);
  for (let t = 0; t + 2 < wallVertices; t += 3) {
    const o = t * 3;
    const ux = positions[o + 3] - positions[o], uy = positions[o + 4] - positions[o + 1], uz = positions[o + 5] - positions[o + 2];
    const vx = positions[o + 6] - positions[o], vy = positions[o + 7] - positions[o + 1], vz = positions[o + 8] - positions[o + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx, len = Math.hypot(nx, ny);
    if (len < 1e-9 || Math.abs(nz) > len * 1e-3) continue; // не вертикальная грань
    nx /= len; ny /= len;
    for (let k = 0; k < 3; k++) {
      const a = o + k * 3, b = o + (k + 1) % 3 * 3;
      if (Math.abs(positions[a] - positions[b]) > 1e-4 || Math.abs(positions[a + 1] - positions[b + 1]) > 1e-4 || positions[a + 2] === positions[b + 2]) continue;
      const lo = Math.min(positions[a + 2], positions[b + 2]), hi = Math.max(positions[a + 2], positions[b + 2]);
      const key = `${Math.round(positions[a] * PRECISION)},${Math.round(positions[a + 1] * PRECISION)},${Math.round(lo * PRECISION)},${Math.round(hi * PRECISION)}`;
      const pair = open.get(key);
      if (!pair) { open.set(key, [nx, ny]); continue; }
      open.delete(key);
      const dot = pair[0] * nx + pair[1] * ny;
      if (dot < minDot || dot > maxDot) continue;
      lines.push(positions[a], positions[a + 1], lo, positions[a], positions[a + 1], hi);
      faces.push(pair[0], pair[1], nx, ny, pair[0], pair[1], nx, ny);
    }
  }
  return { lines: new Float32Array(lines), faces: new Float32Array(faces) };
}

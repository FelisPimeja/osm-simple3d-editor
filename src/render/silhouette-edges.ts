/** Излом меньше этого (°) — одна плоскость: силуэта там не бывает. */
const MIN_TURN = 1;
const PRECISION = 1e3;

export interface SilhouetteEdges {
  /** Отрезки: x, y, z, x, y, z. */
  lines: Float32Array;
  /** На вершину отрезка: нормали двух граней — ax, ay, az, bx, by, bz. */
  faces: Float32Array;
}

/**
 * Стыки граней с изломом меньше maxTurn: сами рёбра скрыты порогом, иначе цилиндр превратился бы в частокол,
 * но край такой поверхности виден. Шейдер показывает стык там, где одна грань смотрит на камеру, другая — нет.
 * Кандидаты — вертикальные стыки стен и, у кривых крыш (roofEnd — конец вершин крыши), все стыки скатов.
 */
export function silhouetteEdges(positions: Float32Array, wallVertices: number, maxTurn: number, roofEnd = wallVertices): SilhouetteEdges {
  const open = new Map<string, [number, number, number]>();
  const lines: number[] = [], faces: number[] = [];
  const minDot = Math.cos(maxTurn * Math.PI / 180), maxDot = Math.cos(MIN_TURN * Math.PI / 180);
  const vertexKey = (o: number) => `${Math.round(positions[o] * PRECISION)},${Math.round(positions[o + 1] * PRECISION)},${Math.round(positions[o + 2] * PRECISION)}`;
  for (let t = 0; t + 2 < roofEnd; t += 3) {
    const o = t * 3, wall = t < wallVertices;
    const ux = positions[o + 3] - positions[o], uy = positions[o + 4] - positions[o + 1], uz = positions[o + 5] - positions[o + 2];
    const vx = positions[o + 6] - positions[o], vy = positions[o + 7] - positions[o + 1], vz = positions[o + 8] - positions[o + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    const len = Math.hypot(cx, cy, cz);
    if (len < 1e-9 || (wall && Math.abs(cz) > Math.hypot(cx, cy) * 1e-3)) continue; // у стен — только вертикальные грани
    const nx = cx / len, ny = cy / len, nz = cz / len;
    for (let k = 0; k < 3; k++) {
      let a = o + k * 3, b = o + (k + 1) % 3 * 3;
      const vertical = Math.abs(positions[a] - positions[b]) <= 1e-4 && Math.abs(positions[a + 1] - positions[b + 1]) <= 1e-4;
      if (wall && (!vertical || positions[a + 2] === positions[b + 2])) continue;
      let ka = vertexKey(a), kb = vertexKey(b);
      if (ka > kb) { [a, b] = [b, a]; [ka, kb] = [kb, ka]; }
      const key = `${ka};${kb}`;
      const pair = open.get(key);
      if (!pair) { open.set(key, [nx, ny, nz]); continue; }
      open.delete(key);
      const dot = pair[0] * nx + pair[1] * ny + pair[2] * nz;
      if (Math.abs(dot) < minDot || Math.abs(dot) > maxDot) continue;
      // Обход соседних граней бывает разным: нормали — в одну сторону, иначе знаки в шейдере не сравнить
      const s = dot < 0 ? -1 : 1;
      lines.push(positions[a], positions[a + 1], positions[a + 2], positions[b], positions[b + 1], positions[b + 2]);
      for (let v = 0; v < 2; v++) faces.push(pair[0], pair[1], pair[2], nx * s, ny * s, nz * s);
    }
  }
  return { lines: new Float32Array(lines), faces: new Float32Array(faces) };
}

import type { Skeleton } from './skeleton';

/** CGAL иногда отдаёт один узел несколькими вершинами с субмиллиметровым зазором. */
export function weldRoofSkeleton(sk: Skeleton): Skeleton {
  const parent = sk.vertices.map((_, i) => i);
  const root = (i: number): number => parent[i] === i ? i : (parent[i] = root(parent[i]));
  for (const f of sk.polygons) for (let k = 0; k < f.length; k++) {
    const a = f[k], b = f[(k + 1) % f.length];
    const p = sk.vertices[a], q = sk.vertices[b];
    // Контур здания сохраняем: объединяем только внутренние узлы скелета.
    if (p[2] > 1e-9 && q[2] > 1e-9 && Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 0.001) {
      const u = root(a), v = root(b);
      parent[Math.max(u, v)] = Math.min(u, v);
    }
  }
  const polygons = sk.polygons.map((f) => {
    const ids = f.map(root);
    const clean = ids.filter((id, i) => id !== ids[(i + ids.length - 1) % ids.length]);
    // В узле разделения волнового фронта грань может пройти к узлу и
    // вернуться вдоль той же стороны. Такой субмиллиметровый шип не скат.
    for (let changed = true; changed && clean.length > 3;) {
      changed = false;
      for (let i = 0; i < clean.length; i++) {
        const a = sk.vertices[clean[(i + clean.length - 1) % clean.length]];
        const p = sk.vertices[clean[i]], b = sk.vertices[clean[(i + 1) % clean.length]];
        const d = b.map((v, k) => v - a[k]);
        const len2 = d.reduce((s, v) => s + v * v, 0);
        if (len2 < 1e-12) continue;
        const t = d.reduce((s, v, k) => s + v * (p[k] - a[k]), 0) / len2;
        if ((t < 0 || t > 1) && Math.hypot(...p.map((v, k) => v - a[k] - t * d[k])) < 0.001) {
          clean.splice(i, 1); changed = true; break;
        }
      }
    }
    return clean;
  }).filter((f) => f.length >= 3);
  // Одинаково разбиваем стороны соседних граней в Т-стыках. Иначе одна
  // длинная линия пересекает и настоящий излом, и плоский участок стыка.
  const used = [...new Set(polygons.flat())];
  const split = polygons.map((f) => f.flatMap((a, i) => {
    const b = f[(i + 1) % f.length], p = sk.vertices[a], q = sk.vertices[b];
    const d = q.map((v, k) => v - p[k]);
    const len2 = d.reduce((s, v) => s + v * v, 0);
    if (len2 < 1e-12) return [a];
    const inside = used.filter((id) => id !== a && id !== b).map((id) => {
      const v = sk.vertices[id];
      const t = d.reduce((s, x, k) => s + x * (v[k] - p[k]), 0) / len2;
      const dist = Math.hypot(...v.map((x, k) => x - p[k] - t * d[k]));
      return { id, t, dist };
    }).filter(({ t, dist }) => t > 1e-6 && t < 1 - 1e-6 && dist < 0.001).sort((a, b) => a.t - b.t);
    return [a, ...inside.map(({ id }) => id)];
  }));
  return { vertices: sk.vertices, polygons: split };
}

/** Продлить линию пересечения соседних скатов до торца, сохраняя их плоскости. */
export function extendGables(sk: Skeleton) {
  const vertices = sk.vertices.map((v) => [...v] as [number, number, number]);
  const contour = (i: number) => sk.vertices[i][2] < 1e-9;
  const gables = new Set<number[]>();
  const moved = new Set<number>();
  const merged = new Map<number, number>();
  const ends = sk.polygons.filter((f) => f.filter(contour).length === 2)
    .map((f) => {
      const base = f.filter(contour);
      const [a, b] = base.map((i) => sk.vertices[i]);
      return { f, base, a, b, len: Math.hypot(b[0] - a[0], b[1] - a[1]) };
    }).sort((a, b) => a.len - b.len);
  for (const { f, base, a, b, len } of ends) {
    const tips = f.filter((i) => !contour(i));
    if (!tips.length || tips.some((i) => moved.has(i))) continue;
    // Аппроксимация только короткого ребра вершины: максимум 10 см и 1% торца.
    const tolerance = tips.length === 1 ? 1e-6 : Math.min(0.1, len * 0.01);
    if (tips.some((i) => tips.some((j) => Math.hypot(...sk.vertices[i].map((v, k) => v - sk.vertices[j][k])) > tolerance))) continue;
    const apex = tips[0];
    // t — высота исходного скелета. На каждой грани t = nx*x + ny*y + c.
    const neighbours = sk.polygons.filter((p) => p !== f && p.some((i) => tips.includes(i)));
    const planes = neighbours.map((p) => {
      const edge = p.filter(contour);
      if (edge.length !== 2) return undefined;
      const [u, v] = edge.map((i) => sk.vertices[i]);
      const top = sk.vertices[p.find((i) => tips.includes(i))!];
      const dx = v[0] - u[0], dy = v[1] - u[1];
      const cross = dx * (top[1] - u[1]) - dy * (top[0] - u[0]);
      if (Math.abs(cross) < 1e-9) return undefined;
      const nx = -dy * top[2] / cross, ny = dx * top[2] / cross;
      return [nx, ny, -nx * u[0] - ny * u[1]];
    });
    if (planes.length < 2 || planes.some((p) => !p)) continue;
    // Два ската по бокам торца сохраняем точно; остальные примыкания — в допуске.
    const p = planes[neighbours.findIndex((f) => f.includes(base[0]))];
    const q = planes[neighbours.findIndex((f) => f.includes(base[1]))];
    if (!p || !q) continue;
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const den = (p[0] - q[0]) * dx + (p[1] - q[1]) * dy;
    if (Math.abs(den) < 1e-9) continue;
    const along = -((p[0] - q[0]) * a[0] + (p[1] - q[1]) * a[1] + p[2] - q[2]) / den;
    if (along < 0 || along > 1) continue;
    const x = a[0] + dx * along, y = a[1] + dy * along;
    const t = p[0] * x + p[1] * y + p[2];
    if (t <= 1e-9 || !planes.every((r) => Math.abs(r![0] * x + r![1] * y + r![2] - t) <= tolerance)) continue;
    for (const tip of tips) {
      vertices[tip] = [x, y, t];
      moved.add(tip);
      merged.set(tip, apex);
    }
    gables.add(f);
  }
  const polygons = sk.polygons.map((f) => {
    const ids = f.map((i) => merged.get(i) ?? i);
    const clean = ids.filter((id, i) => id !== ids[(i + ids.length - 1) % ids.length]);
    return clean.length === f.length && clean.every((id, i) => id === f[i]) ? f : clean;
  });
  const finalGables = new Set(sk.polygons.flatMap((f, i) => gables.has(f) ? [polygons[i]] : []));
  return { vertices, polygons: polygons.filter((f) => f.length >= 3), gables: finalGables };
}

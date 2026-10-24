/**
 * Стыки частей: рёбра на границе соседних объектов, где их грани продолжают друг друга в одной плоскости
 * (фасад через две части, верх нижней части под такой же верхней), не рисуем.
 */

export interface SeamItem {
  /** Треугольники объекта, xyz. */
  positions: Float32Array;
  /** Его рёбра, пары точек xyz. */
  edges: Float32Array;
  /** Перекрытия — последние вершины: они внутри объёма и в счёт не идут. */
  floorVertices: number;
  box: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number }; isEmpty(): boolean };
}

/** Совпадающие грани (общая стена двух частей, крыша под дном соседа) — с одной стороны ребра, в одной плоскости. */
const SEAM_SAME_COS = Math.cos(2 * Math.PI / 180);
const SEAM_EPS = 0.02;
/** Сторон в одном пересчёте — меньше этого (2^22): номер стороны — младшие разряды ключа. */
const SIDE_SPAN = 2 ** 22;

/** Ключ вершины: координаты с точностью до сантиметра, 31-битный хеш (совпадения отсеет проверка на прямой). */
function vertexKey(x: number, y: number, z: number): number {
  return (Math.imul(Math.round(x * 100), 73856093) ^ Math.imul(Math.round(y * 100), 19349663) ^ Math.imul(Math.round(z * 100), 83492791)) >>> 1;
}

/** Результат по рёбрам объекта: годен, пока те же его треугольники и треугольники соседей. */
const seamCache = new WeakMap<Float32Array, { positions: Float32Array; deps: Float32Array[]; wallCos: number; flatCos: number; edges: Float32Array }>();

/**
 * Рёбра объектов без стыков с соседями: участок ребра убираем, если у него ровно две грани (совпадающие
 * пары граней сокращаются), они из разных объектов и одна продолжает другую: стены — с изломом меньше
 * wallAngle, прочие грани — меньше flatAngle, градусы. Грани у ребра ищутся по общим с ним вершинам: стык
 * без общих узлов (одна часть касается другой серединой стороны) не находится — ребро остаётся.
 */
export function dropPartSeams(items: SeamItem[], wallAngle: number, flatAngle: number): Float32Array[] {
  const wallCos = Math.cos(wallAngle * Math.PI / 180), flatCos = Math.cos(flatAngle * Math.PI / 180);
  // Соседи по габаритам: у объекта без соседей стыков нет
  const near: number[][] = items.map(() => []);
  const order = items.map((_, i) => i).filter((i) => !items[i].box.isEmpty()).sort((a, b) => items[a].box.min.x - items[b].box.min.x);
  for (let n = 0; n < order.length; n++) {
    const A = items[order[n]].box;
    for (let m = n + 1; m < order.length && items[order[m]].box.min.x <= A.max.x + SEAM_EPS; m++) {
      const B = items[order[m]].box;
      if (A.min.y > B.max.y + SEAM_EPS || B.min.y > A.max.y + SEAM_EPS || A.min.z > B.max.z + SEAM_EPS || B.min.z > A.max.z + SEAM_EPS) continue;
      near[order[n]].push(order[m]); near[order[m]].push(order[n]);
    }
  }
  // Пересчёт — только у объектов, у которых изменились они сами или соседи (тайл пересобирается
  // на каждую порцию крыш, а меняются в ней немногие)
  const result: Float32Array[] = items.map((it) => it.edges);
  const dirty: number[] = [];
  items.forEach((it, a) => {
    if (!near[a].length) return;
    const hit = seamCache.get(it.edges);
    if (hit && hit.positions === it.positions && hit.wallCos === wallCos && hit.flatCos === flatCos && hit.deps.length === near[a].length
      && near[a].every((b) => hit.deps.includes(items[b].positions))) result[a] = hit.edges;
    else dirty.push(a);
  });
  if (!dirty.length) return result;
  const touching = new Set<number>();
  for (const a of dirty) { touching.add(a); for (const b of near[a]) touching.add(b); }
  // Стороны треугольников соприкасающихся объектов — по их концам. Стыки частей проходят по общим узлам OSM:
  // у совпадающих граней концы сторон совпадают, и кандидатов на ребро — единицы, а не перебор по сетке
  const sideItem: number[] = [], sideVert: number[] = [];
  let entries = new Float64Array(1 << 14), entryCount = 0;
  const put = (key: number, side: number) => {
    if (entryCount === entries.length) { const grown = new Float64Array(entryCount * 2); grown.set(entries); entries = grown; }
    entries[entryCount++] = key * SIDE_SPAN + side;
  };
  for (const a of touching) {
    const P = items[a].positions, end = P.length - items[a].floorVertices * 3;
    for (let o = 0; o < end; o += 9) {
      for (let k = 0; k < 3; k++) {
        const s = sideItem.length;
        sideItem.push(a); sideVert.push(o + k);
        const p = o + k * 3, q = o + ((k + 1) % 3) * 3;
        put(vertexKey(P[p], P[p + 1], P[p + 2]), s);
        put(vertexKey(P[q], P[q + 1], P[q + 2]), s);
      }
    }
  }
  if (sideItem.length >= SIDE_SPAN) return result;
  // Пары «вершина, сторона» по возрастанию (ключ·2^22 + сторона, точно в double): стороны вершины — отрезок массива
  const byVertex = entries.subarray(0, entryCount).sort();
  const vertexStart = (key: number) => {
    const v = key * SIDE_SPAN;
    let lo = 0, hi = byVertex.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (byVertex[mid] < v) lo = mid + 1; else hi = mid; }
    return lo;
  };
  const stamp = new Int32Array(sideItem.length);
  let pass = 0;
  // Стороны на прямой текущего отрезка: объект, интервал вдоль отрезка, направление грани от ребра (единичное),
  // стена ли (нормаль горизонтальна) — в общих буферах, без объектов на каждый отрезок
  let cap = 64;
  const live = new Uint8Array(256);
  let fItem = new Int32Array(cap), fT = new Float64Array(cap * 2), fDir = new Float64Array(cap * 3), fWall = new Uint8Array(cap);
  const cuts = new Float64Array(2 * live.length + 2);
  for (const a of dirty) {
    const it = items[a], segs = it.edges;
    let out: Float32Array | undefined;
    let n = 0;
    const emit = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => {
      if (n + 6 > out!.length) { const grown = new Float32Array(out!.length * 2 + 6); grown.set(out!); out = grown; }
      out![n++] = x0; out![n++] = y0; out![n++] = z0; out![n++] = x1; out![n++] = y1; out![n++] = z1;
    };
    for (let s = 0; s < segs.length; s += 6) {
      const px = segs[s], py = segs[s + 1], pz = segs[s + 2];
      const qx = segs[s + 3], qy = segs[s + 4], qz = segs[s + 5];
      let dx = qx - px, dy = qy - py, dz = qz - pz;
      const len = Math.hypot(dx, dy, dz);
      let count = 0, other = false;
      if (len >= SEAM_EPS) {
        dx /= len; dy /= len; dz /= len;
        pass++;
        for (let c = 0; c < 2; c++) {
          const key = c ? vertexKey(qx, qy, qz) : vertexKey(px, py, pz);
          const base = key * SIDE_SPAN, last = base + SIDE_SPAN;
          for (let e = vertexStart(key); e < byVertex.length && byVertex[e] < last; e++) {
            const side = byVertex[e] - base;
            if (stamp[side] === pass) continue;
            stamp[side] = pass;
            const b = sideItem[side], v = sideVert[side], k = v % 3, o = v - k;
            const P = items[b].positions;
            const va = o + k * 3, vb = o + ((k + 1) % 3) * 3, vc = o + ((k + 2) % 3) * 3;
            const ax = P[va] - px, ay = P[va + 1] - py, az = P[va + 2] - pz;
            const ta = ax * dx + ay * dy + az * dz;
            if (Math.hypot(ax - ta * dx, ay - ta * dy, az - ta * dz) > SEAM_EPS) continue;
            const bx = P[vb] - px, by = P[vb + 1] - py, bz = P[vb + 2] - pz;
            const tb = bx * dx + by * dy + bz * dz;
            if (Math.hypot(bx - tb * dx, by - tb * dy, bz - tb * dz) > SEAM_EPS) continue;
            const t0 = Math.max(0, Math.min(ta, tb)), t1 = Math.min(len, Math.max(ta, tb));
            if (t1 - t0 < SEAM_EPS) continue;
            const cx = P[vc] - px, cy = P[vc + 1] - py, cz = P[vc + 2] - pz;
            const tc = cx * dx + cy * dy + cz * dz;
            const ix = cx - tc * dx, iy = cy - tc * dy, iz = cz - tc * dz;
            const il = Math.hypot(ix, iy, iz);
            if (il < 1e-3) continue;
            if (count === cap) {
              cap *= 2;
              const gi = new Int32Array(cap), gt = new Float64Array(cap * 2), gd = new Float64Array(cap * 3), gw = new Uint8Array(cap);
              gi.set(fItem); gt.set(fT); gd.set(fDir); gw.set(fWall);
              fItem = gi; fT = gt; fDir = gd; fWall = gw;
            }
            fItem[count] = b; fT[count * 2] = t0; fT[count * 2 + 1] = t1;
            fDir[count * 3] = ix / il; fDir[count * 3 + 1] = iy / il; fDir[count * 3 + 2] = iz / il;
            fWall[count] = Math.abs(dx * iy - dy * ix) / il < 0.1 ? 1 : 0;
            count++;
            if (b !== a) other = true;
          }
        }
      }
      if (!other || count > live.length) { if (out) emit(px, py, pz, qx, qy, qz); continue; }
      // Точки деления — концы граней на отрезке, по возрастанию, без почти совпадающих (их обычно две-три)
      let cutCount = 0;
      for (let f = -2; f < count * 2; f++) {
        const t = f === -2 ? 0 : f === -1 ? len : fT[f];
        let at = 0;
        while (at < cutCount && cuts[at] < t - SEAM_EPS) at++;
        if (at < cutCount && Math.abs(cuts[at] - t) <= SEAM_EPS) continue;
        cuts.copyWithin(at + 1, at, cutCount);
        cuts[at] = t;
        cutCount++;
      }
      for (let c = 1; c < cutCount; c++) {
        const c0 = cuts[c - 1], c1 = cuts[c];
        if (c1 - c0 < SEAM_EPS) continue;
        const m = (c0 + c1) / 2;
        let left = 0;
        for (let f = 0; f < count; f++) { live[f] = fT[f * 2] < m && fT[f * 2 + 1] > m ? 1 : 0; left += live[f]; }
        // Совпадающие грани сокращаются попарно
        for (let x = 0; x < count; x++) {
          if (!live[x]) continue;
          for (let y = x + 1; y < count; y++) {
            if (!live[y] || fDir[x * 3] * fDir[y * 3] + fDir[x * 3 + 1] * fDir[y * 3 + 1] + fDir[x * 3 + 2] * fDir[y * 3 + 2] < SEAM_SAME_COS) continue;
            live[x] = live[y] = 0; left -= 2;
            break;
          }
        }
        let f = -1, g = -1;
        if (left === 2) for (let x = 0; x < count; x++) if (live[x]) { if (f < 0) f = x; else g = x; }
        const seam = left === 2 && fItem[f] !== fItem[g]
          && fDir[f * 3] * fDir[g * 3] + fDir[f * 3 + 1] * fDir[g * 3 + 1] + fDir[f * 3 + 2] * fDir[g * 3 + 2] < -(fWall[f] && fWall[g] ? wallCos : flatCos);
        if (seam) {
          // Первый убранный участок: копируем уже пройденные отрезки
          if (!out) { out = new Float32Array(segs.length + 6); out.set(segs.subarray(0, s)); n = s; }
          continue;
        }
        if (out) emit(px + dx * c0, py + dy * c0, pz + dz * c0, px + dx * c1, py + dy * c1, pz + dz * c1);
        else if (c0 > 0 || c1 < len) { out = new Float32Array(segs.length + 6); out.set(segs.subarray(0, s)); n = s; emit(px + dx * c0, py + dy * c0, pz + dz * c0, px + dx * c1, py + dy * c1, pz + dz * c1); }
      }
    }
    result[a] = out ? out.slice(0, n) : segs;
    seamCache.set(segs, { positions: it.positions, deps: near[a].map((b) => items[b].positions), wallCos, flatCos, edges: result[a] });
  }
  return result;
}

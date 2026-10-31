import type { Pt } from '../render/building-geometry';

/**
 * Выровнять углы контуров (как «Ортогонализация» в iD/JOSM, Q): все стороны — вдоль двух перпендикулярных
 * направлений, общих для всех колец (главное направление — взвешенное по длине сторон среднее углов по модулю 90°).
 * Узлы не добавляются и не удаляются: стороны одного направления подряд (промежуточные узлы, Т-образные стыки)
 * сливаются в одну прямую, их узлы проецируются на неё; углы — пересечения соседних прямых. Прямая стороны —
 * средняя (по длине) линия её отрезков, так что контур почти не съезжает.
 * Кольца — без повтора первой точки, на выходе те же длины. Строка — почему нельзя.
 */
export function orthogonalize(rings: Pt[][], maxDeg = MAX_DEVIATION_DEG): { rings: Pt[][]; maxDeviation: number } | string {
  let sx = 0, sy = 0;
  for (const r of rings) for (let k = 0; k < r.length; k++) {
    const [ax, ay] = r[k], [bx, by] = r[(k + 1) % r.length];
    const len = Math.hypot(bx - ax, by - ay), phi = Math.atan2(by - ay, bx - ax);
    sx += len * Math.cos(4 * phi); sy += len * Math.sin(4 * phi);
  }
  const theta = Math.atan2(sy, sx) / 4;
  const cos = Math.cos(theta), sin = Math.sin(theta);
  const toFrame = ([x, y]: Pt): Pt => [x * cos + y * sin, -x * sin + y * cos];
  const fromFrame = ([x, y]: Pt): Pt => [x * cos - y * sin, x * sin + y * cos];
  let maxDeviation = 0;
  const out: Pt[][] = [];
  for (const ring of rings) {
    const n = ring.length;
    if (n < 4) return 'few';
    const p = ring.map(toFrame);
    // Направление стороны k (от p[k] к p[k+1]): 0 — вдоль x, 1 — вдоль y; нулевые — как у предыдущей
    const dir: (0 | 1 | undefined)[] = p.map((a, k) => {
      const b = p[(k + 1) % n], dx = Math.abs(b[0] - a[0]), dy = Math.abs(b[1] - a[1]);
      if (Math.hypot(dx, dy) < 1e-6) return undefined;
      maxDeviation = Math.max(maxDeviation, (Math.atan2(Math.min(dx, dy), Math.max(dx, dy)) * 180) / Math.PI);
      return dx >= dy ? 0 : 1;
    });
    const first = dir.findIndex((d) => d !== undefined);
    if (first < 0) return 'few';
    for (let s = 0; s < n; s++) { const k = (first + s) % n; if (dir[k] === undefined) dir[k] = dir[(k - 1 + n) % n]; }
    if (maxDeviation > maxDeg) return 'skewed';
    // Начинаем с границы прямых, чтобы прямая не рвалась на стыке начала и конца кольца
    const start = dir.findIndex((d, k) => d !== dir[(k - 1 + n) % n]);
    if (start < 0) return 'few'; // все стороны одного направления
    // Прямые: подряд идущие стороны одного направления; у каждой — значение y (вдоль x) или x (вдоль y)
    const lineOf = new Array<number>(n);
    const lines: { dir: 0 | 1; value: number }[] = [];
    let w = 0, acc = 0, cnt = 0, sum = 0;
    for (let s = 0; s < n; s++) {
      const k = (start + s) % n;
      const a = p[k], b = p[(k + 1) % n], d = dir[k]!;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]), mid = d === 0 ? (a[1] + b[1]) / 2 : (a[0] + b[0]) / 2;
      w += len; acc += len * mid; cnt++; sum += mid;
      lineOf[k] = lines.length;
      if (dir[(k + 1) % n] !== d) { lines.push({ dir: d, value: w > 1e-9 ? acc / w : sum / cnt }); w = acc = cnt = sum = 0; }
    }
    if (lines.length < 4) return 'few';
    out.push(p.map((q, k) => {
      const before = lines[lineOf[(k - 1 + n) % n]], after = lines[lineOf[k]];
      if (before === after) return fromFrame(after.dir === 0 ? [q[0], after.value] : [after.value, q[1]]); // узел на прямой
      const h = before.dir === 0 ? before : after, v = before.dir === 0 ? after : before;
      return fromFrame([v.value, h.value]);
    }));
  }
  return { rings: out, maxDeviation };
}

/**
 * То же для незамкнутой линии: углы — пересечения соседних прямых, концы проецируются на свою прямую.
 * Строка — почему нельзя.
 */
export function orthogonalizeLine(line: Pt[], maxDeg = MAX_DEVIATION_DEG): Pt[] | string {
  const n = line.length - 1;
  if (n < 2) return 'few';
  let sx = 0, sy = 0;
  for (let k = 0; k < n; k++) {
    const [ax, ay] = line[k], [bx, by] = line[k + 1];
    const len = Math.hypot(bx - ax, by - ay), phi = Math.atan2(by - ay, bx - ax);
    sx += len * Math.cos(4 * phi); sy += len * Math.sin(4 * phi);
  }
  const theta = Math.atan2(sy, sx) / 4, cos = Math.cos(theta), sin = Math.sin(theta);
  const p = line.map(([x, y]): Pt => [x * cos + y * sin, -x * sin + y * cos]);
  const lines: { dir: 0 | 1; w: number; acc: number }[] = [];
  const lineOf: number[] = [];
  for (let k = 0; k < n; k++) {
    const a = p[k], b = p[k + 1], dx = Math.abs(b[0] - a[0]), dy = Math.abs(b[1] - a[1]), len = Math.hypot(dx, dy);
    if ((Math.atan2(Math.min(dx, dy), Math.max(dx, dy)) * 180) / Math.PI > maxDeg) return 'skewed';
    const dir = dx >= dy ? 0 : 1, last = lines[lines.length - 1];
    const cur = last && (last.dir === dir || len < 1e-6) ? last : (lines.push({ dir, w: 0, acc: 0 }), lines[lines.length - 1]);
    cur.w += len; cur.acc += len * (cur.dir === 0 ? (a[1] + b[1]) / 2 : (a[0] + b[0]) / 2);
    lineOf.push(lines.length - 1);
  }
  const value = (l: { w: number; acc: number }) => l.acc / (l.w || 1);
  return p.map((q, k) => {
    const before = lines[lineOf[Math.max(k - 1, 0)]], after = lines[lineOf[Math.min(k, n - 1)]];
    const [x, y]: Pt = before === after
      ? (after.dir === 0 ? [q[0], value(after)] : [value(after), q[1]])
      : before.dir === 0 ? [value(after), value(before)] : [value(before), value(after)];
    return [x * cos - y * sin, x * sin + y * cos];
  });
}

/** Насколько сторона может отклоняться от прямого угла, чтобы её выровнять, градусы (в iD — 13°). */
export const MAX_DEVIATION_DEG = 20;

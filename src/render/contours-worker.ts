/// <reference lib="webworker" />
import mlcontour from 'maplibre-contour';
import { demHeights, DEM_SIZE } from '../view/dem-tiles';

/**
 * Воркер горизонталей: тайл высот с 8 соседями (без разрывов на стыках) → изолинии (maplibre-contour) →
 * отрезки в локальных метрах тайла (от северо-западного угла: x — восток, y — север, z — отметка).
 * В основном потоке это десятки миллисекунд на тайл — подвисания при движении карты.
 */
export interface ContourJob { id: number; z: number; x: number; y: number; minor: number; major: number }
/** labels — по 4 числа на подпись: долгота, широта, отметка, поворот текста (градусы по часовой от востока). */
export interface ContourResult { id: number; minor: Float32Array; major: Float32Array; metre: number; labels: Float64Array }

const EXTENT = 4096;
/** Допуск упрощения ломаных, единицы тайла: пиксель тайла высот (изолинии идут вершиной на каждый пиксель). */
const SIMPLIFY = EXTENT / DEM_SIZE;

/** Дуглас — Пекер для ломаной [x0, y0, x1, y1, …]: вершины, отклоняющиеся меньше tol, выбрасываются. */
function simplify(l: number[], tol: number): number[] {
  const n = l.length / 2;
  if (n < 3) return l;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  const t2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const ax = l[a * 2], ay = l[a * 2 + 1], dx = l[b * 2] - ax, dy = l[b * 2 + 1] - ay, len2 = dx * dx + dy * dy;
    let best = -1, far = t2;
    for (let i = a + 1; i < b; i++) {
      const px = l[i * 2] - ax, py = l[i * 2 + 1] - ay;
      const t = len2 > 0 ? Math.max(0, Math.min(1, (px * dx + py * dy) / len2)) : 0;
      const ex = px - t * dx, ey = py - t * dy, d = ex * ex + ey * ey;
      if (d > far) { far = d; best = i; }
    }
    if (best >= 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(l[i * 2], l[i * 2 + 1]);
  return out;
}

/** Подписи: шаг вдоль утолщённой линии и полуширина разрыва под текст, единицы тайла (4096 ≈ 1000–2000 px экрана). */
const LABEL_STEP = EXTENT * 0.6;
const LABEL_GAP = 110;

/**
 * Места подписей на ломаной (с шагом, только на почти прямых участках и внутри тайла — соседний подпишет свои) и та
 * же ломаная отрезками с разрывами под них: [отрезки, подписи (x, y, угол)].
 */
function labelled(l: number[]): [number[], [number, number, number][]] {
  const n = l.length / 2;
  const cum = [0];
  for (let i = 1; i < n; i++) cum.push(cum[i - 1] + Math.hypot(l[i * 2] - l[i * 2 - 2], l[i * 2 + 1] - l[i * 2 - 1]));
  const total = cum[n - 1];
  const at = (s: number): [number, number] => {
    let i = 1;
    while (i < n - 1 && cum[i] < s) i++;
    const t = cum[i] > cum[i - 1] ? (s - cum[i - 1]) / (cum[i] - cum[i - 1]) : 0;
    return [l[i * 2 - 2] + (l[i * 2] - l[i * 2 - 2]) * t, l[i * 2 - 1] + (l[i * 2 + 1] - l[i * 2 - 1]) * t];
  };
  const labels: [number, number, number][] = [], cuts: [number, number][] = [];
  for (let s = LABEL_STEP / 2; s + LABEL_GAP < total; s += LABEL_STEP) {
    if (s < LABEL_GAP) continue;
    const a = at(s - LABEL_GAP), c = at(s), b = at(s + LABEL_GAP);
    if (c[0] < 0 || c[0] >= EXTENT || c[1] < 0 || c[1] >= EXTENT) continue;
    // Почти прямо: хорда разрыва не короче 92 % пути по линии
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 2 * LABEL_GAP * 0.92) continue;
    let ang = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
    if (ang > 90) ang -= 180; else if (ang < -90) ang += 180;
    labels.push([c[0], c[1], ang]);
    cuts.push([s - LABEL_GAP, s + LABEL_GAP]);
  }
  const segs: number[] = [];
  for (let i = 1; i < n; i++) {
    let from = cum[i - 1];
    const to = cum[i];
    for (const [c0, c1] of cuts) {
      if (c1 <= from || c0 >= to) continue;
      if (c0 > from) { const p = at(from), q = at(c0); segs.push(p[0], p[1], q[0], q[1]); }
      from = Math.max(from, c1);
    }
    if (from < to) { const p = at(from), q = at(to); segs.push(p[0], p[1], q[0], q[1]); }
  }
  return [segs, labels];
}

async function heightTile(z: number, x: number, y: number) {
  const h = await demHeights(z, x, y);
  return h && new mlcontour.HeightTile(DEM_SIZE, DEM_SIZE, (px, py) => h[py * DEM_SIZE + px]);
}

self.onmessage = async (ev: MessageEvent<ContourJob>) => {
  const { id, z, x, y, minor, major } = ev.data;
  try {
    const n = 2 ** z;
    const near: Promise<InstanceType<typeof mlcontour.HeightTile> | undefined>[] = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const yy = y + dy, xx = (((x + dx) % n) + n) % n;
      near.push(yy < 0 || yy >= n ? Promise.resolve(undefined) : heightTile(z, xx, yy).catch(() => undefined));
    }
    const combined = mlcontour.HeightTile.combineNeighbors(await Promise.all(near));
    if (!combined) { self.postMessage({ id, minor: new Float32Array(0), major: new Float32Array(0), metre: 1, labels: new Float64Array(0) }); return; }
    const lines = mlcontour.generateIsolines(minor, combined.materialize(2).averagePixelCentersToGrid().materialize(1), EXTENT, 1);
    // Метр в единицах Меркатора у центра тайла (как MercatorCoordinate.meterInMercatorCoordinateUnits)
    const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / n))) * (180 / Math.PI);
    const metre = 1 / (40075016.68557849 * Math.cos((lat * Math.PI) / 180));
    const k = 1 / n / EXTENT / metre;
    const out = { minor: [] as number[], major: [] as number[] }, labels: number[] = [];
    const lon = (px: number) => ((x + px / EXTENT) / n) * 360 - 180;
    const latOf = (py: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + py / EXTENT)) / n))) * 180) / Math.PI;
    for (const [eleStr, list] of Object.entries(lines)) {
      const ele = Number(eleStr), isMajor = ele % major === 0, seg = isMajor ? out.major : out.minor;
      for (const raw of list) {
        const l = simplify(raw, SIMPLIFY);
        // Утолщённые — с подписями: разрыв в самой линии, подпись — точно в нём
        if (isMajor) {
          const [segs, marks] = labelled(l);
          for (let i = 0; i + 3 < segs.length; i += 4) seg.push(segs[i] * k, -segs[i + 1] * k, ele, segs[i + 2] * k, -segs[i + 3] * k, ele);
          for (const [px, py, ang] of marks) labels.push(lon(px), latOf(py), ele, ang);
          continue;
        }
        for (let i = 0; i + 3 < l.length; i += 2) seg.push(l[i] * k, -l[i + 1] * k, ele, l[i + 2] * k, -l[i + 3] * k, ele);
      }
    }
    const res: ContourResult = { id, minor: new Float32Array(out.minor), major: new Float32Array(out.major), metre, labels: new Float64Array(labels) };
    self.postMessage(res, [res.minor.buffer, res.major.buffer, res.labels.buffer]);
  } catch {
    self.postMessage({ id, minor: new Float32Array(0), major: new Float32Array(0), metre: 1, labels: new Float64Array(0) });
  }
};

/// <reference lib="webworker" />
import mlcontour from 'maplibre-contour';
import { demHeights, DEM_SIZE } from '../view/dem-tiles';

/**
 * Воркер горизонталей: тайл высот с 8 соседями (без разрывов на стыках) → изолинии (maplibre-contour) →
 * отрезки в локальных метрах тайла (от северо-западного угла: x — восток, y — север, z — отметка).
 * В основном потоке это десятки миллисекунд на тайл — подвисания при движении карты.
 */
export interface ContourJob { id: number; z: number; x: number; y: number; minor: number; major: number }
/**
 * labels — по 4 числа на подпись: x, y (локальные метры тайла), отметка, направление линии (градусы, против часовой от
 * востока в локальных осях).
 * majorMask — по 4 числа на отрезок утолщённых: точка подписи (локальные метры, z — отметка) и радиус маски в
 * экранных пикселях (0 — отрезок не у подписи): линия под подписью отбрасывается шейдером.
 */
export interface ContourResult { id: number; minor: Float32Array; major: Float32Array; majorMask: Float32Array; metre: number; labels: Float64Array }

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

/**
 * Подписи: шаг вдоль утолщённой линии; окно вокруг подписи, единицы тайла, — его отрезки короткие и знают подпись
 * (маска в шейдере); не меньше радиуса маски при самом мелком показе тайла (~4 единицы на экранный пиксель).
 */
const LABEL_STEP = EXTENT * 0.6;
const LABEL_WINDOW = 150;
/** Полуширина подписи в экранных пикселях: «1,290 м» шрифтом 10 px. */
const labelRadius = (ele: number) => { const d = String(Math.abs(ele)).length; return ((d + Math.floor((d - 1) / 3) + 2 + (ele < 0 ? 1 : 0)) * 5.6) / 2 + 4; };

/**
 * Места подписей на ломаной (с шагом, только на почти прямых участках и внутри тайла — соседний подпишет свои) и
 * отрезки ломаной: у подписи — разбиты на короткие куски с номером подписи (иначе −1).
 */
function labelled(l: number[]): [number[], number[], [number, number, number][]] {
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
  const labels: [number, number, number][] = [], wins: [number, number][] = [];
  for (let s = LABEL_STEP / 2; s + LABEL_WINDOW < total; s += LABEL_STEP) {
    if (s < LABEL_WINDOW) continue;
    const a = at(s - LABEL_WINDOW / 2), c = at(s), b = at(s + LABEL_WINDOW / 2);
    if (c[0] < 0 || c[0] >= EXTENT || c[1] < 0 || c[1] >= EXTENT) continue;
    // Почти прямо: хорда под подписью не короче 92 % пути по линии
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < LABEL_WINDOW * 0.92) continue;
    let ang = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
    if (ang > 90) ang -= 180; else if (ang < -90) ang += 180;
    labels.push([c[0], c[1], ang]);
    wins.push([s - LABEL_WINDOW, s + LABEL_WINDOW]);
  }
  // Точки разбиения: вершины ломаной и края окон с шагом ~1/8 окна внутри (маска считается по вершинам отрезка)
  const cutsAt: number[] = [...cum];
  for (const [w0, w1] of wins) for (let s = w0; s <= w1 + 1e-6; s += LABEL_WINDOW / 8) cutsAt.push(Math.max(0, Math.min(total, s)));
  cutsAt.sort((p, q) => p - q);
  const segs: number[] = [], owner: number[] = [];
  for (let i = 1; i < cutsAt.length; i++) {
    const s0 = cutsAt[i - 1], s1 = cutsAt[i];
    if (s1 - s0 < 1e-6) continue;
    const p = at(s0), q = at(s1), mid = (s0 + s1) / 2;
    segs.push(p[0], p[1], q[0], q[1]);
    owner.push(wins.findIndex(([w0, w1]) => mid >= w0 && mid <= w1));
  }
  return [segs, owner, labels];
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
    if (!combined) { self.postMessage({ id, minor: new Float32Array(0), major: new Float32Array(0), majorMask: new Float32Array(0), metre: 1, labels: new Float64Array(0) }); return; }
    const lines = mlcontour.generateIsolines(minor, combined.materialize(2).averagePixelCentersToGrid().materialize(1), EXTENT, 1);
    // Метр в единицах Меркатора у центра тайла (как MercatorCoordinate.meterInMercatorCoordinateUnits)
    const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / n))) * (180 / Math.PI);
    const metre = 1 / (40075016.68557849 * Math.cos((lat * Math.PI) / 180));
    const k = 1 / n / EXTENT / metre;
    const out = { minor: [] as number[], major: [] as number[], mask: [] as number[] }, labels: number[] = [];
    for (const [eleStr, list] of Object.entries(lines)) {
      const ele = Number(eleStr), isMajor = ele % major === 0, seg = isMajor ? out.major : out.minor;
      for (const raw of list) {
        const l = simplify(raw, SIMPLIFY);
        // Утолщённые — с подписями: разрыв в самой линии, подпись — точно в нём
        if (isMajor) {
          const [segs, owner, marks] = labelled(l), r = labelRadius(ele);
          for (let i = 0, j = 0; i + 3 < segs.length; i += 4, j++) {
            seg.push(segs[i] * k, -segs[i + 1] * k, ele, segs[i + 2] * k, -segs[i + 3] * k, ele);
            const lab = owner[j] >= 0 ? marks[owner[j]] : undefined;
            out.mask.push(lab ? lab[0] * k : 0, lab ? -lab[1] * k : 0, ele, lab ? r : 0);
          }
          for (const [px, py, ang] of marks) labels.push(px * k, -py * k, ele, -ang);
          continue;
        }
        for (let i = 0; i + 3 < l.length; i += 2) {
          seg.push(l[i] * k, -l[i + 1] * k, ele, l[i + 2] * k, -l[i + 3] * k, ele);
          if (isMajor) out.mask.push(0, 0, 0, 0);
        }
      }
    }
    const res: ContourResult = { id, minor: new Float32Array(out.minor), major: new Float32Array(out.major), majorMask: new Float32Array(out.mask), metre, labels: new Float64Array(labels) };
    self.postMessage(res, [res.minor.buffer, res.major.buffer, res.majorMask.buffer, res.labels.buffer]);
  } catch {
    self.postMessage({ id, minor: new Float32Array(0), major: new Float32Array(0), majorMask: new Float32Array(0), metre: 1, labels: new Float64Array(0) });
  }
};

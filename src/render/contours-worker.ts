/// <reference lib="webworker" />
import mlcontour from 'maplibre-contour';
import { demHeights, DEM_SIZE } from '../view/dem-tiles';

/**
 * Воркер горизонталей: тайл высот с 8 соседями (без разрывов на стыках) → изолинии (maplibre-contour) →
 * отрезки в локальных метрах тайла (от северо-западного угла: x — восток, y — север, z — отметка).
 * В основном потоке это десятки миллисекунд на тайл — подвисания при движении карты.
 */
export interface ContourJob { id: number; z: number; x: number; y: number; minor: number; major: number }
export interface ContourResult { id: number; minor: Float32Array; major: Float32Array; metre: number }

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
    if (!combined) { self.postMessage({ id, minor: new Float32Array(0), major: new Float32Array(0), metre: 1 }); return; }
    const lines = mlcontour.generateIsolines(minor, combined.materialize(2).averagePixelCentersToGrid().materialize(1), EXTENT, 1);
    // Метр в единицах Меркатора у центра тайла (как MercatorCoordinate.meterInMercatorCoordinateUnits)
    const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / n))) * (180 / Math.PI);
    const metre = 1 / (40075016.68557849 * Math.cos((lat * Math.PI) / 180));
    const k = 1 / n / EXTENT / metre;
    const out = { minor: [] as number[], major: [] as number[] };
    for (const [eleStr, list] of Object.entries(lines)) {
      const ele = Number(eleStr), seg = ele % major === 0 ? out.major : out.minor;
      for (const raw of list) { const l = simplify(raw, SIMPLIFY); for (let i = 0; i + 3 < l.length; i += 2) seg.push(l[i] * k, -l[i + 1] * k, ele, l[i + 2] * k, -l[i + 3] * k, ele); }
    }
    const res: ContourResult = { id, minor: new Float32Array(out.minor), major: new Float32Array(out.major), metre };
    self.postMessage(res, [res.minor.buffer, res.major.buffer]);
  } catch {
    self.postMessage({ id, minor: new Float32Array(0), major: new Float32Array(0), metre: 1 });
  }
};

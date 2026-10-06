import type { Feature, Geometry, MultiPolygon } from 'geojson';
import polygonClipping from 'polygon-clipping';

export type Ring = [number, number][];

export interface TileBuilding {
  id: number;
  geometry: Geometry;
  height: number;
  minHeight: number;
  colour?: string;
}

interface Piece { id: number; polys: Ring[][]; area: number; bbox: [number, number, number, number]; c: [number, number]; h: number; min: number; colour?: string }

const OUTLINE_COVERAGE = 0.5;

export interface OutlineRemainders {
  /** Тайловые фичи, которые заменяются остатками. */
  replacedIds: Set<number>;
  /** «Контур минус части» — рендерится на высоте контура. */
  remainders: Feature<MultiPolygon>[];
}

/**
 * Simple 3D по тайлам. OpenMapTiles ставит hide_3d только контурам из отношений type=building,
 * поэтому остальные контуры рисуются поверх своих building:part.
 *
 * Для каждой фичи A ищем вложенные фичи B, пересекающиеся с ней по высоте (B.min < A.height;
 * иначе B стоит сверху, как ярус башни), и заменяем A на A − ∪B той же высоты.
 *
 * Ограничение: в тайлах нет признака building/building:part, поэтому «контур с частями» и «часть
 * с вложенными деталями» различаем только по доле покрытия — это эвристика. Ошибка даёт «яму»
 * в части, а не пропавшее здание.
 */
export function computeOutlineRemainders(features: TileBuilding[]): OutlineRemainders {
  const pieces = features.flatMap(toPiece);
  const cell = 0.0005;
  const grid = new Map<string, Piece[]>();
  for (const p of pieces) {
    const k = `${Math.floor(p.c[0] / cell)}:${Math.floor(p.c[1] / cell)}`;
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(p);
  }

  // Проход 1: что вычитать из каждого куска
  const inners = new Map<Piece, Ring[][]>();
  for (const a of pieces) {
    const inner: Piece[] = [];
    const [x0, y0, x1, y1] = a.bbox;
    for (let gx = Math.floor(x0 / cell); gx <= Math.floor(x1 / cell); gx++) {
      for (let gy = Math.floor(y0 / cell); gy <= Math.floor(y1 / cell); gy++) {
        for (const b of grid.get(`${gx}:${gy}`) ?? []) {
          // Высоты в тайлах округлены до метра — допуск 0.5 м
          if (b.id === a.id || b.min >= a.h - 0.5 || b.area >= a.area) continue;
          if (a.polys.some((poly) => inPolygon(b.c, poly))) inner.push(b);
        }
      }
    }
    // Покрыта вложенными фичами в основном — похоже на контур, вычитаем всё (по спеке контур не рисуется).
    // Иначе, скорее, это часть с вложенными деталями — вычитаем только то, что не ниже её самой
    // (башня на основании), чтобы не проделать «яму» до высоты более низкой детали.
    const covered = inner.reduce((s, b) => s + b.area, 0) >= a.area * OUTLINE_COVERAGE;
    const cut = covered ? inner : inner.filter((b) => b.h >= a.h - 1);
    if (cut.length) inners.set(a, cut.flatMap((b) => b.polys));
  }
  const replacedIds = new Set([...inners.keys()].map((p) => p.id));

  // Проход 2: остаток для каждого куска заменяемой фичи. Фича, разрезанная границей тайлов,
  // приходит несколькими кусками — куски без вложенных частей тоже нужно отдать целиком.
  const remainders: Feature<MultiPolygon>[] = [];
  for (const a of pieces) {
    if (!replacedIds.has(a.id)) continue;
    const inner = inners.get(a);
    let rest = a.polys;
    if (inner) {
      try {
        rest = polygonClipping.difference(a.polys as never, ...(inner as never[])) as Ring[][];
      } catch {
        // вырожденная геометрия — рисуем кусок как есть
      }
    }
    if (!rest.length) continue;
    remainders.push({
      type: 'Feature',
      id: a.id,
      geometry: { type: 'MultiPolygon', coordinates: rest },
      properties: { render_height: a.h, render_min_height: a.min, colour: a.colour },
    });
  }
  return { replacedIds, remainders };
}

function toPiece(f: TileBuilding): Piece[] {
  const g = f.geometry;
  const polys = polygonsOf(g);
  if (!polys.length) return [];
  let area = 0, cx = 0, cy = 0, n = 0;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const poly of polys) {
    area += ringArea(poly[0]) - poly.slice(1).reduce((s, h) => s + ringArea(h), 0);
    for (const [x, y] of poly[0]) {
      cx += x; cy += y; n++;
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
  }
  // Для точки внутри берём центр крупнейшего полигона, а не среднее по всем
  const main = polys.reduce((best, p) => (ringArea(p[0]) > ringArea(best[0]) ? p : best));
  const c = interiorPoint(main) ?? [cx / n, cy / n];
  return [{ id: f.id, polys, area, bbox: [x0, y0, x1, y1], c, h: f.height, min: f.minHeight, colour: f.colour }];
}

function ringArea(r: Ring): number {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]);
  return Math.abs(a / 2);
}

function inRing([x, y]: [number, number], r: Ring): boolean {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function inPolygon(p: [number, number], poly: Ring[]): boolean {
  return inRing(p, poly[0]) && !poly.slice(1).some((h) => inRing(p, h));
}

/** Точка гарантированно внутри полигона (центроид у Г-образных зданий может лежать снаружи). */
export function interiorPoint(poly: Ring[]): [number, number] | undefined {
  const r = poly[0];
  let cx = 0, cy = 0;
  for (const [x, y] of r) { cx += x; cy += y; }
  const c: [number, number] = [cx / r.length, cy / r.length];
  if (inPolygon(c, poly)) return c;
  // Горизонтальная линия через центр: середина самого длинного отрезка внутри полигона
  const xs: number[] = [];
  for (const ring of poly) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if (yi > c[1] !== yj > c[1]) xs.push(((xj - xi) * (c[1] - yi)) / (yj - yi) + xi);
    }
  }
  xs.sort((a, b) => a - b);
  let best: [number, number] | undefined, len = 0;
  for (let i = 0; i + 1 < xs.length; i += 2) {
    if (xs[i + 1] - xs[i] > len) { len = xs[i + 1] - xs[i]; best = [(xs[i] + xs[i + 1]) / 2, c[1]]; }
  }
  return best;
}

/** Полигоны фичи (Polygon/MultiPolygon) как массив колец. */
export function polygonsOf(g: Geometry): Ring[][] {
  return g.type === 'Polygon' ? [g.coordinates as Ring[]] : g.type === 'MultiPolygon' ? (g.coordinates as Ring[][]) : [];
}

const SAMPLES = 12;

export interface OverlapSubject { key: string; src: number; poly: Ring[] }
export interface OverlapOther { id: number; polys: Ring[][] }

/**
 * Доля площади каждого полигона, перекрытая чужими полигонами зданий меньшей площади
 * (контур перекрыт своими частями, а не наоборот). Полигоны той же исходной фичи не считаются —
 * это дубли из соседних тайлов.
 */
export function overlapShares(subjects: OverlapSubject[], others: OverlapOther[]): Map<string, number> {
  const cell = 0.0005;
  const grid = new Map<string, { id: number; poly: Ring[]; bbox: number[]; area: number }[]>();
  const bboxOf = (r: Ring) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of r) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    return [x0, y0, x1, y1];
  };
  for (const o of others) {
    for (const poly of o.polys) {
      const bbox = bboxOf(poly[0]);
      const area = polyArea(poly);
      for (let gx = Math.floor(bbox[0] / cell); gx <= Math.floor(bbox[2] / cell); gx++) {
        for (let gy = Math.floor(bbox[1] / cell); gy <= Math.floor(bbox[3] / cell); gy++) {
          const k = `${gx}:${gy}`;
          (grid.get(k) ?? grid.set(k, []).get(k)!).push({ id: o.id, poly, bbox, area });
        }
      }
    }
  }

  const shares = new Map<string, number>();
  for (const s of subjects) {
    const [x0, y0, x1, y1] = bboxOf(s.poly[0]);
    const own = polyArea(s.poly);
    const cands = new Set<Ring[]>();
    for (let gx = Math.floor(x0 / cell); gx <= Math.floor(x1 / cell); gx++) {
      for (let gy = Math.floor(y0 / cell); gy <= Math.floor(y1 / cell); gy++) {
        for (const c of grid.get(`${gx}:${gy}`) ?? []) {
          if (c.id !== s.src && c.area < own * 0.98 && c.bbox[0] < x1 && c.bbox[2] > x0 && c.bbox[1] < y1 && c.bbox[3] > y0) cands.add(c.poly);
        }
      }
    }
    if (!cands.size || own <= 0) { shares.set(s.key, 0); continue; }
    // Оценка по сетке точек внутри полигона: точное объединение сотен кандидатов слишком медленное
    const list = [...cands];
    let inside = 0, covered = 0;
    for (let i = 0; i < SAMPLES; i++) {
      for (let j = 0; j < SAMPLES; j++) {
        const p: [number, number] = [x0 + ((i + 0.5) / SAMPLES) * (x1 - x0), y0 + ((j + 0.5) / SAMPLES) * (y1 - y0)];
        if (!inPolygon(p, s.poly)) continue;
        inside++;
        if (list.some((c) => inPolygon(p, c))) covered++;
      }
    }
    shares.set(s.key, inside ? covered / inside : 0);
  }
  return shares;
}

function polyArea(poly: Ring[]): number {
  return ringArea(poly[0]) - poly.slice(1).reduce((s, h) => s + ringArea(h), 0);
}

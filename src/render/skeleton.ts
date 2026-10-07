/**
 * Straight skeleton (CGAL в WebAssembly, пакет straight-skeleton) для скатных крыш на контурах любой формы.
 * Модуль весит ~2 МБ, поэтому грузится отдельным чанком; пока он не готов, skeletonOf возвращает null,
 * а после загрузки слои пересобираются (onSkeletonReady).
 */
import type { Pt } from './building-geometry';

export interface Skeleton {
  /** x, y и «время» — расстояние до ближайшей стороны контура. */
  vertices: [number, number, number][];
  /** Грани: каждая опирается на одну сторону контура, вершины — индексы в vertices. */
  polygons: number[][];
}

type Builder = { init(): Promise<void>; buildFromPolygon(rings: number[][][]): Skeleton | null };

let builder: Builder | undefined;

export const skeletonReady: Promise<boolean> = import('straight-skeleton')
  .then(async (m) => {
    const b = ((m as { SkeletonBuilder?: Builder }).SkeletonBuilder ??
      (m as { default: { SkeletonBuilder: Builder } }).default.SkeletonBuilder);
    await b.init();
    builder = b;
    return true;
  })
  .catch((err) => {
    console.warn('straight skeleton недоступен — сложные крыши будут плоскими:', err);
    return false;
  });

const signedArea = (r: Pt[]) => {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]);
  return a / 2; // > 0 — против часовой
};

/** Скелет полигона (внешнее кольцо + дыры, без повторённой точки). null — модуль не готов или CGAL не справился. */
export function skeletonOf(outer: Pt[], inners: Pt[][]): Skeleton | null {
  if (!builder) return null;
  const orient = (r: Pt[], ccw: boolean) => {
    const ring = signedArea(r) > 0 === ccw ? r : [...r].reverse();
    return [...ring, ring[0]];
  };
  try {
    return builder.buildFromPolygon([orient(outer, true), ...inners.map((r) => orient(r, false))]);
  } catch (err) {
    console.warn('straight skeleton:', err);
    return null;
  }
}

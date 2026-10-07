/// <reference lib="webworker" />
/**
 * Web Worker для straight skeleton: CGAL на отдельных полигонах иногда считает секундами
 * (вырожденные контуры), в главном потоке это зависание всей карты.
 */
type Builder = { init(): Promise<void>; buildFromPolygon(rings: number[][][]): unknown };

// UMD-сборка straight-skeleton проверяет window, чтобы понять, что она в браузере
(self as unknown as { window: unknown }).window = self;

const ready: Promise<Builder> = import('straight-skeleton').then(async (m) => {
  const b = (m as { SkeletonBuilder?: Builder }).SkeletonBuilder ?? (m as { default: { SkeletonBuilder: Builder } }).default.SkeletonBuilder;
  await b.init();
  return b;
});

self.onmessage = async (e: MessageEvent<{ id: number; rings: number[][][] }>) => {
  const b = await ready;
  let skeleton: unknown = null;
  try { skeleton = b.buildFromPolygon(e.data.rings); } catch { /* CGAL не справился — крыша будет плоской */ }
  self.postMessage({ id: e.data.id, skeleton });
};

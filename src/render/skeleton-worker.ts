/// <reference lib="webworker" />
/**
 * Web Worker для straight skeleton: CGAL на отдельных полигонах иногда считает секундами
 * (вырожденные контуры), в главном потоке это зависание всей карты.
 */
type Builder = { init(): Promise<void>; buildFromPolygon(rings: number[][][]): unknown };
import { buildStableSkeleton } from './skeleton-stabilize';

// UMD-сборка straight-skeleton проверяет window, чтобы понять, что она в браузере
(self as unknown as { window: unknown }).window = self;

const ready: Promise<Builder> = import('straight-skeleton').then(async (m) => {
  const b = (m as { SkeletonBuilder?: Builder }).SkeletonBuilder ?? (m as { default: { SkeletonBuilder: Builder } }).default.SkeletonBuilder;
  await b.init();
  return b;
});
// Готовность — отдельным сообщением: сторожевой таймер главного потока не должен включать загрузку WASM
void ready.then(() => self.postMessage({ ready: true }));

self.onmessage = async (e: MessageEvent<{ id: number; rings: number[][][]; stabilize: boolean }>) => {
  const b = await ready;
  let skeleton: unknown = null, broken = false;
  try { skeleton = e.data.stabilize ? buildStableSkeleton(b as Parameters<typeof buildStableSkeleton>[0], e.data.rings) : b.buildFromPolygon(e.data.rings); } catch (err) {
    // CGAL не справился — крыша будет плоской. Аварийный выход WASM (assert на вырожденном контуре) оставляет модуль
    // сломанным: дальше все крыши были бы плоскими — просим главный поток заменить воркер
    broken = err instanceof WebAssembly.RuntimeError || /Abort/.test(String(err));
  }
  self.postMessage({ id: e.data.id, skeleton, broken });
};

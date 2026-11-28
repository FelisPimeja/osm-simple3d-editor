/// <reference lib="webworker" />
import mlcontour from 'maplibre-contour';
import { demUrl, DEM_MAX_ZOOM, demTileBlob } from '../view/dem-tiles';

/**
 * Воркер векторных тайлов горизонталей для 2D-слоя (maplibre-contour): изолинии и кодирование тайла — здесь, а не
 * в основном потоке (там подгрузка горизонталей давала кадры по 50–130 мс). Тайлы высот — с подстановкой
 * отсутствующих зумов из родителя (demTileBlob), как в основном потоке.
 */
export type ContourTileJob = { id: number; z: number; x: number; y: number; options: unknown; dem: string } | { id: number; abort: true };
export type ContourTileResult = { id: number; data?: ArrayBuffer; error?: string };

/** Менеджер на источник высот: у каждого свои кеши горизонталей. */
const managers = new Map<string, InstanceType<typeof mlcontour.LocalDemManager>>();
const managerOf = (dem: string) => {
  let m = managers.get(dem);
  if (!m) managers.set(dem, m = new mlcontour.LocalDemManager({ demUrlPattern: demUrl(dem), cacheSize: 100, encoding: 'terrarium', maxzoom: DEM_MAX_ZOOM, timeoutMs: 10_000, getTile: demTileBlob }));
  return m;
};
const aborts = new Map<number, AbortController>();

self.onmessage = async (ev: MessageEvent<ContourTileJob>) => {
  const job = ev.data;
  if ('abort' in job) { aborts.get(job.id)?.abort(); aborts.delete(job.id); return; }
  const ac = new AbortController();
  aborts.set(job.id, ac);
  try {
    const manager = managerOf(job.dem);
    const tile = await manager.fetchContourTile(job.z, job.x, job.y, job.options as Parameters<typeof manager.fetchContourTile>[3], ac);
    // Копия: буфер тайла лежит в кеше менеджера — отдать его самого нельзя
    const data = tile.arrayBuffer.slice(0);
    (self as unknown as Worker).postMessage({ id: job.id, data } satisfies ContourTileResult, [data]);
  } catch (e) {
    (self as unknown as Worker).postMessage({ id: job.id, error: String(e) } satisfies ContourTileResult);
  } finally {
    aborts.delete(job.id);
  }
};

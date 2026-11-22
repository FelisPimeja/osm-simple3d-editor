/// <reference lib="webworker" />
import mlcontour from 'maplibre-contour';
import { DEM_URL, DEM_MAX_ZOOM, demTileBlob } from '../view/dem-tiles';

/**
 * Воркер векторных тайлов горизонталей для 2D-слоя (maplibre-contour): изолинии и кодирование тайла — здесь, а не
 * в основном потоке (там подгрузка горизонталей давала кадры по 50–130 мс). Тайлы высот — с подстановкой
 * отсутствующих зумов из родителя (demTileBlob), как в основном потоке.
 */
export type ContourTileJob = { id: number; z: number; x: number; y: number; options: unknown } | { id: number; abort: true };
export type ContourTileResult = { id: number; data?: ArrayBuffer; error?: string };

const manager = new mlcontour.LocalDemManager({ demUrlPattern: DEM_URL, cacheSize: 100, encoding: 'terrarium', maxzoom: DEM_MAX_ZOOM, timeoutMs: 10_000, getTile: demTileBlob });
const aborts = new Map<number, AbortController>();

self.onmessage = async (ev: MessageEvent<ContourTileJob>) => {
  const job = ev.data;
  if ('abort' in job) { aborts.get(job.id)?.abort(); aborts.delete(job.id); return; }
  const ac = new AbortController();
  aborts.set(job.id, ac);
  try {
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

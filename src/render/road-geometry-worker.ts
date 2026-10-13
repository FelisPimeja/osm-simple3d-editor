/// <reference lib="webworker" />
/** Web Worker сборки мостов и тоннелей: на плотной развязке это сотни миллисекунд — не в главном потоке. */
import { buildRoadMesh, type Obstacle } from './road-geometry';
import type { LonLat } from '../osm/model';
import type { RoadWay } from '../osm/roads';

/** ox, oy — начало локальной системы в координатах Меркатора, m — метр в них. */
interface Job { id: number; ways: RoadWay[]; obstacles: Obstacle[]; ox: number; oy: number; m: number }

self.onmessage = (e: MessageEvent<Job>) => {
  const { id, ways, obstacles, ox, oy, m } = e.data;
  // То же, что MercatorCoordinate.fromLngLat, без maplibre в воркере
  const toLocal = ([lng, lat]: LonLat): [number, number] => {
    const x = (lng + 180) / 360;
    const y = (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360;
    return [(x - ox) / m, -(y - oy) / m];
  };
  const data = buildRoadMesh(ways, toLocal, obstacles);
  const buffers = [data.solid, data.glass].flatMap((p) => [p.positions.buffer, p.colors.buffer, p.ways.buffer]);
  self.postMessage({ id, data }, buffers);
};

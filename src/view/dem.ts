import type { LonLat } from '../osm/model';
import { demHeights } from './dem-tiles';

/**
 * Рельеф (эксперимент): тайлы Mapterhorn (terrarium, 512 px). Те же тайлы MapLibre рисует как terrain, а здесь они
 * декодируются для отметок объектов сцены: основание здания — минимум DEM под контуром, деревья и ограждения —
 * по точкам. Пока тайла нет, отметка — 0; пришёл — onLoad (сцену пересобрать).
 */
export const DEM_ATTRIBUTION = "<a href='https://mapterhorn.com/attribution' target='_blank'>© Mapterhorn</a>";
/**
 * Зум выборки отметок: z15 (~3 м/px на 512 px) — там, где есть лидар, отметки совпадают с подробным рельефом
 * MapLibre; где его нет, тайл собирается из z12 (см. dem-tiles).
 */
const DEM_ZOOM = 15;
const SIZE = 512;

type Tile = Float32Array | 'loading' | 'failed';

export class Dem {
  private readonly tiles = new Map<string, Tile>();
  private enabled = false;
  /** Растёт при каждом пришедшем тайле: по нему слои видят, что отметки поменялись. */
  revision = 0;
  private notify?: ReturnType<typeof setTimeout>;

  constructor(private readonly onLoad: () => void) {}

  get active() { return this.enabled; }

  setActive(on: boolean) {
    if (on === this.enabled) return;
    this.enabled = on;
    this.revision++;
  }

  /** Отметка точки, м над уровнем моря (билинейно); тайла ещё нет или рельеф выключен — 0 (тайл запрашивается). */
  at(p: LonLat): number {
    return this.sample(p) ?? 0;
  }

  /** Отметка точки; undefined — рельеф выключен или тайл ещё не пришёл (не загрузился). */
  private sample([lon, lat]: LonLat): number | undefined {
    if (!this.enabled) return;
    const n = 2 ** DEM_ZOOM;
    const x = ((lon + 180) / 360) * n;
    const s = Math.sin((lat * Math.PI) / 180);
    const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n;
    const tx = Math.floor(x), ty = Math.floor(y);
    const t = this.tile(tx, ty);
    if (!(t instanceof Float32Array)) return;
    // Центры пикселей — на половинках: крайние берём по краю тайла (без соседнего тайла)
    const px = Math.min(SIZE - 1, Math.max(0, (x - tx) * SIZE - 0.5)), py = Math.min(SIZE - 1, Math.max(0, (y - ty) * SIZE - 0.5));
    const x0 = Math.floor(px), y0 = Math.floor(py), x1 = Math.min(SIZE - 1, x0 + 1), y1 = Math.min(SIZE - 1, y0 + 1);
    const fx = px - x0, fy = py - y0;
    const v = (xx: number, yy: number) => t[yy * SIZE + xx];
    return (v(x0, y0) * (1 - fx) + v(x1, y0) * fx) * (1 - fy) + (v(x0, y1) * (1 - fx) + v(x1, y1) * fx) * fy;
  }

  /**
   * Минимум отметки под кольцами (вершины и сетка внутри с шагом ~10 м): основание здания на склоне — по нижней
   * точке, верхняя сторона уходит в землю, а не висит в воздухе.
   */
  minUnder(rings: LonLat[][]): number {
    if (!this.enabled) return 0;
    let min = Infinity;
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const r of rings) for (const p of r) {
      const v = this.sample(p);
      if (v !== undefined) min = Math.min(min, v);
      w = Math.min(w, p[0]); e = Math.max(e, p[0]); s = Math.min(s, p[1]); n = Math.max(n, p[1]);
    }
    const outer = rings[0];
    const dLat = 10 / 111_320, dLon = dLat / Math.max(0.05, Math.cos((((s + n) / 2) * Math.PI) / 180));
    // Не больше ~400 проб на объект (огромные контуры — реже)
    const k = Math.max(1, Math.sqrt((((e - w) / dLon) * ((n - s) / dLat)) / 400));
    for (let y = s + dLat * k / 2; y < n; y += dLat * k) for (let x = w + dLon * k / 2; x < e; x += dLon * k) {
      const v = outer && inRing([x, y], outer) ? this.sample([x, y]) : undefined;
      if (v !== undefined) min = Math.min(min, v);
    }
    return Number.isFinite(min) ? min : 0;
  }

  private tile(x: number, y: number): Tile | undefined {
    const n = 2 ** DEM_ZOOM;
    if (y < 0 || y >= n) return 'failed';
    const xx = ((x % n) + n) % n, key = `${xx}/${y}`;
    const t = this.tiles.get(key);
    if (t) return t;
    this.tiles.set(key, 'loading');
    void this.load(xx, y).then((data) => {
      this.tiles.set(key, data ?? 'failed');
      // Сбой загрузки (сеть, ответ сервера) — не навсегда: через 10 с тайл запросится снова при следующей выборке,
      // иначе здания под ним остались бы на 0 м под рельефом
      if (!data) { setTimeout(() => { if (this.tiles.get(key) === 'failed') this.tiles.delete(key); this.revision++; this.onLoad(); }, 10_000); return; }
      this.revision++;
      // Тайлы приходят пачкой: пересборка — одна на пачку
      clearTimeout(this.notify);
      this.notify = setTimeout(() => this.onLoad(), 150);
    });
    return 'loading';
  }

  private async load(x: number, y: number): Promise<Float32Array | undefined> {
    try { return await demHeights(DEM_ZOOM, x, y); } catch { return; }
  }
}

function inRing([x, y]: LonLat, ring: LonLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

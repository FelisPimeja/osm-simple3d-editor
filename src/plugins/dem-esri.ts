/**
 * Источник высот плагина «Esri World Elevation»: Terrain3D ImageServer (LERC1, 257×257 F32 по углам ячеек,
 * Web Mercator, до z16). Только для показа (рельеф, отмывка, горизонтали): по Esri Master License Agreement
 * разрешение для OSM касается World Imagery, высоты в правки не переносятся (редактор их и не пишет).
 *
 * Тайл 512 px на z — из четырёх тайлов Esri z+1 (256 ячеек каждый): та же подробность, что у самого Esri.
 * Тайлы без данных (67 байт, вне покрытия) и z > 15 — undefined: редактор возьмёт родителя (dem-tiles).
 */
import * as Lerc from 'lerc';
import wasmUrl from 'lerc/lerc-wasm.wasm?url';
import { DEM_SIZE, type DemProvider } from '../view/dem-tiles';

const URL_PATTERN = 'https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer/tile/{z}/{y}/{x}';
const ESRI_MAX_ZOOM = 16;
export const ESRI_ATTRIBUTION = 'Sources: Vantor, Airbus DS, USGS, NGA, NASA, CGIAR, GEBCO, N Robinson, NCEAS, NLS, OS, NMA, Geodatastyrelsen and the GIS User Community';

let ready: Promise<void> | undefined;

/** Тайл Esri: сетка (n+1)² высот по углам ячеек; undefined — данных нет. */
async function esriTile(z: number, x: number, y: number, signal?: AbortSignal): Promise<{ n: number; h: Float32Array } | undefined> {
  const res = await fetch(URL_PATTERN.replace('{z}', String(z)).replace('{y}', String(y)).replace('{x}', String(x)), { signal, credentials: 'omit' });
  if (res.status === 404) return;
  if (!res.ok) throw new Error(`Esri DEM ${res.status} ${z}/${x}/${y}`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength < 200) return;
  await (ready ??= Lerc.load({ locateFile: () => wasmUrl }));
  const r = Lerc.decode(buf);
  const w = r.width;
  if (w < 2 || r.height !== w) return;
  const h = r.pixels[0] instanceof Float32Array ? r.pixels[0] : Float32Array.from(r.pixels[0] as ArrayLike<number>);
  // Нет данных (маска) — уровень моря
  if (r.mask) for (let i = 0; i < h.length; i++) if (!r.mask[i]) h[i] = 0;
  return { n: w - 1, h };
}

export const dem: DemProvider = {
  async heights(z, x, y, signal) {
    if (z + 1 > ESRI_MAX_ZOOM) return;
    const kids = await Promise.all([0, 1, 2, 3].map((i) => esriTile(z + 1, 2 * x + (i & 1), 2 * y + (i >> 1), signal)));
    if (kids.some((k) => !k)) return;
    const out = new Float32Array(DEM_SIZE * DEM_SIZE);
    for (let py = 0; py < DEM_SIZE; py++) {
      // Центр пикселя в долях тайла → ребёнок и позиция в его сетке углов
      const v = ((py + 0.5) / DEM_SIZE) * 2, cy = Math.min(1, Math.floor(v));
      for (let px = 0; px < DEM_SIZE; px++) {
        const u = ((px + 0.5) / DEM_SIZE) * 2, cx = Math.min(1, Math.floor(u));
        const k = kids[cy * 2 + cx]!, n = k.n, s = n + 1;
        const gx = (u - cx) * n, gy = (v - cy) * n;
        const x0 = Math.min(n - 1, Math.floor(gx)), y0 = Math.min(n - 1, Math.floor(gy)), fx = gx - x0, fy = gy - y0;
        const a = k.h[y0 * s + x0], b = k.h[y0 * s + x0 + 1], c = k.h[(y0 + 1) * s + x0], d = k.h[(y0 + 1) * s + x0 + 1];
        out[py * DEM_SIZE + px] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
      }
    }
    return out;
  },
};

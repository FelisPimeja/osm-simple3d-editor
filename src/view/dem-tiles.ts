/**
 * Тайлы высот Mapterhorn с подстановкой: подробные зумы (до z17) есть только там, где есть открытый лидар
 * (Швейцария, часть Европы, США, Япония), в остальном мире — до z12, выше сервер отвечает 404. На 404 берём
 * родительский тайл, вырезаем нужную часть и растягиваем (билинейно по высотам, не по байтам цвета) —
 * так один источник с maxzoom 17 работает везде без дыр в рельефе.
 */
export const DEM_URL = 'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp';
/** Глобальное покрытие: до этого зума тайлы есть везде. */
export const DEM_BASE_ZOOM = 12;
/** Самый подробный зум Mapterhorn (лидар 0,5–1 м). */
export const DEM_MAX_ZOOM = 17;
export const DEM_SIZE = 512;

const urlOf = (z: number, x: number, y: number) => DEM_URL.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));

/** Тайлы, которых нет (404): ключ z/x/y — чтобы не спрашивать сервер снова. */
const missing = new Set<string>();
/** Декодированные высоты недавних тайлов (для подстановки детям). */
const heights = new Map<string, Promise<Float32Array | undefined>>();
const HEIGHTS_CACHE = 64;

async function decode(blob: Blob): Promise<Float32Array | undefined> {
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  if (bmp.width !== DEM_SIZE || bmp.height !== DEM_SIZE) return;
  const c = new OffscreenCanvas(DEM_SIZE, DEM_SIZE);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0);
  const px = ctx.getImageData(0, 0, DEM_SIZE, DEM_SIZE).data;
  const out = new Float32Array(DEM_SIZE * DEM_SIZE);
  // terrarium: (R·256 + G + B/256) − 32768
  for (let i = 0; i < out.length; i++) out[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
  return out;
}

async function encode(h: Float32Array): Promise<Blob> {
  const img = new ImageData(DEM_SIZE, DEM_SIZE);
  const d = img.data;
  for (let i = 0; i < h.length; i++) {
    const v = Math.max(0, Math.min(65535.99, h[i] + 32768));
    const r = Math.floor(v / 256), g = Math.floor(v) % 256, b = Math.floor((v - Math.floor(v)) * 256);
    d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = 255;
  }
  const c = new OffscreenCanvas(DEM_SIZE, DEM_SIZE);
  c.getContext('2d')!.putImageData(img, 0, 0);
  // PNG — без потерь: байты — биты высоты
  return c.convertToBlob({ type: 'image/png' });
}

/** Четверть (qx, qy) родителя, растянутая вдвое (билинейно; края — по краю родителя). */
function upsample(parent: Float32Array, qx: number, qy: number): Float32Array {
  const out = new Float32Array(DEM_SIZE * DEM_SIZE), half = DEM_SIZE / 2, max = DEM_SIZE - 1;
  for (let y = 0; y < DEM_SIZE; y++) {
    const sy = Math.min(max, Math.max(0, qy * half + (y + 0.5) / 2 - 0.5)), y0 = Math.floor(sy), y1 = Math.min(max, y0 + 1), fy = sy - y0;
    for (let x = 0; x < DEM_SIZE; x++) {
      const sx = Math.min(max, Math.max(0, qx * half + (x + 0.5) / 2 - 0.5)), x0 = Math.floor(sx), x1 = Math.min(max, x0 + 1), fx = sx - x0;
      const a = parent[y0 * DEM_SIZE + x0], b = parent[y0 * DEM_SIZE + x1], c = parent[y1 * DEM_SIZE + x0], e = parent[y1 * DEM_SIZE + x1];
      out[y * DEM_SIZE + x] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + e * fx) * fy;
    }
  }
  return out;
}

async function fetchBlob(z: number, x: number, y: number, signal?: AbortSignal): Promise<Blob | undefined> {
  const key = `${z}/${x}/${y}`;
  if (z > DEM_BASE_ZOOM && missing.has(key)) return;
  const res = await fetch(urlOf(z, x, y), { signal });
  if (res.status === 404) { missing.add(key); return; }
  if (!res.ok) throw new Error(`DEM ${res.status} ${key}`);
  return res.blob();
}

/** Высоты тайла z/x/y (с подстановкой из родителя). */
export function demHeights(z: number, x: number, y: number, signal?: AbortSignal): Promise<Float32Array | undefined> {
  const key = `${z}/${x}/${y}`;
  let p = heights.get(key);
  if (!p) {
    p = (async () => {
      const blob = await fetchBlob(z, x, y, signal);
      if (blob) return decode(blob);
      if (z <= DEM_BASE_ZOOM) return;
      const parent = await demHeights(z - 1, x >> 1, y >> 1, signal);
      return parent && upsample(parent, x & 1, y & 1);
    })();
    p.catch(() => heights.delete(key));
    heights.set(key, p);
    if (heights.size > HEIGHTS_CACHE) heights.delete(heights.keys().next().value!);
  }
  return p;
}

/** Тайл для maplibre-contour (getTile): настоящий — как есть, отсутствующий — из родителя, PNG terrarium. */
export async function demTileBlob(url: string, abort: AbortController): Promise<{ data: Blob }> {
  const m = /\/(\d+)\/(\d+)\/(\d+)\.webp$/.exec(url);
  if (!m) throw new Error(`DEM url ${url}`);
  const [z, x, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const blob = await fetchBlob(z, x, y, abort.signal);
  if (blob) return { data: blob };
  const h = z > DEM_BASE_ZOOM ? await demHeights(z - 1, x >> 1, y >> 1, abort.signal) : undefined;
  if (!h) throw new Error(`DEM нет тайла ${z}/${x}/${y}`);
  return { data: await encode(upsample(h, x & 1, y & 1)) };
}

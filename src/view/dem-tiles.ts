/**
 * Тайлы высот (terrarium, 512 px) для рельефа, отмывки и горизонталей. Источник по умолчанию — Mapterhorn;
 * плагин может добавить другой (src/plugins/dem-<id>.ts, экспорт dem: DemProvider), выбор — в настройках под «3D рельеф».
 *
 * Mapterhorn: подробные зумы (до z17) есть только там, где есть открытый лидар (Швейцария, часть Европы, США,
 * Япония), в остальном мире — до z12, выше сервер отвечает 404. На 404 берём родительский тайл, вырезаем нужную
 * часть и растягиваем (билинейно по высотам, не по байтам цвета) — так один источник с maxzoom 17 работает везде.
 * Другие источники устроены так же: тайла нет — из родителя.
 *
 * Адрес тайла (для maplibre-contour и кешей): dem://<источник>/{z}/{x}/{y}.webp — у источников разные ключи кеша.
 */
const MAPTERHORN = 'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp';
/** Глобальное покрытие: до этого зума тайлы есть везде. */
export const DEM_BASE_ZOOM = 12;
/** Самый подробный зум источников (Mapterhorn — лидар 0,5–1 м); подробнее — из родителя. */
export const DEM_MAX_ZOOM = 17;
export const DEM_SIZE = 512;

/** Источник высот из плагина: высоты тайла z/x/y (DEM_SIZE², построчно с севера), undefined — тайла нет. */
export interface DemProvider {
  heights(z: number, x: number, y: number, signal?: AbortSignal): Promise<Float32Array | undefined>;
}
const PROVIDERS = import.meta.glob<{ dem: DemProvider }>('../plugins/dem-*.ts');
const providers = new Map<string, Promise<DemProvider | undefined>>();
function provider(id: string): Promise<DemProvider | undefined> {
  let p = providers.get(id);
  if (!p) {
    const load = PROVIDERS[`../plugins/dem-${id}.ts`];
    p = load ? load().then((m) => m.dem) : Promise.resolve(undefined);
    providers.set(id, p);
  }
  return p;
}

let current = 'mapterhorn';
/** Сменить источник (в основном потоке и в каждом воркере). Неизвестный — Mapterhorn. */
export function setDemSource(id: string) { current = id === 'mapterhorn' || PROVIDERS[`../plugins/dem-${id}.ts`] ? id : 'mapterhorn'; }
export const demSourceId = () => current;
/** Шаблон адреса тайлов текущего источника (getTile — demTileBlob). */
export const demUrl = (id = current) => `dem://${id}/{z}/{x}/{y}.webp`;
export const DEM_URL = demUrl('mapterhorn');

const urlOf = (z: number, x: number, y: number) => MAPTERHORN.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
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

/** Высоты тайла источника как есть (без подстановки); undefined — тайла нет. */
async function ownHeights(id: string, z: number, x: number, y: number, signal?: AbortSignal): Promise<Float32Array | undefined> {
  if (id === 'mapterhorn') { const blob = await fetchBlob(z, x, y, signal); return blob && decode(blob); }
  return (await provider(id))?.heights(z, x, y, signal);
}

/** Высоты тайла z/x/y текущего источника (с подстановкой из родителя). */
export function demHeights(z: number, x: number, y: number, signal?: AbortSignal, id = current): Promise<Float32Array | undefined> {
  const key = `${id}/${z}/${x}/${y}`;
  let p = heights.get(key);
  if (!p) {
    p = (async () => {
      const own = await ownHeights(id, z, x, y, signal);
      if (own) return own;
      if (z <= DEM_BASE_ZOOM) return;
      const parent = await demHeights(z - 1, x >> 1, y >> 1, signal, id);
      return parent && upsample(parent, x & 1, y & 1);
    })();
    p.catch(() => heights.delete(key));
    heights.set(key, p);
    if (heights.size > HEIGHTS_CACHE) heights.delete(heights.keys().next().value!);
  }
  return p;
}

/** Тайл для maplibre-contour (getTile): Mapterhorn — как есть, иначе (и отсутствующий) — PNG terrarium из высот. */
export async function demTileBlob(url: string, abort: AbortController): Promise<{ data: Blob }> {
  const m = /^dem:\/\/([\w-]+)\/(\d+)\/(\d+)\/(\d+)\.webp$/.exec(url);
  if (!m) throw new Error(`DEM url ${url}`);
  const id = m[1], [z, x, y] = [Number(m[2]), Number(m[3]), Number(m[4])];
  if (id === 'mapterhorn') { const blob = await fetchBlob(z, x, y, abort.signal); if (blob) return { data: blob }; }
  const h = await demHeights(z, x, y, abort.signal, id);
  if (!h) throw new Error(`DEM нет тайла ${z}/${x}/${y}`);
  return { data: await encode(h) };
}

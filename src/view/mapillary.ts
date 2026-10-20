/**
 * Mapillary (mapillary.com) — уличные фото и панорамы, разрешённые для OSM (CC-BY-SA 4.0, с указанием Mapillary).
 * Нужен клиентский токен (VITE_MAPILLARY_TOKEN, MLY|…) — без него сервиса нет в списке слоёв. Тайлы: обзор (точки,
 * z0–5), маршруты (z6–14), снимки (z14). Соседние снимки — по списку снимков маршрута. Слой и окно — общие для
 * сервисов уличных фото (src/view/street-photos.ts).
 */
import { tr } from '../i18n';
import { COLOR_360, COLOR_FLAT, filterExpr, type Picture, type PhotoService } from './street-photos';

const TOKEN = import.meta.env?.VITE_MAPILLARY_TOKEN ?? '';
const GRAPH = 'https://graph.mapillary.com';

const graph = async <T>(path: string, params: Record<string, string>): Promise<T> => {
  const q = new URLSearchParams({ ...params, access_token: TOKEN });
  const res = await fetch(`${GRAPH}/${path}?${q}`);
  if (!res.ok) throw new Error(`mapillary: ${res.status}`);
  return res.json() as Promise<T>;
};

interface MlyImage {
  id: string;
  geometry?: { coordinates: [number, number] };
  computed_geometry?: { coordinates: [number, number] };
  compass_angle?: number;
  computed_compass_angle?: number;
  captured_at?: number;
  is_pano?: boolean;
  thumb_2048_url?: string;
  creator?: { username?: string };
  sequence?: string;
}

const where = (i: MlyImage) => (i.computed_geometry ?? i.geometry)!.coordinates;

/** Снимки маршрута по порядку (кэш: соседей ищем у каждого открытого снимка). */
const sequences = new Map<string, Promise<string[]>>();
function sequenceIds(seq: string): Promise<string[]> {
  let p = sequences.get(seq);
  if (!p) {
    p = graph<{ data: { id: string }[] }>('image_ids', { sequence_id: seq }).then((r) => r.data.map((d) => d.id));
    p.catch(() => sequences.delete(seq));
    sequences.set(seq, p);
  }
  return p;
}

/** Соседи по маршруту: id и точки (одним запросом). */
async function neighbours(id: string, seq: string | undefined): Promise<Pick<Picture, 'prev' | 'next'>> {
  if (!seq) return {};
  try {
    const ids = await sequenceIds(seq), i = ids.indexOf(id);
    const prev = ids[i - 1], next = i >= 0 ? ids[i + 1] : undefined;
    const want = [prev, next].filter((x): x is string => !!x);
    if (!want.length) return {};
    const r = await graph<{ data: MlyImage[] }>('images', { image_ids: want.join(','), fields: 'id,geometry,computed_geometry' });
    const at = (x: string | undefined) => {
      const img = x ? r.data.find((d) => String(d.id) === x) : undefined;
      return img && (img.computed_geometry ?? img.geometry) ? { id: x!, lngLat: where(img) } : undefined;
    };
    return { prev: at(prev), next: at(next) };
  } catch { return {}; }
}

async function fetchPicture(id: string): Promise<Picture> {
  const i = await graph<MlyImage>(encodeURIComponent(id), {
    fields: 'id,geometry,computed_geometry,compass_angle,computed_compass_angle,captured_at,is_pano,thumb_2048_url,creator,sequence',
  });
  if (!i.thumb_2048_url || !(i.computed_geometry ?? i.geometry)) throw new Error('mapillary: снимок не найден');
  return {
    id: String(i.id),
    lngLat: where(i),
    azimuth: i.computed_compass_angle ?? i.compass_angle ?? 0,
    pano: !!i.is_pano,
    image: i.thumb_2048_url,
    date: i.captured_at ? new Date(i.captured_at).toISOString().slice(0, 10) : '',
    author: i.creator?.username ?? '',
    license: { title: 'CC BY-SA 4.0', href: 'https://creativecommons.org/licenses/by-sa/4.0/' },
    ...await neighbours(String(i.id), i.sequence),
  };
}

const isPano = ['to-boolean', ['get', 'is_pano']] as PhotoService['isPano'];

export const mapillary: PhotoService | undefined = TOKEN ? {
  id: 'mapillary',
  name: 'Mapillary',
  tiles: `https://tiles.mapillary.com/maps/vtp/mly1_public/2/{z}/{x}/{y}?access_token=${TOKEN}`,
  maxzoom: 14,
  attribution: '<a href="https://www.mapillary.com" target="_blank" rel="noopener">© Mapillary</a>',
  seqLayer: 'sequence',
  picLayer: 'image',
  seqMinzoom: 6, // обзор (точки) в тайлах — до z5
  picMinzoom: 16,
  idProp: 'id',
  heading: ['get', 'compass_angle'],
  isPano,
  seqDate: ['get', 'captured_at'],
  picDate: ['get', 'captured_at'],
  dateMs: true,
  seqProps: ['is_pano', 'captured_at'],
  overview: {
    sourceLayer: 'overview',
    spec(f) {
      return {
        type: 'circle',
        filter: filterExpr(mapillary!, f, ['get', 'captured_at']),
        paint: {
          'circle-color': ['case', isPano, COLOR_360, COLOR_FLAT],
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 0, 1.5, 5, 3],
          'circle-opacity': 0.6,
        },
      };
    },
  },
  fetchPicture,
  pageUrl: (pic) => `https://www.mapillary.com/app/?pKey=${pic.id}&focus=photo`,
  get openLabel() { return tr('Открыть на Mapillary'); },
} : undefined;

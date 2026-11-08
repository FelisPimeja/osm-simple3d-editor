/**
 * Fotoshi (fotoshi.com) — краудсорсинговые фото мест (CC BY 4.0), привязанные к объектам OSM. Ключ — публичный
 * браузерный VITE_FOTOSHI_TOKEN, выданный Fotoshi именно редактору (разрешён для felispimeja.github.io и
 * localhost/127.0.0.1:5173); без него слоя нет. Лимиты: 60 запросов в минуту, 1000 в сутки (UTC), до 100 снимков
 * на область — при 429 ждём Retry-After. Снимки видимой области — GeoJSON (fetchArea); на мелких зумах — тайлы
 * покрытия (z0–8, округлённые места с плотностью), подпись «© Fotoshi contributors» обязательна.
 */
import { tr } from '../i18n';
import type { Expr, Picture, PhotoService } from './street-photos';

const API = 'https://api.fotoshi.com/v1/data';
const TOKEN = import.meta.env?.VITE_FOTOSHI_TOKEN ?? '';
const COVERAGE = 'https://tiles.fotoshi.com/coverage_overview/';

/** Ключ к тайлам покрытия (transformRequest карты: тайлы MapLibre грузит сам). */
export function fotoshiRequest(url: string): { url: string; headers?: Record<string, string> } | undefined {
  return TOKEN && url.startsWith(COVERAGE) ? { url, headers: { Authorization: `Bearer ${TOKEN}` } } : undefined;
}

/** Лимит исчерпан (429): до этого момента не запрашиваем. */
let blockedUntil = 0;
async function get(url: string): Promise<Response> {
  if (Date.now() < blockedUntil) throw new Error('fotoshi: rate limited');
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (res.status === 429) {
    const after = Number(res.headers.get('Retry-After'));
    blockedUntil = Date.now() + (Number.isFinite(after) && after > 0 ? after : 60) * 1000;
  }
  if (!res.ok) throw new Error(`fotoshi: ${res.status}`);
  return res;
}

interface FotoshiPhoto {
  id: string;
  geometry: { coordinates: [number, number] };
  properties: { heading?: number | null; captured_at?: string | null; capture_interval?: { start?: string } | null; creator_name?: string;
    source_organization?: string | null; image_license?: string; assets?: Record<string, { href: string }> };
  links?: { rel: string; href: string; title?: string }[];
}

async function fetchArea([w, s, e, n]: [number, number, number, number]): Promise<GeoJSON.FeatureCollection> {
  // Ключ интеграции пускает только «ограниченные» запросы: bbox и limit, без photo_size (иначе 403)
  const q = new URLSearchParams({ bbox: [w, s, e, n].map((v) => v.toFixed(6)).join(','), limit: '100' });
  const res = await get(`${API}/photos?${q}`);
  const data = (await res.json()) as { features: FotoshiPhoto[] };
  return {
    type: 'FeatureCollection',
    features: data.features.map((f) => ({
      type: 'Feature', geometry: { type: 'Point', coordinates: f.geometry.coordinates },
      properties: { id: f.id, heading: f.properties.heading ?? 0, date: f.properties.captured_at ?? f.properties.capture_interval?.start ?? '' },
    })),
  };
}

async function fetchPicture(id: string): Promise<Picture> {
  const res = await get(`${API}/photos/${encodeURIComponent(id)}`);
  const f = (await res.json()) as FotoshiPhoto, p = f.properties;
  const lic = f.links?.find((l) => l.rel === 'license');
  return {
    id: f.id,
    lngLat: f.geometry.coordinates,
    azimuth: p.heading ?? 0,
    pano: false,
    image: p.assets?.['image-1280']?.href ?? '',
    date: p.captured_at ?? p.capture_interval?.start ?? '',
    author: p.creator_name ?? p.source_organization ?? '',
    license: { title: lic?.title ?? p.image_license ?? '', href: lic?.href },
  };
}

/** Только с ключом. */
export const fotoshi: PhotoService | undefined = TOKEN ? {
  id: 'fotoshi',
  name: 'Fotoshi',
  tiles: '',
  maxzoom: 22,
  attribution: '<a href="https://fotoshi.com" target="_blank" rel="noopener">© Fotoshi contributors</a>',
  seqLayer: '',
  picLayer: '',
  seqMinzoom: 24,
  picMinzoom: 16,
  idProp: 'id',
  heading: ['get', 'heading'],
  isPano: ['to-boolean', 0] as Expr,
  seqDate: ['get', 'date'],
  picDate: ['get', 'date'],
  seqProps: [],
  // Покрытие: места, где есть снимки (плотность — полосами), до зума снимков
  overview: {
    sourceLayer: 'overview',
    tiles: `${COVERAGE}{z}/{x}/{y}.pbf`,
    maxzoom: 8,
    spec: () => ({
      type: 'circle',
      filter: ['has', 'density'] as Expr,
      paint: {
        'circle-color': '#e8590c',
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 2, ['match', ['get', 'density'], 'dense', 4, 'more', 3, 2], 14,
          ['match', ['get', 'density'], 'dense', 9, 'more', 7, 'some', 5, 4]],
        'circle-opacity': ['match', ['get', 'density'], 'dense', 0.8, 'more', 0.65, 'some', 0.5, 0.4],
      },
    }),
  },
  fetchArea,
  fetchPicture,
  pageUrl: (pic) => `https://fotoshi.com/explore?lng=${pic.lngLat[0]}&lat=${pic.lngLat[1]}&z=18&panel=gallery&view=photos&drawer=open&photo=${pic.id}`,
  get openLabel() { return tr('Открыть на Fotoshi'); },
} : undefined;

/**
 * Fotoshi (fotoshi.com) — краудсорсинговые фото мест (CC BY 4.0), привязанные к объектам OSM. Пока на пробу:
 * API в режиме developer preview (ключ, лимиты, без production-интеграций), поэтому слой есть только на
 * dev-сервере — запросы идут через его прокси /fotoshi-api, который подставляет ключ FOTOSHI_TOKEN из .env.local
 * (в браузер ключ не попадает). Тайлов у API нет: снимки видимой области — GeoJSON (fetchArea).
 */
import { tr } from '../i18n';
import type { Expr, Picture, PhotoService } from './street-photos';

const API = '/fotoshi-api';

interface FotoshiPhoto {
  id: string;
  geometry: { coordinates: [number, number] };
  properties: { heading?: number | null; captured_at?: string | null; capture_interval?: { start?: string } | null; creator_name?: string;
    source_organization?: string | null; image_license?: string; assets?: Record<string, { href: string }> };
  links?: { rel: string; href: string; title?: string }[];
}

async function fetchArea([w, s, e, n]: [number, number, number, number]): Promise<GeoJSON.FeatureCollection> {
  const q = new URLSearchParams({ bbox: [w, s, e, n].map((v) => v.toFixed(6)).join(','), limit: '100', photo_size: 'none' });
  const res = await fetch(`${API}/photos?${q}`);
  if (!res.ok) throw new Error(`fotoshi: ${res.status}`);
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
  const res = await fetch(`${API}/photos/${encodeURIComponent(id)}?photo_size=1280`);
  if (!res.ok) throw new Error(`fotoshi: ${res.status}`);
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

/** Только на dev-сервере (прокси с ключом); в сборке слоя нет. */
export const fotoshi: PhotoService | undefined = import.meta.env.DEV ? {
  id: 'fotoshi',
  name: 'Fotoshi',
  tiles: '',
  maxzoom: 22,
  attribution: '<a href="https://fotoshi.com" target="_blank" rel="noopener">Fotoshi</a>',
  seqLayer: '',
  picLayer: '',
  seqMinzoom: 24,
  picMinzoom: 16,
  idProp: 'id',
  heading: ['get', 'heading'],
  isPano: ['==', 1, 0] as Expr,
  seqDate: ['get', 'date'],
  picDate: ['get', 'date'],
  seqProps: [],
  fetchArea,
  fetchPicture,
  pageUrl: (pic) => `https://fotoshi.com/explore?lng=${pic.lngLat[0]}&lat=${pic.lngLat[1]}&z=18&panel=gallery&view=photos&drawer=open&photo=${pic.id}`,
  get openLabel() { return tr('Открыть на Fotoshi'); },
} : undefined;

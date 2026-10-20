/**
 * Panoramax (panoramax.xyz) — открытые уличные фото и панорамы, разрешённые для OSM (CC-BY-SA, etalab-2.0).
 * Тайлы федерации: сетка наличия снимков до z14 (шестиугольники, цвет — плотность), маршруты и снимки. Слой и окно —
 * общие для сервисов уличных фото (src/view/street-photos.ts).
 */
import { tr } from '../i18n';
import type { Expr, Picture, PhotoFilter, PhotoService } from './street-photos';

const API = 'https://api.panoramax.xyz/api';

/**
 * Сетка: тип — по числу снимков этого типа в ячейке; дата у ячейки одна (последней съёмки), поэтому фильтруется
 * только начало периода: ячейка видна, если в ней есть снимки не раньше «с».
 */
function gridFilter(f: PhotoFilter): Expr {
  const all: unknown[] = [];
  if (f.type === '360') all.push(['>', ['coalesce', ['get', 'nb_360_pictures'], 0], 0]);
  if (f.type === 'flat') all.push(['>', ['coalesce', ['get', 'nb_flat_pictures'], 0], 0]);
  if (f.from) all.push(['>=', ['to-string', ['coalesce', ['get', 'date'], '']], f.from]);
  return ['all', true, ...all] as Expr;
}

const gridCoef = (f: PhotoFilter): Expr =>
  ['coalesce', ['get', f.type === '360' ? 'coef_360_pictures' : f.type === 'flat' ? 'coef_flat_pictures' : 'coef'], 0] as Expr;

interface StacLink { rel: string; href: string; title?: string; id?: string; geometry?: { coordinates: [number, number] } }

const neighbour = (l: StacLink | undefined) => (l?.id && l.geometry ? { id: l.id, lngLat: l.geometry.coordinates } : undefined);

async function fetchPicture(id: string): Promise<Picture> {
  const res = await fetch(`${API}/search?ids=${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`panoramax: ${res.status}`);
  const f = ((await res.json()) as { features: Record<string, any>[] }).features[0];
  if (!f) throw new Error('panoramax: снимок не найден');
  const p = f.properties, links = f.links as StacLink[];
  const lic = links.find((l) => l.rel === 'license');
  return {
    id: f.id,
    lngLat: f.geometry.coordinates,
    azimuth: p['view:azimuth'] ?? 0,
    pano: p['pers:interior_orientation']?.field_of_view === 360,
    image: f.assets.sd?.href ?? f.assets.hd?.href,
    date: (p.datetimetz ?? p.datetime ?? '').slice(0, 10),
    author: f.providers?.[0]?.name ?? p['geovisio:producer'] ?? '',
    license: { title: p.license ?? '', href: lic?.href },
    prev: neighbour(links.find((l) => l.rel === 'prev')),
    next: neighbour(links.find((l) => l.rel === 'next')),
  };
}

export const panoramax: PhotoService = {
  id: 'panoramax',
  name: 'Panoramax',
  tiles: `${API}/map/2/{z}/{x}/{y}.mvt`,
  maxzoom: 17, // точки снимков — в тайлах с z15, все — с z17
  attribution: '<a href="https://panoramax.xyz" target="_blank" rel="noopener">Panoramax</a>',
  seqLayer: 'sequences',
  picLayer: 'pictures',
  seqMinzoom: 15, // сетка в тайлах — до z14
  picMinzoom: 17,
  idProp: 'id',
  heading: ['get', 'heading'],
  isPano: ['==', ['get', 'type'], 'equirectangular'],
  seqDate: ['get', 'date'],
  picDate: ['get', 'ts'],
  seqProps: ['type', 'date'],
  overview: {
    sourceLayer: 'grid',
    spec: (f) => ({
      type: 'fill',
      filter: gridFilter(f),
      paint: {
        'fill-color': ['interpolate', ['linear'], gridCoef(f), 0, '#e1bee7', 0.25, '#ba68c8', 0.5, '#9c27b0', 0.75, '#7b1fa2', 1, '#4a148c'],
        'fill-opacity': 0.45,
      },
      layout: { 'fill-sort-key': gridCoef(f) },
    }),
  },
  fetchPicture,
  pageUrl: (pic) => `https://api.panoramax.xyz/?pic=${pic.id}&focus=pic`,
  get openLabel() { return tr('Открыть на Panoramax'); },
};

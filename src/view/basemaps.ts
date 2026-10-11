/**
 * Подложки: векторная карта стиля сервера или спутниковые снимки поверх неё (под подписями и зданиями).
 * Только снимки, с которых разрешено обводить для OSM (editor-layer-index, permission_osm), с обязательной
 * атрибуцией. Bing не подключён: нужен свой ключ Bing Maps; Mapbox — только если в сборке задан VITE_MAPBOX_TOKEN.
 * Выбор хранится в localStorage (и в профиле на сервере — настройка simple3d:basemap, см. main.ts).
 */
import type { Map as MlMap } from 'maplibre-gl';
import { tr } from '../i18n';

export interface Imagery {
  id: string;
  name: string;
  tiles: string[];
  tileSize: number;
  /** Последний зум с настоящими снимками; дальше — растягиваем (у Esri выше — заглушки «Map data not yet available»). */
  maxzoom: number;
  attribution: string;
}

const ESRI_ATTRIBUTION = 'Esri, Maxar, Earthstar Geographics, GIS User Community · '
  + '<a href="https://wiki.openstreetmap.org/wiki/Esri" target="_blank" rel="noopener">Terms &amp; Feedback</a>';

const MAPBOX_TOKEN = import.meta.env?.VITE_MAPBOX_TOKEN ?? '';

export const IMAGERY: Imagery[] = [
  {
    id: 'esri',
    name: 'Esri World Imagery',
    tiles: ['https://services.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      'https://server.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
    tileSize: 256,
    maxzoom: 19,
    attribution: ESRI_ATTRIBUTION,
  },
  {
    id: 'esri-clarity',
    name: 'Esri World Imagery (Clarity) Beta',
    tiles: ['https://clarity.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
    tileSize: 256,
    maxzoom: 19,
    attribution: ESRI_ATTRIBUTION,
  },
  ...(MAPBOX_TOKEN ? [{
    id: 'mapbox',
    name: 'Mapbox Satellite',
    tiles: [`https://api.mapbox.com/v4/mapbox.satellite/{z}/{x}/{y}@2x.jpg90?access_token=${MAPBOX_TOKEN}`],
    tileSize: 512,
    maxzoom: 22,
    attribution: '<a href="https://www.mapbox.com/about/maps" target="_blank" rel="noopener">© Mapbox</a> · '
      + '<a href="https://www.mapbox.com/map-feedback/" target="_blank" rel="noopener">Terms &amp; Feedback</a>',
  }] : []),
];

/** 'map' — векторная карта без снимков. */
export const MAP_BASEMAP = 'map';
export const IMAGERY_LAYER = 'imagery';

const STORE_KEY = 'osm3d.basemap';

export const isBasemap = (id: string | undefined | null): id is string => id === MAP_BASEMAP || IMAGERY.some((i) => i.id === id);

export function storedBasemap(): string {
  let v: string | null = null;
  try { v = localStorage.getItem(STORE_KEY); } catch { /* без хранилища */ }
  return isBasemap(v) ? v : MAP_BASEMAP;
}

export function storeBasemap(id: string) {
  try { if (id === MAP_BASEMAP) localStorage.removeItem(STORE_KEY); else localStorage.setItem(STORE_KEY, id); } catch { /* до перезагрузки */ }
}

/**
 * Показать подложку: снимки — растровым слоем под первым слоем подписей стиля (заливки и линии карты под ним
 * не видны), здания и подписи остаются сверху. Возвращает, добавлен ли слой снимков.
 */
export function applyBasemap(map: MlMap, id: string): boolean {
  if (map.getLayer(IMAGERY_LAYER)) map.removeLayer(IMAGERY_LAYER);
  if (map.getSource(IMAGERY_LAYER)) map.removeSource(IMAGERY_LAYER);
  const im = IMAGERY.find((i) => i.id === id);
  if (!im) return false;
  map.addSource(IMAGERY_LAYER, {
    type: 'raster', tiles: im.tiles, tileSize: im.tileSize, maxzoom: im.maxzoom, attribution: im.attribution,
  });
  const before = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
  map.addLayer({ id: IMAGERY_LAYER, type: 'raster', source: IMAGERY_LAYER, paint: { 'raster-fade-duration': 150 } }, before);
  return true;
}

/** Кнопка со списком подложек — в общем блоке кнопок карты (масштаб, компас). */
export class BasemapButton {
  private readonly btn: HTMLButtonElement;
  private readonly menu: HTMLDivElement;

  constructor(group: HTMLElement, private current: string, private readonly onSelect: (id: string) => void) {
    group.classList.add('basemap-group');
    const btn = this.btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'maplibregl-ctrl-basemap';
    btn.title = tr('Подложка');
    btn.setAttribute('aria-haspopup', 'true');
    // Стопка слоёв
    btn.innerHTML = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M10 3 18 7.2 10 11.4 2 7.2z" fill="#fff"/><path d="M4.6 9.6 2 11l8 4.2 8-4.2-2.6-1.4"/><path d="M4.6 13.4 2 14.8 10 19l8-4.2-2.6-1.4" opacity=".6"/></svg>';
    btn.addEventListener('click', (e) => { e.stopPropagation(); this.toggleMenu(); });
    const menu = this.menu = document.createElement('div');
    menu.className = 'basemap-menu';
    menu.hidden = true;
    const items: [string, string][] = [[MAP_BASEMAP, tr('Карта')], ...IMAGERY.map((i): [string, string] => [i.id, i.name])];
    for (const [id, label] of items) {
      const row = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'basemap';
      input.value = id;
      input.addEventListener('change', () => { if (input.checked) this.select(id); });
      row.append(input, ` ${label}`);
      menu.append(row);
    }
    const note = document.createElement('div');
    note.className = 'basemap-note';
    note.textContent = tr('Снимки, разрешённые для обводки в OSM. Проверяйте сдвиг снимков по GPS-трекам.');
    menu.append(note);
    group.append(btn, menu);
    this.sync();
    document.addEventListener('click', (e) => {
      if (!this.menu.hidden && !this.menu.contains(e.target as Node)) this.toggleMenu(false);
    });
  }

  private toggleMenu(open = this.menu.hidden) {
    this.menu.hidden = !open;
    this.btn.setAttribute('aria-expanded', String(open));
  }

  private select(id: string) {
    this.current = id;
    this.sync();
    this.onSelect(id);
  }

  /** Подложку сменили не кнопкой (пришла из профиля). */
  set(id: string) {
    this.current = id;
    this.sync();
  }

  private sync() {
    this.btn.classList.toggle('active', this.current !== MAP_BASEMAP);
    for (const input of this.menu.querySelectorAll('input')) input.checked = input.value === this.current;
  }
}

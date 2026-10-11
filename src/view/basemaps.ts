/**
 * Подложки: векторная карта стиля сервера или спутниковые снимки поверх неё (под подписями и зданиями).
 * Только снимки, с которых разрешено обводить для OSM (editor-layer-index, permission_osm), с обязательной
 * атрибуцией. Bing не подключён: нужен свой ключ Bing Maps; Mapbox — только если в сборке задан VITE_MAPBOX_TOKEN.
 * Выбор хранится в localStorage (и в профиле на сервере — настройка simple3d:basemap, см. main.ts).
 */
import * as maplibregl from 'maplibre-gl';
import type { Map as MlMap, RasterTileSource } from 'maplibre-gl';
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
/** Общедоступные GPS-треки OSM — эталон, по которому видно смещение снимков. */
export const GPS_LAYER = 'gps-traces';

const STORE_KEY = 'osm3d.basemap';
const GPS_KEY = 'osm3d.gps-traces';

export const isBasemap = (id: string | undefined | null): id is string => id === MAP_BASEMAP || IMAGERY.some((i) => i.id === id);

export function storedBasemap(): string {
  let v: string | null = null;
  try { v = localStorage.getItem(STORE_KEY); } catch { /* без хранилища */ }
  return isBasemap(v) ? v : MAP_BASEMAP;
}

export function storeBasemap(id: string) {
  try { if (id === MAP_BASEMAP) localStorage.removeItem(STORE_KEY); else localStorage.setItem(STORE_KEY, id); } catch { /* до перезагрузки */ }
}

export function storedGps(): boolean {
  try { return localStorage.getItem(GPS_KEY) === '1'; } catch { return false; }
}

export function storeGps(on: boolean) {
  try { if (on) localStorage.setItem(GPS_KEY, '1'); else localStorage.removeItem(GPS_KEY); } catch { /* до перезагрузки */ }
}

/** Смещение снимка, м: на восток и на север (как сдвинуть картинку, чтобы совпала с GPS-треками). */
export interface Offset { east: number; north: number }

const OFFSETS_KEY = 'osm3d.imagery-offsets';
const offsets: Record<string, Offset> = (() => {
  try { return JSON.parse(localStorage.getItem(OFFSETS_KEY) ?? '{}') as Record<string, Offset>; } catch { return {}; }
})();

export const getOffset = (id: string): Offset => offsets[id] ?? { east: 0, north: 0 };
export const isOffset = (o: Offset) => Math.abs(o.east) >= 0.005 || Math.abs(o.north) >= 0.005;

/** Запомнить смещение снимка (в этом браузере). */
export function storeOffset(id: string, o: Offset) {
  if (isOffset(o)) offsets[id] = { east: +o.east.toFixed(2), north: +o.north.toFixed(2) };
  else delete offsets[id];
  try { localStorage.setItem(OFFSETS_KEY, JSON.stringify(offsets)); } catch { /* до перезагрузки */ }
}

/**
 * Смещённые снимки: MapLibre не умеет сдвигать растровый слой, поэтому тайл imgoffset://<снимок>/z/x/y?e=&n=
 * собирается из соседних тайлов снимка, нарисованных со сдвигом (метры → пиксели по широте центра тайла).
 * Исходные тайлы кешируются — при перетаскивании тайлы пересобираются без новых запросов.
 */
const PROTOCOL = 'imgoffset';
const EARTH = 2 * Math.PI * 6378137;
const sourceCache = new Map<string, Promise<ImageBitmap | null>>();

function sourceTile(url: string): Promise<ImageBitmap | null> {
  let p = sourceCache.get(url);
  if (p) { sourceCache.delete(url); sourceCache.set(url, p); return p; } // свежий — в конец (LRU)
  p = fetch(url).then((r) => (r.ok ? r.blob() : null)).then((b) => (b ? createImageBitmap(b) : null)).catch(() => null);
  sourceCache.set(url, p);
  while (sourceCache.size > 400) {
    const [k, old] = sourceCache.entries().next().value!;
    sourceCache.delete(k);
    void old.then((bmp) => bmp?.close());
  }
  return p;
}

const tileUrl = (im: Imagery, z: number, x: number, y: number) =>
  im.tiles[(x + y) % im.tiles.length].replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));

maplibregl.addProtocol(PROTOCOL, async (params) => {
  const u = new URL(params.url);
  const im = IMAGERY.find((i) => i.id === u.hostname);
  const [z, x, y] = u.pathname.split('/').filter(Boolean).map(Number);
  if (!im) throw new Error(`imgoffset: ${params.url}`);
  const n = 2 ** z, S = im.tileSize;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / n)));
  const mpp = (EARTH * Math.cos(lat)) / (n * S);
  // Картинку сдвигаем на восток на px и на север на py (вверх — минус по экранной оси)
  const px = Number(u.searchParams.get('e')) / mpp, py = Number(u.searchParams.get('n')) / mpp;
  const draws: Promise<void>[] = [];
  const canvas = new OffscreenCanvas(S, S);
  const ctx = canvas.getContext('2d')!;
  const parts: { bmp: Promise<ImageBitmap | null>; left: number; top: number }[] = [];
  for (let tx = Math.floor(x - 1 - px / S); tx <= Math.ceil(x + 1 - px / S); tx++) {
    for (let ty = Math.floor(y - 1 + py / S); ty <= Math.ceil(y + 1 + py / S); ty++) {
      const left = (tx - x) * S + px, top = (ty - y) * S - py;
      if (ty < 0 || ty >= n || left >= S || left + S <= 0 || top >= S || top + S <= 0) continue;
      parts.push({ bmp: sourceTile(tileUrl(im, z, ((tx % n) + n) % n, ty)), left, top });
    }
  }
  let drawn = 0;
  for (const p of parts) draws.push(p.bmp.then((bmp) => { if (!bmp) return;
    try { ctx.drawImage(bmp, p.left, p.top, S, S); drawn++; } catch { /* вытеснен из кеша и закрыт */ } }));
  await Promise.all(draws);
  if (!drawn) throw new Error(`imgoffset: нет тайлов ${params.url}`);
  return { data: canvas.transferToImageBitmap() };
});

/** Адреса тайлов снимка с учётом смещения. */
function imageryTiles(im: Imagery): string[] {
  const o = getOffset(im.id);
  return isOffset(o) ? [`${PROTOCOL}://${im.id}/{z}/{x}/{y}?e=${o.east.toFixed(2)}&n=${o.north.toFixed(2)}`] : im.tiles;
}

/** Смещение показываемого снимка изменилось — пересобрать его тайлы. */
export function refreshImagery(map: MlMap, id: string) {
  const im = IMAGERY.find((i) => i.id === id);
  const src = map.getSource(IMAGERY_LAYER) as RasterTileSource | undefined;
  if (im && src) src.setTiles(imageryTiles(im));
}

/** Слой подписей стиля, под который кладём растры. */
const firstSymbol = (map: MlMap) => map.getStyle().layers.find((l) => l.type === 'symbol')?.id;

/** GPS-треки поверх подложки (и карты, и снимков), под подписями и зданиями. Возвращает, добавлен ли слой. */
export function applyGpsTraces(map: MlMap, on: boolean): boolean {
  if (map.getLayer(GPS_LAYER)) map.removeLayer(GPS_LAYER);
  if (map.getSource(GPS_LAYER)) map.removeSource(GPS_LAYER);
  if (!on) return false;
  map.addSource(GPS_LAYER, {
    type: 'raster',
    tiles: ['a', 'b', 'c'].map((s) => `https://${s}.gps-tile.openstreetmap.org/lines/{z}/{x}/{y}.png`),
    tileSize: 256,
    maxzoom: 20,
    attribution: tr('GPS-треки') + ' <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a>',
  });
  map.addLayer({ id: GPS_LAYER, type: 'raster', source: GPS_LAYER, paint: { 'raster-fade-duration': 150 } }, firstSymbol(map));
  return true;
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
    type: 'raster', tiles: imageryTiles(im), tileSize: im.tileSize, maxzoom: im.maxzoom, attribution: im.attribution,
  });
  // Под GPS-треками, если они включены
  const before = map.getLayer(GPS_LAYER) ? GPS_LAYER : firstSymbol(map);
  map.addLayer({ id: IMAGERY_LAYER, type: 'raster', source: IMAGERY_LAYER, paint: { 'raster-fade-duration': 150 } }, before);
  return true;
}

/** Кнопка со списком подложек — в общем блоке кнопок карты (масштаб, компас). */
export class BasemapButton {
  private readonly btn: HTMLButtonElement;
  private readonly menu: HTMLDivElement;
  private readonly gpsInput: HTMLInputElement;
  private readonly offsetBtns = new Map<string, HTMLButtonElement>();

  constructor(group: HTMLElement, private current: string, private readonly onSelect: (id: string) => void,
    private gps: boolean, onGps: (on: boolean) => void, onOffset: (id: string) => void) {
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
      if (id !== MAP_BASEMAP) {
        // Смещение снимка: подсвечена, если снимок сдвинут
        const off = document.createElement('button');
        off.type = 'button';
        off.className = 'basemap-offset-btn';
        off.title = tr('Смещение снимка');
        off.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1.5v13M1.5 8h13M8 1.5 6.2 3.3M8 1.5l1.8 1.8M8 14.5l-1.8-1.8M8 14.5l1.8-1.8M1.5 8l1.8-1.8M1.5 8l1.8 1.8M14.5 8l-1.8-1.8M14.5 8l-1.8 1.8"/></svg>';
        off.addEventListener('click', (e) => {
          e.preventDefault(); // не выбирать радиокнопку строки дважды
          e.stopPropagation();
          this.toggleMenu(false);
          onOffset(id);
        });
        this.offsetBtns.set(id, off);
        row.append(off);
      }
      menu.append(row);
    }
    const gpsRow = document.createElement('label');
    gpsRow.className = 'basemap-overlay';
    gpsRow.title = tr('Общедоступные GPS-треки участников OSM: по ним видно, куда сдвинуты снимки');
    const gpsInput = this.gpsInput = document.createElement('input');
    gpsInput.type = 'checkbox';
    gpsInput.checked = gps;
    gpsInput.addEventListener('change', () => { this.gps = gpsInput.checked; this.sync(); onGps(gpsInput.checked); });
    gpsRow.append(gpsInput, ` ${tr('GPS-треки OSM')}`);
    menu.append(gpsRow);
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

  /** GPS-треки включили или выключили не галкой (из профиля). */
  setGps(on: boolean) {
    this.gps = on;
    this.gpsInput.checked = on;
    this.sync();
  }

  /** Подложку сменили не кнопкой (пришла из профиля). */
  set(id: string) {
    this.current = id;
    this.sync();
  }

  /** Подсветить кнопки смещения сдвинутых снимков и кнопку слоёв. */
  sync() {
    this.btn.classList.toggle('active', this.current !== MAP_BASEMAP || this.gps);
    for (const input of this.menu.querySelectorAll<HTMLInputElement>('input[type=radio]')) input.checked = input.value === this.current;
    for (const [id, b] of this.offsetBtns) b.classList.toggle('active', isOffset(getOffset(id)));
  }
}

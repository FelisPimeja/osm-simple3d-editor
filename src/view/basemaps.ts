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
  /** Esri Wayback: дата показанного выпуска. */
  release?: string;
}

const ESRI_ATTRIBUTION = 'Esri, Maxar, Earthstar Geographics, GIS User Community · '
  + '<a href="https://wiki.openstreetmap.org/wiki/Esri" target="_blank" rel="noopener">Terms &amp; Feedback</a>';

const MAPBOX_TOKEN = import.meta.env?.VITE_MAPBOX_TOKEN ?? '';

export const IMAGERY: Imagery[] = [
  {
    id: 'esri',
    name: 'Esri World Imagery',
    tiles: ['https://services.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}?blankTile=false',
      'https://server.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}?blankTile=false'],
    tileSize: 256,
    maxzoom: 19,
    attribution: ESRI_ATTRIBUTION,
  },
  {
    id: 'esri-clarity',
    name: 'Esri World Imagery (Clarity) Beta',
    tiles: ['https://clarity.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}?blankTile=false'],
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

/**
 * Esri World Imagery Wayback (src/view/wayback.ts) — для OpenHistoricalMap: выпуск по дате слайдера времени.
 * Адрес тайлов задаёт выбранный выпуск; пока список выпусков не загружен — пусто, слой не показывается.
 */
export const WAYBACK: Imagery = {
  id: 'esri-wayback',
  name: 'Esri Wayback',
  tiles: [],
  tileSize: 256,
  maxzoom: 19,
  attribution: ESRI_ATTRIBUTION,
};

const ALL_IMAGERY = [...IMAGERY, WAYBACK];
export const findImagery = (id: string) => ALL_IMAGERY.find((i) => i.id === id);

/** 'map' — векторная карта без снимков. */
export const MAP_BASEMAP = 'map';
export const IMAGERY_LAYER = 'imagery';
/** Общедоступные GPS-треки OSM — эталон, по которому видно смещение снимков. */
export const GPS_LAYER = 'gps-traces';

const STORE_KEY = 'osm3d.basemap';
const GPS_KEY = 'osm3d.gps-traces';

export const isBasemap = (id: string | undefined | null): id is string => id === MAP_BASEMAP || ALL_IMAGERY.some((i) => i.id === id);

/** scope — свой выбор у серверов с другим набором снимков (OHM: '.ohm'). */
export function storedBasemap(scope = ''): string {
  let v: string | null = null;
  try { v = localStorage.getItem(STORE_KEY + scope); } catch { /* без хранилища */ }
  return isBasemap(v) ? v : MAP_BASEMAP;
}

export function storeBasemap(id: string, scope = '') {
  try { if (id === MAP_BASEMAP) localStorage.removeItem(STORE_KEY + scope); else localStorage.setItem(STORE_KEY + scope, id); } catch { /* до перезагрузки */ }
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

const OPACITY_KEY = 'osm3d.imagery-opacity';
const opacities: Record<string, number> = (() => {
  try { return JSON.parse(localStorage.getItem(OPACITY_KEY) ?? '{}') as Record<string, number>; } catch { return {}; }
})();

/** Непрозрачность снимка, 0…1. */
export const getOpacity = (id: string): number => opacities[id] ?? 1;

export function storeOpacity(id: string, v: number) {
  if (v < 0.995) opacities[id] = +v.toFixed(2); else delete opacities[id];
  try { localStorage.setItem(OPACITY_KEY, JSON.stringify(opacities)); } catch { /* до перезагрузки */ }
}

/** У снимка изменены настройки (сдвиг или прозрачность) — шестерёнка синяя. */
export const isTuned = (id: string) => isOffset(getOffset(id)) || getOpacity(id) < 0.995;

/** Показать непрозрачность снимка сразу (панель настроек). */
export function setImageryOpacity(map: MlMap, v: number) {
  if (map.getLayer(IMAGERY_LAYER)) map.setPaintProperty(IMAGERY_LAYER, 'raster-opacity', v);
}

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
  const im = findImagery(u.hostname);
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
  const im = findImagery(id);
  const src = map.getSource(IMAGERY_LAYER) as RasterTileSource | undefined;
  if (im?.tiles.length && src) src.setTiles(imageryTiles(im));
}

/** Слой подписей стиля, под который кладём растры. */
const firstSymbol = (map: MlMap) => map.getStyle().layers.find((l) => l.type === 'symbol')?.id;

/** Область показа [з, ю, в, с]: снимки грузятся только тайлами, задевающими её (режим здания — вокруг здания). */
export type Bounds = [number, number, number, number];

/** GPS-треки поверх подложки (и карты, и снимков), под подписями и зданиями. Возвращает, добавлен ли слой. */
export function applyGpsTraces(map: MlMap, on: boolean, bounds?: Bounds): boolean {
  if (map.getLayer(GPS_LAYER)) map.removeLayer(GPS_LAYER);
  if (map.getSource(GPS_LAYER)) map.removeSource(GPS_LAYER);
  if (!on) return false;
  map.addSource(GPS_LAYER, {
    type: 'raster',
    tiles: ['a', 'b', 'c'].map((s) => `https://${s}.gps-tile.openstreetmap.org/lines/{z}/{x}/{y}.png`),
    tileSize: 256,
    maxzoom: 20,
    ...(bounds && { bounds }),
    attribution: tr('GPS-треки') + ' <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a>',
  });
  map.addLayer({ id: GPS_LAYER, type: 'raster', source: GPS_LAYER, paint: { 'raster-fade-duration': 150 } }, firstSymbol(map));
  return true;
}

/**
 * Показать подложку: снимки — растровым слоем под первым слоем подписей стиля (заливки и линии карты под ним
 * не видны), здания и подписи остаются сверху. Возвращает, добавлен ли слой снимков.
 */
export function applyBasemap(map: MlMap, id: string, bounds?: Bounds): boolean {
  if (map.getLayer(IMAGERY_LAYER)) map.removeLayer(IMAGERY_LAYER);
  if (map.getSource(IMAGERY_LAYER)) map.removeSource(IMAGERY_LAYER);
  const im = findImagery(id);
  if (!im?.tiles.length) return false;
  map.addSource(IMAGERY_LAYER, {
    type: 'raster', tiles: imageryTiles(im), tileSize: im.tileSize, maxzoom: im.maxzoom,
    attribution: im.release ? `${im.attribution} · Wayback ${im.release}` : im.attribution,
    ...(bounds && { bounds }),
  });
  // Под GPS-треками, если они включены
  const before = map.getLayer(GPS_LAYER) ? GPS_LAYER : firstSymbol(map);
  map.addLayer({ id: IMAGERY_LAYER, type: 'raster', source: IMAGERY_LAYER, paint: { 'raster-fade-duration': 150, 'raster-opacity': getOpacity(id) } }, before);
  return true;
}

/** Кнопка со списком подложек — в общем блоке кнопок карты (масштаб, компас). */
const BUILDINGS_KEY = 'osm3d.buildings';
const BUILDINGS_OPACITY_KEY = 'osm3d.buildings-opacity';
const WIREFRAME_KEY = 'osm3d.wireframe';

/** Слой 3D-зданий: показан ли и его непрозрачность (1 — как есть). */
export interface BuildingsView { shown: boolean; opacity: number; /** Режим контуров. */ wireframe: boolean }

export function storedBuildings(): BuildingsView {
  try {
    const o = Number(localStorage.getItem(BUILDINGS_OPACITY_KEY) ?? 1);
    return { shown: localStorage.getItem(BUILDINGS_KEY) !== 'off', opacity: Number.isFinite(o) ? Math.min(1, Math.max(0, o)) : 1,
      wireframe: localStorage.getItem(WIREFRAME_KEY) === '1' };
  } catch { return { shown: true, opacity: 1, wireframe: false }; }
}

export function storeBuildings(v: BuildingsView) {
  try {
    if (v.shown) localStorage.removeItem(BUILDINGS_KEY); else localStorage.setItem(BUILDINGS_KEY, 'off');
    if (v.opacity >= 1) localStorage.removeItem(BUILDINGS_OPACITY_KEY); else localStorage.setItem(BUILDINGS_OPACITY_KEY, String(v.opacity));
    if (v.wireframe) localStorage.setItem(WIREFRAME_KEY, '1'); else localStorage.removeItem(WIREFRAME_KEY);
  } catch { /* до перезагрузки */ }
}

const GEAR_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M6.8 1.5h2.4l.4 1.8 1.2.7 1.8-.6 1.2 2.1-1.4 1.2v1.4l1.4 1.2-1.2 2.1-1.8-.6-1.2.7-.4 1.8H6.8l-.4-1.8-1.2-.7-1.8.6-1.2-2.1 1.4-1.2V6.7L2.2 5.5l1.2-2.1 1.8.6 1.2-.7z"/><circle cx="8" cy="8" r="2"/></svg>';

export class BasemapButton {
  private readonly btn: HTMLButtonElement;
  private readonly menu: HTMLDivElement;
  private readonly gpsInput?: HTMLInputElement;
  private readonly buildingsInput: HTMLInputElement;
  private readonly buildingsGear: HTMLButtonElement;
  private readonly alphaInput: HTMLInputElement;
  private readonly offsetBtns = new Map<string, HTMLButtonElement>();
  private readonly labels = new Map<string, HTMLSpanElement>();

  constructor(group: HTMLElement, private current: string, private readonly onSelect: (id: string) => void,
    private gps: boolean, onGps: (on: boolean) => void, onOffset: (id: string) => void,
    /** Снимки в меню (у OSM — разрешённые для обводки, у OHM — Esri Wayback); пусто — только слой зданий. */
    list: Imagery[],
    /** GPS-треки и пояснение — только у OSM. */
    osm: boolean, private buildings: BuildingsView, onBuildings: (v: BuildingsView) => void) {
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
    const items: [string, string][] = list.length ? [[MAP_BASEMAP, tr('Карта')], ...list.map((i): [string, string] => [i.id, i.name])] : [];
    for (const [id, label] of items) {
      const row = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'basemap';
      input.value = id;
      input.addEventListener('change', () => { if (input.checked) this.select(id); });
      const text = document.createElement('span');
      text.textContent = ` ${label}`;
      this.labels.set(id, text);
      row.append(input, text);
      if (id !== MAP_BASEMAP) {
        // Настройки снимка (видна у выбранного)
        const off = document.createElement('button');
        off.type = 'button';
        off.className = 'basemap-offset-btn';
        off.title = tr('Настройки подложки: смещение и прозрачность');
        // Шестерёнка
        off.innerHTML = GEAR_SVG;
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
    // 3D-здания: показать или скрыть; шестерёнка — прозрачность (видна подложка сквозь здания)
    const bRow = document.createElement('label');
    bRow.className = list.length ? 'basemap-overlay' : '';
    const bInput = this.buildingsInput = document.createElement('input');
    bInput.type = 'checkbox';
    bInput.checked = buildings.shown;
    bInput.addEventListener('change', () => { this.buildings = { ...this.buildings, shown: bInput.checked }; this.sync(); onBuildings(this.buildings); });
    const gear = this.buildingsGear = document.createElement('button');
    gear.type = 'button';
    gear.className = 'basemap-offset-btn';
    gear.title = tr('Настройки слоя зданий: прозрачность');
    gear.innerHTML = GEAR_SVG;
    const alphaRow = document.createElement('label');
    alphaRow.className = 'basemap-alpha';
    alphaRow.hidden = true;
    const alpha = this.alphaInput = document.createElement('input');
    alpha.type = 'range';
    alpha.min = '0';
    alpha.max = '100';
    alpha.step = '5';
    const alphaValue = document.createElement('span');
    const syncAlpha = () => {
      const t = Math.round((1 - this.buildings.opacity) * 100);
      alpha.value = String(t);
      alphaValue.textContent = `${t} %`;
    };
    syncAlpha();
    alpha.addEventListener('input', () => {
      this.buildings = { ...this.buildings, opacity: 1 - Number(alpha.value) / 100 };
      syncAlpha();
      this.sync();
      onBuildings(this.buildings);
    });
    gear.addEventListener('click', (e) => {
      e.preventDefault(); // не переключать галку строки
      e.stopPropagation();
      alphaRow.hidden = !alphaRow.hidden;
    });
    alphaRow.append(tr('Прозрачность'), alpha, alphaValue);
    bRow.append(bInput, ` ${tr('3D-здания')}`, gear);
    menu.append(bRow, alphaRow);
    if (!osm && list.length) {
      const note = document.createElement('div');
      note.className = 'basemap-note';
      note.textContent = tr('Esri Wayback: архив снимков с 2014 г. Выпуск — последний до даты слайдера времени (дата выпуска, а не съёмки).');
      menu.append(note);
    }
    if (osm) {
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
    }
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

  /** Слой зданий переключили не из меню (режим контуров — кнопкой или клавишей). */
  setBuildings(v: BuildingsView) {
    this.buildings = v;
    this.sync();
  }

  /** GPS-треки включили или выключили не галкой (из профиля). */
  setGps(on: boolean) {
    this.gps = on;
    if (this.gpsInput) this.gpsInput.checked = on;
    this.sync();
  }

  /** Подпись подложки в меню (Esri Wayback — с датой выпуска). */
  setLabel(id: string, label: string) {
    const el = this.labels.get(id);
    if (el) el.textContent = ` ${label}`;
  }

  /** Подложку сменили не кнопкой (пришла из профиля). */
  set(id: string) {
    this.current = id;
    this.sync();
  }

  /** Подсветить кнопки смещения сдвинутых снимков и кнопку слоёв. */
  sync() {
    this.btn.classList.toggle('active', this.current !== MAP_BASEMAP || this.gps || !this.buildings.shown || this.buildings.opacity < 1);
    this.buildingsInput.checked = this.buildings.shown;
    // В режиме контуров заливки нет — прозрачность не к чему применять
    this.alphaInput.disabled = this.buildings.wireframe;
    this.buildingsGear.classList.toggle('active', this.buildings.opacity < 1);
    for (const input of this.menu.querySelectorAll<HTMLInputElement>('input[type=radio]')) input.checked = input.value === this.current;
    // Шестерёнка — только у выбранного снимка; синяя, если сдвиг или прозрачность изменены
    for (const [id, b] of this.offsetBtns) {
      b.hidden = id !== this.current;
      b.classList.toggle('active', isTuned(id));
    }
  }
}

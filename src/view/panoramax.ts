/**
 * Panoramax (panoramax.xyz) — открытые уличные фото и панорамы, разрешённые для OSM (CC-BY-SA, etalab-2.0).
 * На карте — векторные тайлы федерации (последовательности и точки снимков с направлением), по клику — снимок
 * в окне просмотра: панорама 360° — сферой на three.js (перетаскивание — поворот, колесо — зум), обычное фото — картинкой.
 * На карте у открытого снимка — конус, куда сейчас смотрим (раствор — по углу обзора окна). На мелких зумах — сетка
 * наличия снимков (шестиугольники, цвет — плотность). Фильтр: тип (обычные фото / 360°) и диапазон дат съёмки.
 */
import type { ExpressionSpecification, GeoJSONSource, Map as MlMap, MapSourceDataEvent, MapGeoJSONFeature, PointLike } from 'maplibre-gl';
import * as THREE from 'three';
import { tr } from '../i18n';

const API = 'https://api.panoramax.xyz/api';
const SOURCE = 'panoramax';
const SEQ_LAYER = 'panoramax-sequences';
const PIC_LAYER = 'panoramax-pictures';
const GRID_LAYER = 'panoramax-grid';
const VIEW_SOURCE = 'panoramax-view';
const VIEW_LAYER = 'panoramax-view';
const ARROW = 'panoramax-arrow';
const DOT = 'panoramax-dot';
const CONE = 'panoramax-cone';
/** Цвета: панорамы 360° — пурпурный (ближе к красному: заметно отличается), обычные фото — тёмно-синий. */
const COLOR_360 = '#9c1f6e';
const COLOR_FLAT = '#1e3a8a';
const IS_360: Expr = ['==', ['get', 'type'], 'equirectangular'];
const typeColor: Expr = ['case', IS_360, COLOR_360, COLOR_FLAT];
/** Выражение MapLibre (собираем из частей — типы спецификации тут не помогают). */
type Expr = ExpressionSpecification;
const STORE_KEY = 'osm3d.panoramax';
const FILTER_KEY = 'osm3d.panoramax-filter';
/** Сетка — до этого зума (в тайлах она есть до z14), дальше — маршруты и снимки. */
const GRID_MAXZOOM = 15;

export const isPanoramaxLayer = (id: string) => id.startsWith('panoramax');

export function storedPanoramax(): boolean {
  try { return localStorage.getItem(STORE_KEY) === '1'; } catch { return false; }
}

export function storePanoramax(on: boolean) {
  try { if (on) localStorage.setItem(STORE_KEY, '1'); else localStorage.removeItem(STORE_KEY); } catch { /* до перезагрузки */ }
}

/** Фильтр снимков: тип и даты съёмки ('ГГГГ-ММ-ДД', пусто — без границы). */
export interface PanoramaxFilter { type: 'all' | 'flat' | '360'; from: string; to: string }

export function storedPanoramaxFilter(): PanoramaxFilter {
  const d: PanoramaxFilter = { type: 'all', from: '', to: '' };
  try { return { ...d, ...JSON.parse(localStorage.getItem(FILTER_KEY) ?? '{}') as Partial<PanoramaxFilter> }; } catch { return d; }
}

export function storePanoramaxFilter(f: PanoramaxFilter) {
  try {
    if (f.type === 'all' && !f.from && !f.to) localStorage.removeItem(FILTER_KEY);
    else localStorage.setItem(FILTER_KEY, JSON.stringify(f));
  } catch { /* до перезагрузки */ }
}

export const isPanoramaxFiltered = (f: PanoramaxFilter) => f.type !== 'all' || !!f.from || !!f.to;


/** Условия фильтра для слоя: тип — свойство type ('equirectangular' — 360°), дата — dateExpr ('ГГГГ-ММ-ДД…'). */
function filterExpr(f: PanoramaxFilter, dateExpr: Expr | undefined): Expr {
  const all: unknown[] = [];
  if (f.type !== 'all') all.push([f.type === '360' ? '==' : '!=', ['get', 'type'], 'equirectangular']);
  if (dateExpr) {
    const day = ['slice', ['to-string', ['coalesce', dateExpr, '']], 0, 10] as Expr;
    if (f.from) all.push(['>=', day, f.from]);
    if (f.to) all.push(['<=', day, f.to]);
  }
  return ['all', true, ...all] as Expr;
}

/**
 * Сетка: тип — по числу снимков этого типа в ячейке; дата у ячейки одна (последней съёмки), поэтому фильтруется
 * только начало периода: ячейка видна, если в ней есть снимки не раньше «с».
 */
function gridFilter(f: PanoramaxFilter): Expr {
  const all: unknown[] = [];
  if (f.type === '360') all.push(['>', ['coalesce', ['get', 'nb_360_pictures'], 0], 0]);
  if (f.type === 'flat') all.push(['>', ['coalesce', ['get', 'nb_flat_pictures'], 0], 0]);
  if (f.from) all.push(['>=', ['to-string', ['coalesce', ['get', 'date'], '']], f.from]);
  return ['all', true, ...all] as Expr;
}

const gridCoef = (f: PanoramaxFilter): Expr =>
  ['coalesce', ['get', f.type === '360' ? 'coef_360_pictures' : f.type === 'flat' ? 'coef_flat_pictures' : 'coef'], 0] as Expr;

/** Применить фильтр к показанным слоям. */
export function setPanoramaxFilter(map: MlMap, f: PanoramaxFilter) {
  if (!map.getLayer(PIC_LAYER)) return;
  map.setFilter(PIC_LAYER, clip(filterExpr(f, ['get', 'ts'])));
  map.setFilter(SEQ_LAYER, filterExpr(f, ['get', 'date']));
  map.setFilter(GRID_LAYER, gridFilter(f));
  map.setPaintProperty(GRID_LAYER, 'fill-color', gridColor(f));
}

const gridColor = (f: PanoramaxFilter): Expr => ['interpolate', ['linear'], gridCoef(f),
  0, '#e1bee7', 0.25, '#ba68c8', 0.5, '#9c27b0', 0.75, '#7b1fa2', 1, '#4a148c'] as Expr;

/**
 * Значок обычного фото: точка со стрелкой вверх (поворачивается по heading — куда смотрит камера). У панорамы 360°
 * направления нет (heading — лишь ход машины) — просто точка.
 */
function pointImage(arrow: boolean): ImageData {
  const S = 32, c = new OffscreenCanvas(S, S).getContext('2d')!;
  c.fillStyle = arrow ? COLOR_FLAT : COLOR_360;
  c.strokeStyle = '#fff';
  c.lineWidth = 1.5;
  if (arrow) { c.beginPath(); c.moveTo(16, 2); c.lineTo(22, 12); c.lineTo(10, 12); c.closePath(); c.fill(); c.stroke(); }
  c.beginPath(); c.arc(16, 18, 6, 0, 2 * Math.PI); c.fill(); c.stroke();
  return c.getImageData(0, 0, S, S);
}

/**
 * Конус обзора открытого снимка: вершина в центре, смотрит вверх; fov — горизонтальный угол обзора, °.
 * Боковые границы — длинные линии (видно, что попадает в кадр), заливка к краю тает.
 */
function coneImage(fov: number): ImageData {
  const S = 400, c = new OffscreenCanvas(S, S).getContext('2d')!, r = S / 2;
  const half = THREE.MathUtils.degToRad(Math.min(fov, 170) / 2), a0 = -Math.PI / 2 - half, a1 = -Math.PI / 2 + half;
  const g = c.createRadialGradient(r, r, 0, r, r, r);
  g.addColorStop(0, 'rgba(255,122,0,0.45)');
  g.addColorStop(1, 'rgba(255,122,0,0)');
  c.fillStyle = g;
  c.beginPath(); c.moveTo(r, r); c.arc(r, r, r, a0, a1); c.closePath(); c.fill();
  c.lineCap = 'round';
  for (const [w, colour] of [[6, 'rgba(255,255,255,0.8)'], [3, '#ff7a00']] as const) {
    c.lineWidth = w; c.strokeStyle = colour;
    c.beginPath();
    c.moveTo(r + Math.cos(a0) * (r - 4), r + Math.sin(a0) * (r - 4)); c.lineTo(r, r);
    c.lineTo(r + Math.cos(a1) * (r - 4), r + Math.sin(a1) * (r - 4));
    c.stroke();
  }
  c.fillStyle = '#ff7a00'; c.strokeStyle = '#fff'; c.lineWidth = 3;
  c.beginPath(); c.arc(r, r, 9, 0, 2 * Math.PI); c.fill(); c.stroke();
  return c.getImageData(0, 0, S, S);
}

/** Область показа [з, ю, в, с] (режим здания) — как у снимков подложки. */
export type PanoramaxBounds = [number, number, number, number];
let clipBounds: PanoramaxBounds | undefined;
let appliedKey: string | undefined;
/** Источник обрезанных маршрутов (режим здания) и его обновление по загрузке тайлов. */
const SEQ_CLIP = 'panoramax-seq-clip';
/** Невидимый слой маршрутов из тайлов: без слоя в стиле MapLibre не разбирает их и querySourceFeatures пуст. */
const SEQ_RAW = 'panoramax-seq-raw';
let seqClipListener: ((e: MapSourceDataEvent) => void) | undefined;

/**
 * Обрезка по области режима здания: тайлы грузятся только задевающие её (bounds источника), точки снимков — только
 * внутри прямоугольника (within). Маршруты within отбросил бы целиком, если кусок выходит за край, — их режем
 * по прямоугольнику сами (clippedSequences).
 */
function clip(e: Expr): Expr {
  if (!clipBounds) return e;
  const [w, s, east, n] = clipBounds;
  const poly = { type: 'Polygon', coordinates: [[[w, s], [east, s], [east, n], [w, n], [w, s]]] };
  return ['all', e, ['within', poly]] as Expr;
}

/** Отрезок a–b внутри прямоугольника (Лян — Барски): доли от a, или undefined — снаружи. */
function clipSegment(a: number[], b: number[], [w, s, e, n]: PanoramaxBounds): [number, number] | undefined {
  let t0 = 0, t1 = 1;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  for (const [p, q] of [[-dx, a[0] - w], [dx, e - a[0]], [-dy, a[1] - s], [dy, n - a[1]]]) {
    if (p === 0) { if (q < 0) return; continue; }
    const t = q / p;
    if (p < 0) { if (t > t1) return; if (t > t0) t0 = t; } else { if (t < t0) return; if (t < t1) t1 = t; }
  }
  return [t0, t1];
}

/** Маршруты из загруженных тайлов, обрезанные по прямоугольнику: части внутри — отдельными линиями. */
function clippedSequences(map: MlMap, b: PanoramaxBounds): GeoJSON.FeatureCollection {
  const out: GeoJSON.Feature[] = [];
  const at = (a: number[], c: number[], t: number) => [a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t];
  for (const f of map.querySourceFeatures(SOURCE, { sourceLayer: 'sequences' })) {
    const g = f.geometry;
    // Свойства фичи тайла — не простой объект: в воркер MapLibre (setData) его не передать
    const properties = { type: f.properties.type, date: f.properties.date };
    const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
    for (const line of lines) {
      let run: number[][] = [];
      const flush = () => {
        if (run.length > 1) out.push({ type: 'Feature', properties, geometry: { type: 'LineString', coordinates: run } });
        run = [];
      };
      for (let i = 0; i + 1 < line.length; i++) {
        const t = clipSegment(line[i], line[i + 1], b);
        if (!t) { flush(); continue; }
        const p0 = at(line[i], line[i + 1], t[0]), p1 = at(line[i], line[i + 1], t[1]);
        if (!run.length || t[0] > 0) { flush(); run.push(p0); }
        run.push(p1);
        if (t[1] < 1) flush();
      }
      flush();
    }
  }
  return { type: 'FeatureCollection', features: out };
}

/** Слой снимков на карте; bounds — обрезать по области (режим здания); off — убрать. */
export function applyPanoramax(map: MlMap, on: boolean, filter: PanoramaxFilter, before?: string, bounds?: PanoramaxBounds) {
  // Без изменений — не пересоздавать источник (тайлы грузились бы заново)
  const key = on ? JSON.stringify(bounds ?? null) : 'off';
  if (key === appliedKey && (!on || map.getLayer(PIC_LAYER))) return;
  appliedKey = key;
  clipBounds = bounds;
  for (const id of [VIEW_LAYER, PIC_LAYER, SEQ_LAYER, SEQ_RAW, GRID_LAYER]) if (map.getLayer(id)) map.removeLayer(id);
  for (const id of [SOURCE, SEQ_CLIP]) if (map.getSource(id)) map.removeSource(id);
  if (seqClipListener) { map.off('sourcedata', seqClipListener); seqClipListener = undefined; }
  if (!on) return;
  if (!map.hasImage(ARROW)) map.addImage(ARROW, pointImage(true), { pixelRatio: 2 });
  if (!map.hasImage(DOT)) map.addImage(DOT, pointImage(false), { pixelRatio: 2 });
  if (!map.hasImage(CONE)) map.addImage(CONE, coneImage(70), { pixelRatio: 2 });
  map.addSource(SOURCE, {
    type: 'vector',
    tiles: [`${API}/map/2/{z}/{x}/{y}.mvt`],
    minzoom: 0,
    maxzoom: 17, // точки снимков — в тайлах с z15, все — с z17
    attribution: '<a href="https://panoramax.xyz" target="_blank" rel="noopener">Panoramax</a>',
    ...(bounds && { bounds }),
  });
  map.addLayer({
    id: GRID_LAYER, type: 'fill', source: SOURCE, 'source-layer': 'grid', maxzoom: GRID_MAXZOOM,
    filter: gridFilter(filter),
    paint: { 'fill-color': gridColor(filter), 'fill-opacity': 0.45 },
    layout: { 'fill-sort-key': gridCoef(filter) },
  }, before);
  if (bounds) {
    // Режим здания: маршруты — обрезанной копией из загруженных тайлов, обновляется по мере их загрузки
    map.addSource(SEQ_CLIP, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    let timer = 0;
    seqClipListener = (e) => {
      if (e.sourceId !== SOURCE || timer) return;
      timer = window.setTimeout(() => {
        timer = 0;
        (map.getSource(SEQ_CLIP) as GeoJSONSource | undefined)?.setData(clippedSequences(map, bounds));
      }, 100);
    };
    map.on('sourcedata', seqClipListener);
    map.addLayer({ id: SEQ_RAW, type: 'line', source: SOURCE, 'source-layer': 'sequences', paint: { 'line-opacity': 0 } }, before);
  }
  map.addLayer({
    id: SEQ_LAYER, type: 'line', minzoom: GRID_MAXZOOM,
    ...(bounds ? { source: SEQ_CLIP } : { source: SOURCE, 'source-layer': 'sequences' }),
    filter: filterExpr(filter, ['get', 'date']),
    paint: { 'line-color': typeColor, 'line-opacity': 0.7, 'line-width': ['interpolate', ['linear'], ['zoom'], 15, 1.5, 18, 3] },
    layout: { 'line-cap': 'round' },
  }, before);
  map.addLayer({
    id: PIC_LAYER, type: 'symbol', source: SOURCE, 'source-layer': 'pictures', minzoom: 17,
    filter: clip(filterExpr(filter, ['get', 'ts'])),
    layout: {
      'icon-image': ['case', IS_360, DOT, ARROW],
      'icon-size': ['interpolate', ['linear'], ['zoom'], 17, 0.6, 20, 1],
      'icon-rotate': ['case', IS_360, 0, ['coalesce', ['get', 'heading'], 0]],
      'icon-rotation-alignment': 'map',
      'icon-pitch-alignment': 'map',
      'icon-allow-overlap': true,
    },
  }, before);
  if (!map.getSource(VIEW_SOURCE)) map.addSource(VIEW_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({
    id: VIEW_LAYER, type: 'symbol', source: VIEW_SOURCE,
    layout: {
      'icon-image': CONE, 'icon-rotate': ['get', 'bearing'], 'icon-rotation-alignment': 'map',
      'icon-pitch-alignment': 'map', 'icon-allow-overlap': true, 'icon-ignore-placement': true,
    },
  }, before);
}

/** Настройки слоя в меню слоёв: тип снимков и даты съёмки. */
export function panoramaxSettings(f: PanoramaxFilter, onChange: (f: PanoramaxFilter) => void): HTMLElement {
  const el = document.createElement('div');
  el.className = 'panoramax-filter';
  // Тип — переключатель из трёх кнопок
  let typeValue = f.type;
  const type = document.createElement('div');
  type.className = 'panoramax-seg';
  for (const [v, label] of [['all', tr('Все')], ['flat', tr('Обычные')], ['360', '360°']] as const) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.classList.toggle('active', v === typeValue);
    b.addEventListener('click', () => {
      typeValue = v;
      for (const x of type.children) x.classList.toggle('active', x === b);
      emit();
    });
    type.append(b);
  }
  const date = (v: string) => {
    const i = document.createElement('input');
    i.type = 'date';
    i.value = v;
    return i;
  };
  const from = date(f.from), to = date(f.to);
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.textContent = '×';
  clear.title = tr('Сбросить даты');
  const emit = () => onChange({ type: typeValue, from: from.value, to: to.value });
  for (const i of [from, to]) i.addEventListener('change', emit);
  clear.addEventListener('click', () => { from.value = ''; to.value = ''; emit(); });
  // Сетка в две колонки: подписи слева, поля одной ширины справа (× — в третьей колонке у «по»)
  const label = (text: string) => {
    const l = document.createElement('span');
    l.textContent = text;
    return l;
  };
  el.append(label(tr('Тип')), type, document.createElement('span'),
    label(tr('Съёмка с')), from, document.createElement('span'),
    label(tr('по')), to, clear);
  // Клики внутри не закрывают меню и не переключают галку строки
  el.addEventListener('click', (e) => e.stopPropagation());
  return el;
}

/** Снимок Panoramax под точкой экрана (id). */
export function pickPanoramax(map: MlMap, p: PointLike): string | undefined {
  if (!map.getLayer(PIC_LAYER)) return;
  const [x, y] = Array.isArray(p) ? p : [(p as { x: number }).x, (p as { y: number }).y];
  const hits: MapGeoJSONFeature[] = map.queryRenderedFeatures([[x - 8, y - 8], [x + 8, y + 8]], { layers: [PIC_LAYER] });
  return hits[0]?.properties.id as string | undefined;
}

interface Picture {
  id: string;
  collection: string;
  lngLat: [number, number];
  /** Направление съёмки (центр кадра), ° от севера. */
  azimuth: number;
  pano: boolean;
  image: string;
  date: string;
  author: string;
  license: { title: string; href?: string };
  /** Соседние снимки маршрута: id и точка. */
  prev?: { id: string; lngLat: [number, number] };
  next?: { id: string; lngLat: [number, number] };
}

/**
 * Снимок как blob: URL. Адреса ассетов у снимков других инстансов (IGN…) — редирект на хранилище, и браузер,
 * взяв ответ хранилища из кэша (с Access-Control-Allow-Origin под другой Origin), отказывал по CORS. Без кэша — работает.
 */
async function loadImage(url: string): Promise<string> {
  let res: Response;
  try { res = await fetch(url, { cache: 'no-store' }); } catch { res = await fetch(`${url}${url.includes('?') ? '&' : '?'}_=${Date.now()}`, { cache: 'no-store' }); }
  if (!res.ok) throw new Error(`panoramax: ${res.status}`);
  return URL.createObjectURL(await res.blob());
}

interface StacLink { rel: string; href: string; title?: string; id?: string; geometry?: { coordinates: [number, number] } }

const neighbour = (l: StacLink | undefined) => (l?.id && l.geometry ? { id: l.id, lngLat: l.geometry.coordinates } : undefined);

/** Азимут от a к b, ° от севера по часовой. */
function bearing([lon1, lat1]: [number, number], [lon2, lat2]: [number, number]): number {
  const r = Math.PI / 180, dl = (lon2 - lon1) * r;
  const y = Math.sin(dl) * Math.cos(lat2 * r);
  const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos(dl);
  return (Math.atan2(y, x) / r + 360) % 360;
}

async function fetchPicture(id: string): Promise<Picture> {
  const res = await fetch(`${API}/search?ids=${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`panoramax: ${res.status}`);
  const f = ((await res.json()) as { features: Record<string, any>[] }).features[0];
  if (!f) throw new Error('panoramax: снимок не найден');
  const p = f.properties, links = f.links as StacLink[];
  const lic = links.find((l) => l.rel === 'license');
  return {
    id: f.id,
    collection: f.collection,
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

/** Скруглённый треугольник стрелки (остриём вверх): белый, с тёмной тенью — виден и на светлом фото. */
/**
 * Стрелка — плитка на «земле»: белая грань сверху, под ней слои в 3D (translateZ вниз) — боковина толщиной
 * и размытая тень на земле. Наклон «земли» делает стек видимым снизу при любом повороте стрелки.
 */
const ARROW_PATH = '<path d="M20 6 34 30H6z" stroke-width="7" stroke-linejoin="round"/>';
const ARROW_LAYER = (cls: string, z: number) =>
  `<svg class="${cls}" viewBox="-4 -4 48 48" style="transform:translateZ(${z}px)">${ARROW_PATH}</svg>`;
const ARROW_SVG = ARROW_LAYER('shadow', -14)
  + Array.from({ length: 10 }, (_, i) => ARROW_LAYER('side', -10 + i)).join('')
  + ARROW_LAYER('face', 0);
/** Края окна для изменения размера: n, s, e, w и углы. */
const EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const;

/** Окно просмотра снимка: перетаскивается за заголовок, размер — за края и углы. */
export class PanoramaxViewer {
  private readonly el: HTMLDivElement;
  private readonly stage: HTMLDivElement;
  private readonly info: HTMLDivElement;
  private readonly arrows: { prev: HTMLButtonElement; next: HTMLButtonElement };
  /** «Земля» под стрелками: круг внизу кадра, наклонённый в перспективе. */
  private readonly nav: HTMLDivElement;
  private readonly img: HTMLImageElement;
  private renderer?: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(75, 1, 0.1, 10);
  private sphere?: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  private pic?: Picture;
  /** Взгляд: азимут (° от севера) и наклон (°). */
  private yaw = 0;
  private pitch = 0;
  private loadId = 0;
  private readonly resize = new ResizeObserver(() => { this.draw(); this.syncCone(); });
  /** blob: URL показанного снимка — освободить при смене. */
  private blobUrl?: string;
  /** Раствор конуса на карте, ° — перерисовываем значок, когда угол обзора заметно изменился. */
  private coneFov = 70;
  /** Окно двигали или меняли его размер — больше не прижимаем его к панелям инструментов сами. */
  private userPlaced = false;

  constructor(private readonly map: MlMap) {
    const el = this.el = document.createElement('div');
    el.className = 'panoramax-viewer';
    el.hidden = true;
    // Заголовок — как у остальных панелей
    const head = document.createElement('header');
    head.className = 'panel-head panoramax-head';
    const title = document.createElement('h1');
    title.textContent = 'Panoramax';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'panoramax-close';
    close.textContent = '×';
    close.title = tr('Закрыть');
    close.addEventListener('click', () => this.close());
    head.append(title, close);
    this.stage = document.createElement('div');
    this.stage.className = 'panoramax-stage';
    this.img = document.createElement('img');
    this.img.alt = '';
    this.nav = document.createElement('div');
    this.nav.className = 'panoramax-nav';
    this.stage.append(this.nav);
    const arrow = (tip: string, go: () => string | undefined) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'panoramax-arrow';
      b.title = tip;
      b.hidden = true;
      b.innerHTML = ARROW_SVG;
      b.addEventListener('pointerdown', (e) => e.stopPropagation()); // не поворачивать панораму
      b.addEventListener('click', () => { const id = go(); if (id) void this.open(id); });
      this.nav.append(b);
      return b;
    };
    this.arrows = {
      prev: arrow(tr('Предыдущий снимок'), () => this.pic?.prev?.id),
      next: arrow(tr('Следующий снимок'), () => this.pic?.next?.id),
    };
    this.info = document.createElement('div');
    this.info.className = 'panoramax-info';
    el.append(head, this.stage, this.info);
    for (const d of EDGES) {
      const h = document.createElement('div');
      h.className = `panoramax-rs panoramax-rs-${d}`;
      el.append(h);
      this.bindResize(h, d);
    }
    document.body.append(el);
    this.bindMove(head);
    // Не налезать на вертикальные панели инструментов (в режиме здания они длинные)
    const toolbars = document.getElementById('toolbars');
    if (toolbars) {
      new MutationObserver(() => this.place()).observe(toolbars, { attributes: true, subtree: true, attributeFilter: ['hidden'] });
      new ResizeObserver(() => this.place()).observe(toolbars);
    }
    addEventListener('resize', () => this.place());
    this.resize.observe(this.stage);
    this.bindDrag();
  }

  get shown() { return !this.el.hidden; }

  /**
   * Пока окно не двигали — слева внизу, правее панелей инструментов, если они видны. Иначе — там, куда поставили,
   * но в пределах окна браузера.
   */
  private place() {
    if (this.el.hidden) return;
    if (!this.userPlaced) {
      const tb = document.getElementById('toolbars');
      const r = tb && tb.offsetParent ? tb.getBoundingClientRect() : undefined;
      const left = r && r.width ? r.right + 8 : 10;
      Object.assign(this.el.style, { left: `${left}px`, top: '', bottom: '34px',
        maxWidth: `${innerWidth - left - 10}px`, maxHeight: `${innerHeight - 60}px` });
      return;
    }
    const r = this.el.getBoundingClientRect();
    const w = Math.min(r.width, innerWidth), h = Math.min(r.height, innerHeight);
    this.setRect(Math.max(0, Math.min(r.left, innerWidth - w)), Math.max(0, Math.min(r.top, innerHeight - h)), w, h);
  }

  private setRect(left: number, top: number, width: number, height: number) {
    Object.assign(this.el.style, { left: `${left}px`, top: `${top}px`, bottom: '', width: `${width}px`, height: `${height}px`,
      maxWidth: '', maxHeight: '' });
  }

  /** Перетаскивание за заголовок (кроме кнопок). */
  private bindMove(head: HTMLElement) {
    let start: { x: number; y: number; r: DOMRect } | undefined;
    head.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('button')) return;
      e.preventDefault();
      start = { x: e.clientX, y: e.clientY, r: this.el.getBoundingClientRect() };
      head.setPointerCapture(e.pointerId);
    });
    head.addEventListener('pointermove', (e) => {
      if (!start) return;
      const { r } = start;
      this.userPlaced = true;
      this.setRect(Math.max(0, Math.min(r.left + e.clientX - start.x, innerWidth - r.width)),
        Math.max(0, Math.min(r.top + e.clientY - start.y, innerHeight - r.height)), r.width, r.height);
    });
    const up = () => { start = undefined; };
    head.addEventListener('pointerup', up);
    head.addEventListener('pointercancel', up);
  }

  /** Изменение размера за край или угол d: двигается только эта сторона. */
  private bindResize(h: HTMLElement, d: typeof EDGES[number]) {
    const MIN_W = 240, MIN_H = 180;
    let start: { x: number; y: number; r: DOMRect } | undefined;
    h.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      start = { x: e.clientX, y: e.clientY, r: this.el.getBoundingClientRect() };
      h.setPointerCapture(e.pointerId);
    });
    h.addEventListener('pointermove', (e) => {
      if (!start) return;
      const { r } = start, dx = e.clientX - start.x, dy = e.clientY - start.y;
      let { left, top, right, bottom } = r;
      if (d.includes('w')) left = Math.max(0, Math.min(left + dx, right - MIN_W));
      if (d.includes('e')) right = Math.min(innerWidth, Math.max(right + dx, left + MIN_W));
      if (d.includes('n')) top = Math.max(0, Math.min(top + dy, bottom - MIN_H));
      if (d.includes('s')) bottom = Math.min(innerHeight, Math.max(bottom + dy, top + MIN_H));
      this.userPlaced = true;
      this.setRect(left, top, right - left, bottom - top);
    });
    const up = () => { start = undefined; };
    h.addEventListener('pointerup', up);
    h.addEventListener('pointercancel', up);
  }

  /**
   * Стрелки к соседним снимкам — как на сайте Panoramax: всегда внизу кадра, обе сразу, на «земле» (круг в
   * перспективе); каждая повёрнута к своему снимку относительно взгляда — при повороте панорамы доворачивается.
   */
  private updateArrows() {
    const p = this.pic;
    // Направление взгляда: у панорамы — куда повернули, у фото — направление съёмки
    const view = p?.pano ? this.yaw : p?.azimuth ?? 0;
    for (const key of ['prev', 'next'] as const) {
      const b = this.arrows[key], n = p?.[key];
      b.hidden = !p || !n;
      if (!p || !n) continue;
      const rel = bearing(p.lngLat, n.lngLat) - view;
      b.style.transform = `rotate(${rel}deg) translateY(-40px)`;
    }
  }

  async open(id: string) {
    const load = ++this.loadId;
    this.el.hidden = false;
    this.place();
    this.info.textContent = tr('Загрузка…');
    let pic: Picture;
    try { pic = await fetchPicture(id); } catch { if (load === this.loadId) this.info.textContent = tr('Не удалось загрузить снимок'); return; }
    if (load !== this.loadId) return;
    this.pic = pic;
    // Смотрим туда же, куда смотрели (по следующим снимкам), иначе — по направлению съёмки
    if (!this.sphere?.visible) this.yaw = pic.azimuth;
    this.renderInfo(pic);
    let url: string;
    try { url = await loadImage(pic.image); } catch { if (load === this.loadId) this.info.textContent = tr('Не удалось загрузить снимок'); return; }
    if (load !== this.loadId) { URL.revokeObjectURL(url); return; }
    if (this.blobUrl) URL.revokeObjectURL(this.blobUrl);
    this.blobUrl = url;
    if (pic.pano) await this.showPano(url);
    else this.showFlat(url);
    this.updateArrows();
    this.syncCone();
  }

  close() {
    this.loadId++;
    this.el.hidden = true;
    this.pic = undefined;
    this.syncCone();
  }

  private renderInfo(pic: Picture) {
    const page = `https://api.panoramax.xyz/?pic=${pic.id}&focus=pic`;
    const lic = pic.license.href
      ? `<a href="${pic.license.href}" target="_blank" rel="noopener">${pic.license.title}</a>` : pic.license.title;
    this.info.innerHTML = '';
    const a = document.createElement('span');
    a.textContent = [pic.date, pic.author].filter(Boolean).join(' · ');
    const rest = document.createElement('span');
    rest.innerHTML = ` · ${lic} · <a href="${page}" target="_blank" rel="noopener">${tr('Открыть на Panoramax')}</a>`;
    this.info.append(a, rest);
  }

  private showFlat(url: string) {
    if (this.sphere) this.sphere.visible = false;
    this.renderer?.domElement.remove();
    this.img.src = url;
    this.stage.prepend(this.img);
  }

  private async showPano(url: string) {
    this.img.remove();
    if (!this.renderer) {
      this.renderer = new THREE.WebGLRenderer({ antialias: true });
      this.renderer.setPixelRatio(devicePixelRatio);
      this.sphere = new THREE.Mesh(new THREE.SphereGeometry(5, 64, 32), new THREE.MeshBasicMaterial({ side: THREE.BackSide }));
      this.sphere.scale.x = -1; // изнутри: без зеркала
      this.scene.add(this.sphere);
    }
    this.stage.prepend(this.renderer.domElement);
    const tex = await new THREE.TextureLoader().loadAsync(url).catch(() => undefined);
    if (!tex) { this.info.textContent = tr('Не удалось загрузить снимок'); return; }
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = this.sphere!.material;
    mat.map?.dispose();
    mat.map = tex;
    mat.needsUpdate = true;
    this.sphere!.visible = true;
    this.draw();
  }

  /** Перерисовать панораму по текущему взгляду. */
  private draw() {
    if (!this.pic?.pano) { this.updateArrows(); return; }
    if (!this.renderer) return;
    const w = this.stage.clientWidth, h = this.stage.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // Центр равнопромежуточной картинки (u = 0.5) — направление съёмки azimuth. SphereGeometry кладёт u = 0.5 на +X,
    // после зеркала по X (чтобы изнутри не было отражения) — на −X; вправо от взгляда на −X — это −Z.
    // Азимут взгляда относительно кадра: yaw − azimuth (по часовой, как на карте).
    const rel = THREE.MathUtils.degToRad(this.yaw - this.pic.azimuth), el = THREE.MathUtils.degToRad(this.pitch);
    this.camera.position.set(0, 0, 0);
    this.camera.lookAt(-Math.cos(el) * Math.cos(rel), Math.sin(el), -Math.cos(el) * Math.sin(rel));
    this.renderer.render(this.scene, this.camera);
    this.updateArrows();
  }

  private bindDrag() {
    let last: { x: number; y: number } | undefined;
    this.stage.addEventListener('pointerdown', (e) => {
      if (!this.pic?.pano) return;
      last = { x: e.clientX, y: e.clientY };
      this.stage.setPointerCapture(e.pointerId);
    });
    this.stage.addEventListener('pointermove', (e) => {
      if (!last) return;
      const k = this.camera.fov / this.stage.clientHeight;
      this.yaw = (this.yaw - (e.clientX - last.x) * k + 360) % 360;
      this.pitch = Math.max(-85, Math.min(85, this.pitch + (e.clientY - last.y) * k));
      last = { x: e.clientX, y: e.clientY };
      this.draw();
      this.syncCone();
    });
    const up = () => { last = undefined; };
    this.stage.addEventListener('pointerup', up);
    this.stage.addEventListener('pointercancel', up);
    this.stage.addEventListener('wheel', (e) => {
      if (!this.pic?.pano) return;
      e.preventDefault();
      this.camera.fov = Math.max(20, Math.min(100, this.camera.fov + e.deltaY * 0.05));
      this.draw();
      this.syncCone();
    }, { passive: false });
  }

  /** Конус на карте: точка снимка и направление взгляда. */
  syncCone() {
    const src = this.map.getSource(VIEW_SOURCE) as GeoJSONSource | undefined;
    if (!src) return;
    const p = this.pic;
    // Раствор: у панорамы — горизонтальный угол обзора окна, у обычного фото — условные 60°
    const fov = p?.pano
      ? THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2) * this.camera.aspect)) : 60;
    if (Math.abs(fov - this.coneFov) > 1 && this.map.hasImage(CONE)) {
      this.coneFov = fov;
      this.map.updateImage(CONE, coneImage(fov));
    }
    src.setData({ type: 'FeatureCollection', features: p ? [{
      type: 'Feature', geometry: { type: 'Point', coordinates: p.lngLat },
      properties: { bearing: p.pano ? this.yaw : p.azimuth },
    }] : [] });
  }
}

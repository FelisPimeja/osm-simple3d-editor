/**
 * Уличные фото и панорамы на карте (Panoramax, Mapillary — src/view/panoramax.ts, src/view/mapillary.ts): общее для
 * сервисов. На карте — векторные тайлы сервиса (маршруты и точки снимков с направлением), на мелких зумах — обзор
 * наличия снимков; по клику — снимок в окне просмотра: панорама 360° — сферой на three.js (перетаскивание — поворот,
 * колесо — зум), обычное фото — картинкой. У открытого снимка на карте — конус, куда сейчас смотрим (раствор — по углу
 * обзора окна). Фильтр: тип (обычные фото / 360°) и диапазон дат съёмки.
 */
import type { ExpressionSpecification, GeoJSONSource, LayerSpecification, Map as MlMap, MapSourceDataEvent, MapGeoJSONFeature, PointLike } from 'maplibre-gl';
import * as THREE from 'three';
import { tr } from '../i18n';
import { glPixels } from '../edit/eyedropper';

/** Выражение MapLibre (собираем из частей — типы спецификации тут не помогают). */
export type Expr = ExpressionSpecification;
/** Цвета: панорамы 360° — пурпурный (ближе к красному: заметно отличается), обычные фото — тёмно-синий. */
export const COLOR_360 = '#9c1f6e';
export const COLOR_FLAT = '#1e3a8a';
/** Непрозрачность маршрутов и снимков, закрытых зданиями. */
const GHOST_OPACITY = 0.3;

/** Фильтр снимков: тип и даты съёмки ('ГГГГ-ММ-ДД', пусто — без границы). */
export interface PhotoFilter { type: 'all' | 'flat' | '360'; from: string; to: string }

export const isPhotoFiltered = (f: PhotoFilter) => f.type !== 'all' || !!f.from || !!f.to;

/** Снимок для окна просмотра. */
export interface Picture {
  id: string;
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

/** Слой обзора на мелких зумах (сетка, точки): спецификация по фильтру; при смене фильтра обновляем filter, paint и layout. */
type OverviewSpec = { type: 'fill' | 'circle'; filter: Expr; paint: Record<string, unknown>; layout?: Record<string, unknown> };

/** Сервис уличных фото: тайлы, свойства в них и загрузка снимка. */
export interface PhotoService {
  /** Префикс слоёв и источников на карте и ключей настроек. */
  id: string;
  /** Название — заголовок окна. */
  name: string;
  tiles: string;
  maxzoom: number;
  attribution: string;
  /** Слои тайлов: маршруты и снимки. */
  seqLayer: string;
  picLayer: string;
  /** С какого зума — маршруты и снимки (до маршрутов — обзор). */
  seqMinzoom: number;
  picMinzoom: number;
  /** Свойства снимка в тайле: id, направление; панорама ли; дата съёмки у маршрута и снимка. */
  idProp: string;
  heading: Expr;
  isPano: Expr;
  seqDate: Expr;
  picDate: Expr;
  /** Дата в тайлах — миллисекунды (иначе строка 'ГГГГ-ММ-ДД…'). */
  dateMs?: boolean;
  /** Свойства маршрута, нужные слою (копируем при обрезке в режиме здания). */
  seqProps: string[];
  overview?: { sourceLayer: string; spec(f: PhotoFilter): OverviewSpec };
  fetchPicture(id: string): Promise<Picture>;
  /** Страница снимка на сайте сервиса и подпись ссылки. */
  pageUrl(pic: Picture): string;
  openLabel: string;
}

/** Включённость слоя и фильтр — в localStorage. */
export function storedOn(s: PhotoService): boolean {
  try { return localStorage.getItem(`osm3d.${s.id}`) === '1'; } catch { return false; }
}

export function storeOn(s: PhotoService, on: boolean) {
  try { if (on) localStorage.setItem(`osm3d.${s.id}`, '1'); else localStorage.removeItem(`osm3d.${s.id}`); } catch { /* до перезагрузки */ }
}

export function storedFilter(s: { id: string }): PhotoFilter | undefined {
  try {
    const v = localStorage.getItem(`osm3d.${s.id}-filter`);
    return v ? { type: 'all', from: '', to: '', ...JSON.parse(v) as Partial<PhotoFilter> } : undefined;
  } catch { return; }
}

export function storeFilter(s: { id: string }, f: PhotoFilter) {
  try {
    if (!isPhotoFiltered(f)) localStorage.removeItem(`osm3d.${s.id}-filter`);
    else localStorage.setItem(`osm3d.${s.id}-filter`, JSON.stringify(f));
  } catch { /* до перезагрузки */ }
}

/** Условия фильтра для слоя по типу (isPano) и дате (dateExpr). */
export function filterExpr(s: PhotoService, f: PhotoFilter, dateExpr: Expr | undefined): Expr {
  const all: unknown[] = [];
  if (f.type !== 'all') all.push(f.type === '360' ? s.isPano : ['!', s.isPano]);
  if (dateExpr) {
    if (s.dateMs) {
      const t = ['to-number', ['coalesce', dateExpr, 0]];
      if (f.from) all.push(['>=', t, Date.parse(f.from)]);
      if (f.to) all.push(['<', t, Date.parse(f.to) + 86400e3]);
    } else {
      const day = ['slice', ['to-string', ['coalesce', dateExpr, '']], 0, 10];
      if (f.from) all.push(['>=', day, f.from]);
      if (f.to) all.push(['<=', day, f.to]);
    }
  }
  return ['all', true, ...all] as Expr;
}

/**
 * Значок обычного фото: точка со стрелкой вверх (поворачивается по направлению камеры). У панорамы 360°
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
export type PhotoBounds = [number, number, number, number];

/** Отрезок a–b внутри прямоугольника (Лян — Барски): доли от a, или undefined — снаружи. */
function clipSegment(a: number[], b: number[], [w, s, e, n]: PhotoBounds): [number, number] | undefined {
  let t0 = 0, t1 = 1;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  for (const [p, q] of [[-dx, a[0] - w], [dx, e - a[0]], [-dy, a[1] - s], [dy, n - a[1]]]) {
    if (p === 0) { if (q < 0) return; continue; }
    const t = q / p;
    if (p < 0) { if (t > t1) return; if (t > t0) t0 = t; } else { if (t < t0) return; if (t < t1) t1 = t; }
  }
  return [t0, t1];
}

/** Слой снимков сервиса на карте. */
export class PhotoLayer {
  private readonly SOURCE: string;
  private readonly SEQ: string;
  private readonly PIC: string;
  private readonly OVERVIEW: string;
  /** Конус открытого снимка (источник и слой одного имени). */
  readonly VIEW: string;
  readonly CONE: string;
  private readonly ARROW: string;
  private readonly DOT: string;
  /** Источник обрезанных маршрутов (режим здания) и невидимый слой маршрутов из тайлов: без слоя в стиле MapLibre не разбирает их и querySourceFeatures пуст. */
  private readonly SEQ_CLIP: string;
  private readonly SEQ_RAW: string;
  /** Бледные копии маршрутов и снимков поверх зданий. */
  private readonly SEQ_GHOST: string;
  private readonly PIC_GHOST: string;
  private clipBounds?: PhotoBounds;
  private appliedKey?: string;
  private seqClipListener?: (e: MapSourceDataEvent) => void;

  constructor(private readonly map: MlMap, readonly service: PhotoService) {
    const p = service.id;
    this.SOURCE = p; this.SEQ = `${p}-sequences`; this.PIC = `${p}-pictures`; this.OVERVIEW = `${p}-overview`;
    this.VIEW = `${p}-view`; this.CONE = `${p}-cone`; this.ARROW = `${p}-arrow`; this.DOT = `${p}-dot`;
    this.SEQ_CLIP = `${p}-seq-clip`; this.SEQ_RAW = `${p}-seq-raw`;
    this.SEQ_GHOST = `${p}-sequences-ghost`; this.PIC_GHOST = `${p}-pictures-ghost`;
  }

  isLayer(id: string) { return id.startsWith(this.service.id); }

  /**
   * Обрезка по области режима здания: тайлы грузятся только задевающие её (bounds источника), точки снимков — только
   * внутри прямоугольника (within). Маршруты within отбросил бы целиком, если кусок выходит за край, — их режем
   * по прямоугольнику сами (clippedSequences).
   */
  private clip(e: Expr): Expr {
    if (!this.clipBounds) return e;
    const [w, s, east, n] = this.clipBounds;
    const poly = { type: 'Polygon', coordinates: [[[w, s], [east, s], [east, n], [w, n], [w, s]]] };
    return ['all', e, ['within', poly]] as Expr;
  }

  /** Маршруты из загруженных тайлов, обрезанные по прямоугольнику: части внутри — отдельными линиями. */
  private clippedSequences(b: PhotoBounds): GeoJSON.FeatureCollection {
    const out: GeoJSON.Feature[] = [];
    const at = (a: number[], c: number[], t: number) => [a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t];
    for (const f of this.map.querySourceFeatures(this.SOURCE, { sourceLayer: this.service.seqLayer })) {
      const g = f.geometry;
      // Свойства фичи тайла — не простой объект: в воркер MapLibre (setData) его не передать
      const properties = Object.fromEntries(this.service.seqProps.map((k) => [k, f.properties[k]]));
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

  /** Применить фильтр к показанным слоям. */
  setFilter(f: PhotoFilter) {
    const { map, service: s } = this;
    if (!map.getLayer(this.PIC)) return;
    for (const id of [this.PIC, this.PIC_GHOST]) map.setFilter(id, this.clip(filterExpr(s, f, s.picDate)));
    for (const id of [this.SEQ, this.SEQ_GHOST]) map.setFilter(id, filterExpr(s, f, s.seqDate));
    if (s.overview) {
      const o = s.overview.spec(f);
      map.setFilter(this.OVERVIEW, o.filter);
      for (const [k, v] of Object.entries(o.paint)) map.setPaintProperty(this.OVERVIEW, k as never, v as never);
      for (const [k, v] of Object.entries(o.layout ?? {})) map.setLayoutProperty(this.OVERVIEW, k as never, v as never);
    }
  }

  /**
   * Слой снимков; before — слой, под которым рисовать (поверх зданий), under — слой под зданиями: там основные
   * маршруты и снимки, здания их закрывают; bounds — обрезать по области (режим здания); off — убрать.
   */
  apply(on: boolean, filter: PhotoFilter, before?: string, bounds?: PhotoBounds, under?: string) {
    const { map, service: s } = this;
    // Без изменений — не пересоздавать источник (тайлы грузились бы заново)
    const key = on ? JSON.stringify(bounds ?? null) : 'off';
    if (key === this.appliedKey && (!on || map.getLayer(this.PIC))) return;
    this.appliedKey = key;
    this.clipBounds = bounds;
    for (const id of [this.VIEW, this.PIC, this.PIC_GHOST, this.SEQ, this.SEQ_GHOST, this.SEQ_RAW, this.OVERVIEW]) if (map.getLayer(id)) map.removeLayer(id);
    for (const id of [this.SOURCE, this.SEQ_CLIP]) if (map.getSource(id)) map.removeSource(id);
    if (this.seqClipListener) { map.off('sourcedata', this.seqClipListener); this.seqClipListener = undefined; }
    if (!on) return;
    if (!map.hasImage(this.ARROW)) map.addImage(this.ARROW, pointImage(true), { pixelRatio: 2 });
    if (!map.hasImage(this.DOT)) map.addImage(this.DOT, pointImage(false), { pixelRatio: 2 });
    if (!map.hasImage(this.CONE)) map.addImage(this.CONE, coneImage(70), { pixelRatio: 2 });
    map.addSource(this.SOURCE, {
      type: 'vector', tiles: [s.tiles], minzoom: 0, maxzoom: s.maxzoom, attribution: s.attribution,
      ...(bounds && { bounds }),
    });
    if (s.overview) {
      const o = s.overview.spec(filter);
      map.addLayer({
        id: this.OVERVIEW, source: this.SOURCE, 'source-layer': s.overview.sourceLayer, maxzoom: s.seqMinzoom, ...o,
      } as LayerSpecification, before);
    }
    if (bounds) {
      // Режим здания: маршруты — обрезанной копией из загруженных тайлов, обновляется по мере их загрузки
      map.addSource(this.SEQ_CLIP, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      let timer = 0;
      this.seqClipListener = (e) => {
        if (e.sourceId !== this.SOURCE || timer) return;
        timer = window.setTimeout(() => {
          timer = 0;
          (map.getSource(this.SEQ_CLIP) as GeoJSONSource | undefined)?.setData(this.clippedSequences(bounds));
        }, 100);
      };
      map.on('sourcedata', this.seqClipListener);
      map.addLayer({ id: this.SEQ_RAW, type: 'line', source: this.SOURCE, 'source-layer': s.seqLayer, paint: { 'line-opacity': 0 } }, before);
    }
    // Маршруты и снимки — дважды: под зданиями (здания их закрывают) и бледной копией поверх (видно сквозь здания)
    for (const [ghost, at] of [[false, under ?? before], [true, before]] as const) {
      const op = ghost ? GHOST_OPACITY : 1;
      map.addLayer({
        id: ghost ? this.SEQ_GHOST : this.SEQ, type: 'line', minzoom: s.seqMinzoom,
        ...(bounds ? { source: this.SEQ_CLIP } : { source: this.SOURCE, 'source-layer': s.seqLayer }),
        filter: filterExpr(s, filter, s.seqDate),
        paint: {
          'line-color': ['case', s.isPano, COLOR_360, COLOR_FLAT], 'line-opacity': 0.7 * op,
          'line-width': ['interpolate', ['linear'], ['zoom'], 15, 1.5, 18, 3],
        },
        layout: { 'line-cap': 'round' },
      }, at);
      map.addLayer({
        id: ghost ? this.PIC_GHOST : this.PIC, type: 'symbol', source: this.SOURCE, 'source-layer': s.picLayer, minzoom: s.picMinzoom,
        filter: this.clip(filterExpr(s, filter, s.picDate)),
        layout: {
          'icon-image': ['case', s.isPano, this.DOT, this.ARROW],
          'icon-size': ['interpolate', ['linear'], ['zoom'], 17, 0.6, 20, 1],
          'icon-rotate': ['case', s.isPano, 0, ['coalesce', s.heading, 0]],
          'icon-rotation-alignment': 'map',
          'icon-pitch-alignment': 'map',
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
        paint: { 'icon-opacity': op },
      }, at);
    }
    if (!map.getSource(this.VIEW)) map.addSource(this.VIEW, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: this.VIEW, type: 'symbol', source: this.VIEW,
      layout: {
        'icon-image': this.CONE, 'icon-rotate': ['get', 'bearing'], 'icon-rotation-alignment': 'map',
        'icon-pitch-alignment': 'map', 'icon-allow-overlap': true, 'icon-ignore-placement': true,
      },
    }, before);
  }

  /** Снимок под точкой экрана (id). */
  pick(p: PointLike): string | undefined {
    if (!this.map.getLayer(this.PIC)) return;
    const [x, y] = Array.isArray(p) ? p : [(p as { x: number }).x, (p as { y: number }).y];
    const hits: MapGeoJSONFeature[] = this.map.queryRenderedFeatures([[x - 8, y - 8], [x + 8, y + 8]], { layers: [this.PIC] });
    const id = hits[0]?.properties[this.service.idProp] as string | number | undefined;
    return id === undefined ? undefined : String(id);
  }
}

/** Настройки слоя в меню слоёв: тип снимков и даты съёмки. */
export function photoFilterSettings(f: PhotoFilter, onChange: (f: PhotoFilter) => void): HTMLElement {
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
    // Пустое поле — подсказка формата серым
    const empty = () => i.classList.toggle('empty', !i.value);
    i.addEventListener('input', empty);
    i.addEventListener('change', empty);
    empty();
    return i;
  };
  const from = date(f.from), to = date(f.to);
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.textContent = '×';
  clear.title = tr('Сбросить даты');
  const emit = () => onChange({ type: typeValue, from: from.value, to: to.value });
  for (const i of [from, to]) i.addEventListener('change', emit);
  clear.addEventListener('click', () => { from.value = ''; to.value = ''; from.classList.add('empty'); to.classList.add('empty'); emit(); });
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

/**
 * Снимок как blob: URL. Адреса ассетов у снимков других инстансов (IGN…) — редирект на хранилище, и браузер,
 * взяв ответ хранилища из кэша (с Access-Control-Allow-Origin под другой Origin), отказывал по CORS. Без кэша — работает.
 */
async function loadImage(url: string): Promise<string> {
  let res: Response;
  try { res = await fetch(url, { cache: 'no-store' }); } catch { res = await fetch(`${url}${url.includes('?') ? '&' : '?'}_=${Date.now()}`, { cache: 'no-store' }); }
  if (!res.ok) throw new Error(`photo: ${res.status}`);
  return URL.createObjectURL(await res.blob());
}

/** Азимут от a к b, ° от севера по часовой. */
function bearing([lon1, lat1]: [number, number], [lon2, lat2]: [number, number]): number {
  const r = Math.PI / 180, dl = (lon2 - lon1) * r;
  const y = Math.sin(dl) * Math.cos(lat2 * r);
  const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos(dl);
  return (Math.atan2(y, x) / r + 360) % 360;
}

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

/** Окно просмотра снимка (одно на все сервисы): перетаскивается за заголовок, размер — за края и углы. */
export class PhotoViewer {
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
  /** Холст с пикселями обычного фото (для пипетки) — по blob: URL. */
  private flatPixels?: { url: string; ctx: CanvasRenderingContext2D };
  /** Последний открытый снимок и его слой — покажем, когда слой снова включат. */
  private last?: { layer: PhotoLayer; id: string };
  /** Слой показанного снимка (его сервис и конус на карте). */
  private layer?: PhotoLayer;
  private readonly title: HTMLHeadingElement;

  /** onClose — окно закрыли кнопкой × (слой выключается вместе с окном). */
  constructor(private readonly map: MlMap, private readonly onClose: () => void) {
    const el = this.el = document.createElement('div');
    el.className = 'panoramax-viewer';
    el.hidden = true;
    // Заголовок — как у остальных панелей
    const head = document.createElement('header');
    head.className = 'panel-head panoramax-head';
    const title = this.title = document.createElement('h1');
    title.textContent = tr('Уличные фото');
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'panoramax-close';
    close.textContent = '×';
    close.title = tr('Закрыть');
    close.addEventListener('click', () => { this.close(); this.onClose(); });
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
      b.addEventListener('click', () => { const id = go(); if (id && this.layer) void this.open(this.layer, id); });
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

  /** Область фото — источник растра для пипетки (src/edit/eyedropper.ts). */
  get photoEl(): HTMLElement { return this.stage; }

  /**
   * Пока окно не двигали — слева внизу, правее панелей инструментов, если они видны; если открыто окно другого
   * сервиса — над ним. Иначе — там, куда поставили, но в пределах окна браузера.
   */
  private place() {
    if (this.el.hidden) return;
    if (!this.userPlaced) {
      const tb = document.getElementById('toolbars');
      const r = tb && tb.offsetParent ? tb.getBoundingClientRect() : undefined;
      const left = r && r.width ? r.right + 8 : 10;
      // Окна, открытые раньше и стоящие на месте по умолчанию, — ниже этого
      let bottom = 34;
      for (const o of document.querySelectorAll<HTMLElement>('.panoramax-viewer')) {
        if (o === this.el) break;
        if (!o.hidden && o.style.bottom) bottom = Math.max(bottom, innerHeight - o.getBoundingClientRect().top + 8);
      }
      Object.assign(this.el.style, { left: `${left}px`, top: '', bottom: `${bottom}px`,
        maxWidth: `${innerWidth - left - 10}px`, maxHeight: `${innerHeight - bottom - 26}px` });
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

  /** Открыть снимок id сервиса слоя layer (конус — на его слое, у прежнего — убрать). */
  async open(layer: PhotoLayer, id: string) {
    const load = ++this.loadId;
    if (this.layer !== layer) {
      this.pic = undefined;
      this.syncCone();
      this.layer = layer;
    }
    this.title.textContent = layer.service.name;
    this.el.hidden = false;
    this.place();
    this.info.textContent = tr('Загрузка…');
    let pic: Picture;
    try { pic = await layer.service.fetchPicture(id); } catch { if (load === this.loadId) this.info.textContent = tr('Не удалось загрузить снимок'); return; }
    if (load !== this.loadId) return;
    this.pic = pic;
    this.last = { layer, id: pic.id };
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

  /**
   * Показать окно (слой включили): последний снимок, если его слой включён (shown), иначе — подсказка.
   */
  show(shown: (layer: PhotoLayer) => boolean) {
    if (!this.el.hidden && (this.layer || !this.last || !shown(this.last.layer))) return;
    if (this.last && shown(this.last.layer)) { void this.open(this.last.layer, this.last.id); return; }
    this.pic = undefined;
    this.title.textContent = tr('Уличные фото');
    this.el.hidden = false;
    this.place();
    this.renderer?.domElement.remove();
    this.img.remove();
    this.updateArrows();
    this.info.textContent = tr('Кликните по снимку на карте');
  }

  /** Слой выключили: его снимок убрать из окна (окно остаётся, если включён другой слой). */
  drop(layer: PhotoLayer) {
    if (this.layer !== layer) return;
    this.loadId++;
    this.pic = undefined;
    this.syncCone();
    this.layer = undefined;
    this.title.textContent = tr('Уличные фото');
    this.renderer?.domElement.remove();
    this.img.remove();
    this.updateArrows();
    this.info.textContent = tr('Кликните по снимку на карте');
  }

  close() {
    this.loadId++;
    this.el.hidden = true;
    this.pic = undefined;
    this.syncCone();
  }

  private renderInfo(pic: Picture) {
    const lic = pic.license.href
      ? `<a href="${pic.license.href}" target="_blank" rel="noopener">${pic.license.title}</a>` : pic.license.title;
    this.info.innerHTML = '';
    const a = document.createElement('span');
    a.textContent = [pic.date, pic.author].filter(Boolean).join(' · ');
    const rest = document.createElement('span');
    rest.innerHTML = ` · ${lic} · <a href="${this.layer!.service.pageUrl(pic)}" target="_blank" rel="noopener">${this.layer!.service.openLabel}</a>`;
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

  /**
   * Пиксели фото вокруг точки стадии: квадрат (2R+1)², строки сверху вниз, RGBA (за краем фото — прозрачные).
   * Панораму перерисовываем и читаем из WebGL в той же задаче (буфер ещё не очищен; строки там снизу вверх);
   * обычное фото — из холста с картинкой (blob: — без CORS), в пикселях самой картинки.
   */
  pixelsAt(x: number, y: number, R: number): Uint8ClampedArray | undefined {
    const n = 2 * R + 1;
    if (this.pic?.pano && this.renderer) {
      this.draw();
      return glPixels(this.renderer.getContext(), x, y, R, this.renderer.getPixelRatio());
    }
    if (!this.pic || !this.img.naturalWidth) return;
    const { naturalWidth: nw, naturalHeight: nh } = this.img;
    if (this.flatPixels?.url !== this.img.src) {
      const ctx = new OffscreenCanvas(nw, nh).getContext('2d', { willReadFrequently: true }) as unknown as CanvasRenderingContext2D;
      ctx.drawImage(this.img, 0, 0);
      this.flatPixels = { url: this.img.src, ctx };
    }
    // object-fit: contain — картинка вписана по центру
    const w = this.stage.clientWidth, h = this.stage.clientHeight, s = Math.min(w / nw, h / nh);
    const ix = Math.round((x - (w - nw * s) / 2) / s), iy = Math.round((y - (h - nh * s) / 2) / s);
    if (ix < 0 || iy < 0 || ix >= nw || iy >= nh) return;
    return this.flatPixels.ctx.getImageData(ix - R, iy - R, n, n).data;
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
    if (!this.layer) return;
    const src = this.map.getSource(this.layer.VIEW) as GeoJSONSource | undefined;
    if (!src) return;
    const p = this.pic;
    // Раствор: у панорамы — горизонтальный угол обзора окна, у обычного фото — условные 60°
    const fov = p?.pano
      ? THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2) * this.camera.aspect)) : 60;
    if (Math.abs(fov - this.coneFov) > 1 && this.map.hasImage(this.layer.CONE)) {
      this.coneFov = fov;
      this.map.updateImage(this.layer.CONE, coneImage(fov));
    }
    src.setData({ type: 'FeatureCollection', features: p ? [{
      type: 'Feature', geometry: { type: 'Point', coordinates: p.lngLat },
      properties: { bearing: p.pano ? this.yaw : p.azimuth },
    }] : [] });
  }
}

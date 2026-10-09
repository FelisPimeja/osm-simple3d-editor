import polygonClipping from 'polygon-clipping';
import * as maplibregl from 'maplibre-gl';
import type { ExpressionSpecification, FillExtrusionLayerSpecification, MapGeoJSONFeature } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { fetchMap, type Bbox, type OsmElement, type OsmMember, type OsmNode } from './osm/api';
import { fetchUser, getToken, login, logout, type OsmUser } from './osm/auth';
import { SERVERS, server, setServer, type ServerId } from './osm/servers';
import { ConflictError, uploadEdits } from './osm/upload';
import { computeHeights, LEVEL_HEIGHT } from './osm/heights';
import { ViewCube } from './view/view-cube';
import { centroid, isBareOutlineTags, kindOf, markOutlinesWithParts, parseBuildings, pointInRing, pointOnSurface, type BuildingGroup, type Feature3D, type LonLat, type MemberWay, type Polygon } from './osm/model';
import { MoveTool } from './edit/move-tool';
import * as THREE from 'three';
import { inheritedTags, inheritedValue } from './osm/inherit';
import { BuildingsLayer, setInheritance, type GraphicsOptions, type RenderedFeature, type SnapHit, type SnapKind } from './render/buildings-layer';
import { gridKeyOfPoint, queryTileBuildings, tileFeatureIdsByTile, type TileBuildingFeature } from './tiles/tile-features';
import { OverpassTiles, type TileSource } from './view/overpass-tiles';
import { CursorOrbit } from './view/orbit';
import { PushTool, type PushTarget } from './edit/push-tool';
import { SplitTool, type CutPoint } from './edit/split-tool';
import { insertInLine, insertInRing, restructureRing, type Insert, type RingWay } from './edit/topology';
import { MeasureTool } from './edit/measure-tool';
import { OffsetTool } from './edit/offset-tool';
import { setToolCursor, type ToolCursor } from './view/cursors';
import { PAINT_TAGS, PaintTool } from './edit/paint-tool';
import { DrawTool, RECT_LABELS, RECT_MODES, type DrawShape, type RectMode } from './edit/draw-tool';
import { suggestComment } from './edit/changeset-comment';
import { EditSession, type ObjectEdit, type Tagged, type TagChange } from './edit/session';
import { onSkeletons } from './render/skeleton';
import { timed } from './perf';
import { bindTagForms, renderMultiTagForm, renderTagForm, type InheritSource } from './edit/tag-form';
import { computeOutlineRemainders, inPolygon, interiorPoint, polygonsOf } from './tiles/outlines';

const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
const BUILDINGS_LAYER = 'simple3d-buildings';
const REMAINDERS_LAYER = 'simple3d-outline-remainders';
const MERGED_LAYER = 'simple3d-merged-exploded';
const MERGED_HIGHLIGHT_LAYER = 'simple3d-merged-highlight';
const TILE_LAYERS = [BUILDINGS_LAYER, REMAINDERS_LAYER, MERGED_LAYER];
const HIGHLIGHT_LAYER = 'simple3d-highlight';
// Начиная с этого зума здания тайлов z14 подменяются данными OSM API
const OVERPASS_MIN_ZOOM = 15;
/** Ниже OVERPASS_MIN_ZOOM — только тайлы, уже лежащие в кеше (без запросов к Overpass). */
const CACHED_MIN_ZOOM = 10;
// Замена контуров с частями на «контур минус части» (src/tiles/outlines.ts). Временно выключено:
// по тайлам контур не отличить от части, эвристика даёт артефакты — см. PLAN.md.
const OUTLINE_REMAINDERS = false;
// Ограничение самого API — 0.25 deg², но берём заметно меньше, чтобы не упираться в 50k узлов
const MAX_API_AREA = 0.0004;

// Склеенные фичи (id с суффиксом 0) рисуем отдельным слоем, разрезанными на полигоны
const BASE_FILTER: ExpressionSpecification = ['all', ['!=', ['get', 'hide_3d'], true], ['!=', ['%', ['id'], 10], 0]];

// Здания из тайлов — условные (без крыш и частей), рисуем белыми, чтобы отличать от данных OSM API.
// Цвет из тайла (colour, с разбором 'a;b') — см. тег openfreemap-tiles.
const TILE_FILL = '#ffffff';

/** id тайловых фич-контуров, заменённых остатком «контур минус части». */
let replacedIds: number[] = [];
/**
 * Временно: скрытые вручную кнопкой «Скрыть» (для изучения наложений).
 * Ключ — id тайловой фичи или `key` полигона склеенной фичи.
 */
const userHidden = new Set<string>();

interface GraphicsSettings extends GraphicsOptions { antialias: boolean; monochrome: boolean; orbitAtCursor: boolean }
const GFX_KEY = 'osm3d.graphics';
const gfx: GraphicsSettings = { antialias: true, monochrome: false, orbitAtCursor: false, hemisphere: false, groundAO: false, edges: true, noGlass: false, ...loadGraphics() };

function loadGraphics(): Partial<GraphicsSettings> {
  try { return JSON.parse(localStorage.getItem(GFX_KEY) ?? '{}'); } catch { return {}; }
}
function saveGraphics() {
  try { localStorage.setItem(GFX_KEY, JSON.stringify(gfx)); } catch { /* приватный режим и т.п. */ }
}

// В сборке воркер MapLibre лежит в maplibre/ рядом со страницей (см. vite.config.ts); в dev — штатно из node_modules
if (import.meta.env.PROD) maplibregl.setWorkerUrl(new URL('maplibre/maplibre-gl-worker.mjs', document.baseURI).href);

/** Хэш карты из адреса до создания карты: в режиме здания наклон бывает больше, чем MapLibre примет вне его. */
const startHash = location.hash.slice(1).split('/').map(Number);

const map = new maplibregl.Map({
  container: 'map',
  // MSAA задаётся только при создании контекста — переключение требует перезагрузки
  canvasContextAttributes: { antialias: gfx.antialias },
  style: STYLE_URL,
  // Shift+клик — множественное выделение; зум рамкой с Shift перехватывал бы клик
  boxZoom: false,
  center: [37.6205, 55.7535],
  zoom: 16,
  pitch: 60,
  bearing: -20,
  hash: true,
  maxPitch: 175, // хэш из ссылки на здание (наклон до 175°) не должен отбрасываться; потом ограничит orbit
});
// View cube (только в режиме здания, слева от кнопок масштаба): вид с грани, ребра или угла куба по осям здания
const viewCube = new ViewCube({
  frame: () => {
    const box = focus ? overpassLayer.focusBox() : undefined;
    if (!box) return;
    const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
    const a = overpassLayer.focusAxes;
    return { center: [c.x, c.y, c.z], half: Math.max(s.x, s.y, s.z) / 2, x: a?.x ?? [1, 0], y: a?.y ?? [0, 1] };
  },
  center: () => (focus ? overpassLayer.focusFrame()?.center : undefined),
});
map.addControl(viewCube, 'top-right');
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }));
// В режиме здания вместо компаса — кнопка куба вида (показать / скрыть), выбор запоминается
const cubeBtn = document.createElement('button');
cubeBtn.type = 'button';
cubeBtn.className = 'maplibregl-ctrl-cube';
cubeBtn.title = 'Куб вида';
// Куб на кольце компаса (как сам view cube) — чтобы не путать со значком части здания
cubeBtn.innerHTML = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><ellipse cx="10" cy="13.2" rx="8" ry="3.6" stroke-width="1.6" opacity=".55"/><path d="M10 2.2 14.6 4.7v5.4L10 12.6 5.4 10.1V4.7z" fill="#fff"/><path d="M5.4 4.7 10 7.2l4.6-2.5M10 7.2v5.4"/></svg>';
document.querySelector('.maplibregl-ctrl-compass')?.after(cubeBtn);
try { viewCube.shown = localStorage.getItem('view-cube') !== 'off'; } catch { /* по умолчанию показан */ }
cubeBtn.classList.toggle('active', viewCube.shown);
cubeBtn.addEventListener('click', () => {
  viewCube.shown = !viewCube.shown;
  cubeBtn.classList.toggle('active', viewCube.shown);
  try { localStorage.setItem('view-cube', viewCube.shown ? 'on' : 'off'); } catch { /* только до перезагрузки */ }
  viewCube.update();
});

const infoEl = document.getElementById('info')!;

// Сворачивание панелей в заголовок; состояние запоминается.
function setCollapsed(panel: HTMLElement, collapsed: boolean) {
  const btn = panel.querySelector<HTMLButtonElement>('.collapse-btn')!;
  panel.classList.toggle('collapsed', collapsed);
  btn.setAttribute('aria-expanded', String(!collapsed));
  btn.title = collapsed ? 'Развернуть' : 'Свернуть';
}
for (const panel of document.querySelectorAll<HTMLElement>('.panel')) {
  // Панель правок сворачивается и раскрывается сама (renderChanges) — состояние не запоминаем
  const auto = panel.hasAttribute('data-auto-collapse');
  const storeKey = `osm3d.collapsed.${panel.id}`;
  if (!auto) try { setCollapsed(panel, localStorage.getItem(storeKey) === '1'); } catch { /* нет хранилища */ }
  panel.querySelector('.panel-head')!.addEventListener('click', () => {
    const collapsed = !panel.classList.contains('collapsed');
    setCollapsed(panel, collapsed);
    if (!auto) try { localStorage.setItem(storeKey, collapsed ? '1' : '0'); } catch { /* нет хранилища */ }
  });
}
const editsPanel = document.getElementById('edits-panel')!;
const outlinerPanel = document.getElementById('outliner-panel')!;
const outlinerEl = document.getElementById('outliner')!;
const outlinerCount = document.getElementById('outliner-count')!;
/** Скрытые глазиком части в режиме здания — только показ, на данные не влияет. */
const focusHidden = new Set<string>();
const editsCount = document.getElementById('edits-count')!;
/** Было ли в панели правок что показать при прошлой отрисовке: раскрываем/сворачиваем только на переходе. */
let editsHadContent = false;
const statusEl = document.getElementById('status')!;
const opIndicator = document.getElementById('op-indicator')!;
opIndicator.querySelector('.retry')!.addEventListener('click', () => overpass.retryFailed());
const monoToggle = document.getElementById('mono-toggle') as HTMLInputElement;

/**
 * Правки поверх данных тайлов. Объект попадает в сессию (копией), когда его выделяют;
 * при отрисовке тайлов отслеживаемые объекты подменяются этими копиями — правки переживают перезагрузку тайлов.
 */
let session = new EditSession([], onSessionChange);
const overpassLayer = new BuildingsLayer('osm-overpass-buildings');
const overpass = new OverpassTiles(map, overpassLayer, () => {
  updateTileFilter();
  showOverpassStatus();
}, (f) => (session.isDeleted(f.key) ? { ...f, polygons: [] } : (session.get(f.key) as Feature3D | undefined) ?? f));
overpass.setExtras(() => session.createdAlive().filter((t): t is Feature3D => 'polygons' in t && !!t.polygons?.length) as Feature3D[]);
let selectedKey: string | undefined;
/** Все выделенные объекты (Shift+клик добавляет); selectedKey — последний из них. */
let selection: string[] = [];
/** Режим «добавить части»: группа, в которую добавляем, и отмеченные Shift+кликом кандидаты. */
let addingTo: BuildingGroup | undefined;
let addPending: string[] = [];
/** Временные отрицательные id для создаваемых отношений. */
let nextNewId = -1;
/** Отношения type=building, попавшие в сессию (выделенные, изменённые, созданные), и индекс «член → группа». */
let editGroups = new Map<string, EditGroup>();
let editMemberGroup = new Map<string, string>();
/** Группа, в которую «провалились» двойным кликом: внутри неё выделяются отдельные части. */
let drill: BuildingGroup | undefined;
/** Режим одного здания (группа, в которую вошли двойным кликом): окружение скрыто. */
let focus: BuildingGroup | undefined;
/** Видимость слоёв стиля до входа в режим одного здания. */
let focusHiddenLayers: { id: string; visibility: string }[] = [];
/** Слои зданий тайлов, ждущие возврата после выхода из режима здания. */
let pendingTileLayers: { id: string; visibility: string }[] = [];
/** Группа в сессии: ещё и члены с ролями (их можно править). */
type EditGroup = BuildingGroup & Tagged & { relMembers: OsmMember[] };
let osmUser: OsmUser | undefined;
let uploadComment = '';
let uploading = false;
const changesEl = document.getElementById('changes')!;
const accountEl = document.getElementById('account')!;

map.on('load', () => {
  // Убираем штатные экструзии стиля и добавляем свою с учётом Simple 3D
  for (const layer of map.getStyle().layers) {
    if (layer.type === 'fill-extrusion') map.removeLayer(layer.id);
  }

  const extrusion: FillExtrusionLayerSpecification['paint'] = {
    'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 5],
    'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
    'fill-extrusion-opacity': 0.9,
  };

  map.addLayer({
    id: BUILDINGS_LAYER,
    type: 'fill-extrusion',
    source: 'openmaptiles',
    'source-layer': 'building',
    minzoom: 14,
    filter: BASE_FILTER,
    paint: {
      ...extrusion,
      'fill-extrusion-color': TILE_FILL,
    },
  });

  map.addSource('outline-remainders', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({
    id: REMAINDERS_LAYER,
    type: 'fill-extrusion',
    source: 'outline-remainders',
    minzoom: 14,
    paint: { ...extrusion, 'fill-extrusion-color': TILE_FILL },
  });

  map.addSource('merged-exploded', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({
    id: MERGED_LAYER,
    type: 'fill-extrusion',
    source: 'merged-exploded',
    minzoom: 14,
    paint: { ...extrusion, 'fill-extrusion-color': TILE_FILL },
  });
  map.addLayer({
    id: MERGED_HIGHLIGHT_LAYER,
    type: 'fill-extrusion',
    source: 'merged-exploded',
    minzoom: 14,
    filter: ['==', ['get', 'key'], ''],
    paint: { ...extrusion, 'fill-extrusion-color': '#ff7a00' },
  });

  map.addLayer({
    id: HIGHLIGHT_LAYER,
    type: 'fill-extrusion',
    source: 'openmaptiles',
    'source-layer': 'building',
    minzoom: 14,
    filter: ['==', ['id'], -1],
    paint: { ...extrusion, 'fill-extrusion-color': '#ff7a00' },
  });

  map.addLayer(overpassLayer);
  overpass.setSource(tileSource());
  refreshOverpass();
});

map.on('moveend', () => refreshOverpass());

// Все здания белым — тайловые и так белые, переключаем только слои с данными OSM
monoToggle.checked = gfx.monochrome;
monoToggle.addEventListener('change', () => {
  gfx.monochrome = monoToggle.checked;
  saveGraphics();
  applyMonochrome();
});
// Вращение вокруг точки под курсором (как в SketchUp)
const orbit = new CursorOrbit(map, (x, y) => {
  const hit = overpassLayer.pickHit([x, y]);
  // В режиме здания мимо геометрии — вокруг центра здания
  if (!hit && focus) { const c = overpassLayer.focusCenter(); if (c) return c; }
  // Не попали в 3D-слой (тайловое здание или пусто) — точка на земле
  return hit ?? { lngLat: map.unproject([x, y]), altitude: 0 };
});
const orbitToggle = document.getElementById('orbit-toggle') as HTMLInputElement;
orbitToggle.checked = gfx.orbitAtCursor;
orbit.setEnabled(gfx.orbitAtCursor);
orbitToggle.addEventListener('change', () => {
  gfx.orbitAtCursor = orbitToggle.checked;
  saveGraphics();
  orbit.setEnabled(gfx.orbitAtCursor || !!focus); // в режиме здания вращение вокруг курсора всегда
});

function applyMonochrome() {
  overpassLayer.setMonochrome(gfx.monochrome);
}
applyMonochrome();

// Настройки графики: отдельные галки, чтобы сравнивать влияние на производительность
for (const input of document.querySelectorAll<HTMLInputElement>('[data-gfx]')) {
  const key = input.dataset.gfx as keyof GraphicsSettings;
  input.checked = !!gfx[key];
  input.addEventListener('change', () => {
    gfx[key] = input.checked;
    saveGraphics();
    if (key === 'antialias') return location.reload();
    applyGraphics();
  });
}

function applyGraphics() {
  overpassLayer.setGraphics(gfx);
}
applyGraphics();

// Постоянный кеш тайлов OSM API (IndexedDB)
const cacheInfo = document.getElementById('cache-info')!;
async function showCacheInfo() {
  cacheInfo.textContent = `Кэш тайлов: ${await overpass.store.count()}`;
}
document.getElementById('cache-clear')!.addEventListener('click', async () => {
  await overpass.clearStore();
  await showCacheInfo();
});
document.getElementById('tiles-reload')!.addEventListener('click', () => {
  if (overpass.mode !== 'full') return setStatus(`Тайлы загружаются с z ≥ ${OVERPASS_MIN_ZOOM}.`, true);
  setStatus(`Перезапрашиваем тайлов (${overpass.sourceLabel}): ${overpass.reloadVisible()}.`);
});
document.getElementById('gfx')!.addEventListener('toggle', () => void showCacheInfo());
void showCacheInfo();

// FPS считаем по кадрам MapLibre (рисует по требованию — смотреть при движении карты)
const perfEl = document.getElementById('perf')!;
let frames = 0;
map.on('render', () => frames++);
setInterval(() => {
  const triangles = overpassLayer.lastTriangles;
  perfEl.textContent = `FPS: ${frames} · треугольников: ${triangles.toLocaleString('ru')}`;
  frames = 0;
}, 1000);

function refreshOverpass() {
  // В режиме здания окружение не видно — тайлы не грузим и не собираем (у горизонта их в кадре десятки)
  if (!map.getLayer(overpassLayer.id) || focus) return;
  timed('refreshOverpass', refreshOverpassImpl);
}

function refreshOverpassImpl() {
  const z = map.getZoom();
  overpass.mode = z >= OVERPASS_MIN_ZOOM ? 'full' : z >= CACHED_MIN_ZOOM ? 'cached' : 'off';
  overpass.update();
}

function showOverpassStatus() {
  updateOverpassIndicator();
  updateDraftStyle();
  if (uploading) return;
  const src = overpass.sourceLabel;
  if (!overpass.enabled) return setStatus(`Здания из тайлов. С z ≥ ${OVERPASS_MIN_ZOOM} — из ${src}.`);
  const { ready, total, loading, waiting } = overpass.status();
  if (overpass.mode === 'cached') {
    return setStatus(`Здания из тайлов${ready ? `, рядом с центром — из кеша ${src} (${ready} тайлов)` : ''}. С z ≥ ${OVERPASS_MIN_ZOOM} — из ${src}.`);
  }
  setStatus(`${src}: ${ready}/${total} тайлов${loading ? `, загружается ${loading}` : ''}${waiting ? `, ждут повтора ${waiting} (лимит/ошибка, см. консоль)` : ''}.`);
}

// Пересчитываем контуры с частями, когда догрузились новые тайлы
let tilesChanged = false;
let lastMergedSig = '';
const isMergedId = (id: number) => id % 10 === 0;
map.on('sourcedata', (e) => {
  if (e.sourceId === 'openmaptiles' && e.isSourceLoaded) tilesChanged = true;
});
map.on('idle', () => {
  if (!tilesChanged || !map.getLayer(BUILDINGS_LAYER)) return;
  tilesChanged = false;
  timed('idle: склеенные фичи и фильтр', onTilesIdle);
});

function onTilesIdle() {
  // Склеенные фичи (суффикс 0) — только они нужны для разрезанного слоя; обрезка кешируется на тайле
  const merged = timed('тайлы: склеенные фичи', () => explodeMerged(queryTileBuildings(map, 'openmaptiles', 'building', isMergedId)), (r) => `${r.length} полигонов`);
  const mergedSig = merged.map((f) => f.properties!.key).join('|');
  if (mergedSig !== lastMergedSig) {
    // setData заставляет MapLibre заново обработать весь GeoJSON в воркере — только если состав изменился
    lastMergedSig = mergedSig;
    (map.getSource('merged-exploded') as maplibregl.GeoJSONSource).setData({ type: 'FeatureCollection', features: merged });
  }
  if (OUTLINE_REMAINDERS) {
    const tileFeatures = map.querySourceFeatures('openmaptiles', { sourceLayer: 'building' });
    const { replacedIds: ids, remainders } = computeOutlineRemainders(
      tileFeatures
        .filter((f) => typeof f.id === 'number' && !f.properties.hide_3d)
        .map((f) => ({
          id: f.id as number,
          geometry: f.geometry,
          height: f.properties.render_height ?? 0,
          minHeight: f.properties.render_min_height ?? 0,
          colour: f.properties.colour,
        })),
    );
    replacedIds = [...ids];
    (map.getSource('outline-remainders') as maplibregl.GeoJSONSource).setData({ type: 'FeatureCollection', features: remainders });
  }
  updateTileFilter();
}

/**
 * Planetiler склеивает в одну фичу (id с суффиксом 0) все полигоны тайла с одинаковыми атрибутами —
 * это разные, часто разбросанные здания. Режем на отдельные полигоны, чтобы работать с каждым.
 * key — стабильный в пределах тайла ключ полигона: исходный id + центр.
 */
function explodeMerged(features: TileBuildingFeature[]): GeoJSON.Feature<GeoJSON.Polygon>[] {
  const visible = features.filter((f) => !f.properties.hide_3d);
  const out = new Map<string, GeoJSON.Feature<GeoJSON.Polygon>>();
  for (const f of visible) {
    if (f.id % 10 !== 0) continue;
    for (const poly of f.polys) {
      const ring = poly[0];
      const cx = ring.reduce((s, p) => s + p[0], 0) / ring.length;
      const cy = ring.reduce((s, p) => s + p[1], 0) / ring.length;
      const key = `${f.id}@${cx.toFixed(5)},${cy.toFixed(5)}`;
      out.set(key, {
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: poly },
        properties: { ...f.properties, src: f.id, key, tile: f.tile ?? gridKeyOfPoint(ring[0]) ?? '' },
      });
    }
  }
  return [...out.values()];
}

let lastFilterSig = '';

function updateTileFilter() {
  const notIn = (ids: number[]): ExpressionSpecification => ['!', ['in', ['id'], ['literal', ids]]];
  const hiddenIds = [...userHidden].map(Number).filter(Number.isFinite);
  // Тайлы, здания которых уже нарисованы из данных API
  const overpassTiles = overpass.displayed();
  const byTile = overpassTiles.length ? timed('тайлы: id по клеткам', () => tileFeatureIdsByTile(map, 'openmaptiles', 'building')) : new Map<string, number[]>();
  const overpassIds = overpassTiles.flatMap((k) => byTile.get(k) ?? []);
  // setFilter перестраивает бакеты всех тайлов слоя — вызываем, только если набор скрытого изменился
  const sig = [replacedIds.length, hiddenIds.join(), overpassTiles.sort().join(), overpassIds.length].join('|');
  if (sig === lastFilterSig) return;
  lastFilterSig = sig;
  console.debug(`[perf] setFilter: скрыто ${overpassIds.length} фич тайлов под Overpass`);
  map.setFilter(BUILDINGS_LAYER, ['all', BASE_FILTER, notIn([...replacedIds, ...hiddenIds, ...overpassIds])]);
  map.setFilter(REMAINDERS_LAYER, notIn(hiddenIds));
  map.setFilter(MERGED_LAYER, ['all',
    ['!', ['in', ['get', 'tile'], ['literal', overpassTiles]]],
    ['!', ['in', ['get', 'key'], ['literal', [...userHidden]]]]]);
}

/** Группа type=building объекта (или сама группа по своему ключу) в текущем режиме. */
function groupOf(key: string): BuildingGroup | undefined {
  // Группы из сессии (с правками состава, созданные) главнее данных тайлов
  const own = editMemberGroup.get(key) ?? (editGroups.has(key) && session.get(key) ? key : undefined);
  if (own) return editGroups.get(own);
  const g = overpass.groupOf(key);
  // Группа есть в сессии, но объекта в ней уже нет (исключили) — или её создание отменили
  if (g && editGroups.has(g.key)) return undefined;
  return g;
}

/** Индекс «член → группа» по существующим сейчас группам сессии (созданные можно отменить). */
function rebuildGroupIndex() {
  editMemberGroup = new Map();
  for (const g of [...editGroups.values()]) {
    if (!session.get(g.key)) continue;
    for (const m of g.members) if (!editMemberGroup.has(m)) editMemberGroup.set(m, g.key);
  }
}

/** Объект сессии по ключу; при первом обращении — копия из данных тайлов. */
function entity(key: string): Tagged | undefined {
  if (session.has(key)) return session.get(key);
  const g = overpass.groupOf(key);
  if (g?.key === key) {
    const copy: EditGroup = {
      ...g, tags: { ...g.tags }, members: [...g.members], roles: [...g.roles],
      relMembers: g.members.map((k, i) => {
        const [type, ref] = k.split('/');
        return { type: type as 'way' | 'relation', ref: Number(ref), role: g.roles[i] ?? '' };
      }),
    };
    editGroups.set(key, copy);
    session.track(copy);
    rebuildGroupIndex();
    return copy;
  }
  // Не нарисованный в тайлах (часть здания из соседнего тайла) — из загруженных данных
  const f = overpass.get(key)?.feature ?? overpass.findFeature(key);
  if (!f) return;
  // У мультиполигона — состав (пути-члены): правка топологии меняет его
  const relMembers = f.ways?.map((w) => ({ type: 'way' as const, ref: w.id, role: w.role }));
  return session.track({ ...f, tags: { ...f.tags }, ...(relMembers ? { relMembers } : {}) });
}

/** Что выделить по клику: вне группы — группу целиком; внутри группы — часть; клик мимо группы — выход к ней. */
function resolveClick(key: string | undefined): string | undefined {
  if (focus) return key && focus.members.includes(key) ? key : undefined; // из режима здания клик не выводит
  if (drill) {
    if (key && drill.members.includes(key)) return key;
    const g = drill;
    leaveDrill();
    return g.key;
  }
  return key ? (groupOf(key)?.key ?? key) : undefined;
}

/** Ключи для подсветки: у группы — все её члены. */
function highlightKeys(key: string | undefined): string[] {
  if (!key) return [];
  const g = groupOf(key);
  return g?.key === key ? g.members : [key];
}

map.on('click', (e) => {
  if (suppressClick) return;
  if (copyPick) { pickCopyBase([e.point.x, e.point.y]); return; }
  if (drawTool.active) { drawTool.click([e.point.x, e.point.y]); updateSnap([e.point.x, e.point.y]); return; }
  if (measureTool.active) { measureTool.click([e.point.x, e.point.y]); updateSnap([e.point.x, e.point.y]); return; }
  if (offsetTool.active) { offsetTool.click([e.point.x, e.point.y], e.originalEvent.shiftKey); return; }
  if (paintTool.active) {
    // Образец уже взят на нажатии (Ctrl/Cmd/Alt) — этот клик его же
    if (performance.now() - paintPickedAt > 600) paintTool.click([e.point.x, e.point.y], false);
    return;
  }
  if (splitTool.active) {
    const p: [number, number] = [e.point.x, e.point.y];
    if (!splitTool.click(p) && splitTool.state === 'pick') { splitTool.stop(); measureTool.stop(); paintTool.stop(); offsetTool.stop(); select(undefined); }
    return;
  }
  if (pushTool.active) {
    const p: [number, number] = [e.point.x, e.point.y];
    // Мимо объектов при невыбранной грани — выключить инструмент
    if (!pushTool.click(p, e.originalEvent.shiftKey) && pushTool.state === 'pick' && !overpassLayer.pickHit(e.point)) { pushTool.stop(); select(undefined); }
    updateSnap(p);
    return;
  }
  if (moveTool.active) {
    // Перемещение не начато, клик мимо всех объектов — выключаем инструмент и снимаем выделение
    if (moveTool.state === 'pick' && !overpassLayer.snapAt([e.point.x, e.point.y], moveTool.pickFilter) && !overpassLayer.pickHit(e.point)) {
      moveTool.stop();
      select(undefined);
      updateSnap(undefined);
      return;
    }
    moveTool.click([e.point.x, e.point.y]);
    updateSnap([e.point.x, e.point.y]);
    return;
  }
  const key = e.originalEvent.altKey ? cyclePick(e.point) : overpassLayer.pick(e.point);
  if (addingTo) {
    if (e.originalEvent.shiftKey) { if (key) toggleAddPending(key); return; }
    stopAdding(); // обычный клик — выходим из режима добавления
  }
  if (e.originalEvent.shiftKey && key) {
    // Shift+клик: добавить/убрать объект; внутри группы — только её члены
    const k = drill ? (drill.members.includes(key) ? key : undefined) : (groupOf(key)?.key ?? key);
    if (k) toggleSelection(k);
    return;
  }
  if (select(resolveClick(key))) return;
  const f = queryTileLayers(e.point)[0];
  infoEl.innerHTML = f ? describeTile(f) : '';
  map.setFilter(HIGHLIGHT_LAYER, ['==', ['id'], f?.layer.id === MERGED_LAYER ? -1 : f?.id ?? -1]);
  map.setFilter(MERGED_HIGHLIGHT_LAYER, ['==', ['get', 'key'], f?.layer.id === MERGED_LAYER ? f.properties.key : '']);
  if (f) resolveTileFeature(f);
});

/** Alt+клик: повторные клики в ту же точку по очереди выбирают объекты под курсором, от ближнего к дальнему. */
let altCycle: { x: number; y: number; keys: string[]; i: number } | undefined;
function cyclePick(p: { x: number; y: number }): string | undefined {
  const same = altCycle && Math.hypot(p.x - altCycle.x, p.y - altCycle.y) < 5;
  // Вне группы клик выделяет всё здание — перебираем разные результаты, а не части одного здания
  // (resolveClick не годится — он выходит из группы)
  const keys = overpassLayer.pickAll([p.x, p.y]).filter((k) => !focus || focus.members.includes(k));
  if (!keys.length) { altCycle = undefined; return; }
  const resolved = (k: string) => focus || drill?.members.includes(k) ? k : groupOf(k)?.key ?? k;
  const uniq: string[] = [];
  for (const k of keys) if (!uniq.some((u) => resolved(u) === resolved(k))) uniq.push(k);
  const i = same && altCycle!.keys.join() === uniq.join() ? (altCycle!.i + 1) % uniq.length : 0;
  altCycle = { x: p.x, y: p.y, keys: uniq, i };
  setStatus(`Alt+клик: объект ${i + 1} из ${uniq.length} под курсором.`);
  return uniq[i];
}

// Двойной клик по группе — режим одного здания (вместо приближения карты); ничего не выделяется
map.on('dblclick', (e) => {
  const key = overpassLayer.pick(e.point);
  if (focus) {
    // Двойной клик мимо здания — назад к карте
    e.preventDefault();
    if (toolActive()) return;
    if (!key) closeFocus();
    return;
  }
  if (!key) return;
  const g = groupOf(key) ?? soloGroup(key);
  if (!g) return;
  e.preventDefault();
  enterFocus(g);
});

/** Здание режима здания в адресе: ?edit=w123 / ?edit=r456 (хэш карты не трогаем, в историю не пишем). */
function setEditParam(key: string | undefined) {
  const m = key?.match(/^(way|relation)\/(\d+)$/); // новые (отрицательные id) — не в адрес
  const url = new URL(location.href);
  if (m) url.searchParams.set('edit', m[1][0] + m[2]);
  else url.searchParams.delete('edit');
  if (url.href !== location.href) history.replaceState(history.state, '', url);
}

/** Открыть здание из ссылки ?edit=: без хэша — подлёт к объекту, вход — когда он появится в данных тайлов. */
async function openEditLink() {
  const m = new URLSearchParams(location.search).get('edit')?.match(/^([wr])(\d+)$/);
  if (!m) return;
  const type = m[1] === 'w' ? 'way' : 'relation', key = `${type}/${m[2]}`;
  const linked = startHash.length >= 3 && startHash.every(Number.isFinite);
  if (!linked) {
    try {
      const res = await fetch(`${server().api}/${type}/${m[2]}/full.json`);
      if (!res.ok) throw new Error(`OSM API ${res.status}`);
      const nodes = ((await res.json()) as { elements: OsmElement[] }).elements.filter((e): e is OsmNode => e.type === 'node');
      if (!nodes.length) throw new Error('нет узлов');
      const lon = nodes.map((n) => n.lon), lat = nodes.map((n) => n.lat);
      map.fitBounds([[Math.min(...lon), Math.min(...lat)], [Math.max(...lon), Math.max(...lat)]], { padding: 80, maxZoom: 18, pitch: map.getPitch(), bearing: map.getBearing(), duration: 0 });
    } catch (err) {
      setEditParam(undefined);
      return setStatus(`Ссылка на ${key}: объект не загрузился (${(err as Error).message}).`, true);
    }
  }
  const deadline = Date.now() + 60_000;
  const tryEnter = () => {
    if (focus) return clearInterval(timer);
    if (!map.getLayer(overpassLayer.id)) return; // стиль и слой зданий ещё не готовы
    // Карту не показываем вовсе: пустая сцена режима здания, пока здание не пришло
    if (!focusHiddenLayers.length) { hideMapLayers(); overpassLayer.setFocus([]); }
    const g = type === 'relation' ? (groupOf(key)?.key === key ? groupOf(key) : soloGroup(key)) : groupOf(key) ?? soloGroup(key);
    // Отношение может прийти с соседним тайлом раньше своих частей — ждём, пока появится хоть одна
    if (g && groupFeatures(g).length) {
      clearInterval(timer);
      enterFocus(g, !linked);
      // Ракурс ссылки: наклон вне режима здания урезан, в режиме здания он снова допустим
      if (linked) map.jumpTo({ center: [startHash[2], startHash[1]], zoom: startHash[0], bearing: startHash[3] || 0, pitch: Math.min(startHash[4] || 0, map.getMaxPitch()) });
    }
    else if (Date.now() > deadline) {
      clearInterval(timer);
      setEditParam(undefined);
      overpassLayer.setFocus(undefined);
      for (const { id, visibility } of focusHiddenLayers) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visibility as 'visible' | 'none');
      focusHiddenLayers = [];
      setStatus(`${key}: здание не найдено в загруженных данных.`, true);
    }
  };
  // Не ждём, пока догрузится вся карта (idle): входим, как только здание пришло с первым тайлом
  const timer = setInterval(tryEnter, 100);
}

/** Префикс ключа «группы» отдельного здания (без отношения type=building) в режиме здания. */
const SOLO = 'solo:';
const isSolo = (g: BuildingGroup | undefined) => !!g?.key.startsWith(SOLO);

/** Отдельное здание (путь или мультиполигон с building=*) — как группа из одного объекта; отношения нет. */
/** Объект входит в здание режима здания (с запасом на случай, если focus отстал от состава отношения). */
function inFocus(k: string): boolean {
  if (!focus) return false;
  return focus.members.includes(k) || !!groupOf(focus.key)?.members.includes(k) || !!groupOf(focus.members[0])?.members.includes(k);
}

function soloGroup(key: string): BuildingGroup | undefined {
  const f = entity(key) as Feature3D | undefined;
  if (!f?.polygons?.length || editGroups.has(key) || f.tags.type === 'building') return;
  return { key: SOLO + key, type: 'relation', id: 0, version: 0, tags: {}, members: [key], roles: [''] };
}

/** Члены группы для отрисовки: из сессии (с правками) или из тайлов. */
function groupFeatures(g: BuildingGroup): Feature3D[] {
  return g.members.map((k) => (session.get(k) as Feature3D | undefined) ?? overpass.get(k)?.feature).filter((f): f is Feature3D => !!f);
}

/** Контуры отношения без своей высоты — в режиме здания рисуются плоским полигоном. */
function bareOutlines(g: BuildingGroup): string[] {
  return g.members.filter((k, i) => {
    if (g.roles[i] !== 'outline') return false;
    const t = entity(k)?.tags;
    // Контур нового отношения, покрытый частями (рассекли отдельное здание), — плоским следом; часть
    // поменьше (надстройка, пристройка) — нет: объём по-прежнему задаёт контур
    return !!t && (isBareOutlineTags(t) || (g.id < 0 && outlineCovered(g, k)));
  });
}

/** Части группы покрывают контур key (то же правило, что на карте: ≥ 50% площади, внутри объёма контура). */
function outlineCovered(g: BuildingGroup, key: string): boolean {
  const feats = groupFeatures(g);
  const outline = feats.find((f) => f.key === key);
  if (!outline) return false;
  const probe: Feature3D = { ...outline, kind: 'building', hasParts: false };
  const parts = feats.filter((f, i) => f.key !== key && g.roles[g.members.indexOf(f.key)] === 'part' && i >= 0).map((f) => ({ ...f, kind: 'part' as const }));
  markOutlinesWithParts([...parts, probe], [probe]);
  return probe.hasParts;
}

/** Скрыть слои карты на время режима здания (запоминая, как было); уже скрыты (ссылка на здание) — не трогать. */
function hideMapLayers() {
  if (focusHiddenLayers.length) return;
  for (const l of map.getStyle().layers) {
    if (l.id === overpassLayer.id || l.type === 'background') continue;
    const pending = pendingTileLayers.find((p) => p.id === l.id);
    focusHiddenLayers.push(pending ?? { id: l.id, visibility: (map.getLayoutProperty(l.id, 'visibility') as string | undefined) ?? 'visible' });
    map.setLayoutProperty(l.id, 'visibility', 'none');
  }
}

function enterFocus(g: BuildingGroup, flyIn = true) {
  // Вход в здание посреди наброска на карте (двойной клик при включённом R / L): набросок закрыть сейчас —
  // иначе его закрытие позже (пробел, Esc) снимет сцену режима здания вместе с собой
  if (sketching) drawTool.stop();
  if (!focus) hideMapLayers();
  const fly = !focus && flyIn;
  if (focus?.key !== g.key) {
    // Голые контуры (без высоты, всё здание — части) по умолчанию выключены, включаются глазиком
    session.dropViewActions(); // шаги скрытия — о прежнем здании
    focusHidden.clear();
    for (const k of bareOutlines(g)) focusHidden.add(k);
  }
  drill = focus = g;
  focusToolbar.hidden = false;
  syncMapTools();
  orbit.setEnabled(true);
  orbit.setUnderground(true);
  overpassLayer.setFocus(groupFeatures(g), bareOutlines(g));
  overpassLayer.setFocusHidden(focusHidden);
  // На следующем кадре: внутри обработки dblclick MapLibre после обработчиков останавливает камеру (stop)
  if (fly) requestAnimationFrame(flyToFocus);
  addingTo = undefined;
  addPending = [];
  selection = [];
  selectedKey = undefined;
  clearTileHighlight();
  paintSelection();
  renderSelected();
  setEditParam(isSolo(g) ? g.members[0] : g.key);
}

/** Доля экрана, которую занимает здание после подлёта. */
const FOCUS_FILL = 0.8;

/** Плавный подлёт к зданию режима: оно занимает 80% ширины или высоты экрана; наклон и поворот те же. */
function flyToFocus() {
  const center = overpassLayer.focusFrame()?.center;
  if (!center) return;
  const canvas = map.getCanvas();
  // Центр и размер — по всему экрану, панели не вычитаем (так нагляднее)
  const availW = canvas.clientWidth, availH = canvas.clientHeight;
  // Размер на экране зависит от удалённости от камеры (перспектива) — меряем на пробной камере,
  // уже наведённой на здание, и уточняем зум несколько раз
  type Tr = { clone(): Tr; setCenter(c: maplibregl.LngLat): void; setZoom(z: number): void; getProjectionDataForCustomLayer(): { mainMatrix: ArrayLike<number> } };
  const measure = (z: number) => {
    // В maplibre-gl 6 состояние камеры — во внутреннем map._camera.transform
    const tr = (map as unknown as { _camera: { transform: Tr } })._camera.transform.clone();
    tr.setCenter(center);
    tr.setZoom(z);
    return overpassLayer.focusFrame(tr.getProjectionDataForCustomLayer().mainMatrix)?.rect;
  };
  let zoom = map.getZoom();
  let rect: [number, number, number, number] | undefined;
  try {
    rect = measure(zoom);
    for (let i = 0; rect && i < 5; i++) {
      const [x0, y0, x1, y1] = rect;
      const step = Math.log2(Math.min(availW * FOCUS_FILL / Math.max(x1 - x0, 1), availH * FOCUS_FILL / Math.max(y1 - y0, 1)));
      if (!Number.isFinite(step)) { rect = undefined; break; }
      zoom = Math.min(zoom + step, map.getMaxZoom());
      rect = measure(zoom);
      if (Math.abs(step) < 0.02) break;
    }
  } catch (err) {
    console.warn('[focus] замер на пробной камере не удался', err);
    rect = undefined;
  }
  // Запасной вариант: по текущему виду, без учёта перспективы
  const now = overpassLayer.focusFrame()?.rect;
  if (!rect && now) {
    const scale = Math.min(availW * FOCUS_FILL / Math.max(now[2] - now[0], 1), availH * FOCUS_FILL / Math.max(now[3] - now[1], 1));
    zoom = Math.min(map.getZoom() + Math.log2(scale), map.getMaxZoom());
  }
  // Пробная камера смотрит в основание здания — сдвигаем так, чтобы в центр экрана попал весь объём
  const dx = rect ? (rect[0] + rect[2]) / 2 - canvas.clientWidth / 2 : 0;
  const dy = rect ? (rect[1] + rect[3]) / 2 - canvas.clientHeight / 2 : 0;
  map.easeTo({
    center,
    zoom,
    offset: [-dx, -dy],
    duration: 800,
  });
}

/** Удалённые в сессии объекты — чтобы заметить удаление и его отмену. */
const deletedKeys = new Set<string>();

/**
 * Удалить выделенные объекты одним шагом истории (отменяется Ctrl+Z). В режиме здания — части (контур нельзя:
 * без него отношение сломается), они же убираются из отношения; на карте — отдельные здания-пути вне отношений.
 * При отправке путь уходит в <delete> вместе с узлами без тегов, которые больше никому не нужны.
 */
function deleteSelected() {
  const keys = [...selection];
  const why = (k: string): string | undefined => {
    // Мультиполигон удаляется вместе со своими путями без тегов (при отправке)
    if (!k.startsWith('way/') && entity(k)?.tags.type !== 'multipolygon') return `${k}: удалять можно только пути и мультиполигоны.`;
    if (focus && !isSolo(focus)) {
      if (!inFocus(k)) return `${k} не входит в это здание.`;
      if (focus.roles[focus.members.indexOf(k)] === 'outline') return 'Контур здания (outline) удалить нельзя — только части.';
    } else if (!focus && groupOf(k)) return `${k} входит в здание type=building — удалите его в режиме здания (двойной клик).`;
    return;
  };
  const err = keys.map(why).find(Boolean);
  if (err) return setStatus(err, true);
  const edits: Parameters<typeof session.editMany>[0] = keys.map((k) => { entity(k); return { key: k, delete: true }; });
  if (focus && !isSolo(focus)) {
    const g = entity(focus.key) as EditGroup | undefined;
    if (g) edits.push({ key: g.key, members: g.relMembers.filter((m) => !keys.includes(`${m.type}/${m.ref}`)) });
  }
  // Удалили само отдельное здание (а не вставленную рядом копию) — выходим на карту
  const solo = isSolo(focus) && keys.includes(focus!.members[0]);
  select(undefined);
  session.editMany(edits);
  if (solo) leaveDrill();
  setStatus(`Удалено объектов: ${keys.length}. Отменить — Ctrl+Z.`);
}

/** Тайлы карты устарели (правки в режиме здания) — перерисовать при выходе. */
let tilesStale = false;
/** Объекты, правленные в режиме здания: при выходе перерисовываются только их тайлы. */
const staleKeys = new Set<string>();

function exitFocus() {
  if (!focus) return;
  focus = undefined;
  setEditParam(undefined);
  if (tilesStale) { tilesStale = false; overpass.rerenderFeatures(staleKeys); staleKeys.clear(); }
  focusHidden.clear();
  session.dropViewActions();
  overpassLayer.setHover(undefined);
  moveTool.stop();
  pushTool.stop();
  splitTool.stop(); measureTool.stop(); paintTool.stop(); offsetTool.stop();
  drawTool.stop();
  focusToolbar.hidden = true;
  syncMapTools();
  renderOutliner();
  updateSnap(undefined);
  orbit.setUnderground(false);
  orbit.setEnabled(gfx.orbitAtCursor);
  overpassLayer.setFocus(undefined);
  const restore = (ls: typeof focusHiddenLayers) => {
    for (const { id, visibility } of ls) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visibility as 'visible' | 'none');
  };
  // Здания из векторных тайлов — только после того, как тайлы догрузятся и фильтр скроет то, что уже есть
  // из API; иначе на миг мелькает их грубая геометрия
  const tileLayers = pendingTileLayers = focusHiddenLayers.filter((l) => TILE_LAYERS.includes(l.id));
  restore(focusHiddenLayers.filter((l) => !TILE_LAYERS.includes(l.id)));
  focusHiddenLayers = [];
  map.once('idle', () => {
    if (focus || pendingTileLayers !== tileLayers) return; // успели снова войти в режим здания — вернёт следующий выход
    pendingTileLayers = [];
    updateTileFilter();
    restore(tileLayers);
  });
  refreshOverpass(); // камера могла уйти — догружаем тайлы
}

/** Выйти из группы (и из режима одного здания). */
function leaveDrill() {
  drill = undefined;
  exitFocus();
}

/** Выйти из режима одного здания, оставив группу выделенной. */
function closeFocus() {
  const g = focus;
  if (!g) return;
  leaveDrill();
  select(isSolo(g) ? g.members[0] : g.key);
}

// Привязки в режиме здания: маркер у ближайшей вершины, середины ребра или центра объекта
const snapEl = document.createElement('div');
snapEl.className = 'snap-marker';
snapEl.hidden = true;
map.getContainer().appendChild(snapEl);
const SNAP_LABELS = { vertex: 'Вершина', midpoint: 'Середина', center: 'Центр', grid: 'Сетка', perpendicular: 'Перпендикуляр', edge: 'На ребре', extension: 'Продолжение' } as const;
/** Текущая привязка под курсором — для будущих инструментов геометрии. */
let currentSnap: SnapHit | undefined;

function updateSnap(point: [number, number] | undefined) {
  updateSnapMarker(point);
  overpassLayer.setSnapLine(currentSnap?.along && [currentSnap.along, currentSnap.local]);
}

// Alt — привязки временно выключены (пока зажат)
for (const type of ['keydown', 'keyup'] as const) {
  window.addEventListener(type, (e) => {
    if (e.key !== 'Alt' || overpassLayer.snapsSuspended === (type === 'keydown')) return;
    overpassLayer.snapsSuspended = type === 'keydown';
    if (lastPointer) updateSnap(lastPointer);
  });
}
window.addEventListener('blur', () => { overpassLayer.snapsSuspended = false; });

function updateSnapMarker(point: [number, number] | undefined) {
  if (point && moveTool.state === 'move') moveTool.move(point);
  if (point && pushTool.state === 'push') pushTool.move(point);
  if (point && splitTool.state === 'cut') splitTool.move(point);
  if (point && drawTool.active) drawTool.move(point);
  if (point && measureTool.active) measureTool.move(point);
  if (point && offsetTool.active) offsetTool.move(point);
  if (pushTool.active || splitTool.active || drawTool.active || measureTool.active || copyPick) {
    // Рассечение: подсвечиваем вершины и середины рёбер объектов (концы разреза)
    currentSnap = pushTool.active ? (pushTool.state === 'push' ? pushTool.snap : undefined)
      : drawTool.active ? (point ? drawTool.snap : undefined)
      : measureTool.active ? (point ? measureTool.snap : undefined)
      : splitTool.state === 'cut' ? (point ? splitTool.snap : undefined)
      : point ? overpassLayer.snapAt(point) : undefined;
    if (currentSnap?.kind === 'center') currentSnap = undefined;
    snapEl.hidden = !currentSnap;
    if (currentSnap) {
      snapEl.className = `snap-marker ${currentSnap.kind}`;
      snapEl.dataset.label = SNAP_LABELS[currentSnap.kind];
      snapEl.style.left = `${currentSnap.point[0]}px`;
      snapEl.style.top = `${currentSnap.point[1]}px`;
    }
    return;
  }
  // Привязки — только при активном инструменте
  currentSnap = !focus || !point || !moveTool.active ? undefined
    : moveTool.state === 'move' ? moveTool.snap
    : overpassLayer.snapAt(point, moveTool.pickFilter);
  snapEl.hidden = !currentSnap;
  if (!currentSnap) return;
  snapEl.className = `snap-marker ${currentSnap.kind}`;
  snapEl.dataset.label = SNAP_LABELS[currentSnap.kind];
  snapEl.style.left = `${currentSnap.point[0]}px`;
  snapEl.style.top = `${currentSnap.point[1]}px`;
}
/** Последняя точка курсора над картой — чтобы пересчитать привязку после S без движения мыши. */
let lastPointer: [number, number] | undefined;
map.on('mousemove', (e) => { lastPointer = [e.point.x, e.point.y]; updateSnap(lastPointer); });
map.on('movestart', () => { if (moveTool.state !== 'move') updateSnap(undefined); });
map.getCanvasContainer().addEventListener('mouseleave', () => updateSnap(undefined));

// --- Инструменты режима здания ---
const focusToolbar = document.getElementById('focus-tools')!;
const moveBtn = focusToolbar.querySelector<HTMLButtonElement>('[data-tool="move"]')!;
const popupEl = document.getElementById('popup')!;
const moveTool = new MoveTool(overpassLayer, map.getContainer(), commitMove, (hint) => {
  moveBtn.classList.toggle('active', moveTool.active);
  syncCursor();
  if (hint) setStatus(hint);
  else showOverpassStatus();
});

moveBtn.addEventListener('click', () => (moveTool.active ? moveTool.stop() : startMove()));

// Инструмент «Вытянуть»: верх/низ по вертикали (height / min_height) и стены по нормали (узлы контура)
const pushBtn = focusToolbar.querySelector<HTMLButtonElement>('[data-tool="push"]')!;
const pushTool = new PushTool(overpassLayer, map.getContainer(),
  (key) => !!focus?.members.includes(key) && !focusHidden.has(key),
  allowPushSide, clampPush, previewPush, commitPush,
  (hint) => {
    pushBtn.classList.toggle('active', pushTool.active);
    syncCursor();
    if (hint) setStatus(hint); else showOverpassStatus();
  });
pushBtn.addEventListener('click', () => (pushTool.active ? pushTool.stop() : startPush()));

function startPush() {
  if (!focus) return;
  moveTool.stop();
  splitTool.stop(); measureTool.stop(); paintTool.stop(); offsetTool.stop();
  drawTool.stop();
  pushTool.start();
}

// Инструмент «Рассечь»: прямой разрез верхней грани делит путь на два (больший сохраняет историю)
const splitBtn = focusToolbar.querySelector<HTMLButtonElement>('[data-tool="split"]')!;
const splitTool = new SplitTool(overpassLayer, splitReason, splitFeature, (hint, error) => {
  splitBtn.classList.toggle('active', splitTool.active);
  syncCursor();
  if (hint) setStatus(hint, error); else showOverpassStatus();
});
splitBtn.addEventListener('click', () => (splitTool.active ? splitTool.stop() : startSplit()));

function startSplit() {
  if (!focus) return;
  moveTool.stop();
  pushTool.stop();
  drawTool.stop();
  measureTool.stop();
  paintTool.stop();
  offsetTool.stop();
  splitTool.begin();
}

// Инструмент «Рулетка» (T): расстояние между двумя точками
const measureBtn = focusToolbar.querySelector<HTMLButtonElement>('[data-tool="measure"]')!;
const measureTool = new MeasureTool(overpassLayer, map.getContainer(), (hint) => {
  measureBtn.classList.toggle('active', measureTool.active);
  syncCursor();
  if (hint) setStatus(hint); else showOverpassStatus();
});
measureBtn.addEventListener('click', () => (measureTool.active ? measureTool.stop() : startMeasure()));

function startMeasure() {
  if (!focus) return;
  moveTool.stop(); pushTool.stop(); splitTool.stop(); drawTool.stop(); paintTool.stop(); offsetTool.stop();
  measureTool.start();
}

// Инструмент «Заливка» (B): Ctrl+клик — взять цвет и материал поверхности, клик — назначить
const paintBtn = focusToolbar.querySelector<HTMLButtonElement>('[data-tool="paint"]')!;
const paintTool = new PaintTool(overpassLayer,
  (key) => !!focus?.members.includes(key) && !focusHidden.has(key),
  (key, face) => {
    const t = PAINT_TAGS[face];
    const own = entity(key)?.tags ?? {};
    // Своего нет — то, с чем объект нарисован (унаследованное от контура или отношения)
    const inh = (tag: string) => own[tag] ?? inheritSources(key).map((s) => inheritedValue(s.tags, tag)).find((v) => v !== undefined);
    return { from: face, colour: inh(t.colour), material: inh(t.material) };
  },
  (key, face, sample) => {
    const t = PAINT_TAGS[face];
    if (!entity(key)) return;
    session.setTags(key, { [t.colour]: sample.colour, [t.material]: sample.material });
    setStatus(`${face === 'roof' ? 'Крыша' : 'Фасад'} ${key}: цвет ${sample.colour ?? '—'}, материал ${sample.material ?? '—'}. Отменить — Ctrl+Z.`);
  },
  (hint, error) => {
    paintBtn.classList.toggle('active', paintTool.active);
    syncCursor();
    if (hint) setStatus(hint, error); else showOverpassStatus();
  });
paintBtn.addEventListener('click', () => (paintTool.active ? paintTool.stop() : startPaint()));

function startPaint() {
  if (!focus) return;
  moveTool.stop(); pushTool.stop(); splitTool.stop(); drawTool.stop(); measureTool.stop(); offsetTool.stop();
  paintTool.start();
}

// Инструмент «Отступ» (O): от контура плоской крыши или низа (Shift) — новый плоский контур наружу или внутрь
const offsetBtn = focusToolbar.querySelector<HTMLButtonElement>('[data-tool="offset"]')!;
const offsetTool = new OffsetTool(overpassLayer, map.getContainer(),
  (point, back) => {
    const hits = overpassLayer.focusRayHits(point, (k) => !!focus?.members.includes(k) && !focusHidden.has(k));
    if (!hits.length) return;
    const key = hits[0].key;
    const box = overpassLayer.focusItemBox(key);
    const polys = overpassLayer.focusPolygons(key);
    const f = entity(key) as Feature3D | undefined;
    if (!box || !polys?.length || !f) return;
    let face: 'top' | 'bottom' = 'bottom';
    if (!back) {
      const h = hits[0];
      const shape = f.tags['roof:shape'];
      // Только плоская крыша: верх у скатов не плоский — откладывать не от чего
      if (h.face === 'wall' || (shape && shape !== 'flat') || Math.abs(h.local.z - box.max.z) > 0.05) {
        return 'Отступ — от плоской крыши (или Shift+клик — от низа).';
      }
      face = 'top';
    }
    const at: [number, number] = [hits[0].local.x, hits[0].local.y];
    const poly = polys.find((p) => pointInRing(at, p.outer)) ?? polys[0];
    return { key, face, z: face === 'top' ? box.max.z : box.min.z, ring: poly.outer };
  },
  (t, ring) => {
    const tags = entity(t.key)?.tags ?? {};
    const fmt = (v: number) => String(Math.round(v * 100) / 100);
    const out: Record<string, string> = { 'building:part': 'yes' };
    // Как у исходной части: только этажи — новый контур тоже этажами, иначе метрами
    if (tags.height === undefined && tags.min_height === undefined && tags['building:levels'] !== undefined) {
      const level = t.face === 'top' ? Number(tags['building:levels']) : Number(tags['building:min_level'] ?? 0);
      out['building:levels'] = String(level);
      if (level > 0) out['building:min_level'] = String(level);
    } else {
      out.height = fmt(t.z);
      if (t.z > 0.01) out.min_height = fmt(t.z);
    }
    return createDrawn(ring, t.z, out);
  },
  (hint, error) => {
    offsetBtn.classList.toggle('active', offsetTool.active);
    syncCursor();
    if (hint) setStatus(hint, error); else showOverpassStatus();
  });
offsetBtn.addEventListener('click', () => (offsetTool.active ? offsetTool.stop() : startOffset()));

function startOffset() {
  if (!focus) return;
  moveTool.stop(); pushTool.stop(); splitTool.stop(); drawTool.stop(); measureTool.stop(); paintTool.stop();
  offsetTool.start();
}

// Образец — Ctrl/Cmd/Alt+клик. На macOS Ctrl+клик — это правый клик (click не приходит), поэтому берём на нажатии
let paintPickedAt = 0;
map.getContainer().addEventListener('pointerdown', (e) => {
  if (!paintTool.active || e.button !== 0 || !(e.ctrlKey || e.metaKey || e.altKey)) return;
  const rect = map.getCanvas().getBoundingClientRect();
  paintTool.click([e.clientX - rect.left, e.clientY - rect.top], true);
  paintPickedAt = performance.now();
}, { capture: true });

/** Курсор над картой — по включённому инструменту; у заливки — пипетка, пока нет образца или зажат Ctrl/Cmd/Alt. */
let pickModifier = false;
function syncCursor() {
  const tool: ToolCursor | undefined = moveTool.active ? 'move' : pushTool.active ? 'push' : splitTool.active ? 'split'
    : drawTool.active ? drawTool.shape : measureTool.active ? 'measure' : offsetTool.active ? 'offset'
    : paintTool.active ? (pickModifier || !paintTool.sample ? 'pick' : 'paint') : undefined;
  setToolCursor(map.getCanvasContainer(), tool);
  renderHelp();
}
for (const type of ['keydown', 'keyup'] as const) {
  window.addEventListener(type, (e) => {
    const on = e.ctrlKey || e.metaKey || e.altKey;
    if (on !== pickModifier) { pickModifier = on; syncCursor(); }
  });
}
window.addEventListener('blur', () => { pickModifier = false; syncCursor(); });

/** Какой-нибудь инструмент режима здания включён. */
function toolActive(): boolean {
  return moveTool.active || pushTool.active || splitTool.active || drawTool.active || measureTool.active || paintTool.active || offsetTool.active || !!copyPick;
}

// Инструменты «Прямоугольник» (R) и «Полигон» (L): новая часть здания — плоский контур нулевой толщины
const rectBtn = focusToolbar.querySelector<HTMLButtonElement>('[data-tool="rect"]')!;
const polyBtn = focusToolbar.querySelector<HTMLButtonElement>('[data-tool="polygon"]')!;
map.on('move', () => { if (drawTool.active) drawTool.relabel(); });
const drawTool = new DrawTool(overpassLayer, map.getContainer(), createDrawn, (hint, error) => {
  // Инструмент выключили посреди наброска (Esc, пробел) — набросок тоже
  if (!drawTool.active && sketching) endSketch();
  else syncMapTools();
  rectBtn.classList.toggle('active', drawTool.active && drawTool.shape === 'rect');
  syncRectIcons();
  polyBtn.classList.toggle('active', drawTool.active && drawTool.shape === 'polygon');
  syncCursor();
  if (hint) setStatus(hint, error); else showOverpassStatus();
});
rectBtn.addEventListener('click', () => toggleDraw('rect'));
polyBtn.addEventListener('click', () => toggleDraw('polygon'));

// Новое здание прямо с карты: «Прямоугольник» и «Полигон» рисуют контур на земле поверх карты (набросок),
// готовый контур — отдельное здание building=yes нулевой высоты; сразу открывается в режиме здания с «Вытянуть»
const mapToolbar = document.getElementById('map-tools')!;
const mapRectBtn = mapToolbar.querySelector<HTMLButtonElement>('[data-tool="rect"]')!;
const mapPolyBtn = mapToolbar.querySelector<HTMLButtonElement>('[data-tool="polygon"]')!;
let sketching = false;
mapRectBtn.addEventListener('click', () => toggleSketch('rect'));
mapPolyBtn.addEventListener('click', () => toggleSketch('polygon'));

// Способ построения прямоугольника — всплывашка у кнопки (стрелка в углу): выбранный способ встаёт на кнопку
const RECT_ICONS: Record<RectMode, string> = {
  corners: '<path d="M3.5 6h13v8h-13z"/><circle cx="3.5" cy="6" r="1.3" fill="currentColor"/><circle cx="16.5" cy="14" r="1.3" fill="currentColor"/>',
  three: '<path d="M3.5 6h13v8h-13z"/><circle cx="3.5" cy="14" r="1.3" fill="currentColor"/><circle cx="16.5" cy="14" r="1.3" fill="currentColor"/><circle cx="16.5" cy="6" r="1.3" fill="currentColor"/>',
  center: '<path d="M3.5 6h13v8h-13z"/><circle cx="10" cy="10" r="1.3" fill="currentColor"/><circle cx="16.5" cy="14" r="1.3" fill="currentColor"/>',
};
const rectSvg = (m: RectMode) => `<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round">${RECT_ICONS[m]}</svg>`;
try { const m = localStorage.getItem('rect-mode') as RectMode | null; if (m && RECT_MODES.includes(m)) drawTool.rectMode = m; } catch { /* нет хранилища */ }
let rectFlyout: HTMLElement | undefined;
function closeRectFlyout() { rectFlyout?.remove(); rectFlyout = undefined; }
function syncRectIcons() {
  for (const [btn, what] of [[rectBtn, 'новая часть'], [mapRectBtn, 'новое здание']] as const) {
    btn.innerHTML = `${rectSvg(drawTool.rectMode)}<span class="flyout-arrow" data-flyout title="Способ построения"></span>`;
    btn.title = `Прямоугольник ${RECT_LABELS[drawTool.rectMode]}: ${what} (R; Tab или стрелка в углу — способ построения)`;
  }
  try { localStorage.setItem('rect-mode', drawTool.rectMode); } catch { /* нет хранилища */ }
}
function openRectFlyout(btn: HTMLButtonElement, start: () => void) {
  closeRectFlyout();
  const fly = document.createElement('div');
  fly.className = 'tool-flyout';
  fly.innerHTML = RECT_MODES.map((m) => `<button type="button" data-mode="${m}" class="${m === drawTool.rectMode ? 'active' : ''}" title="Прямоугольник ${RECT_LABELS[m]}">${rectSvg(m)}<span>${RECT_LABELS[m]}</span></button>`).join('');
  fly.addEventListener('click', (e) => {
    const m = (e.target as HTMLElement).closest<HTMLElement>('[data-mode]')?.dataset.mode as RectMode | undefined;
    if (!m) return;
    e.stopPropagation();
    closeRectFlyout();
    drawTool.setRectMode(m);
    syncRectIcons();
    if (!(drawTool.active && drawTool.shape === 'rect')) start();
  });
  btn.after(fly);
  const r = btn.getBoundingClientRect(), pr = btn.offsetParent!.getBoundingClientRect();
  fly.style.top = `${r.top - pr.top}px`;
  rectFlyout = fly;
}
for (const [btn, start] of [[rectBtn, () => startDraw('rect')], [mapRectBtn, () => startSketch('rect')]] as const) {
  // Стрелка — до обработчика кнопки (capture), чтобы клик по ней не включал инструмент
  btn.addEventListener('click', (e) => {
    if (!(e.target as HTMLElement).closest('[data-flyout]')) { closeRectFlyout(); return; }
    e.stopImmediatePropagation();
    if (rectFlyout && rectFlyout.previousElementSibling === btn) closeRectFlyout(); else openRectFlyout(btn, start);
  }, true);
}
document.addEventListener('pointerdown', (e) => { if (rectFlyout && !(e.target as HTMLElement).closest('.tool-flyout, [data-flyout]')) closeRectFlyout(); });
syncRectIcons();

function toggleSketch(shape: DrawShape) {
  if (sketching && drawTool.shape === shape) return drawTool.stop();
  startSketch(shape);
}

function startSketch(shape: DrawShape) {
  if (focus) return startDraw(shape);
  if (map.getZoom() < 15) return setStatus('Приблизьте карту (z ≥ 15), чтобы нарисовать здание.', true);
  cancelCopyPick();
  select(undefined);
  const c = map.getCenter();
  overpassLayer.setSketch([c.lng, c.lat]);
  sketching = true;
  drawTool.begin(shape);
  syncMapTools();
}

function endSketch() {
  if (!sketching) return;
  sketching = false;
  overpassLayer.setSketch(undefined);
  updateSnap(undefined);
  syncMapTools();
}

function syncMapTools() {
  mapToolbar.hidden = !!focus;
  renderHelp();
  mapRectBtn.classList.toggle('active', sketching && drawTool.shape === 'rect');
  mapPolyBtn.classList.toggle('active', sketching && drawTool.shape === 'polygon');
}

/** Готовый контур наброска — новое отдельное здание; открыть его в режиме здания и включить «Вытянуть». */
function createSketched(ring: [number, number][]): string | undefined {
  const ll = ring.map((p) => overpassLayer.focusToLngLat(p[0], p[1])!);
  const ids = ll.map(() => nextNewId--);
  const wayId = nextNewId--;
  const key = `way/${wayId}`;
  const building: Feature3D = { key, type: 'way', id: wayId, version: 0, kind: 'building', tags: { building: 'yes', height: '0' },
    polygons: [{ outer: ll, inners: [], outerIds: ids, innerIds: [] }], hasParts: false };
  session.editMany([{ key, create: building }]);
  // После возврата из инструмента (он ещё дочищает своё состояние) — выход из наброска и вход в здание
  requestAnimationFrame(() => {
    drawTool.stop();
    endSketch();
    const g = soloGroup(key);
    if (!g) return;
    enterFocus(g);
    select(key);
    startPush();
    setStatus(`Новое здание ${key}. Задайте высоту: клик по крыше и тяните вверх (или число + Enter).`);
  });
  return;
}

function toggleDraw(shape: DrawShape) {
  if (drawTool.active && drawTool.shape === shape) return drawTool.stop();
  startDraw(shape);
}

function startDraw(shape: DrawShape) {
  if (!focus) return;
  moveTool.stop();
  pushTool.stop();
  splitTool.stop(); measureTool.stop(); paintTool.stop(); offsetTool.stop();
  drawTool.begin(shape);
}

/** Точка ближе этого к вершине или стороне существующего пути — общий узел, м. */
const SHARE_EPS = 0.03;

/**
 * Нарисованный контур (метры сцены, плоскость z) — новый путь building:part=yes нулевой толщины на высоте z.
 * Точки на вершинах других путей берут их узлы, точки на сторонах — новые узлы, вставленные и в эти пути.
 * Часть входит в отношение здания (у отдельного здания — в новое, исходный путь — контур). Один шаг истории.
 */
/** tags — теги новой части (по умолчанию — плоская часть на высоте z в метрах). */
function createDrawn(ring: [number, number][], z: number, tagsFor?: Record<string, string>): string | undefined {
  if (sketching) return createSketched(ring);
  if (!focus) return 'Нет здания.';
  const lngLat = (p: [number, number]) => overpassLayer.focusToLngLat(p[0], p[1])!;
  // Кандидаты на общие узлы — пути рядом с контуром (грубый отбор по габаритам в градусах)
  const ll = ring.map(lngLat);
  const pad = 2e-5;
  const [w, so, e, n] = [Math.min(...ll.map((c) => c[0])) - pad, Math.min(...ll.map((c) => c[1])) - pad, Math.max(...ll.map((c) => c[0])) + pad, Math.max(...ll.map((c) => c[1])) + pad];
  const near = (c: LonLat) => c[0] >= w && c[0] <= e && c[1] >= so && c[1] <= n;
  const rings: { ids: number[]; pts: [number, number][]; coords: LonLat[] }[] = [];
  const seen = new Set<string>();
  for (const f of [...focus.members.map((k) => entity(k) as Feature3D | undefined), ...overpass.allFeatures()]) {
    if (!f?.polygons || seen.has(f.key) || !f.key.startsWith('way/')) continue;
    seen.add(f.key);
    const cur = (session.has(f.key) ? session.get(f.key) as Feature3D : f);
    adoptNodeIds(cur);
    for (const p of cur.polygons) {
      if (!p.outerIds || !p.outer.some(near)) continue;
      rings.push({ ids: p.outerIds, coords: p.outer, pts: p.outer.map((c) => overpassLayer.focusToLocal(c)!) });
    }
  }
  const coord = new Map<number, LonLat>();
  const fresh: FreshNode[] = [];
  const ids = ring.map((q, i) => {
    for (const r of rings) {
      const k = r.pts.findIndex((p) => Math.hypot(p[0] - q[0], p[1] - q[1]) < SHARE_EPS);
      if (k >= 0) { coord.set(r.ids[k], r.coords[k]); return r.ids[k]; }
    }
    const id = nextNewId--;
    coord.set(id, ll[i]);
    for (const r of rings) {
      for (let k = 0; k < r.pts.length; k++) {
        const a = r.pts[k], b = r.pts[(k + 1) % r.pts.length];
        if (segDist2(q, a, b) < SHARE_EPS) { fresh.push({ id, p: q, u: r.ids[k], v: r.ids[(k + 1) % r.ids.length] }); return id; }
      }
    }
    return id;
  });
  if (new Set(ids).size !== ids.length) return 'Две точки контура попали в один узел.';
  const wayId = nextNewId--;
  const key = `way/${wayId}`;
  const neighbours = fresh.length ? insertIntoNeighbours(key, fresh, coord) : new Map<string, Feature3D['polygons']>();
  if (typeof neighbours === 'string') return neighbours;
  const fmt = (v: number) => String(Math.round(v * 100) / 100);
  // Всё нарисованное в режиме здания — части этого здания (и снаружи контура: контур потом расширяется
  // кнопкой «Обновить контур»); у отдельного здания — в новом отношении
  const tags: Record<string, string> = tagsFor ?? { 'building:part': 'yes', height: fmt(z) };
  if (!tagsFor && z > 0.01) tags.min_height = fmt(z);
  const part: Feature3D = { key, type: 'way', id: wayId, version: 0, kind: 'part', tags,
    polygons: [{ outer: ids.map((id) => coord.get(id)!), inners: [], outerIds: ids, innerIds: [] }], hasParts: false };
  const edits: Parameters<typeof session.editMany>[0] = [
    { key, create: part },
    ...[...neighbours].map(([k, polygons]) => ({ key: k, polygons })),
  ];
  const group = attachParts(edits, [wayId]);
  if (typeof group === 'string') return group;
  session.editMany(edits);
  if (group) enterFocus(group);
  select(key);
  const shared = ids.filter((id) => id > 0).length;
  setStatus(`Создана часть ${key}${shared || fresh.length ? ` (общих узлов: ${shared}, новых на сторонах соседей: ${fresh.length})` : ''}. Высоту задайте «Вытянуть» (P).`);
  return;
}

/**
 * Добавить новые пути частями здания режима: в его отношение, а у отдельного здания — в новое отношение
 * (исходный путь — контур). Правки дописываются в edits; созданное отношение возвращается (в него потом входим).
 */
function attachParts(edits: Parameters<typeof session.editMany>[0], wayIds: number[]): EditGroup | undefined | string {
  if (!focus) return 'Нет здания.';
  const parts = wayIds.map((ref) => ({ type: 'way' as const, ref, role: 'part' }));
  if (isSolo(focus)) {
    const relId = nextNewId--;
    const [type, ref] = focus.members[0].split('/');
    const relMembers = [{ type: type as 'way' | 'relation', ref: Number(ref), role: 'outline' }, ...parts];
    const group: EditGroup = { key: `relation/${relId}`, type: 'relation', id: relId, version: 0, tags: { type: 'building' },
      members: relMembers.map((m) => `${m.type}/${m.ref}`), roles: relMembers.map((m) => m.role), relMembers };
    editGroups.set(group.key, group);
    edits.push({ key: group.key, create: group });
    return group;
  }
  const g = entity(focus.key) as EditGroup | undefined;
  if (!g) return 'Отношение здания не найдено.';
  edits.push({ key: g.key, members: [...g.relMembers, ...parts] });
  return;
}

/** Буфер копирования: части (теги и контуры) и базовая точка (lng/lat и высота) — вставляются новыми путями. */
let clipboard: { items: { tags: Record<string, string>; polygons: Feature3D['polygons'] }[]; base: { lngLat: LonLat; z: number } } | undefined;
/** Ctrl+C: части скопированы, ждём клика по базовой точке. */
let copyPick: { items: NonNullable<typeof clipboard>['items'] } | undefined;

/** Ctrl+C в режиме здания: выделенные части (простые пути; контур здания — нет), затем клик — базовая точка. */
function copySelected() {
  if (!focus) return;
  const keys = selection.filter((k) => focus!.members.includes(k));
  const items: NonNullable<typeof clipboard>['items'] = [];
  let skipped = 0;
  for (const k of keys) {
    const f = entity(k) as Feature3D | undefined;
    const role = focus.roles[focus.members.indexOf(k)];
    if (!f?.polygons || !k.startsWith('way/') || role === 'outline' || f.polygons.length !== 1 || f.polygons[0].inners.length) { skipped++; continue; }
    items.push({ tags: { ...f.tags }, polygons: f.polygons.map((p) => ({ outer: p.outer.map((c) => [...c] as LonLat), inners: [] })) });
  }
  if (!items.length) return setStatus(keys.length ? 'Копируются только части-пути (не контур здания и не мультиполигоны).' : 'Выберите части здания, затем Ctrl+C.', true);
  moveTool.stop(); pushTool.stop(); splitTool.stop(); measureTool.stop(); paintTool.stop(); offsetTool.stop(); drawTool.stop();
  copyPick = { items };
  setStatus(`Копирование (${items.length}${skipped ? `, пропущено ${skipped} — контур или мультиполигон` : ''}): кликните базовую точку — за неё копия будет привязана к курсору при вставке. Esc — отмена.`);
  if (lastPointer) updateSnap(lastPointer);
}

/** Клик в режиме выбора базовой точки: привязка, иначе поверхность под курсором, иначе земля. */
function pickCopyBase(point: [number, number]) {
  if (!copyPick) return;
  const s = overpassLayer.snapAt(point);
  let p = s?.local ?? overpassLayer.focusRayHits(point)[0]?.local;
  if (!p) {
    const ray = overpassLayer.focusRay(point);
    if (ray && Math.abs(ray.direction.z) > 1e-6 && -ray.origin.z / ray.direction.z > 0) p = ray.at(-ray.origin.z / ray.direction.z, new THREE.Vector3());
  }
  if (!p) return setStatus('Кликните по точке здания или земли.', true);
  const ll = overpassLayer.focusToLngLat(p.x, p.y);
  if (!ll) return;
  clipboard = { items: copyPick.items, base: { lngLat: ll, z: p.z } };
  copyPick = undefined;
  updateSnap(undefined);
  setStatus(`Скопировано частей: ${clipboard.items.length}. Ctrl+V — вставить (копия поедет за курсором).`);
}

function cancelCopyPick() {
  if (!copyPick) return;
  copyPick = undefined;
  updateSnap(undefined);
  setStatus('Копирование отменено.');
}

/**
 * Ctrl+V в режиме здания: копии частей новыми путями (свои узлы, без общих с соседями) в отношение здания,
 * сразу привязаны к курсору за базовую точку; клик — место базовой точки. Esc — вставка отменяется целиком.
 */
function pasteClipboard() {
  if (!focus || !clipboard) return setStatus('Буфер пуст: выберите части, Ctrl+C и клик по базовой точке.', true);
  const edits: Parameters<typeof session.editMany>[0] = [];
  const wayIds: number[] = [];
  const keys: string[] = [];
  // Копии — части этого здания (у отдельного здания — в новом отношении); за контуром — «Обновить контур»
  for (const c of clipboard.items) {
    const outer = c.polygons[0].outer.map((p) => [...p] as LonLat);
    const ids = outer.map(() => nextNewId--);
    const wayId = nextNewId--;
    const key = `way/${wayId}`;
    const tags = { ...c.tags };
    // Копия отдельного здания — часть: building → building:part
    if (!tags['building:part'] && tags.building) { tags['building:part'] = tags.building === 'no' ? 'yes' : tags.building; delete tags.building; }
    const part: Feature3D = { key, type: 'way', id: wayId, version: 0, kind: kindOf(tags) ?? 'part', tags,
      polygons: [{ outer, inners: [], outerIds: ids, innerIds: [] }], hasParts: false };
    edits.push({ key, create: part });
    wayIds.push(wayId);
    keys.push(key);
  }
  const group = attachParts(edits, wayIds);
  if (typeof group === 'string') return setStatus(group, true);
  session.editMany(edits);
  if (group) enterFocus(group);
  selection = keys;
  selectedKey = keys.at(-1);
  paintSelection();
  renderSelected();
  const b = overpassLayer.focusToLocal(clipboard.base.lngLat);
  if (!b) return;
  pushTool.stop(); splitTool.stop(); measureTool.stop(); paintTool.stop(); offsetTool.stop(); drawTool.stop();
  moveTool.drag(keys, new THREE.Vector3(b[0], b[1], clipboard.base.z),
    `Вставка (${keys.length}): кликните, куда поставить базовую точку. Shift/стрелки — ось, число + Enter — сдвиг. Esc — отмена вставки.`,
    () => setStatus(`Вставлено частей: ${keys.length}.`),
    () => { selectAfterHistory(session.undo()); setStatus('Вставка отменена.'); });
}

function segDist2([px, py]: [number, number], [ax, ay]: [number, number], [bx, by]: [number, number]): number {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

/** Почему объект нельзя рассечь (undefined — можно). */
function splitReason(key: string): string | undefined {
  if (isSolo(focus) && key !== focus!.members[0]) return 'Копию режьте отдельно: выйдите и откройте её двойным кликом.';
  if (!focus?.members.includes(key) || focusHidden.has(key)) return 'Резать можно только части этого здания.';
  const f = entity(key) as Feature3D | undefined;
  if (!f?.polygons) return 'Объект не найден.';
  if (!key.startsWith('way/')) return 'Пока режутся только простые контуры (линии), не мультиполигоны.';
  if (f.polygons.length !== 1 || f.polygons[0].inners.length) return 'Пока режутся только контуры без дыр.';
  const role = focus.roles[focus.members.indexOf(key)];
  if (role === 'outline') return 'Контур здания (outline) не режем — только части.';
  const shape = f.tags['roof:shape'];
  const h = computeHeights(f.tags);
  if (shape && shape !== 'flat' && h.top - h.min > 0.1) return `Резать можно плоский объект или с плоской крышей, здесь roof:shape=${shape}.`;
  if (!nodeIds(f)) return 'В кеше нет id узлов этого объекта — нажмите «Перезагрузить видимые тайлы» в настройках графики.';
  return;
}

/** Теги, которые не копируем во вторую половину отдельного здания: они бы задвоились. */
const IDENTITY_TAGS = /^(name|official_name|alt_name|old_name|short_name|loc_name|addr:|wikidata|wikipedia|wikimedia_commons|ref|website|url|contact:|phone|email|opening_hours|operator|brand|image|description|note|fixme|start_date|heritage|tourism|amenity|shop|office)/;

function copyTags(f: Feature3D): Record<string, string> {
  if (f.kind === 'part') return { ...f.tags };
  return Object.fromEntries(Object.entries(f.tags).filter(([k]) => !IDENTITY_TAGS.test(k)));
}

/** Отрезки пересекаются во внутренних точках (касание концами не считается). */
function segCross(a: [number, number], b: [number, number], c: [number, number], d: [number, number]): boolean {
  const o = (p: [number, number], q: [number, number], r: [number, number]) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
  return ((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9)) && ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9));
}

function ringArea(r: [number, number][]): number {
  let s = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]);
  return Math.abs(s / 2);
}

function inLocalRing([x, y]: [number, number], ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Рассечь путь отрезком a–b (метры сцены режима здания). Новые узлы на рёбрах вставляются и в соседние пути
 * с тем же отрезком (без Т-стыков). Больший кусок остаётся исходным путём, меньший — новый путь с копией тегов,
 * добавляется в отношение здания с ролью part. Всё одним шагом истории. Возвращает текст ошибки или undefined.
 */
function splitFeature(key: string, a: CutPoint, b: CutPoint): string | undefined {
  const f = entity(key) as Feature3D | undefined;
  const solo = isSolo(focus);
  const g = focus && !solo ? (entity(focus.key) as EditGroup | undefined) : undefined;
  if (!f || (!g && !solo)) return 'Объект не найден.';
  const poly = f.polygons[0];
  const ids = poly.outerIds!;
  const local = poly.outer.map((c) => overpassLayer.focusToLocal(c)!);
  const n = local.length;
  if (a.vertex !== undefined && b.vertex !== undefined && a.vertex === b.vertex) return 'Начало и конец разреза совпадают.';
  if (a.edge === b.edge && a.vertex === undefined && b.vertex === undefined) return 'Начало и конец разреза — на одном ребре.';
  // Отрезок внутри контура: середина внутри, и он не пересекает стороны
  const mid: [number, number] = [(a.p[0] + b.p[0]) / 2, (a.p[1] + b.p[1]) / 2];
  if (!inLocalRing(mid, local)) return 'Разрез проходит снаружи контура.';
  for (let i = 0; i < n; i++) if (segCross(a.p, b.p, local[i], local[(i + 1) % n])) return 'Разрез пересекает стороны контура.';

  // Кольцо с новыми узлами: вставляем с конца, чтобы номера сторон не съезжали
  type V = { p: [number, number]; id: number };
  const ring: V[] = local.map((p, i) => ({ p, id: ids[i] }));
  const fresh: { id: number; p: [number, number]; u: number; v: number }[] = [];
  const cuts = [a, b].map((c) => ({ c, id: c.vertex !== undefined ? ids[c.vertex] : nextNewId-- }));
  for (const { c, id } of [...cuts].sort((x, y) => y.c.edge - x.c.edge)) {
    if (c.vertex !== undefined) continue;
    ring.splice(c.edge + 1, 0, { p: c.p, id });
    fresh.push({ id, p: c.p, u: ids[c.edge], v: ids[(c.edge + 1) % n] });
  }
  const ia = ring.findIndex((v) => v.id === cuts[0].id), ib = ring.findIndex((v) => v.id === cuts[1].id);
  const walk = (from: number, to: number) => {
    const out: V[] = [];
    for (let i = from; ; i = (i + 1) % ring.length) { out.push(ring[i]); if (i === to) break; }
    return out;
  };
  const r1 = walk(ia, ib), r2 = walk(ib, ia);
  if (r1.length < 3 || r2.length < 3) return 'Разрез идёт по стороне контура — делить нечего.';
  const [keep, part] = ringArea(r1.map((v) => v.p)) >= ringArea(r2.map((v) => v.p)) ? [r1, r2] : [r2, r1];
  const lngLat = (p: [number, number]) => overpassLayer.focusToLngLat(p[0], p[1])!;
  const coord = new Map<number, LonLat>(ids.map((id, i) => [id, poly.outer[i]]));
  for (const x of fresh) coord.set(x.id, lngLat(x.p));
  const toPoly = (vs: V[]) => ({ outer: vs.map((v) => coord.get(v.id)!), inners: [], outerIds: vs.map((v) => v.id), innerIds: [] });

  if (solo) return splitSolo(f, toPoly(ring), toPoly(keep), toPoly(part), fresh, coord);
  const wayId = nextNewId--;
  const created: Feature3D = { key: `way/${wayId}`, type: 'way', id: wayId, version: 0, kind: f.kind, tags: copyTags(f), polygons: [toPoly(part)], hasParts: false };

  const neighbours = insertIntoNeighbours(key, fresh, coord);
  if (typeof neighbours === 'string') return neighbours;
  const members = [...g!.relMembers, { type: 'way' as const, ref: wayId, role: 'part' }];
  session.editMany([
    { key, polygons: [toPoly(keep)] },
    { key: created.key, create: created },
    ...[...neighbours].map(([k, polygons]) => ({ key: k, polygons })),
    { key: g!.key, members },
  ]);
  select(created.key);
  setStatus(`Рассечено: ${key} и новая часть ${created.key}${neighbours.size ? `, узлы добавлены в соседей: ${neighbours.size}` : ''}.`);
  return;
}

type FreshNode = { id: number; p: [number, number]; u: number; v: number };

/** Соседи с тем же отрезком u–v: вставить в них новые узлы разреза. Строка — ошибка. */
function insertIntoNeighbours(key: string, fresh: FreshNode[], coord: Map<number, LonLat>): Map<string, Feature3D['polygons']> | string {
  const neighbours = new Map<string, Feature3D['polygons']>();
  for (const x of fresh) {
    // Новые пути сессии (нарисованные, отрезанные) — тоже соседи
    for (const o of [...overpass.allFeatures(), ...session.createdAlive().filter((t): t is Feature3D => 'polygons' in t && !!t.polygons?.length)]) {
      if (o.key === key) continue;
      const cur = neighbours.get(o.key) ?? (session.has(o.key) ? (session.get(o.key) as Feature3D | undefined)?.polygons : o.polygons);
      if (!cur) continue;
      let changed = false;
      const insert = (r: LonLat[], rid: number[] | undefined): [LonLat[], number[] | undefined] => {
        if (!rid) return [r, rid];
        for (let i = 0; i < rid.length; i++) {
          const j = (i + 1) % rid.length;
          if ((rid[i] === x.u && rid[j] === x.v) || (rid[i] === x.v && rid[j] === x.u)) {
            changed = true;
            return [[...r.slice(0, i + 1), coord.get(x.id)!, ...r.slice(i + 1)], [...rid.slice(0, i + 1), x.id, ...rid.slice(i + 1)]];
          }
        }
        return [r, rid];
      };
      const next = cur.map((p) => {
        const [outer, outerIds] = insert(p.outer, p.outerIds);
        const inn = p.inners.map((r, k) => insert(r, p.innerIds?.[k]));
        return { ...p, outer, outerIds, inners: inn.map((x2) => x2[0]), innerIds: p.innerIds ? inn.map((x2) => x2[1]!) : p.innerIds };
      });
      if (!changed) continue;
      // Узлы мультиполигона живут в его путях-членах, которых у нас нет отдельно — такое ребро не трогаем
      if (!o.key.startsWith('way/')) return `Ребро общее с мультиполигоном ${o.key} — резать через него пока нельзя.`;
      entity(o.key);
      neighbours.set(o.key, next);
    }
  }

  return neighbours;
}

/** Допуск «часть внутри контура», м: общие стороны и узлы, погрешность координат. */
const OUTLINE_EPS = 0.05;

/** Контур отношения (путь) и части, выходящие за него хоть одной вершиной. */
function partsOutsideOutline(g: BuildingGroup): { outline: Feature3D; parts: Feature3D[]; out: Feature3D[] } | undefined {
  const oi = g.roles.indexOf('outline');
  const outline = oi >= 0 ? entity(g.members[oi]) as Feature3D | undefined : undefined;
  if (!outline?.polygons?.length || !outline.key.startsWith('way/') || !overpassLayer.focusToLocal([0, 0])) return;
  const ring = outline.polygons[0].outer.map((c) => overpassLayer.focusToLocal(c)!);
  const parts = g.members.filter((k, i) => g.roles[i] === 'part' && !session.isDeleted(k))
    .map((k) => entity(k) as Feature3D | undefined).filter((f): f is Feature3D => !!f?.polygons?.length);
  const inside = (q: [number, number]) => pointInRing(q, ring)
    || ring.some((a, i) => segDist2(q, a, ring[(i + 1) % ring.length]) < OUTLINE_EPS);
  const out = parts.filter((f) => f.polygons.some((p) => p.outer.some((c) => !inside(overpassLayer.focusToLocal(c)!))));
  return { outline, parts, out };
}

/** Новый контур: объединение контура и всех частей (метры сцены); строка — почему нельзя. */
function unitedOutline(outline: Feature3D, parts: Feature3D[]): [number, number][] | string {
  const toRing = (outer: LonLat[]) => {
    const r = outer.map((c) => overpassLayer.focusToLocal(c)!);
    return [[...r, r[0]]] as [number, number][][];
  };
  const polys = [outline, ...parts].flatMap((f) => f.polygons.map((p) => toRing(p.outer)));
  const u = polygonClipping.union(polys[0], ...polys.slice(1));
  if (u.length !== 1) return 'Части не соприкасаются с контуром: контур из нескольких кусков (мультиполигон) пока не поддерживается — соедините части.';
  // Дворы внутри объединения — тоже под контуром (путь без дыр); лишние точки на прямых — убираем
  const ring = u[0][0].slice(0, -1) as [number, number][];
  const out: [number, number][] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = out.length ? out[out.length - 1] : ring[ring.length - 1], b = ring[i], c = ring[(i + 1) % ring.length];
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 0.01) continue;
    if (segDist2(b, a, c) < 0.01) continue; // на прямой a–c
    out.push(b);
  }
  return out.length >= 3 ? out : 'Не удалось построить контур.';
}

/**
 * «Обновить контур»: контур отношения — объединение его и всех частей (новые вершины — узлы частей там, где
 * совпадают, иначе новые узлы). Если у контура был свой объём, он переходит в новую часть по прежней форме,
 * а на контуре остаются только теги здания (название, адрес…). Одним шагом истории.
 */
function fixOutline() {
  if (!focus || isSolo(focus)) return;
  const r = partsOutsideOutline(focus);
  if (!r) return setStatus('Контур здания — не простой путь: обновить его пока нельзя.', true);
  const ring = unitedOutline(r.outline, r.parts);
  if (typeof ring === 'string') return setStatus(ring, true);
  // Узлы: существующие узлы контура и частей в тех же точках, иначе новые
  const known: { id: number; c: LonLat; p: [number, number] }[] = [];
  for (const f of [r.outline, ...r.parts]) {
    for (const p of f.polygons) (p.outerIds ?? []).forEach((id, i) => known.push({ id, c: p.outer[i], p: overpassLayer.focusToLocal(p.outer[i])! }));
  }
  const ids: number[] = [], coords: LonLat[] = [];
  for (const q of ring) {
    const k = known.find((n) => Math.hypot(n.p[0] - q[0], n.p[1] - q[1]) < SHARE_EPS);
    if (k && !ids.includes(k.id)) { ids.push(k.id); coords.push(k.c); continue; }
    ids.push(nextNewId--);
    coords.push(overpassLayer.focusToLngLat(q[0], q[1])!);
  }
  const edits: Parameters<typeof session.editMany>[0] = [];
  const g = entity(focus.key) as EditGroup | undefined;
  if (!g) return setStatus('Отношение здания не найдено.', true);
  const outlineTags = { ...r.outline.tags };
  if (!isBareOutlineTags(outlineTags)) {
    // Объём контура — новой частью прежней формы (на тех же узлах)
    const id = nextNewId--;
    const tags: Record<string, string> = { 'building:part': 'yes' };
    for (const [k, v] of Object.entries(outlineTags)) if (PART_TAGS.test(k)) { tags[k] = v; delete outlineTags[k]; }
    const part: Feature3D = { key: `way/${id}`, type: 'way', id, version: 0, kind: 'part', tags,
      polygons: r.outline.polygons.map((p) => ({ ...p, outer: [...p.outer], outerIds: p.outerIds && [...p.outerIds] })), hasParts: false };
    edits.push({ key: part.key, create: part });
    edits.push({ key: g.key, members: [...g.relMembers, { type: 'way', ref: id, role: 'part' }] });
  }
  edits.push({ key: r.outline.key, polygons: [{ outer: coords, inners: [], outerIds: ids, innerIds: [] }], tags: outlineTags });
  overpassLayer.setDrawPreview(undefined);
  session.editMany(edits);
  renderSelected();
  setStatus(`Контур ${r.outline.key} обновлён: охватывает все части (${r.parts.length}). Отменить — Ctrl+Z.`);
}

/** Предупреждение в панели режима здания: части за контуром и кнопка «Обновить контур». */
function outlineWarning(g: BuildingGroup): string {
  if (isSolo(g)) return '';
  const r = partsOutsideOutline(g);
  if (!r?.out.length) return '';
  return `<p class="warn">⚠ Частей за контуром здания: ${r.out.length}. Контур должен охватывать все части.
    <button type="button" data-outline-fix title="Наведите — предпросмотр нового контура">Обновить контур</button></p>`;
}

/** Теги объёма, которые переходят от отдельного здания к его частям. */
const PART_TAGS = /^(height|min_height|building:levels|building:min_level|roof:|building:colou?r|building:material|colou?r|material)/;

/**
 * Рассечь отдельное здание: исходный путь остаётся контуром (outline, с новыми узлами разреза), обе половины —
 * новые части building:part=yes с тегами объёма, всё в новом отношении type=building. Одним шагом истории;
 * режим здания переходит на новое отношение.
 */
function splitSolo(f: Feature3D, whole: Polygon, a: Polygon, b: Polygon, fresh: FreshNode[], coord: Map<number, LonLat>): string | undefined {
  const neighbours = insertIntoNeighbours(f.key, fresh, coord);
  if (typeof neighbours === 'string') return neighbours;
  const tags: Record<string, string> = { 'building:part': 'yes' };
  for (const [k, v] of Object.entries(f.tags)) if (PART_TAGS.test(k)) tags[k] = v;
  const parts: Feature3D[] = [a, b].map((poly) => {
    const id = nextNewId--;
    return { key: `way/${id}`, type: 'way', id, version: 0, kind: 'part', tags: { ...tags }, polygons: [poly], hasParts: false };
  });
  const relId = nextNewId--;
  const [type, ref] = f.key.split('/');
  const relMembers = [
    { type: type as 'way' | 'relation', ref: Number(ref), role: 'outline' },
    ...parts.map((p) => ({ type: 'way' as const, ref: p.id, role: 'part' })),
  ];
  const group: EditGroup = {
    key: `relation/${relId}`, type: 'relation', id: relId, version: 0, tags: { type: 'building' },
    members: relMembers.map((m) => `${m.type}/${m.ref}`), roles: relMembers.map((m) => m.role), relMembers,
  };
  editGroups.set(group.key, group);
  session.editMany([
    ...(f.type === 'way' ? [{ key: f.key, polygons: [whole] }] : []),
    ...parts.map((p) => ({ key: p.key, create: p })),
    { key: group.key, create: group },
    ...[...neighbours].map(([k, polygons]) => ({ key: k, polygons })),
  ]);
  enterFocus(group);
  select(parts[0].key);
  setStatus(`Создано здание ${group.key}: контур ${f.key} и части ${parts.map((p) => p.key).join(', ')}.`);
  return;
}

/** Минимальная толщина объекта при вытягивании, м. */
const MIN_THICKNESS = 0.5;

/** Узлы стены (два узла стороны контура); undefined — в кеше нет id узлов. */
function sideNodes(f: Feature3D, edge: NonNullable<PushTarget['edge']>): [number, number] | undefined {
  adoptNodeIds(f);
  const p = f.polygons[edge.poly];
  const ids = edge.ring ? p?.innerIds?.[edge.ring - 1] : p?.outerIds;
  if (!ids?.length) return;
  return [ids[edge.i], ids[(edge.i + 1) % ids.length]];
}

/** Стену можно тянуть всегда: общие с соседями узлы и пути при применении разводятся (topologyEdits). */
function allowPushSide(t: PushTarget): boolean {
  const f = entity(t.key) as Feature3D | undefined;
  const nodes = f && t.edge ? sideNodes(f, t.edge) : undefined;
  if (!nodes || (f!.type === 'relation' && !relWays(f!))) {
    setStatus('В кеше нет id узлов или путей этого объекта — нажмите «Перезагрузить видимые тайлы» в настройках графики.', true);
    return false;
  }
  return true;
}

// ── Правка контуров без нахлёстов ──
// Общий узел нельзя сдвинуть (деформируется сосед), поэтому вместо него ставится новый. Новый угол на общей
// стороне вставляется во все пути с этой стороной; пути мультиполигона, которые лишь частью остаются в его
// новом кольце, режутся (свои куски — себе, остальное — соседям), новые стороны — новыми путями.

/** Новое кольцо объекта: узлы по порядку (новые — отрицательные id) и их координаты. */
interface RingRewrite { poly: number; ring: number; ids: number[]; coords: LonLat[] }

/** Объекты с геометрией как сейчас (правки сессии поверх данных) и созданные в сессии. */
function liveFeatures(): Feature3D[] {
  const out = overpass.allFeatures();
  const have = new Set(out.map((f) => f.key));
  for (const c of session.createdAlive()) if (c.polygons?.length && !have.has(c.key)) out.push(c as Feature3D);
  return out;
}

/** Пути-члены мультиполигона (id и роль) — из сессии или из данных; undefined — в кеше их нет. */
function relWays(f: Feature3D): { id: number; role: string }[] | undefined {
  const rel = session.get(f.key)?.relMembers;
  if (rel) return rel.filter((m) => m.type === 'way').map((m) => ({ id: m.ref, role: m.role }));
  return (f.ways ?? overpass.findFeature(f.key)?.ways)?.map((w) => ({ id: w.id, role: w.role }));
}

/** Узлы всех объектов, кроме skip. */
function nodesOutside(skip: Set<string>): Set<number> {
  const out = new Set<number>();
  for (const g of liveFeatures()) if (!skip.has(g.key)) for (const id of nodeIds(g) ?? []) out.add(id);
  return out;
}

/**
 * Правки (одним шагом истории) для новых колец объектов items и вставки новых узлов в общие стороны.
 * Строка — почему нельзя.
 */
function topologyEdits(items: { f: Feature3D; rewrites: RingRewrite[] }[], inserts: Insert[], newCoords: Map<number, LonLat>): ObjectEdit[] | string {
  const live = liveFeatures();
  const coords = new Map<number, LonLat>();
  const ways = new Map<number, { nodes: number[]; tags: Record<string, string> }>();
  for (const g of live) {
    for (const p of g.polygons) {
      p.outerIds?.forEach((id, i) => coords.set(id, p.outer[i]));
      p.inners.forEach((r, j) => p.innerIds?.[j]?.forEach((id, i) => coords.set(id, r[i])));
    }
    for (const w of g.ways ?? []) if (!ways.has(w.id)) ways.set(w.id, { nodes: w.nodes, tags: w.tags ?? {} });
  }
  for (const t of session.lineEntities()) ways.set(Number(t.key.split('/')[1]), { nodes: t.line!.ids, tags: t.tags });
  const at = (id: number) => newCoords.get(id) ?? coords.get(id)!;
  const mine = new Set(items.map((i) => i.f.key));
  const edits = new Map<string, ObjectEdit>();
  const edit = (key: string) => edits.get(key) ?? edits.set(key, { key }).get(key)!;
  /** Новые списки узлов путей-членов (существующих и созданных). */
  const lines = new Map<number, number[]>();
  const created = new Map<number, { tags?: Record<string, string>; splitFrom?: number }>();
  const lineOf = (id: number) => lines.get(id) ?? ways.get(id)?.nodes;
  const ringIns = (ids: number[] | undefined, ring: LonLat[]) => (ids ? insertInRing(ids, ring, inserts, at) : undefined);
  const withInserts = (p: Polygon): Polygon => {
    if (!inserts.length) return p;
    const o = ringIns(p.outerIds, p.outer);
    const inn = p.inners.map((r, j) => ringIns(p.innerIds?.[j], r));
    if (!o && !inn.some(Boolean)) return p;
    return { ...p, outer: o?.coords ?? p.outer, outerIds: o?.ids ?? p.outerIds,
      inners: p.inners.map((r, j) => inn[j]?.coords ?? r), innerIds: p.innerIds?.map((r, j) => inn[j]?.ids ?? r) };
  };

  // Новые узлы на общих сторонах — в контуры соседей и во все пути-члены с этой стороной
  if (inserts.length) {
    for (const g of live) {
      if (mine.has(g.key)) continue;
      const ps = g.polygons.map(withInserts);
      if (ps.some((p, i) => p !== g.polygons[i])) edit(g.key).polygons = ps;
    }
    for (const [id, w] of ways) { const n = insertInLine(w.nodes, inserts); if (n) lines.set(id, n); }
  }

  const pieces = new Map<number, number[]>();
  for (const { f, rewrites } of items) {
    edit(f.key).polygons = f.polygons.map((p, pi) => {
      const q = withInserts(p);
      const outer = rewrites.find((r) => r.poly === pi && r.ring === 0);
      return {
        ...q,
        ...(outer ? { outer: outer.coords, outerIds: outer.ids } : {}),
        inners: q.inners.map((r, j) => rewrites.find((w) => w.poly === pi && w.ring === j + 1)?.coords ?? r),
        innerIds: q.innerIds?.map((r, j) => rewrites.find((w) => w.poly === pi && w.ring === j + 1)?.ids ?? r),
      };
    });
    if (f.type !== 'relation') continue;
    const rw = relWays(f);
    if (!rw) return `${f.key}: в кеше нет путей-членов — перезагрузите видимые тайлы.`;
    let members: OsmMember[] = session.get(f.key)?.relMembers ?? rw.map((w) => ({ type: 'way' as const, ref: w.id, role: w.role }));
    for (const r of rewrites) {
      const p = f.polygons[r.poly];
      const old = r.ring ? p.innerIds?.[r.ring - 1] : p.outerIds;
      if (!old) return `${f.key}: в кеше нет id узлов.`;
      const allowed = new Set([...old, ...r.ids]);
      const role = r.ring ? 'inner' : 'outer';
      const ringWays: RingWay[] = [];
      for (const m of members) {
        if (m.type !== 'way' || (m.role === 'inner') !== (role === 'inner')) continue;
        const nodes = lineOf(m.ref);
        if (!nodes) return `${f.key}: нет данных пути way/${m.ref} — перезагрузите видимые тайлы.`;
        if (nodes.every((id) => allowed.has(id))) ringWays.push({ id: m.ref, role: m.role, nodes, tags: ways.get(m.ref)?.tags });
      }
      const res = restructureRing(ringWays, r.ids, role, () => nextNewId--);
      for (const [id, nodes] of res.lines) lines.set(id, nodes);
      for (const c of res.created) { lines.set(c.id, c.nodes); created.set(c.id, { tags: c.tags, splitFrom: c.splitFrom }); }
      for (const [orig, ids] of res.pieces) pieces.set(orig, [...(pieces.get(orig) ?? []), ...ids]);
      const ringIds = new Set(ringWays.map((w) => w.id));
      const keep = new Set(res.members.map((m) => m.id));
      members = [
        ...members.filter((m) => m.type !== 'way' || !ringIds.has(m.ref) || keep.has(m.ref)),
        ...res.members.filter((m) => !ringIds.has(m.id)).map((m) => ({ type: 'way' as const, ref: m.id, role: m.role })),
      ];
    }
    edit(f.key).members = members;
  }

  // Загруженные соседи с разрезанными путями: куски — рядом с исходным, с той же ролью
  if (pieces.size) {
    for (const g of live) {
      if (g.type !== 'relation' || mine.has(g.key)) continue;
      const rw = relWays(g);
      if (!rw?.some((w) => pieces.has(w.id))) continue;
      const cur: OsmMember[] = session.get(g.key)?.relMembers ?? rw.map((w) => ({ type: 'way' as const, ref: w.id, role: w.role }));
      edit(g.key).members = cur.flatMap((m) => (m.type === 'way' && pieces.has(m.ref)
        ? [m, ...pieces.get(m.ref)!.map((ref) => ({ type: 'way' as const, ref, role: m.role }))] : [m]));
    }
  }

  // Объекты — в сессию (до editMany), пути-члены — отдельными объектами без геометрии здания
  for (const key of edits.keys()) {
    const e = entity(key);
    if (!e) return `${key}: нет в данных.`;
    // У мультиполигона в сессии должен быть состав, иначе его правку не с чем сравнить
    if (edits.get(key)!.members && !e.relMembers) return `${key}: нет состава отношения.`;
  }
  const out = [...edits.values()];
  for (const [id, nodes] of lines) {
    const key = `way/${id}`;
    const line = { ids: nodes, coords: nodes.map(at) };
    const c = created.get(id);
    if (c) { out.push({ key, create: { key, version: 0, tags: { ...(c.tags ?? {}) }, line, splitFrom: c.splitFrom } }); continue; }
    const known = session.get(key);
    if (known && !known.line) return `${key} — сам по себе здание или часть, его не разрезать.`;
    if (!known) {
      const w = ways.get(id)!;
      session.track({ key, version: 0, tags: { ...w.tags }, line: { ids: w.nodes, coords: w.nodes.map(at) } });
    }
    out.push({ key, line });
  }
  return out;
}

/** Правки вытягивания стены: свободные углы двигаются, общие — заменяются новыми узлами (см. topologyEdits). */
function pushSideEdits(f: Feature3D, edge: NonNullable<PushTarget['edge']>, dz: number): ObjectEdit[] | string {
  const moved = pushSidePolygons(f, edge, dz);
  const p = f.polygons[edge.poly], q = moved[edge.poly];
  const ids = edge.ring ? p.innerIds?.[edge.ring - 1] : p.outerIds;
  if (!ids) return 'В кеше нет id узлов этого объекта.';
  const was = edge.ring ? p.inners[edge.ring - 1] : p.outer;
  const now = edge.ring ? q.inners[edge.ring - 1] : q.outer;
  const n = ids.length, i = edge.i, j = (i + 1) % n;
  const shared = nodesOutside(new Set([f.key]));
  const outIds: number[] = [], outC: LonLat[] = [], inserts: Insert[] = [], fresh = new Map<number, LonLat>();
  const put = (id: number, c: LonLat) => { outIds.push(id); outC.push(c); };
  const add = (c: LonLat) => { const id = nextNewId--; fresh.set(id, c); put(id, c); return id; };
  /** Положение c на прямой a→b: t (0 — a, 1 — b) и отступ от прямой, м. */
  const along = (a: LonLat, b: LonLat, c: LonLat) => {
    const [ax, ay] = overpassLayer.focusToLocal(a)!, [bx, by] = overpassLayer.focusToLocal(b)!, [cx, cy] = overpassLayer.focusToLocal(c)!;
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
    const t = ((cx - ax) * dx + (cy - ay) * dy) / l2;
    return { t, off: Math.abs((cx - ax) * dy - (cy - ay) * dx) / Math.sqrt(l2) };
  };
  for (let k = 0; k < n; k++) {
    if (k !== i && k !== j) { put(ids[k], now[k]); continue; }
    if (!shared.has(ids[k])) { put(ids[k], now[k]); continue; } // свободный угол — просто сдвинуть
    // Соседняя сторона: у начала стены — предыдущая, у конца — следующая
    const nb = k === i ? (i - 1 + n) % n : (j + 1) % n;
    const { t, off } = along(was[nb], was[k], now[k]);
    if (off < 1e-3 && t > 1e-6 && t < 1 - 1e-6) {
      // Внутрь: новый угол на соседней стороне — вставить его во все пути с этой стороной
      inserts.push({ id: add(now[k]), u: ids[nb], v: ids[k] });
    } else if (k === i) { put(ids[k], was[k]); add(now[k]); } // наружу: старый угол остаётся, новый — следом
    else { add(now[k]); put(ids[k], was[k]); }
  }
  return topologyEdits([{ f, rewrites: [{ poly: edge.poly, ring: edge.ring, ids: outIds, coords: outC }] }], inserts, fresh);
}

/**
 * Контур с вытянутой стеной: сторона сдвигается на d по нормали, её концы скользят по соседним сторонам
 * (соседние стены сохраняют направление, как в SketchUp); при параллельных соседях — просто по нормали.
 */
function pushSidePolygons(f: Feature3D, edge: NonNullable<PushTarget['edge']>, d: number): Feature3D['polygons'] {
  const local = (c: LonLat) => overpassLayer.focusToLocal(c)!;
  return f.polygons.map((p, pi) => {
    if (pi !== edge.poly) return p;
    const shift = (ring: LonLat[]): LonLat[] => {
      const pts = ring.map(local), n = pts.length;
      const i = edge.i, j = (i + 1) % n;
      const [nx, ny] = [edge.n.x * d, edge.n.y * d];
      const a2: [number, number] = [pts[i][0] + nx, pts[i][1] + ny], b2: [number, number] = [pts[j][0] + nx, pts[j][1] + ny];
      // Новый конец — пересечение сдвинутой стороны с прямой соседней стороны
      const slide = (moved: [number, number], other: [number, number], self: [number, number]): [number, number] => {
        const ex = b2[0] - a2[0], ey = b2[1] - a2[1], sx = self[0] - other[0], sy = self[1] - other[1];
        const den = ex * sy - ey * sx;
        if (Math.abs(den) < 1e-9 * Math.hypot(ex, ey) * Math.hypot(sx, sy) || Math.hypot(sx, sy) < 1e-6) return moved;
        const t = ((other[0] - a2[0]) * sy - (other[1] - a2[1]) * sx) / den;
        return [a2[0] + t * ex, a2[1] + t * ey];
      };
      const out = pts.slice();
      out[i] = slide(a2, pts[(i - 1 + n) % n], pts[i]);
      out[j] = slide(b2, pts[(j + 1) % n], pts[j]);
      return ring.map((c, k) => (k === i || k === j ? overpassLayer.focusToLngLat(out[k][0], out[k][1])! : c));
    };
    return edge.ring
      ? { ...p, inners: p.inners.map((r, ri) => (ri === edge.ring - 1 ? shift(r) : r)) }
      : { ...p, outer: shift(p.outer) };
  });
}

function clampPush(t: PushTarget, dz: number): number {
  const f = entity(t.key) as Feature3D | undefined;
  if (!f) return 0;
  if (t.face === 'side') return dz;
  const h = computeHeights(f.tags);
  // Верх не ниже низа + крыша + запас; низ — не ниже земли и не выше верха стен минус запас
  return t.face === 'top'
    ? Math.max(dz, h.min + h.roofHeight + MIN_THICKNESS - h.top)
    : Math.min(Math.max(dz, -h.min), h.wallTop - MIN_THICKNESS - h.min);
}

function previewPush(t: PushTarget, dz: number | undefined) {
  const f = entity(t.key) as Feature3D | undefined;
  if (!f) return;
  if (dz === undefined) return overpassLayer.previewFocusFeature(f);
  overpassLayer.previewFocusFeature(t.face === 'side'
    ? { ...f, polygons: pushSidePolygons(f, t.edge!, dz) }
    : { ...f, tags: pushTags(f.tags, t.face, dz) });
}

function commitPush(t: PushTarget, dz: number) {
  const f = entity(t.key) as Feature3D | undefined;
  if (!f) return;
  if (t.face === 'side') {
    const edits = pushSideEdits(f, t.edge!, dz);
    if (typeof edits === 'string') return setStatus(edits, true);
    session.editMany(edits);
  }
  else session.setTags(t.key, diffTags(f.tags, pushTags(f.tags, t.face, dz)));
  const levels = t.face !== 'side' && pushTool.units === 'levels' ? ` (${dz >= 0 ? '+' : ''}${Math.round(dz / LEVEL_HEIGHT)} эт.)` : '';
  setStatus(`${{ top: 'Верх', bottom: 'Низ', side: 'Стена' }[t.face]} ${t.key} сдвинут${t.face === 'side' ? 'а' : ''} на ${dz >= 0 ? '+' : ''}${dz.toFixed(2)} м${levels}.`);
}

/** Значения для setTags: новые и удалённые (undefined) теги. */
function diffTags(before: Record<string, string>, after: Record<string, string>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) if (before[k] !== after[k]) out[k] = after[k];
  return out;
}

/**
 * Сдвинуть верх или низ на dz, сохраняя способ разметки: у объекта на этажах при сдвиге, кратном этажу,
 * меняем этажи; иначе пишем метры (height / min_height).
 */
function pushTags(tags: Record<string, string>, face: PushTarget['face'], dz: number): Record<string, string> {
  const h = computeHeights(tags);
  const out = { ...tags };
  const fmt = (v: number) => String(Math.round(v * 100) / 100);
  const k = dz / 3, whole = Math.abs(k - Math.round(k)) < 1e-6;
  // Сдвиг на целые этажи: этажи меняем, а если заданы и метры — их тоже, чтобы не разошлись
  if (face === 'top') {
    if (tags['building:levels'] && whole) {
      out['building:levels'] = String(Number(tags['building:levels']) + Math.round(k));
      if (tags.height) out.height = fmt(h.top + dz);
    } else out.height = fmt(h.top + dz);
    return out;
  }
  if (whole && (tags['building:min_level'] || (!tags.height && !tags.min_height && tags['building:levels']))) {
    const minLevel = Number(tags['building:min_level'] ?? 0) + Math.round(k);
    if (minLevel) out['building:min_level'] = String(minLevel); else delete out['building:min_level'];
    if (tags.min_height) { const min = h.min + dz; if (min > 1e-4) out.min_height = fmt(min); else delete out.min_height; }
    return out;
  }
  const min = h.min + dz;
  if (min > 1e-4) out.min_height = fmt(min); else delete out.min_height;
  delete out['building:min_level']; // низ теперь задан метрами
  // Верх задан этажами — фиксируем его метрами, иначе он поедет вместе с этажами низа
  if (!tags.height) out.height = fmt(h.top);
  return out;
}

/** Попап посреди карты; пустой html — закрыть. */
function showPopup(html: string) {
  popupEl.innerHTML = html ? `<div class="popup-card">${html}<p><button type="button" data-popup-close>Понятно</button></p></div>` : '';
  if (!html) renderSelected(); // вернуть обычную подсветку
}
popupEl.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest('[data-popup-close]') || e.target === popupEl) showPopup('');
});

/**
 * Объект сессии мог быть взят из старого кеша без id узлов, и перезагрузка тайлов его не обновит: сессия держит
 * свою копию. Берём id из свежих данных тайлов, если там тот же контур (то же число вершин в кольцах).
 */
function adoptNodeIds(f: Feature3D) {
  if (f.polygons.every((p) => p.outerIds && (!p.inners.length || p.innerIds))) return;
  const fresh = overpass.findFeature(f.key);
  if (!fresh || fresh === f || fresh.polygons.length !== f.polygons.length) return;
  f.polygons.forEach((p, i) => {
    const q = fresh.polygons[i];
    if (q.outerIds?.length === p.outer.length && p.inners.length === q.inners.length
      && p.inners.every((r, j) => q.innerIds?.[j]?.length === r.length)) {
      p.outerIds = q.outerIds;
      p.innerIds = q.innerIds;
    }
  });
}

/**
 * Для кеша тайлов после отправки: у мультиполигонов — актуальные пути-члены (их состав и узлы могли
 * поменяться при разрезании), в том числе у соседей, которых сами не отправляли.
 */
function withMemberWays<T extends { version: number; tags: Record<string, string>; polygons?: Polygon[] }>(saved: Map<string, T>): Map<string, T & { ways?: MemberWay[] }> {
  const out = new Map<string, T & { ways?: MemberWay[] }>(saved);
  const lines = new Map(session.lineEntities().map((t) => [Number(t.key.split('/')[1]), t] as const));
  if (!lines.size) return out;
  for (const f of liveFeatures()) {
    if (f.type !== 'relation') continue;
    const rw = relWays(f);
    if (!rw?.some((w) => lines.has(w.id)) && !out.has(f.key)) continue;
    const base = new Map((f.ways ?? overpass.findFeature(f.key)?.ways ?? []).map((w) => [w.id, w] as const));
    const ways = rw?.map((w) => {
      const l = lines.get(w.id);
      return { id: w.id, role: w.role, nodes: l?.line!.ids ?? base.get(w.id)?.nodes ?? [], ...(l ? (Object.keys(l.tags).length ? { tags: l.tags } : {}) : base.get(w.id)?.tags ? { tags: base.get(w.id)!.tags } : {}) };
    });
    if (!ways || ways.some((w) => !w.nodes.length)) continue;
    const prev = out.get(f.key);
    out.set(f.key, { ...(prev ?? { version: f.version, tags: f.tags, polygons: f.polygons }), ways } as T & { ways?: MemberWay[] });
  }
  return out;
}

/** Узлы объекта; undefined — в данных нет id узлов (старый кеш). */
function nodeIds(f: Feature3D): number[] | undefined {
  adoptNodeIds(f);
  const ids: number[] = [];
  for (const p of f.polygons) {
    if (!p.outerIds || (p.inners.length && !p.innerIds)) return;
    ids.push(...p.outerIds, ...(p.innerIds ?? []).flat());
  }
  return ids;
}

/** Проверить выделение и включить перемещение (общие с соседями узлы и пути разведутся при применении). */
function startMove() {
  if (!focus) return;
  const keys = selection.filter((k) => focus!.members.includes(k));
  if (!keys.length) return setStatus('Сначала выберите в здании объект (или несколько с Shift), затем инструмент «Переместить».', true);
  const features = keys.map((k) => entity(k) as Feature3D | undefined).filter((f): f is Feature3D => !!f?.polygons);
  if (features.some((f) => !nodeIds(f) || (f.type === 'relation' && !relWays(f)))) {
    return setStatus('В кеше нет id узлов или путей этих объектов — нажмите «Перезагрузить видимые тайлы» в настройках графики.', true);
  }
  pushTool.stop();
  splitTool.stop(); measureTool.stop(); paintTool.stop(); offsetTool.stop();
  drawTool.stop();
  moveTool.start(keys);
}

/** Применить сдвиг: x/y — координаты узлов, z — высоты (теги). */
function commitMove(keys: string[], offset: THREE.Vector3) {
  const features = keys.map((k) => entity(k) as Feature3D | undefined).filter((f): f is Feature3D => !!f?.polygons);
  // Ниже земли не опускаем
  const minBase = Math.min(...features.map((f) => computeHeights(f.tags).min));
  const dz = Math.max(offset.z, -minBase);
  const shift = (c: LonLat): LonLat => {
    const [x, y] = overpassLayer.focusToLocal(c)!;
    return overpassLayer.focusToLngLat(x + offset.x, y + offset.y)!;
  };
  const moved = Math.hypot(offset.x, offset.y) > 1e-4;
  const tags = (f: Feature3D) => (Math.abs(dz) > 1e-4 ? shiftHeights(f.tags, dz) : undefined);
  if (!moved) {
    session.editMany(features.map((f) => ({ key: f.key, tags: tags(f) })));
  } else {
    // Узлы, общие с объектами вне перемещаемых, остаются соседям — у нас на их месте новые
    const shared = nodesOutside(new Set(keys));
    const fresh = new Map<number, LonLat>(), swap = new Map<number, number>();
    const id = (n: number, c: LonLat) => {
      if (!shared.has(n)) return n;
      const k = swap.get(n) ?? swap.set(n, nextNewId--).get(n)!;
      fresh.set(k, c);
      return k;
    };
    const items = features.map((f) => ({
      f,
      rewrites: f.polygons.flatMap((p, poly) => [p.outer, ...p.inners].map((ring, r) => {
        const ids = r ? p.innerIds![r - 1] : p.outerIds!;
        const coords = ring.map(shift);
        return { poly, ring: r, ids: ids.map((n, k) => id(n, coords[k])), coords };
      })),
    }));
    const edits = topologyEdits(items, [], fresh);
    if (typeof edits === 'string') return setStatus(edits, true);
    for (const f of features) {
      const t = tags(f);
      const e = edits.find((x) => x.key === f.key);
      if (t && e) e.tags = t;
    }
    session.editMany(edits);
  }
  setStatus(`Перемещено объектов: ${features.length} на ${offset.length().toFixed(2)} м.`);
}

/** Поднять или опустить объект на dz метров, сохранив способ разметки (этажи — если сдвиг кратен этажу). */
function shiftHeights(tags: Record<string, string>, dz: number): Record<string, string> {
  const h = computeHeights(tags);
  const out = { ...tags };
  const fmt = (v: number) => String(Math.round(v * 100) / 100);
  const levels = dz / 3;
  if (!tags.height && !tags.min_height && tags['building:levels'] && Math.abs(levels - Math.round(levels)) < 1e-6) {
    const k = Math.round(levels);
    const minLevel = Number(tags['building:min_level'] ?? 0) + k;
    if (minLevel) out['building:min_level'] = String(minLevel); else delete out['building:min_level'];
    out['building:levels'] = String(Number(tags['building:levels']) + k);
    return out;
  }
  const min = h.min + dz;
  if (min > 1e-4 || tags.min_height) out.min_height = fmt(min); else delete out.min_height;
  out.height = fmt(h.top + dz);
  delete out['building:min_level']; // высоты теперь заданы метрами
  return out;
}

document.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).closest('input, select, textarea')) return;
  if (e.key === 'Escape' && popupEl.childElementCount) { showPopup(''); e.stopImmediatePropagation(); return; }
  // Пробел — выключить инструмент (незавершённое действие отменяется), обратно к выделению
  if (e.code === 'Space' && toolActive() && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    e.stopImmediatePropagation();
    moveTool.stop();
    pushTool.stop();
    splitTool.stop(); measureTool.stop(); paintTool.stop(); offsetTool.stop();
    drawTool.stop();
    cancelCopyPick();
    updateSnap(undefined);
    return;
  }
  if (e.key === 'Escape' && copyPick) { e.preventDefault(); e.stopImmediatePropagation(); cancelCopyPick(); return; }
  if (moveTool.key(e) || pushTool.key(e) || splitTool.key(e) || drawTool.key(e) || measureTool.key(e) || paintTool.key(e) || offsetTool.key(e)) { e.preventDefault(); e.stopImmediatePropagation(); return; }
  // S — привязки вкл/выкл, в том числе посреди перемещения или вытягивания
  if (focus && e.code === 'KeyS' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    closeCtxMenu();
    toggleSnaps();
    return;
  }
  // G — сетка основания вкл/выкл
  if (focus && e.code === 'KeyG' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    closeCtxMenu();
    toggleGrid();
    return;
  }
  // Ctrl/Cmd+C, Ctrl/Cmd+V — копировать и вставить части здания (по физической клавише — и в русской раскладке)
  // Выделен текст на странице (строка состояния, панель) — Ctrl+C копирует его, как обычно
  const textSelected = !!window.getSelection()?.toString();
  if (focus && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.code === 'KeyV' || (e.code === 'KeyC' && selection.length && !textSelected)) && !toolActive()) {
    e.preventDefault();
    closeCtxMenu();
    if (e.code === 'KeyC') copySelected(); else pasteClipboard();
    return;
  }
  // Del / Backspace — удалить выделенное (на карте — отдельные здания, в режиме здания — части)
  // На Mac клавиша Delete — это Backspace
  if ((e.key === 'Delete' || e.key === 'Backspace') && !toolActive() && selection.length) {
    e.preventDefault();
    closeCtxMenu();
    deleteSelected();
    return;
  }
  // На карте R / L — новое здание (набросок)
  if (!focus && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && (e.code === 'KeyR' || e.code === 'KeyL')) {
    e.preventDefault();
    closeCtxMenu();
    startSketch(e.code === 'KeyR' ? 'rect' : 'polygon');
    return;
  }
  // Шорткаты режима здания — по физической клавише (e.code), чтобы работали и в русской раскладке
  // Работают и посреди другого инструмента: запуск нового выключает текущий
  if (!focus || e.ctrlKey || e.metaKey || e.altKey) return;
  const action = e.code === 'KeyM' && !e.shiftKey ? 'move'
    : e.code === 'KeyP' && !e.shiftKey ? 'push'
    : e.code === 'KeyK' && !e.shiftKey ? 'split'
    : e.code === 'KeyT' && !e.shiftKey ? 'measure'
    : e.code === 'KeyB' && !e.shiftKey ? 'paint'
    : e.code === 'KeyO' && !e.shiftKey ? 'offset'
    : e.code === 'KeyH' ? (e.shiftKey ? 'show-all' : 'hide')
    : e.code === 'KeyR' && !e.shiftKey ? 'rect'
    : e.code === 'KeyL' && !e.shiftKey ? 'polygon' : undefined;
  if (!action) return;
  e.preventDefault();
  closeCtxMenu();
  cancelCopyPick();
  if (action === 'move') startMove(); else if (action === 'push') startPush(); else if (action === 'split') startSplit();
  else if (action === 'measure') startMeasure(); else if (action === 'paint') startPaint(); else if (action === 'offset') startOffset();
  else if (action === 'rect' || action === 'polygon') startDraw(action); else focusAction(action);
}, { capture: true });
document.addEventListener('keyup', (e) => { if (moveTool.key(e) || drawTool.key(e) || measureTool.key(e)) e.preventDefault(); });

/** Здания тайлов под точкой; до загрузки стиля слоёв ещё нет — тогда пусто (иначе MapLibre бросает ошибку). */
function queryTileLayers(point: maplibregl.PointLike): MapGeoJSONFeature[] {
  const layers = TILE_LAYERS.filter((id) => map.getLayer(id));
  return layers.length ? map.queryRenderedFeatures(point, { layers }) : [];
}

// Наведение на «Обновить контур» — предпросмотр нового контура
infoEl.addEventListener('mouseover', (e) => {
  if (!(e.target as HTMLElement).closest('[data-outline-fix]') || !focus) return;
  const r = partsOutsideOutline(focus);
  const ring = r && unitedOutline(r.outline, r.parts);
  if (Array.isArray(ring)) overpassLayer.setDrawPreview(ring.map(([x, y]) => new THREE.Vector3(x, y, 0)), true);
});
infoEl.addEventListener('mouseout', (e) => {
  if ((e.target as HTMLElement).closest('[data-outline-fix]')) overpassLayer.setDrawPreview(undefined);
});

infoEl.addEventListener('click', (e) => {
  const link = (e.target as HTMLElement).closest<HTMLElement>('a[data-select]');
  if (link) { e.preventDefault(); select(link.dataset.select); return; }
  const btn = (e.target as HTMLElement).closest('button');
  if (!btn) return;
  if (btn.dataset.merge !== undefined) return mergeIntoBuilding();
  if (btn.dataset.focusExit !== undefined) return closeFocus();
  if (btn.dataset.outlineFix !== undefined) return fixOutline();
  if (btn.dataset.exclude !== undefined) return excludeFromGroup();
  if (btn.dataset.addParts !== undefined) return startAdding();
  if (btn.dataset.addConfirm !== undefined) return confirmAdding();
  if (btn.dataset.addCancel !== undefined) return stopAdding();
  if (btn.dataset.hide) userHidden.add(btn.dataset.hide);
  else if (btn.dataset.unhideAll !== undefined) userHidden.clear();
  else return;
  updateTileFilter();
  clearSelection();
  if (userHidden.size) {
    infoEl.innerHTML = `<p>Скрыто вручную: ${userHidden.size}</p><p><button type="button" data-unhide-all>Показать все</button></p>`;
  }
});

function clearSelection() {
  leaveDrill();
  addingTo = undefined;
  addPending = [];
  selection = [];
  selectedKey = undefined;
  infoEl.innerHTML = '';
  overpassLayer.select(undefined);
  clearTileHighlight();
}

function clearTileHighlight() {
  map.setFilter(HIGHLIGHT_LAYER, ['==', ['id'], -1]);
  map.setFilter(MERGED_HIGHLIGHT_LAYER, ['==', ['get', 'key'], '']);
}

/** Минимальный индикатор загрузки данных в углу карты: точка цвета состояния + счётчик тайлов. */
function updateOverpassIndicator() {
  const { ready, total, loading, waiting } = overpass.status();
  const state = !overpass.enabled ? 'off' : loading ? 'loading' : waiting ? 'waiting' : 'ready';
  opIndicator.dataset.state = state;
  opIndicator.hidden = state === 'off';
  const src = overpass.sourceLabel;
  opIndicator.querySelector('.label')!.textContent = {
    off: '',
    loading: `Черновик из тайлов — загружаю точную геометрию (${src} ${ready}/${total})…`,
    waiting: `Не удалось получить часть данных (${src} ${ready}/${total})`,
    ready: `${src} ${ready}/${total}`,
  }[state];
  opIndicator.querySelector<HTMLButtonElement>('.retry')!.hidden = state !== 'waiting';
  const servers = overpass.pool.endpoints
    .map((e) => `${e.host}: ${e.active} в работе, ок ${e.ok}, ошибок ${e.failed}${e.coolUntil > Date.now() ? ', остывает' : ''}`)
    .join('\n');
  opIndicator.title = {
    off: '',
    loading: `Загружается тайлов: ${loading}`,
    waiting: `Ждут повтора: ${waiting} (лимит или ошибка OSM API, подробности в консоли)`,
    ready: 'Все видимые тайлы загружены',
  }[state] + (state === 'off' ? '' : `\n${describeFreshness()}\n\n${servers}`);
}

/**
 * Черновик: пока для тайла нет данных API, здание из векторных тайлов — лишь набросок.
 * Рисуем его полупрозрачным серо-голубым «призраком»; пока идёт загрузка — прозрачность «дышит».
 */
const DRAFT_FILL = '#9fb3c8';
let draftTimer: number | undefined;
function updateDraftStyle() {
  if (!map.getLayer(BUILDINGS_LAYER)) return;
  const { loading } = overpass.status();
  const draft = overpass.enabled && overpass.mode === 'full';
  for (const id of TILE_LAYERS) {
    map.setPaintProperty(id, 'fill-extrusion-color', draft ? DRAFT_FILL : TILE_FILL);
    if (!draft || !loading) map.setPaintProperty(id, 'fill-extrusion-opacity', draft ? 0.45 : 0.9);
  }
  if (draft && loading && draftTimer === undefined) {
    const t0 = performance.now();
    draftTimer = window.setInterval(() => {
      const o = 0.4 + 0.15 * Math.sin(((performance.now() - t0) / 1500) * 2 * Math.PI);
      for (const id of TILE_LAYERS) map.setPaintProperty(id, 'fill-extrusion-opacity', o);
    }, 100);
  } else if (!(draft && loading) && draftTimer !== undefined) {
    clearInterval(draftTimer);
    draftTimer = undefined;
  }
}

/** Откуда и когда получены видимые тайлы — чтобы было видно, что на экране старые или неполные данные. */
function describeFreshness(): string {
  const f = overpass.freshness();
  const parts = [f.overpass && `из Overpass (старый кеш): ${f.overpass}`, f.api && `из OSM API: ${f.api}`, f.unknown && `источник неизвестен: ${f.unknown}`].filter(Boolean);
  if (!parts.length) return '';
  const age = f.oldest ? ` · самый старый загружен ${formatAge(Date.now() - f.oldest)} назад` : '';
  return `Тайлы ${parts.join(', ')}${age}`;
}

function formatAge(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} мин`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} ч` : `${Math.round(h / 24)} дн`;
}

function setStatus(text: string, error = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', error);
}

/** Выделить объект (или группу); false — выделять нечего. */
function select(key: string | undefined): boolean {
  addingTo = undefined;
  addPending = [];
  // Переход из списка правок или undo к объекту вне текущей группы — выходим из неё
  if (drill && key && key !== drill.key && !drill.members.includes(key)) leaveDrill();
  if (drill && key === drill.key) leaveDrill();
  // Вне группы её член выделяется вместе с ней
  if (!drill && key) key = groupOf(key)?.key ?? key;
  if (key && !entity(key)) key = undefined; // нет в данных или отменили создание группы
  selection = key ? [key] : [];
  selectedKey = key;
  if (key) clearTileHighlight();
  paintSelection();
  renderSelected();
  return !!key;
}

function toggleSelection(key: string) {
  if (!entity(key)) return;
  clearTileHighlight();
  selection = selection.includes(key) ? selection.filter((k) => k !== key) : [...selection, key];
  selectedKey = selection.at(-1);
  paintSelection();
  renderSelected();
}

/** Добавить к выделению несколько объектов (рамкой). */
function addToSelection(keys: string[]) {
  const add = keys.filter((k) => !selection.includes(k) && !focusHidden.has(k) && entity(k));
  if (!add.length) return;
  clearTileHighlight();
  selection = [...selection, ...add];
  selectedKey = selection.at(-1);
  paintSelection();
  renderSelected();
}

// Выделение рамкой: Shift + перетаскивание. Объект попадает в рамку, если в неё попал центр его основания.
const boxEl = document.createElement('div');
boxEl.className = 'select-box';
boxEl.hidden = true;
map.getCanvasContainer().appendChild(boxEl);
let boxStart: maplibregl.Point | undefined;

map.getCanvasContainer().addEventListener('mousedown', (e) => {
  if (!e.shiftKey || e.button !== 0 || toolActive()) return;
  const r = map.getCanvas().getBoundingClientRect();
  boxStart = new maplibregl.Point(e.clientX - r.left, e.clientY - r.top);
  map.dragPan.disable();
});

window.addEventListener('mousemove', (e) => {
  if (!boxStart) return;
  const r = map.getCanvas().getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  if (boxEl.hidden && Math.hypot(x - boxStart.x, y - boxStart.y) < 5) return; // ещё похоже на клик
  boxEl.hidden = false;
  Object.assign(boxEl.style, {
    left: `${Math.min(x, boxStart.x)}px`, top: `${Math.min(y, boxStart.y)}px`,
    width: `${Math.abs(x - boxStart.x)}px`, height: `${Math.abs(y - boxStart.y)}px`,
  });
});

window.addEventListener('mouseup', (e) => {
  if (!boxStart) return;
  const start = boxStart;
  boxStart = undefined;
  map.dragPan.enable();
  if (boxEl.hidden) return; // это был Shift+клик — его обработает click
  boxEl.hidden = true;
  const r = map.getCanvas().getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  const [x0, x1] = [Math.min(x, start.x), Math.max(x, start.x)];
  const [y0, y1] = [Math.min(y, start.y), Math.max(y, start.y)];
  const keys = new Set<string>();
  // В режиме здания тайлы не пересобираются до выхода (нет новых частей, старая геометрия) — берём само здание
  const candidates = focus
    ? groupFeatures(focus).filter((f) => f.polygons?.length && !focusHidden.has(f.key)).map((feature) => ({ feature }))
    : overpass.renderedFeatures();
  const inBox = candidates.filter(({ feature: f }) => {
    const p = map.project(centroid(f.polygons[0].outer));
    return p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
  });
  if (addingTo) {
    // Режим «добавить части»: рамкой отмечаем кандидатов (подходящие молча, без сообщений о неподходящих)
    for (const { feature: f } of inBox) if (!addPending.includes(f.key) && !addReason(f.key)) addPending.push(f.key);
    paintSelection();
    renderSelected();
    return;
  }
  for (const { feature: f } of inBox) {
    // Как у Shift+клика: внутри группы — только её члены, снаружи — группа целиком
    if (drill) { if (drill.members.includes(f.key)) keys.add(f.key); }
    else keys.add(groupOf(f.key)?.key ?? f.key);
  }
  addToSelection([...keys]);
  // Клик после перетаскивания MapLibre не шлёт, но на всякий случай гасим ближайший
  suppressClick = true;
  setTimeout(() => (suppressClick = false), 0);
});
let suppressClick = false;

function paintSelection() {
  overpassLayer.select([...selection.flatMap(highlightKeys), ...addPending]);
  renderOutliner();
  for (const li of changesEl.querySelectorAll<HTMLElement>('li[data-key]')) li.classList.toggle('selected', selection.includes(li.dataset.key!));
}

const ICON_EYE = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M1 8s2.6-4.5 7-4.5S15 8 15 8s-2.6 4.5-7 4.5S1 8 1 8z"/><circle cx="8" cy="8" r="2"/></svg>';
const ICON_EYE_OFF = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M1 8s2.6-4.5 7-4.5S15 8 15 8s-2.6 4.5-7 4.5S1 8 1 8z" opacity=".35"/><path d="M2.5 13.5l11-11"/></svg>';
/** Контур — домик (здание целиком), часть — куб. */
const ICON_OUTLINE = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M2.5 7.5L8 2.5l5.5 5V14h-11z"/><path d="M6.5 14v-4h3v4"/></svg>';
const ICON_PART = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M8 1.8l5.5 3v6.4L8 14.2l-5.5-3V4.8z"/><path d="M2.5 4.8L8 7.8l5.5-3M8 7.8v6.4"/></svg>';

/** Иконки видов частей (building:part=*), 16×16, контуром. */
const svg16 = (d: string) => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round">${d}</svg>`;
const PART_ICONS = {
  roof: svg16('<path d="M1.5 9.5L8 3.5l6.5 6M1.5 9.5v2.5L8 6l6.5 6V9.5"/>'),
  steps: svg16('<path d="M2 14h12V3h-3v3.5H8V10H5v4"/>'),
  balcony: svg16('<path d="M2 3v11M2 9h12"/><path d="M5 9v4M8 9v4M11 9v4M14 9v4M2 13h12"/>'),
  deck: svg16('<path d="M1.5 9.5h13l-2 2h-9z"/><path d="M4 11.5V14M12 11.5V14"/>'),
  column: svg16('<path d="M4.5 2.5h7M4.5 13.5h7M6 2.5v11M10 2.5v11"/>'),
  tower: svg16('<path d="M5.5 14V5h5v9M4.5 14h7"/><path d="M5.5 5L8 1.5 10.5 5"/><path d="M7 8h2"/>'),
  elevator: svg16('<rect x="3.5" y="1.5" width="9" height="13" rx="1"/><path d="M6 6l2-2 2 2M6 10l2 2 2-2"/>'),
  porch: svg16('<path d="M1.5 6L8 2.5 14.5 6z"/><path d="M3.5 6v8M12.5 6v8M2 14h12"/>'),
  canopy: svg16('<path d="M1.5 5.5h13l-1.5 2.5H3z"/><path d="M4 8v6M12 8v6"/>'),
  mast: svg16('<path d="M8 2v12M5 14h6M5 5.5l3-3.5 3 3.5M6 9h4"/>'),
  dome: svg16('<path d="M2.5 11.5a5.5 5.5 0 0 1 11 0z"/><path d="M8 6V2.5M2 14h12"/>'),
  chimney: svg16('<path d="M6 14V3.5h4V14M5 3.5h6"/><path d="M7 2c.5-.6 1.5-.6 2 0"/>'),
  base: svg16('<path d="M1.5 10.5h13v3.5h-13z"/><path d="M4 10.5V7h8v3.5"/>'),
  wall: svg16('<path d="M2 3.5h12v9H2zM2 8h12M6 3.5V8M10 8v4.5"/>'),
  bridge: svg16('<path d="M1.5 6.5h13M1.5 10.5h13M1.5 6.5v4M14.5 6.5v4"/><path d="M5 8.5h6M9.5 7l1.5 1.5L9.5 10"/>'),
  construction: svg16('<path d="M8 1.8l5.5 3v6.4L8 14.2l-5.5-3V4.8z" stroke-dasharray="2 1.5"/>'),
};
/**
 * Виды частей по самым частым значениям building:part (taginfo): подпись и иконка. Значения-типы зданий
 * (apartments, house, retail…) — обычная «Часть» со значением в подписи.
 */
const PART_KINDS: Record<string, [string, keyof typeof PART_ICONS]> = {
  roof: ['Крыша', 'roof'], 'roof section': ['Крыша', 'roof'],
  steps: ['Ступени', 'steps'], stairs: ['Лестница', 'steps'], staircase: ['Лестница', 'steps'], stairway: ['Лестница', 'steps'], grandstand: ['Трибуна', 'steps'],
  balcony: ['Балкон', 'balcony'], loggia: ['Лоджия', 'balcony'],
  deck: ['Настил', 'deck'], terrace: ['Терраса', 'deck'], patio: ['Патио', 'deck'],
  column: ['Колонна', 'column'], pillar: ['Столб', 'column'], buttress: ['Контрфорс', 'column'],
  tower: ['Башня', 'tower'], bell_tower: ['Колокольня', 'tower'],
  elevator: ['Лифт', 'elevator'], verticalpassage: ['Лифт', 'elevator'],
  porch: ['Крыльцо', 'porch'], veranda: ['Веранда', 'porch'], portico: ['Портик', 'porch'], entrance: ['Вход', 'porch'],
  canopy: ['Навес', 'canopy'], carport: ['Навес для машин', 'canopy'],
  mast: ['Мачта', 'mast'], antenna: ['Антенна', 'mast'],
  dome: ['Купол', 'dome'], cupola: ['Купол', 'dome'],
  chimney: ['Труба', 'chimney'],
  base: ['Основание', 'base'], stylobate: ['Стилобат', 'base'], foundation: ['Фундамент', 'base'], basement: ['Подвал', 'base'],
  wall: ['Стена', 'wall'],
  corridor: ['Переход', 'bridge'], bridge: ['Переход', 'bridge'], passageway: ['Переход', 'bridge'],
  construction: ['Строится', 'construction'],
};

/** Панель частей режима здания: все члены отношения, контур — первым. */
/** Свёрнутые группы частей одного вида (по подписи вида); запоминаются. */
const collapsedKinds = new Set<string>();
try { for (const k of JSON.parse(localStorage.getItem('outliner-collapsed') ?? '[]') as string[]) collapsedKinds.add(k); } catch { /* нет хранилища */ }
const ICON_CHEVRON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4l4 4-4 4"/></svg>';

/** Вид части для панели: подпись и иконка (контур — отдельно). */
function partKind(t: Record<string, string>, outline: boolean): { label: string; icon: string; title: string } {
  if (outline) return { label: 'Контур', icon: ICON_OUTLINE, title: 'Контур (outline)' };
  const value = t['building:part'];
  const kind = PART_KINDS[value?.toLowerCase() ?? ''];
  const label = kind?.[0] ?? (value && value !== 'yes' ? `Часть: ${value}` : 'Часть');
  return { label, icon: kind ? PART_ICONS[kind[1]] : ICON_PART, title: `${label} (building:part=${value ?? '—'})` };
}

/** Члены группы панели по data-group (для клика по группе). */
let outlinerGroups = new Map<string, string[]>();

/**
 * Панель частей режима здания: контур — первым, затем части; две и больше частей одного вида собираются
 * в группу (сворачивается стрелкой, клик выделяет все её части, глазик скрывает или показывает их все).
 */
function renderOutliner() {
  outlinerPanel.hidden = !focus;
  if (!focus) { outlinerEl.innerHTML = ''; return; }
  const g = focus;
  const rows = g.members.map((key, i) => {
    const f = entity(key);
    const outline = g.roles[i] === 'outline';
    return { key, f, outline, kind: partKind(f?.tags ?? {}, outline) };
  });
  // Порядок: контур, крыши, прочие виды (как встретились), обычные части (building:part=yes) — в конце
  const rank = (r: (typeof rows)[number]) => (r.outline ? 0 : r.kind.label === 'Крыша' ? 1 : r.kind.label === 'Часть' ? 3 : 2);
  rows.sort((a, b) => rank(a) - rank(b));
  outlinerCount.textContent = `(${rows.length})`;
  const row = (r: (typeof rows)[number], child: boolean) => {
    const off = focusHidden.has(r.key);
    const cls = [child && 'ol-child', selection.includes(r.key) && 'selected', off && 'off', !r.f && 'missing'].filter(Boolean).join(' ');
    const title = r.f ? r.key : `${r.key} — не загружен`;
    return `<li class="${cls}" data-key="${esc(r.key)}" title="${esc(title)}">
      <span class="ol-icon" title="${esc(r.kind.title)}">${r.kind.icon}</span>
      <span class="ol-label">${child && !r.f?.tags.name ? `<span class="ol-key bare">${esc(r.key)}</span>` : `${esc(r.f?.tags.name ?? r.kind.label)}<span class="ol-key">${esc(r.key)}</span>`}</span>
      <button type="button" class="ol-eye" data-eye title="${off ? 'Показать' : 'Скрыть'}">${off ? ICON_EYE_OFF : ICON_EYE}</button></li>`;
  };
  // Группы — по подписи вида, в порядке первого появления
  const byKind = new Map<string, typeof rows>();
  for (const r of rows) if (!r.outline) (byKind.get(r.kind.label) ?? byKind.set(r.kind.label, []).get(r.kind.label)!).push(r);
  outlinerGroups = new Map();
  const html: string[] = [];
  const done = new Set<string>();
  for (const r of rows) {
    const list = r.outline ? undefined : byKind.get(r.kind.label)!;
    if (!list || list.length < 2) { html.push(row(r, false)); continue; }
    if (done.has(r.kind.label)) continue;
    done.add(r.kind.label);
    const keys = list.map((x) => x.key);
    outlinerGroups.set(r.kind.label, keys);
    const collapsed = collapsedKinds.has(r.kind.label);
    const allOff = keys.every((k) => focusHidden.has(k));
    const live = keys.filter((k) => entity(k) && !focusHidden.has(k));
    const sel = live.length > 0 && live.every((k) => selection.includes(k));
    const cls = ['ol-group', collapsed && 'collapsed', sel && 'selected', allOff && 'off'].filter(Boolean).join(' ');
    html.push(`<li class="${cls}" data-group="${esc(r.kind.label)}" title="Выделить все: ${esc(r.kind.label)}">
      <button type="button" class="ol-toggle" data-toggle title="${collapsed ? 'Развернуть' : 'Свернуть'}">${ICON_CHEVRON}</button>
      <span class="ol-icon" title="${esc(r.kind.title)}">${r.kind.icon}</span>
      <span class="ol-label">${esc(r.kind.label)}<span class="ol-key">${keys.length}</span></span>
      <button type="button" class="ol-eye" data-eye title="${allOff ? 'Показать все' : 'Скрыть все'}">${allOff ? ICON_EYE_OFF : ICON_EYE}</button></li>`);
    if (!collapsed) for (const x of list) html.push(row(x, true));
  }
  outlinerEl.innerHTML = html.join('');
}

// Группа видов: стрелка — свернуть, глазик — скрыть/показать все, клик — выделить все (Shift — добавить или снять)
outlinerEl.addEventListener('click', (e) => {
  const li = (e.target as HTMLElement).closest<HTMLElement>('li[data-group]');
  if (!li || !focus) return;
  e.stopImmediatePropagation();
  const label = li.dataset.group!;
  const keys = outlinerGroups.get(label) ?? [];
  if ((e.target as HTMLElement).closest('[data-toggle]')) {
    if (collapsedKinds.has(label)) collapsedKinds.delete(label); else collapsedKinds.add(label);
    try { localStorage.setItem('outliner-collapsed', JSON.stringify([...collapsedKinds])); } catch { /* только до перезагрузки */ }
    renderOutliner();
    return;
  }
  if ((e.target as HTMLElement).closest('[data-eye]')) {
    const next = new Set(focusHidden);
    const show = keys.every((k) => next.has(k));
    for (const k of keys) if (show) next.delete(k); else next.add(k);
    changeFocusHidden(next);
    return;
  }
  const live = keys.filter((k) => entity(k) && !focusHidden.has(k));
  if (!e.shiftKey) { select(undefined); addToSelection(live); return; }
  if (live.length && live.every((k) => selection.includes(k))) {
    // Вся группа уже выделена — Shift+клик снимает её
    selection = selection.filter((k) => !live.includes(k));
    selectedKey = selection.at(-1);
    paintSelection();
    renderSelected();
  } else addToSelection(live);
}, { capture: true });

outlinerEl.addEventListener('click', (e) => {
  const li = (e.target as HTMLElement).closest<HTMLElement>('li[data-key]');
  if (!li || !focus) return;
  const key = li.dataset.key!;
  if ((e.target as HTMLElement).closest('[data-eye]')) {
    const next = new Set(focusHidden);
    if (next.has(key)) next.delete(key); else next.add(key);
    changeFocusHidden(next);
    return;
  }
  if (!entity(key)) return;
  if (e.shiftKey) toggleSelection(key); else select(key);
});
// Контекстное меню частей (список и сцена): действует на выделение (правый клик вне выделения выделяет объект)
const ctxMenu = document.createElement('ul');
ctxMenu.className = 'ctx-menu';
ctxMenu.hidden = true;
document.body.appendChild(ctxMenu);

function closeCtxMenu() { ctxMenu.hidden = true; }

outlinerEl.addEventListener('contextmenu', (e) => {
  const li = (e.target as HTMLElement).closest<HTMLElement>('li[data-key]');
  if (!li || !focus) return;
  e.preventDefault();
  const key = li.dataset.key!;
  if (!entity(key)) return;
  if (!selection.includes(key)) select(key);
  openCtxMenu(e.clientX, e.clientY, 'list');
});

// То же меню в сцене: правый клик по части здания (не по выделенной — сначала выделяет её).
// Правой кнопкой ещё и вращают карту — меню только если мышь почти не сдвинулась
// Слушаем canvas напрямую: вращение (orbit) перехватывает pointerdown, и map.on('contextmenu') не срабатывает.
// На macOS contextmenu приходит уже при нажатии — меню открываем при отпускании, если мышь почти не сдвинулась
// (иначе это было вращение камеры)
let rightDown: [number, number] | undefined;
// На контейнере, а не на canvas: orbit на canvas останавливает распространение pointerdown
map.getContainer().addEventListener('pointerdown', (e) => { if (e.button === 2) rightDown = [e.clientX, e.clientY]; }, { capture: true });
// Системное меню глушим на всём контейнере карты: при вращении событие приходит не на canvas, а на слой поверх,
// и системное меню уводит фокус из окна — наше тут же закрывается
map.getContainer().addEventListener('contextmenu', (e) => { if (focus) e.preventDefault(); }, { capture: true });
window.addEventListener('pointerup', (e) => {
  if (e.button !== 2 || !rightDown) return;
  const moved = Math.hypot(e.clientX - rightDown[0], e.clientY - rightDown[1]) > 4;
  rightDown = undefined;
  if (!focus || moved || moveTool.state === 'move' || pushTool.state === 'push') return;
  const rect = map.getCanvas().getBoundingClientRect();
  const key = overpassLayer.pickHit([e.clientX - rect.left, e.clientY - rect.top])?.key;
  // Мимо здания — меню режима: показать всё и выход
  if (!key || !focus.members.includes(key)) return openCtxMenu(e.clientX, e.clientY, 'empty');
  if (!selection.includes(key)) select(key);
  openCtxMenu(e.clientX, e.clientY, 'scene');
}, { capture: true });

/**
 * Меню частей. В сцене скрытые не выбрать — вместо «Показать» там «Показать всё скрытое»;
 * 'empty' — клик мимо здания: только «Показать всё» и выход.
 */
function openCtxMenu(x: number, y: number, where: 'list' | 'scene' | 'empty') {
  if (!focus) return;
  const inScene = where !== 'list';
  const kbd = (k: string) => `<kbd>${k}</kbd>`;
  const snaps = `<li class="ctx-sep"></li><li><button type="button" data-ctx="snaps">${overpassLayer.snapsEnabled ? 'Выключить привязки' : 'Включить привязки'}${kbd('S')}</button></li>`;
  const exit = inScene ? `<li class="ctx-sep"></li><li><button type="button" data-ctx="exit">Выйти из режима редактирования${kbd('Esc')}</button></li>` : '';
  const keys = selection.filter((k) => focus!.members.includes(k));
  const anyShown = keys.some((k) => !focusHidden.has(k)), anyHidden = keys.some((k) => focusHidden.has(k));
  const n = keys.length > 1 ? ` (${keys.length})` : '';
  ctxMenu.innerHTML = where === 'empty' ? `
    <li><button type="button" data-ctx="show-all"${focusHidden.size ? '' : ' disabled'}>Показать всё${focusHidden.size ? ` (${focusHidden.size})` : ''}${kbd('⇧H')}</button></li>${snaps}${exit}` : `
    <li><button type="button" data-ctx="hide"${anyShown ? '' : ' disabled'}>Скрыть объекты${n}${kbd('H')}</button></li>
    <li><button type="button" data-ctx="isolate"${keys.length && focus.members.some((k) => !keys.includes(k) && !focusHidden.has(k)) ? '' : ' disabled'}>Изолировать${n}</button></li>
    ${inScene
      ? `<li><button type="button" data-ctx="show-all"${focusHidden.size ? '' : ' disabled'}>Показать всё скрытое${focusHidden.size ? ` (${focusHidden.size})` : ''}${kbd('⇧H')}</button></li>`
      : `<li><button type="button" data-ctx="show"${anyHidden ? '' : ' disabled'}>Показать объекты${n}</button></li>`}
    <li><button type="button" data-ctx="exclude"${keys.length ? '' : ' disabled'}>Исключить из модели${n}</button></li>
    <li><button type="button" data-ctx="delete"${keys.length ? '' : ' disabled'}>Удалить${n}${kbd('Del')}</button></li>${snaps}${exit}`;
  ctxMenu.hidden = false;
  // Не выходим за край окна
  const { width, height } = ctxMenu.getBoundingClientRect();
  ctxMenu.style.left = `${Math.min(x, innerWidth - width - 4)}px`;
  ctxMenu.style.top = `${Math.min(y, innerHeight - height - 4)}px`;
}

ctxMenu.addEventListener('click', (e) => {
  const action = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-ctx]:not(:disabled)')?.dataset.ctx;
  if (!action || !focus) return;
  closeCtxMenu();
  focusAction(action);
});

// Панель «Помощь»: краткая подсказка по включённому инструменту; кнопка «?» показывает и скрывает её
const helpPanel = document.getElementById('help-panel')!;
const helpEl = document.getElementById('help')!;
const helpTool = document.getElementById('help-tool')!;
const helpBtns = document.querySelectorAll<HTMLButtonElement>('[data-help]');
type HelpTopic = { title: string; desc: string; items: string[] };
const HELP: Record<string, HelpTopic> = {
  map: { title: 'Карта', desc: 'Просмотр зданий из OSM в 3D. Выделенное здание можно править в панели «Свойства» или открыть в режиме здания.', items: [
    'Клик — выделить здание, Shift+клик — добавить к выделению, Alt+клик — следующий объект под курсором.',
    'Двойной клик по зданию — режим здания (правка частей).',
    'R — новое здание прямоугольником, L — полигоном. Delete — удалить, Ctrl+Z — отменить.',
    'Перетаскивание правой кнопкой — поворот и наклон карты.',
  ] },
  focus: { title: 'Режим здания', desc: 'Одно здание отдельно от карты: его части, контур и правка геометрии инструментами слева.', items: [
    'Клик — выделить часть, Shift+клик — добавить к выделению, Alt+клик — следующая под курсором.',
    'Перетаскивание правой или средней кнопкой (или Ctrl+левой) — облёт вокруг точки под курсором.',
    'M — переместить, P — вытянуть, K — рассечь, R / L — новая часть, O — отступ, T — рулетка, B — заливка.',
    'Пробел — выключить инструмент. G — сетка, S — привязки, H — скрыть часть, Shift+H — показать все.',
    'Ctrl+C / Ctrl+V — копировать и вставить части, Delete — удалить, Ctrl+Z — отменить.',
    'Esc — снять выделение, ещё раз — назад к карте; двойной клик мимо здания — тоже к карте.',
  ] },
  move: { title: 'Переместить (M)', desc: 'Сдвигает выделенные части по горизонтали или вертикали, как Move в SketchUp. Общие с соседями углы заменяются новыми узлами, чтобы не было нахлёстов.', items: [
    'Клик по точке выделенной части — точка захвата, второй клик — применить; выделенные части едут вместе.',
    'Вдоль оси здания движение прилипает к ней; Shift держит ось, стрелки фиксируют ось (→ x, ← y, ↑ z, ↓ — снять).',
    'Число + Enter — сдвиг в метрах. Привязка к точкам других объектов.',
    'Esc — отмена.',
  ] },
  push: { title: 'Вытянуть (P)', desc: 'Меняет высоту верха (height) или низа (min_height) части либо сдвигает одну стену, как Push/Pull в SketchUp.', items: [
    'Клик по крыше — тянуть верх, по низу — низ, по стене — эту стену наружу или внутрь; второй клик — применить.',
    'Shift — задняя грань под курсором: дно или дальняя стена.',
    'Число + Enter — сдвиг (минус — внутрь или вниз); Tab — метры или этажи.',
    'Привязка к точке другого объекта выравнивает грань по ней. Esc — отмена.',
  ] },
  split: { title: 'Рассечь (K)', desc: 'Прямым разрезом делит верхнюю грань части на две части с теми же тегами.', items: [
    'Клик по ребру верхней грани — начало разреза, клик по другому ребру той же грани — конец.',
    'Разрез идёт прямо и целиком внутри контура; часть делится на две.',
    'Esc — отмена.',
  ] },
  rect: { title: 'Прямоугольник (R)', desc: 'Рисует новую часть — плоский прямоугольный контур; потом её можно вытянуть (P). На карте — новое отдельное здание.', items: [
    'Клики — точки прямоугольника на земле или на плоской крыше (по первому клику).',
    'Способ построения — во всплывашке у кнопки или Tab (первая точка сохраняется).',
    'Число + Enter — длина стороны или «ширина;глубина». Shift — держать ось здания.',
    'Esc — отмена.',
  ] },
  polygon: { title: 'Полигон (L)', desc: 'Рисует новую часть произвольной формы — плоский контур; потом её можно вытянуть (P). На карте — новое отдельное здание.', items: [
    'Клики — вершины на земле или на плоской крыше; клик в первую вершину или Enter — замкнуть.',
    'Число + Enter — длина текущей стороны, Backspace — убрать последнюю точку.',
    'Shift — держать ось здания (на привязке «продолжение» — линию ребра). Esc — отмена.',
  ] },
  offset: { title: 'Отступ (O)', desc: 'Строит новый плоский контур, параллельный контуру плоской крыши или низа части, — например, для парапета, надстройки или козырька.', items: [
    'Наведите на плоскую крышу (Shift — на низ части): контур отступает наружу или внутрь по стороне курсора.',
    'Клик — новый плоский контур на высоте грани; число + Enter — отступ в метрах (минус — внутрь).',
    'Новая часть берёт этажи или метры, как у исходной. Esc — отмена, повторный Esc — выйти.',
  ] },
  measure: { title: 'Рулетка (T)', desc: 'Измеряет расстояние между двумя точками; данные не меняет.', items: [
    'Клик — первая точка, второй клик — вторая: расстояние, по горизонтали и по высоте.',
    'Работают привязки; Shift — держать ось здания (x, y или вертикаль).',
    'Esc — сбросить замер, повторный Esc — выйти.',
  ] },
  pick: { title: 'Заливка (B): взять образец', desc: 'Переносит цвет и материал с одной поверхности на другие. Сначала возьмите образец.', items: [
    'Ctrl/Cmd/Alt+клик по крыше или стене — взять цвет и материал.',
    'Крыша — roof:colour и roof:material, стена — building:colour и building:material.',
  ] },
  paint: { title: 'Заливка (B)', desc: 'Переносит цвет и материал с одной поверхности на другие. Образец взят — назначайте его поверхностям.', items: [
    'Клик по крыше или стене — назначить взятые цвет и материал этой поверхности.',
    'Ctrl/Cmd/Alt+клик — взять новый образец. Esc — выключить.',
  ] },
};
let helpShown = false;
try { helpShown = localStorage.getItem('help-panel') === 'on'; } catch { /* по умолчанию скрыта */ }
let helpTopic = '';
function renderHelp() {
  helpPanel.hidden = !helpShown;
  for (const b of helpBtns) b.classList.toggle('active', helpShown);
  if (!helpShown) return;
  const key = moveTool.active ? 'move' : pushTool.active ? 'push' : splitTool.active ? 'split'
    : drawTool.active ? drawTool.shape : measureTool.active ? 'measure' : offsetTool.active ? 'offset'
    : paintTool.active ? (pickModifier || !paintTool.sample ? 'pick' : 'paint') : focus ? 'focus' : 'map';
  if (key === helpTopic) return;
  helpTopic = key;
  const t = HELP[key];
  helpTool.textContent = `— ${t.title}`;
  helpEl.innerHTML = `<p>${t.desc}</p><ul>${t.items.map((i) => `<li>${i}</li>`).join('')}</ul>`;
}
for (const b of helpBtns) b.addEventListener('click', () => {
  helpShown = !helpShown;
  try { localStorage.setItem('help-panel', helpShown ? 'on' : 'off'); } catch { /* только до перезагрузки */ }
  helpTopic = '';
  renderHelp();
});

const snapsBtn = document.querySelector<HTMLButtonElement>('[data-snaps]')!;
snapsBtn.addEventListener('click', () => toggleSnaps());

// Типы привязок — галками во всплывашке у кнопки привязок (стрелка в углу); выбор запоминается
const SNAP_KINDS: [SnapKind, string][] = [
  ['vertex', 'Вершины'], ['midpoint', 'Середины рёбер'], ['center', 'Центры'], ['edge', 'На ребре'],
  ['perpendicular', 'Перпендикуляр'], ['extension', 'Продолжение ребра'], ['grid', 'Узлы сетки'],
];
try { for (const k of JSON.parse(localStorage.getItem('snaps-off') ?? '[]') as SnapKind[]) overpassLayer.snapKindsOff.add(k); } catch { /* нет хранилища */ }
snapsBtn.insertAdjacentHTML('beforeend', '<span class="flyout-arrow" data-flyout title="Типы привязок"></span>');
let snapsFlyout: HTMLElement | undefined;
function closeSnapsFlyout() { snapsFlyout?.remove(); snapsFlyout = undefined; }
function renderSnapsFlyout() {
  if (!snapsFlyout) return;
  const off = overpassLayer.snapKindsOff;
  // «Все привязки» — включить все типы; доступен, только если какой-то выключен
  snapsFlyout.innerHTML = `<button type="button" class="flyout-all" data-snap-all${off.size ? '' : ' disabled'}>Включить все привязки</button>
    <div class="flyout-sep"></div>
    ${SNAP_KINDS.map(([k, label]) => `<label class="flyout-check${overpassLayer.snapsEnabled ? '' : ' disabled'}"><input type="checkbox" data-snap-kind="${k}"${off.has(k) ? '' : ' checked'}${overpassLayer.snapsEnabled ? '' : ' disabled'}> ${label}</label>`).join('')}`;
}
snapsBtn.addEventListener('click', (e) => {
  if (!(e.target as HTMLElement).closest('[data-flyout]')) return;
  e.stopImmediatePropagation();
  if (snapsFlyout) return closeSnapsFlyout();
  snapsFlyout = document.createElement('div');
  snapsFlyout.className = 'tool-flyout snaps-flyout';
  snapsBtn.after(snapsFlyout);
  snapsFlyout.style.top = `${snapsBtn.offsetTop}px`;
  renderSnapsFlyout();
  snapsFlyout.addEventListener('click', (ev) => {
    if (!(ev.target as HTMLElement).closest('[data-snap-all]')) return;
    overpassLayer.snapKindsOff.clear();
    try { localStorage.removeItem('snaps-off'); } catch { /* нет хранилища */ }
    renderSnapsFlyout();
    if (lastPointer) updateSnap(lastPointer);
  });
  snapsFlyout.addEventListener('change', (ev) => {
    const el = ev.target as HTMLInputElement;
    const k = el.dataset.snapKind as SnapKind | undefined;
    if (!k) return;
    if (el.checked) overpassLayer.snapKindsOff.delete(k); else overpassLayer.snapKindsOff.add(k);
    try { localStorage.setItem('snaps-off', JSON.stringify([...overpassLayer.snapKindsOff])); } catch { /* нет хранилища */ }
    renderSnapsFlyout();
    if (lastPointer) updateSnap(lastPointer);
  });
}, true);
document.addEventListener('pointerdown', (e) => { if (snapsFlyout && !(e.target as HTMLElement).closest('.snaps-flyout, [data-snaps]')) closeSnapsFlyout(); });

function toggleGrid() {
  const on = !overpassLayer.gridVisible;
  overpassLayer.setGridVisible(on);
  try { localStorage.setItem('grid', on ? '1' : '0'); } catch { /* без хранилища — только на сеанс */ }
  setStatus(on ? 'Сетка 10 м включена (G).' : 'Сетка выключена (G) — привязки к ней тоже.');
  if (lastPointer) updateSnap(lastPointer);
}
try { if (localStorage.getItem('grid') === '0') overpassLayer.setGridVisible(false); } catch { /* нет хранилища */ }

function toggleSnaps() {
  overpassLayer.snapsEnabled = !overpassLayer.snapsEnabled;
  snapsBtn.classList.toggle('active', overpassLayer.snapsEnabled);
  snapsBtn.title = overpassLayer.snapsEnabled ? 'Привязки включены (S)' : 'Привязки выключены (S)';
  renderSnapsFlyout();
  setStatus(overpassLayer.snapsEnabled ? 'Привязки включены (S).' : 'Привязки выключены (S) — инструменты двигают свободно.');
  // Обновить маркер и текущее движение инструмента под курсором
  if (lastPointer) updateSnap(lastPointer);
}

/** Действие над выделенными частями (меню и шорткаты): hide, show, show-all, isolate, exclude, exit. */
function focusAction(action: string) {
  if (!focus) return;
  const keys = selection.filter(inFocus);
  if (action === 'exclude') { if (keys.length) excludeFromGroup(); return; }
  if (action === 'delete') { if (keys.length) deleteSelected(); return; }
  if (action === 'exit') return closeFocus();
  if (action === 'snaps') return toggleSnaps();
  // Изолировать — скрыть все части, кроме выделенных (выделенные при этом показать)
  if (action === 'isolate') {
    if (keys.length) changeFocusHidden(new Set(focus.members.filter((k) => !keys.includes(k))));
    return;
  }
  const next = new Set(action === 'show-all' ? [] : focusHidden);
  if (action !== 'show-all') for (const k of keys) if (action === 'hide') next.add(k); else next.delete(k);
  changeFocusHidden(next);
}

/** Скрытие/показ частей шагом общей истории: Cmd+Z / Cmd+Shift+Z отменяют и повторяют его вместе с правками. */
function changeFocusHidden(next: Set<string>) {
  const prev = new Set(focusHidden);
  if (prev.size === next.size && [...next].every((k) => prev.has(k))) return;
  applyFocusHidden(next);
  session.pushView({ undo: () => applyFocusHidden(prev), redo: () => applyFocusHidden(next) });
}

function applyFocusHidden(keys: Set<string>) {
  if (!focus) return;
  const hiding = [...keys].some((k) => !focusHidden.has(k));
  focusHidden.clear();
  for (const k of keys) focusHidden.add(k);
  if (hiding) outlinerUnhover();
  overpassLayer.setFocusHidden(focusHidden);
  renderOutliner();
}
document.addEventListener('pointerdown', (e) => { if (!ctxMenu.contains(e.target as Node)) closeCtxMenu(); }, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !ctxMenu.hidden) { closeCtxMenu(); e.stopPropagation(); } }, true);
window.addEventListener('blur', closeCtxMenu);

// Наведение на строку — подсветка части в сцене (как у списка выделенного); скрытые не подсвечиваем
// Объём — бледно-голубым, как выделение, плюс пунктир закрытых рёбер
outlinerEl.addEventListener('mouseover', (e) => {
  const li = (e.target as HTMLElement).closest<HTMLElement>('li[data-key]');
  const key = li?.dataset.key;
  if (key && !focusHidden.has(key)) {
    overpassLayer.setHover(key);
  } else outlinerUnhover();
});
outlinerEl.addEventListener('mouseleave', outlinerUnhover);
function outlinerUnhover() {
  overpassLayer.setHover(undefined);
}

/** Почему объект нельзя добавить в группу (undefined — можно). */
function addReason(key: string): string | undefined {
  const f = entity(key);
  if (!f || !('polygons' in f)) return 'это не здание и не часть';
  if (!f.tags['building:part'] || f.tags['building:part'] === 'no') return 'нет тега building:part';
  const g = groupOf(key);
  if (g) return g.key === addingTo?.key ? 'уже в этом здании' : `уже входит в ${g.key}`;
}

let addMessage = '';

function toggleAddPending(key: string) {
  const reason = addPending.includes(key) ? undefined : addReason(key);
  addMessage = reason ? `${key}: ${reason}.` : '';
  if (!reason) addPending = addPending.includes(key) ? addPending.filter((k) => k !== key) : [...addPending, key];
  paintSelection();
  renderSelected();
}

function startAdding() {
  const g = selectedKey ? editGroups.get(selectedKey) : undefined;
  if (!g) return;
  addingTo = g;
  addPending = [];
  addMessage = '';
  renderSelected();
}

function stopAdding() {
  addingTo = undefined;
  addPending = [];
  addMessage = '';
  paintSelection();
  renderSelected();
}

function confirmAdding() {
  const g = addingTo ? editGroups.get(addingTo.key) : undefined;
  if (!g || !addPending.length) return;
  const extra = addPending.map((k) => {
    const [type, ref] = k.split('/');
    return { type: type as 'way' | 'relation', ref: Number(ref), role: 'part' };
  });
  addingTo = undefined;
  addPending = [];
  session.setMembers(g.key, [...g.relMembers, ...extra]);
  select(g.key);
}

function renderAdding() {
  const g = addingTo!;
  const list = addPending.map((k) => `<li>${esc(k)}</li>`).join('');
  infoEl.innerHTML = `
    <h2>Добавить части в <a href="${server().web}/${g.key}" target="_blank" rel="noopener">${g.key}</a></h2>
    <p class="hint">Shift+клик по частям — отметить или снять. Обычный клик — отмена.</p>
    ${list ? `<ul class="change-list">${list}</ul>` : '<p class="hint">Пока ничего не отмечено.</p>'}
    ${addMessage ? `<p class="warn">⚠ ${esc(addMessage)}</p>` : ''}
    <p><button type="button" data-add-confirm ${addPending.length ? '' : 'disabled'}>Добавить (${addPending.length})</button>
       <button type="button" data-add-cancel>Отмена</button></p>`;
}

/** candidates — кандидаты в контур, если их несколько (для выбора в панели). */
type MergePlan = { members: { key: string; role: 'outline' | 'part' }[]; candidates?: Feature3D[] } | { reason: string; candidates?: Feature3D[] };

/** Контур, выбранный вручную, когда кандидатов несколько. */
let chosenOutline: string | undefined;

/** Можно ли объединить выделенное в здание type=building: один контур (выделенный или скрытый под частями) и части. */
function mergePlan(keys: string[]): MergePlan {
  if (keys.some((k) => editGroups.has(k))) return { reason: 'В выделении есть здание type=building — объединять можно только отдельные объекты.' };
  if (keys.some((k) => groupOf(k))) return { reason: 'Часть объектов уже входит в здание type=building.' };
  const feats = keys.map(entity).filter((f): f is Feature3D => !!f && 'polygons' in f);
  // Контур — всё с тегом building, даже если на нём же стоит building:part (так часто размечают)
  const isBuilding = (f: Feature3D) => !!f.tags.building && f.tags.building !== 'no';
  const outlines = new Set(feats.filter(isBuilding));
  const parts = feats.filter((f) => f.kind === 'part' && !(outlines.has(f) && f.kind !== 'part'));
  if (!parts.length) return { reason: 'Выделите части здания (building:part).' };
  // Контур под частями часто не выделить: закрыт ими (не рисуется) или нулевой высоты — ищем его сами,
  // если явно не выделен. Годится любое здание (тег building), внутри которого лежат центры частей.
  if (!outlines.size) {
    const centres = parts.flatMap((p) => p.polygons.map(pointOnSurface));
    const partKeys = new Set(parts.map((p) => p.key));
    // Рамка центров — чтобы не проверять точки сотен частей в каждом здании тайлов
    let w = Infinity, so = Infinity, e = -Infinity, n = -Infinity;
    for (const [x, y] of centres) { w = Math.min(w, x); e = Math.max(e, x); so = Math.min(so, y); n = Math.max(n, y); }
    for (const f of overpass.allFeatures()) {
      if (partKeys.has(f.key) || !isBuilding(f)) continue;
      if (!f.polygons.some((p) => p.outer.some(([x]) => x >= w) && p.outer.some(([x]) => x <= e) && p.outer.some(([, y]) => y >= so) && p.outer.some(([, y]) => y <= n))) continue;
      const inside = (c: LonLat) => f.polygons.some((p) => pointInRing(c, p.outer) && !p.inners.some((h) => pointInRing(c, h)));
      if (centres.some(inside)) outlines.add(f);
    }
  }
  if (!outlines.size) return { reason: 'Не найден контур здания (building) вокруг частей — выделите его тоже.' };
  const candidates = [...outlines];
  // Выбор контура: вручную → единственный «чистый» building (без building:part) → единственный кандидат
  const pure = candidates.filter((f) => f.kind !== 'part');
  const outline = candidates.find((f) => f.key === chosenOutline) ?? (pure.length === 1 ? pure[0] : candidates.length === 1 ? candidates[0] : undefined);
  if (!outline) return { reason: `Найдено контуров: ${candidates.length} — выберите, какой из них контур здания.`, candidates };
  // Прочие «чистые» здания частями быть не могут
  const extra = pure.filter((f) => f !== outline);
  if (extra.length) return { reason: `${extra.map((f) => f.key).join(', ')} — здание без building:part: уберите из выделения или выберите контуром.`, candidates };
  if (groupOf(outline.key)) return { reason: `Контур ${outline.key} уже входит в здание type=building.` };
  // Контур с building:part одновременно и часть — входит в отношение в обеих ролях
  const outlineAsPart = outline.kind === 'part' ? [{ key: outline.key, role: 'part' as const }] : [];
  const rest = parts.filter((p) => p !== outline);
  return {
    members: [{ key: outline.key, role: 'outline' }, ...outlineAsPart, ...rest.map((p) => ({ key: p.key, role: 'part' as const }))],
    candidates: candidates.length > 1 ? candidates : undefined,
  };
}

function mergeIntoBuilding() {
  const plan = mergePlan(selection);
  if ('reason' in plan) return;
  const id = nextNewId--;
  const key = `relation/${id}`;
  const group: EditGroup = {
    key, type: 'relation', id, version: 0, tags: { type: 'building' },
    members: plan.members.map((m) => m.key), roles: plan.members.map((m) => m.role),
    relMembers: plan.members.map((m) => {
      const [type, ref] = m.key.split('/');
      return { type: type as 'way' | 'relation', ref: Number(ref), role: m.role };
    }),
  };
  editGroups.set(key, group);
  session.create(group);
  leaveDrill();
  select(key);
}

/** Кнопка исключения выделенных частей из группы, в которую «провалились». */
function excludeButton(): string {
  if (!drill || !selection.length || !selection.every((k) => drill!.members.includes(k))) return '';
  return `<p><button type="button" data-exclude>Исключить из этого здания${selection.length > 1 ? ` (${selection.length})` : ''}</button></p>`;
}

function excludeFromGroup() {
  const g = drill ? editGroups.get(drill.key) : undefined;
  if (!g) return;
  const drop = new Set(selection);
  const members = g.relMembers.filter((m) => !drop.has(`${m.type}/${m.ref}`));
  session.setMembers(g.key, members);
  if (focus) select(undefined); // в режиме здания остаёмся, состав обновит onSessionChange
  else select(g.key); // выходим на уровень группы
}

/** Выбор контура, когда кандидатов несколько (наведение подсвечивает кандидата на карте). */
function outlineChooser(plan: MergePlan): string {
  const cands = plan.candidates;
  if (!cands || cands.length < 2) return '';
  const current = 'members' in plan ? plan.members[0].key : chosenOutline;
  outlineOverlay = current;
  const list = cands.map((f) => `<label class="outline-cand" data-outline-cand="${esc(f.key)}"><input type="radio" name="outline" value="${
    esc(f.key)}" ${f.key === current ? 'checked' : ''} /><span>${esc(f.key)} — building=${esc(f.tags.building)}${
    f.tags['building:part'] ? `, building:part=${esc(f.tags['building:part'])}` : ''}${f.tags.name ? ` «${esc(f.tags.name)}»` : ''}</span></label>`).join('');
  return `<fieldset class="outline-choice"><legend>Контур здания</legend>${list}</fieldset>`;
}

infoEl.addEventListener('change', (e) => {
  const t = e.target as HTMLInputElement;
  if (t.name !== 'outline') return;
  chosenOutline = t.value;
  renderSelected();
});
/** Выбранный контур подсвечивается поверх частей (плоский контур под ними иначе не видно). */
let outlineOverlay: string | undefined;
infoEl.addEventListener('mouseover', (e) => {
  const el = e.target as HTMLElement;
  const key = el.closest<HTMLElement>('[data-outline-cand]')?.dataset.outlineCand;
  if (key) return overpassLayer.setOverlay(key);
  // Строка списка выделенного: подсветить объект (группу — всеми членами) поверх остальных
  const item = el.closest<HTMLElement>('[data-hover-key]')?.dataset.hoverKey;
  if (item) overpassLayer.setOverlay(highlightKeys(item));
});
infoEl.addEventListener('mouseout', (e) => {
  if ((e.target as HTMLElement).closest('[data-outline-cand], [data-hover-key]')) overpassLayer.setOverlay(outlineOverlay);
});

function renderMulti() {
  const plan = mergePlan(selection);
  const list = selection.map((k) => `<li data-hover-key="${esc(k)}"><a href="#" data-select="${esc(k)}">${esc(k)}</a>${
    editGroups.has(k) ? ' (type=building)' : ''}</li>`).join('');
  infoEl.innerHTML = `
    <h2>Выделено: ${selection.length}</h2>
    <ul class="change-list">${list}</ul>
    ${renderMultiTagForm(selection.filter((k) => session.get(k)?.tags.type !== 'building'), session)}
    ${drill ? excludeButton() : `<p><button type="button" data-merge ${'reason' in plan ? 'disabled' : ''}>Объединить в здание</button></p>`}
    ${drill ? '' : 'reason' in plan ? `<p class="hint">${esc(plan.reason)}</p>` : `<p class="hint">Будет создано отношение type=building: контур ${
      esc(plan.members[0].key)} и частей ${plan.members.filter((m) => m.role === 'part').length}.</p>`}
    ${drill ? '' : outlineChooser(plan)}
    <p class="hint">Shift+клик — добавить или убрать объект.</p>`;
}

function renderSelected() {
  outlineOverlay = undefined;
  try {
    renderSelectedImpl();
  } finally { overpassLayer.setOverlay(outlineOverlay); }
}

function renderSelectedImpl() {
  if (addingTo) return renderAdding();
  if (selection.length > 1) return renderMulti();
  const form = selectedKey ? renderTagForm(selectedKey, session, inheritSources(selectedKey)) : undefined;
  const g = selectedKey ? editGroups.get(selectedKey) : undefined;
  // Отношение type=building — только контейнер: высоты, крыша и прочее живут на контуре и частях
  if (g) { infoEl.innerHTML = describeGroup(g); return; }
  // Новые объекты (нарисованные, отрезанные) в режиме здания ещё не нарисованы в тайлах карты — берём из сессии
  const own = selectedKey && !overpass.get(selectedKey) ? session.get(selectedKey) as Feature3D | undefined : undefined;
  const r = selectedKey ? overpass.get(selectedKey) ?? (own?.polygons ? { feature: own, roofApproximated: false } : undefined) : undefined;
  if (!r && focus && !selection.length) { infoEl.innerHTML = describeFocus(focus); return; }
  // В режиме здания подсказка о группе не нужна (выход — Esc и панель частей); «Исключить» — под свойствами
  infoEl.innerHTML = r ? (focus ? '' : drillHint(r.feature.key)) + describeOsm(r, form) + excludeButton() : '';
}

// Рендер: часть без своих цветов/формы крыши/материалов берёт их у контура, затем у отношения
setInheritance((f) => {
  const g = groupOf(f.key);
  if (!g || g.key === f.key) return;
  const outline = g.members.find((_, i) => g.roles[i] === 'outline');
  if (outline === f.key) return;
  const t = outlineTags(g);
  return inheritedTags(f.tags, t ? [t, g.tags] : [g.tags]);
});

/** Откуда часть наследует теги в форме: контур здания, затем само отношение. Контур сам ни от кого не наследует. */
function inheritSources(key: string): InheritSource[] {
  const g = groupOf(key);
  if (!g || g.key === key) return [];
  const outline = g.members.find((_, i) => g.roles[i] === 'outline');
  if (outline === key) return [];
  const out: InheritSource[] = [];
  const t = outlineTags(g);
  if (t) out.push({ label: `контура ${outline}`, tags: t });
  out.push({ label: `отношения ${g.key}`, tags: g.tags });
  return out;
}

/** Панель режима одного здания, пока ничего не выделено. */
function describeFocus(g: BuildingGroup): string {
  const name = g.tags.name ?? outlineTags(g)?.name;
  return `
    <h2>Режим здания</h2>
    ${name ? `<h2 class="group-name">${esc(name)}</h2>` : ''}
    <p class="hint"><a href="${server().web}/${g.key}" target="_blank" rel="noopener">${g.key}</a>, членов: ${g.members.length}.
      Клик по части — выделить её, Shift — несколько. Двойной клик мимо здания — выход.</p>
    ${outlineWarning(g)}
    ${focusExitButton('Esc')}`;
}

function focusExitButton(keys = 'Esc ×2'): string {
  return `<p><button type="button" data-focus-exit>Выйти из режима здания</button> <span class="hint">(${keys})</span></p>`;
}

/** Подсказка над частью, выделенной внутри группы. */
function drillHint(key: string): string {
  if (!drill || !drill.members.includes(key)) return '';
  const name = drill.tags.name ?? outlineTags(drill)?.name;
  return `<p class="hint drill">Внутри группы <a href="${server().web}/${drill.key}" target="_blank" rel="noopener">${drill.key}</a>${
    name ? ` «${esc(name)}»` : ''} — ${focus ? 'Esc снимет выделение, повторный Esc — выход из режима здания' : 'клик вне группы вернёт к ней'}.</p>${focus ? outlineWarning(drill) : ''}`;
}

/** Теги контура группы (роль outline) — название и адрес здания обычно на нём. */
function outlineTags(g: BuildingGroup): Record<string, string> | undefined {
  const key = g.members.find((_, i) => g.roles[i] === 'outline');
  if (!key) return;
  return (session.get(key) ?? overpass.findFeature(key))?.tags;
}

function describeGroup(g: BuildingGroup): string {
  const t = outlineTags(g);
  const name = g.tags.name ?? t?.name;
  const addr = t && [t['addr:street'], t['addr:housenumber']].filter(Boolean).join(', ');
  return `
    ${name ? `<h2 class="group-name">${esc(name)}</h2>` : ''}
    ${addr ? `<p class="hint">${esc(addr)}</p>` : ''}
    <h2>type=building — <a href="${server().web}/${g.key}" target="_blank" rel="noopener">${g.key}</a>${g.version ? ` v${g.version}` : ''}</h2>
    <p class="hint">Членов: ${g.members.length}. Двойной клик по зданию — режим одного здания.
      Отношение — контейнер: теги здания (высота, крыша, адрес) ставятся на контур и части.</p>
    <p><button type="button" data-add-parts>Добавить части</button></p>
    ${tagTable(g.tags)}`;
}

/** После правки тегов: пересобрать меши, обновить панель и список изменений. */
function onSessionChange(keys: string[]) {
  // Созданные группы могли появиться или исчезнуть, у групп — смениться состав (undo/redo)
  if (keys.some((k) => editGroups.has(k))) {
    for (const k of keys) {
      const g = editGroups.get(k);
      if (!g) continue;
      const rel = g.relMembers.filter((m) => m.type !== 'node');
      g.members = rel.map((m) => `${m.type}/${m.ref}`);
      g.roles = rel.map((m) => m.role);
    }
    rebuildGroupIndex();
    paintSelection();
  }
  // Правка контура или отношения меняет унаследованное частями — перерисовать и их
  const affected = new Set(keys);
  for (const k of keys) {
    const g = editGroups.get(k) ?? groupOf(k);
    const outline = g?.members.find((_, i) => g.roles[i] === 'outline');
    if (g && (g.key === k || outline === k)) for (const m of g.members) affected.add(m);
  }
  // В режиме здания тайлы карты не видны — пересоберём их разом при выходе
  if (focus) { tilesStale = true; for (const k of affected) staleKeys.add(k); } else overpass.refreshFeatures([...affected]);
  // Сцену режима здания обновляем напрямую: refreshFeatures доходит до неё только через тайлы, где объект
  // нарисован, а части здания могут лежать в тайле, который сейчас не показан (тогда правка «не применялась»)
  if (focus && !keys.includes(focus.key)) {
    for (const k of affected) {
      const f = focus.members.includes(k) ? session.get(k) as Feature3D | undefined : undefined;
      if (f?.polygons) overpassLayer.previewFocusFeature(f);
    }
  }
  // Созданный путь (рассечение) появился или исчез (отмена) — тайлы перерисовать. Это полная пересборка всех
  // видимых тайлов (сотни мс), а в режиме здания карта скрыта — откладываем до выхода из него
  // Удаление и его отмена — тоже: объект пропадает из тайла или возвращается
  const deletedFlip = keys.some((k) => session.isDeleted(k) !== deletedKeys.has(k));
  for (const k of keys) if (session.isDeleted(k)) deletedKeys.add(k); else deletedKeys.delete(k);
  if (keys.some((k) => k.startsWith('way/-')) || deletedFlip) {
    if (!focus) overpass.rerenderFeatures(affected);
  }
  // Состав здания в режиме одного здания поменялся (исключение, undo/redo) — пересобрать сцену
  if (focus && keys.includes(focus.key)) {
    const g = groupOf(focus.key);
    // Отменили создание отношения из отдельного здания — назад к нему одному
    const outline = focus.members.find((_, i) => focus!.roles[i] === 'outline');
    const back = !g && focus.id < 0 && outline ? soloGroup(outline) : undefined;
    if (g || back) { drill = focus = (g ?? back)!; overpassLayer.setFocus(groupFeatures(focus), bareOutlines(focus)); overpassLayer.setFocusHidden(focusHidden); } else closeFocus();
  } else if (isSolo(focus)) {
    // Повтор рассечения: отдельное здание снова в отношении
    const g = groupOf(focus!.members[0]);
    if (g) enterFocus(g);
    else {
      // Отменили вставку копий рядом с отдельным зданием — убрать их из сцены
      const gone = focus!.members.slice(1).filter((k) => keys.includes(k) && !session.get(k));
      if (gone.length) {
        drill = focus = { ...focus!, members: focus!.members.filter((k) => !gone.includes(k)), roles: focus!.roles.filter((_, i) => !gone.includes(focus!.members[i])) };
        overpassLayer.setFocus(groupFeatures(focus), bareOutlines(focus));
        overpassLayer.setFocusHidden(focusHidden);
      }
    }
  }
  if ((selectedKey && keys.includes(selectedKey)) || (selection.length > 1 && selection.some((k) => keys.includes(k)))) {
    const active = document.activeElement as HTMLElement | null;
    const focusTag = active?.closest('.tag-form') ? active.dataset.tag : undefined;
    renderSelected();
    // Возвращаем фокус в то же поле (Tab уже мог увести его дальше — тогда в следующее)
    if (focusTag) infoEl.querySelector<HTMLElement>(`[data-tag="${CSS.escape(focusTag)}"]`)?.focus();
  }
  renderChanges();
  renderOutliner();
}

const editsHistory = document.getElementById('edits-history')!;
const undoBtn = editsHistory.querySelector<HTMLButtonElement>('[data-undo]')!;
const redoBtn = editsHistory.querySelector<HTMLButtonElement>('[data-redo]')!;
/** Отношение type=building — несколько кубиков. */
const ICON_GROUP = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M5 1.8l3.5 2v4L5 9.8l-3.5-2v-4z"/><path d="M11 6.2l3.5 2v4L11 14.2l-3.5-2v-4z"/></svg>';
const ICON_REVERT = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16.5 14.5C15.5 9.5 12.5 7 8.5 7.5c-1.6.2-3 .9-4.2 2"/><path d="M3.5 5.5v4.5H8"/></svg>';

function renderChanges() {
  renderAccount();
  // Пути-члены мультиполигонов (разрезание при правке контуров) — служебные: отправляются, но в списке не видны
  const changes = session.changes().filter((c) => !c.feature.line);
  // Раздел появляется после первой правки; остаётся, пока есть что отменить или повторить.
  // Шаги скрытия частей — тоже в истории, но панель ради них не раскрываем
  const show = changes.length > 0 || session.hasDataHistory();
  changesEl.hidden = !show;
  editsHistory.hidden = !session.canUndo() && !session.canRedo();
  undoBtn.disabled = !session.canUndo();
  redoBtn.disabled = !session.canRedo();
  editsCount.textContent = changes.length ? `(${changes.length})` : osmUser ? '' : '· не выполнен вход';
  // Появились правки — раскрываем панель, исчезли — сворачиваем; в остальное время решает пользователь
  if (show !== editsHadContent) setCollapsed(editsPanel, !show);
  editsHadContent = show;
  if (!show) { changesEl.innerHTML = ''; return; }
  const list = changes.map((c) => {
    const group = editGroups.has(c.key);
    const icon = group ? ICON_GROUP : (c.feature as Feature3D).kind === 'part' ? ICON_PART : ICON_OUTLINE;
    const name = c.after.name ?? c.before.name;
    const diff = c.diff.map((d) => d.tag === '(члены)' ? membersDiff(c)
      : d.tag.startsWith('(')
      ? `<div>${esc(d.tag.slice(1, -1))}: ${esc(d.to ?? '')}</div>`
      : `<div><span class="ch-tag">${esc(d.tag)}</span> ${d.from === undefined ? '' : `<del>${esc(d.from)}</del> → `}${d.to === undefined ? '<del>удалён</del>' : `<ins>${esc(d.to)}</ins>`}</div>`).join('');
    // Создание и удаление отменяются через undo (там же — состав отношения)
    const revert = c.created || c.deleted ? '' : `<button type="button" class="icon-btn ch-revert" data-revert-key="${esc(c.key)}" title="Вернуть как было">${ICON_REVERT}</button>`;
    return `<li data-key="${esc(c.key)}" class="${selection.includes(c.key) ? 'selected' : ''}" title="${esc(c.key)}">
      <span class="ch-icon">${icon}</span>
      <span class="ch-title">${name ? esc(name) : ''}<span class="ch-key">${esc(c.key)}</span>${c.created ? '<span class="ch-new">новый</span>' : ''}</span>
      ${revert}
      <div class="ch-diff">${diff}</div></li>`;
  }).join('');
  changesEl.innerHTML = `
    ${changes.length ? `<ul class="change-list">${list}</ul>` : '<p class="hint">Изменений нет — можно повторить отменённое.</p>'}
    ${renderUpload(changes.length)}`;
}

/** Состав отношения: было → стало и сколько членов добавлено/убрано. */
function membersDiff(c: TagChange): string {
  const before = c.membersBefore ?? [], after = c.members ?? [];
  const id = (m: { type: string; ref: number }) => `${m.type}/${m.ref}`;
  const was = new Set(before.map(id)), now = new Set(after.map(id));
  const added = after.filter((m) => !was.has(id(m))).length, removed = before.filter((m) => !now.has(id(m))).length;
  const delta = [added && `+${added}`, removed && `−${removed}`].filter(Boolean).join(', ');
  return `<div><span class="ch-tag">члены</span> <del>${before.length}</del> → <ins>${after.length}</ins>${delta ? ` (${delta})` : ''}</div>`;
}

function renderAccount() {
  const s = server();
  accountEl.innerHTML = osmUser
    ? `<a href="${s.web}/user/${encodeURIComponent(osmUser.name)}" target="_blank" rel="noopener">${esc(osmUser.name)}</a> ·
       <button type="button" class="link-btn" data-logout ${uploading ? 'disabled' : ''}>выйти</button>`
    : `<button type="button" class="login-btn" data-login ${uploading ? 'disabled' : ''}>Войти в OSM</button>`;
}

/** Предложенный комментарий: показывается серым в пустом поле, Tab вставляет его для правки. */
let suggestedComment = '';
/** Предложение, вставленное по Tab и ещё не правленное, — устаревает вместе с правками. */
let insertedSuggestion: string | undefined;

function commentSuggestion(): string {
  const groupKey = (key: string) => editGroups.get(key)?.key ?? groupOf(key)?.key;
  return suggestComment(session.changes().filter((c) => !c.feature.line), {
    groupOf: (key) => { const g = groupKey(key); return g && g !== key ? g : undefined; },
    isGroup: (key) => editGroups.has(key),
    buildingName: (key) => {
      const g = editGroups.get(key) ?? groupOf(key);
      return g ? g.tags.name ?? outlineTags(g)?.name : undefined;
    },
  });
}

function renderUpload(count: number): string {
  if (!count) {
    if (insertedSuggestion !== undefined && uploadComment === insertedSuggestion) uploadComment = '';
    insertedSuggestion = undefined;
    return '';
  }
  const s = server();
  const canUpload = osmUser && uploadComment.trim() && !uploading;
  suggestedComment = commentSuggestion();
  // Правки изменились (отмена, другое здание) — вставленный без изменений текст больше не подходит:
  // убираем его, новое предложение снова показывается серым и требует подтверждения
  if (insertedSuggestion !== undefined && uploadComment === insertedSuggestion && uploadComment !== suggestedComment) {
    uploadComment = '';
    insertedSuggestion = undefined;
  }
  const rows = Math.min(8, Math.max(1, (uploadComment || suggestedComment).split('\n').length));
  return `
    <div class="upload">
      <label class="upload-label" for="upload-comment">Комментарий к пакету правок</label>
      <textarea id="upload-comment" data-comment rows="${rows}" placeholder="${esc(suggestedComment)}" ${uploading ? 'disabled' : ''}>${esc(uploadComment)}</textarea>
      <button type="button" class="upload-btn" data-upload ${canUpload ? '' : 'disabled'}>${uploading ? 'Отправка…' : `Сохранить в OSM (${count})`}</button>
      <div class="upload-meta"><span>${osmUser ? commentHint() : 'для отправки войдите в OSM'}</span>
        <span class="server-tag${s.id === 'prod' ? ' prod' : ''}" title="${esc(s.label)}">${s.id === 'prod' ? 'боевой сервер' : 'тестовый сервер'}</span></div>
    </div>`;
}

async function doLogin() {
  try {
    await login();
    osmUser = await fetchUser();
    setStatus(osmUser ? `Вход выполнен: ${osmUser.name}.` : 'Не удалось получить данные пользователя.', !osmUser);
  } catch (err) {
    setStatus((err as Error).message, true);
  }
  renderChanges();
}

async function refreshUser() {
  osmUser = undefined;
  if (getToken()) {
    try { osmUser = await fetchUser(); } catch (err) { console.warn('OSM user:', err); }
  }
  renderChanges();
}

async function doUpload() {
  if (uploading) return;
  const changes = session.changes();
  const s = server();
  uploading = true;
  renderChanges();
  try {
    const edits = changes.map((c) => {
      const g = editGroups.get(c.key);
      const created = !c.created ? undefined
        : g ? { type: 'relation' as const, id: g.id, version: 0, tags: c.after, members: g.relMembers }
        : { type: 'way' as const, id: Number(c.key.split('/')[1]), version: 0, tags: c.after, nodes: c.wayNodes?.after ?? [] };
      return { key: c.key, before: c.before, after: c.after, created, members: c.members, membersBefore: c.membersBefore,
        nodeMoves: c.nodeMoves, wayNodes: c.wayNodes, newNodes: c.newNodes, deleted: c.deleted, version: c.feature.version, polygons: c.feature.polygons,
        splitFrom: c.feature.splitFrom };
    });
    const res = await uploadEdits(edits, uploadComment.trim(), (t) => setStatus(t));
    // Временные id узлов и путей → настоящие: в геометрии, членах отношений и в отправленных полигонах
    const nodeIdMap = new Map<number, number>(), wayIdMap = new Map<number, number>();
    for (const [from, to] of res.newKeys) {
      const [type, a] = from.split('/'), b = Number(to.split('/')[1]);
      if (type === 'node') nodeIdMap.set(Number(a), b);
      if (type === 'way') wayIdMap.set(Number(a), b);
    }
    session.remapIds(nodeIdMap, wayIdMap);
    for (const g of editGroups.values()) {
      const rel = g.relMembers.filter((m) => m.type !== 'node');
      g.members = rel.map((m) => `${m.type}/${m.ref}`);
      g.roles = rel.map((m) => m.role);
    }
    for (const e of edits) if (session.has(e.key)) e.polygons = (session.get(e.key) as Feature3D | undefined)?.polygons ?? e.polygons;
    const saved = new Map<string, { version: number; tags: Record<string, string>; newKey?: string; polygons?: Polygon[] }>();
    for (const e of edits) {
      // Сдвинуты только узлы — путь не отправлялся, версия прежняя
      const version = res.versions.get(e.key) ?? (res.geometrySaved.has(e.key) ? e.version : undefined);
      if (version === undefined) continue;
      const tags = res.written.get(e.key) ?? e.after;
      const newKey = res.newKeys.get(e.key);
      if (newKey) {
        // Созданное отношение получило настоящий id
        const g = editGroups.get(e.key);
        if (g) { editGroups.delete(e.key); g.id = Number(newKey.split('/')[1]); editGroups.set(newKey, g); }
        selection = selection.map((k) => (k === e.key ? newKey : k));
        if (selectedKey === e.key) selectedKey = newKey;
      }
      saved.set(e.key, { version, tags, newKey, polygons: e.polygons });
    }
    session.markSaved(saved, [...res.deleted, ...res.dropped]);
    // Созданные пути получили настоящие id — им место в данных тайлов
    const createdWays: Feature3D[] = [];
    for (const [k, v] of saved) {
      if (!v.newKey?.startsWith('way/')) continue;
      const f = session.get(v.newKey) as Feature3D | undefined;
      if (f?.polygons) { f.id = Number(v.newKey.split('/')[1]); createdWays.push(f); }
      void k;
    }
    rebuildGroupIndex();
    // Сразу в кеш тайлов текущего источника — не ждать фонового обновления тайла
    const savedGroups = [...saved].map(([k, v]) => editGroups.get(v.newKey ?? k)).filter((g): g is EditGroup => !!g)
      .map((g) => ({ key: g.key, type: g.type, id: g.id, version: g.version, tags: { ...g.tags }, members: [...g.members], roles: [...g.roles] }));
    void overpass.applySaved(withMemberWays(new Map([...saved].map(([k, v]) => [v.newKey ?? k, v]))), savedGroups, createdWays, [...res.deleted]);
    uploadComment = '';
    const link = `<a href="${s.web}/changeset/${res.changeset}" target="_blank" rel="noopener">changeset ${res.changeset}</a>`;
    uploading = false;
    setStatus(`Сохранено: ${saved.size + res.deleted.size} объектов.` + (res.rebased.size ? ` Поверх чужих правок других тегов перенесено: ${res.rebased.size}.` : ''));
    statusEl.insertAdjacentHTML('beforeend', ` ${link}`);
  } catch (err) {
    uploading = false;
    if (err instanceof ConflictError) {
      setStatus(`${err.message}. Эти теги уже изменил кто-то другой — перезагрузите тайлы, отмените свои правки этих объектов и повторите.`, true);
    } else {
      setStatus(`Ошибка отправки: ${(err as Error).message}`, true);
    }
  } finally {
    uploading = false;
    renderChanges();
  }
}

editsHistory.addEventListener('click', (e) => {
  e.stopPropagation(); // не сворачивать панель
  const t = e.target as HTMLElement;
  if (t.closest('[data-undo]')) return void selectAfterHistory(session.undo() ?? selectedKey);
  if (t.closest('[data-redo]')) return void selectAfterHistory(session.redo() ?? selectedKey);
});

changesEl.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  if (t.closest('[data-upload]')) return void doUpload();
  const revert = t.closest<HTMLElement>('[data-revert-key]');
  if (revert) return void session.revert(revert.dataset.revertKey!);
  const row = t.closest<HTMLElement>('li[data-key]');
  if (row) select(row.dataset.key);
});
// Наведение на строку — подсветка объекта на карте
changesEl.addEventListener('mouseover', (e) => {
  const key = (e.target as HTMLElement).closest<HTMLElement>('li[data-key]')?.dataset.key;
  // Отношение — контуром всех членов по основанию; отдельный объект — как в списке частей: объём и скрытые рёбра
  const group = key && editGroups.has(key);
  overpassLayer.setHover(key && !group ? key : undefined);
  if (group) overpassLayer.setOverlay(highlightKeys(key), 'base'); else overpassLayer.setOverlay(outlineOverlay);
});
changesEl.addEventListener('mouseleave', () => { overpassLayer.setHover(undefined); overpassLayer.setOverlay(outlineOverlay); });

function commentHint(): string {
  if (uploadComment.trim()) return '';
  return suggestedComment ? 'Tab в поле — вставить предложенный' : 'нужен комментарий';
}

// Tab в пустом поле — вставить предложенный комментарий (дальше его можно править)
changesEl.addEventListener('keydown', (e) => {
  const t = e.target as HTMLTextAreaElement;
  if (e.key !== 'Tab' || e.shiftKey || !t.matches('[data-comment]') || t.value || !suggestedComment) return;
  e.preventDefault();
  t.value = insertedSuggestion = suggestedComment;
  t.rows = Math.min(8, suggestedComment.split('\n').length);
  t.dispatchEvent(new Event('input', { bubbles: true }));
});

changesEl.addEventListener('input', (e) => {
  const t = e.target as HTMLTextAreaElement;
  if (!t.matches('[data-comment]')) return;
  uploadComment = t.value;
  const btn = changesEl.querySelector<HTMLButtonElement>('[data-upload]');
  if (btn) btn.disabled = !(osmUser && session.changes().length && uploadComment.trim() && !uploading);
  const hint = changesEl.querySelector('.upload-meta span');
  if (hint && osmUser) hint.textContent = commentHint();
});

accountEl.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  if (t.closest('[data-login]')) return void doLogin();
  if (t.closest('[data-logout]')) { logout(); osmUser = undefined; renderChanges(); }
});

const serverSelect = document.getElementById('server-select') as HTMLSelectElement;
serverSelect.innerHTML = Object.values(SERVERS).map((s) => `<option value="${s.id}">${esc(s.label)}</option>`).join('');
serverSelect.value = server().id;
serverSelect.addEventListener('change', () => {
  const n = session.changes().length;
  if (n && !confirm(`Есть несохранённые изменения (${n} объектов) — при смене сервера они пропадут. Продолжить?`)) {
    serverSelect.value = server().id;
    return;
  }
  setServer(serverSelect.value as ServerId);
  // Данные — с выбранного сервера: правки прежнего к нему не относятся
  session = new EditSession([], onSessionChange);
  editGroups = new Map();
  editMemberGroup = new Map();
  clearSelection();
  if (map.getLayer(overpassLayer.id)) overpass.setSource(tileSource()); // до загрузки стиля — в обработчике load
  renderChanges();
  void refreshUser();
});

/** Источник тайлов для текущего сервера: его /map API (свой кеш; у боевого — прежняя база кеша). */
function tileSource(): TileSource {
  const s = server();
  return { api: s.api, db: s.id === 'prod' ? 'osm-simple3d' : `osm-simple3d-${s.id}` };
}
void refreshUser();

bindTagForms(infoEl, () => session);

// Скелеты для сложных крыш считаются в воркере; досчитанные — пересобираем ждавшие здания
onSkeletons(() => {
  timed('пересборка зданий со скелетами', () => {
    overpassLayer.rebuildPending();
  });
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !focus || toolActive() || popupEl.childElementCount || (e.target as HTMLElement).closest('input, select, textarea')) return;
  // Esc: сначала снять выделение части, затем выйти из режима здания
  if (selection.length) select(undefined);
  else closeFocus();
});

document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return;
  // В поле с несохранённым вводом — родной undo браузера; поле без правок (фокус вернулся после применения) — undo редактора
  const field = (e.target as HTMLElement).closest<HTMLInputElement | HTMLTextAreaElement>('input, textarea');
  if (field && field.type !== 'color' && field.value !== field.defaultValue) return;
  e.preventDefault();
  const key = e.shiftKey ? session.redo() : session.undo();
  if (key) selectAfterHistory(key);
});

/**
 * Выделить объект, затронутый undo/redo. В режиме здания — только если это его часть: отменённое создание
 * (нарисованная или отрезанная часть) или само отношение не должны выводить на карту.
 */
function selectAfterHistory(key: string | undefined) {
  // Правка нескольких выделенных объектов — выделение не трогаем
  if (key && selection.length > 1 && selection.includes(key)) { renderSelected(); return; }
  if (focus && (!key || !focus.members.includes(key))) { select(undefined); return; }
  select(key);
}

window.addEventListener('beforeunload', (e) => {
  if (session.changes().length) e.preventDefault();
});

function describeOsm({ feature: f, roofApproximated }: RenderedFeature, form?: string): string {
  const h = computeHeights(f.tags);
  const warn = [
    roofApproximated && `Форма крыши «${h.roofShape}» пока не поддерживается для этой геометрии — показаны стены до верха и плоская крыша.`,
    h.source === 'default' && 'Нет height и building:levels — высота взята по умолчанию.',
    f.tags.height && f.tags['building:levels'] && Math.abs(h.top - Number(f.tags['building:levels']) * 3) > h.top * 0.5 &&
      'height и building:levels заметно расходятся.',
  ].filter(Boolean);
  return `
    <h2>${f.kind === 'part' ? 'building:part' : 'building'} — <a href="${server().web}/${f.key}" target="_blank" rel="noopener">${f.key}</a>${f.version ? ` v${f.version}` : ''}</h2>
    <pre>высота: ${fmt(h.min)} → ${fmt(roofApproximated ? h.top : h.wallTop)} → ${fmt(h.top)} м (${h.source})\nкрыша: ${h.roofShape}, ${fmt(h.roofHeight)} м</pre>
    ${warn.map((w) => `<p class="warn">⚠ ${w}</p>`).join('')}
    ${form ? `${form}<details class="all-tags"><summary>Все теги</summary>${tagTable(f.tags)}</details>` : tagTable(f.tags)}`;
}

/** Planetiler: id = osmId * 10 + (1 — node, 2 — way, 3 — relation); 0 — фича, склеенная из нескольких зданий. */
function decodeTileId(id: unknown): string {
  if (typeof id !== 'number') return '—';
  const type = ({ 1: 'node', 2: 'way', 3: 'relation' } as Record<number, string>)[id % 10];
  return type ? osmLink(type, Math.floor(id / 10)) : 'склеенная фича (несколько зданий) — уточняем через API…';
}

function describeTile(f: MapGeoJSONFeature): string {
  const merged = f.layer.id === MERGED_LAYER;
  const id = merged ? f.properties.src : f.id;
  const hideKey = merged ? f.properties.key : f.id;
  const hideBtns = hideKey !== undefined
    ? `<p><button type="button" data-hide="${esc(hideKey)}">Скрыть${merged ? ' полигон' : ''}</button>
       ${userHidden.size ? `<button type="button" data-unhide-all>Показать все (${userHidden.size})</button>` : ''}</p>`
    : '';
  return `<h2>Здание из тайла</h2><p>feature.id: ${id ?? '—'}${merged ? ' (полигон склеенной фичи)' : ''}<br>OSM: ${decodeTileId(id)}</p>${hideBtns}
    <p id="resolved" class="hint">Ищем объекты OSM внутри фичи…</p>${tagTable(f.properties)}`;
}

let resolveSeq = 0;
/** Находит через API все здания/части, из которых состоит тайловая фича (с учётом склеенных). */
async function resolveTileFeature(f: MapGeoJSONFeature) {
  const seq = ++resolveSeq;
  const polys = polygonsOf(f.geometry);
  const xs = polys.flatMap((p) => p[0].map((c) => c[0])), ys = polys.flatMap((p) => p[0].map((c) => c[1]));
  const bbox: Bbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  const out = (html: string) => { if (seq === resolveSeq) document.getElementById('resolved')!.innerHTML = html; };
  if ((bbox[2] - bbox[0]) * (bbox[3] - bbox[1]) > MAX_API_AREA) return out('Фича слишком большая для запроса к API.');
  try {
    const { features } = parseBuildings(await fetchMap(bbox, SERVERS.prod.api)); // id тайлов — боевые
    const h = f.properties.render_height ?? Infinity, min = f.properties.render_min_height ?? 0;
    const matches = features.filter((o) => {
      if (o.hasParts) return false;
      const hh = computeHeights(o.tags);
      const pt = interiorPoint([o.polygons[0].outer, ...o.polygons[0].inners]);
      // Высоты в тайле округлены — сравниваем с запасом
      return pt && polys.some((p) => inPolygon(pt, p)) && hh.min < h + 1 && hh.top > min - 1;
    });
    out(matches.length
      ? `По данным API (${matches.length}): ${matches.slice(0, 15).map((o) => osmLink(o.type, o.id)).join(', ')}${matches.length > 15 ? ' …' : ''}`
      : 'В текущих данных OSM совпадений не найдено (тайлы могут отставать).');
  } catch (err) {
    out(`Не удалось запросить API: ${(err as Error).message}`);
  }
}

const osmLink = (type: string, id: number) => `<a href="https://www.openstreetmap.org/${type}/${id}" target="_blank" rel="noopener">${type}/${id}</a>`;
const fmt = (n: number) => String(Math.round(n * 10) / 10);
function esc(s: unknown): string { return String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`); }
const tagTable = (tags: Record<string, unknown>) =>
  `<table>${Object.entries(tags).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>`;

if (import.meta.env.DEV) Object.assign(window, { map, overpassLayer, overpass, orbit, select, enterFocus, getSession: () => session });

void openEditLink();
renderHelp();

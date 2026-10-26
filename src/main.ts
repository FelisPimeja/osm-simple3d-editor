import { escalatorAreaMatches, syncEscalatorLevels } from './edit/escalator-levels';
import polygonClipping from 'polygon-clipping';
import * as maplibregl from 'maplibre-gl';
import type { ExpressionSpecification, FillExtrusionLayerSpecification, MapGeoJSONFeature } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { IndoorPois } from './view/indoor-pois';
import { Toasts } from './view/toasts';
import { setDeprecatedTags, validateBuilding, validateDuplicates, validateOrphanParts, validateGeometry, selfIntersects, validateIndoor, validateRepeatedRooms, validateStackedEscalators, validateTags, OUTLINE_GROW_SHARE, partGround, type Issue } from './edit/validate';
import { IndoorBadges, type IndoorBadge } from './view/indoor-badges';
import { buildPlans, findVoids } from './view/indoor-voids';
import { completeRelations, fetchBuildingElements, fetchElements, fetchNodes, fetchWayRelations, fetchMap, fetchMapSplit, type Bbox, type OsmElement, type OsmMember, type OsmNode } from './osm/api';
import { materializeRoomWalls, roomTouchesWall, roomWallSpan, type RoomWall, type WallSpan } from './edit/indoor-walls';
import { allowPrefsScope, fetchUser, getToken, login, logout, type OsmUser } from './osm/auth';
import { SERVERS, SERVER_LIST, server, setServer, type ServerId } from './osm/servers';
import { applyBasemapDate, dateSpan, decimalDate, existsIn, isoDay, parseDate, shiftDate } from './osm/dates';
import { buildingRefreshMembers } from './osm/building-refresh';
import { ConflictError, uploadEdits } from './osm/upload';
import { computeHeights, LEVEL_HEIGHT, parseLength } from './osm/heights';
import { CATEGORY_COLOURS, CATEGORY_LABELS, CATEGORY_ORDER, indoorCategory, type IndoorCategory } from './osm/indoor-categories';
import { ViewCube } from './view/view-cube';
import { loadCamera, saveCamera } from './view/camera-store';
import { ImageryOffsetPanel, type OffsetSnap } from './view/imagery-offset';
import { applyBasemap, applyGpsTraces, BasemapButton, IMAGERY, storeBuildings, storedBuildings, GPS_LAYER, IMAGERY_LAYER, isBasemap, MAP_BASEMAP, storeBasemap, storedBasemap, storedGps, storeGps, WAYBACK, findImagery, getOpacity, refreshImagery, setImageryOpacity } from './view/basemaps';
import { pickRelease, setWaybackRelease, waybackReleases } from './view/wayback';
import { isPhotoFiltered, PhotoLayer, PhotoViewer, photoFilterSettings, storedFilter, storedOn, storeFilter, storeOn } from './view/street-photos';
import { panoramax } from './view/panoramax';
import { mapillary } from './view/mapillary';
import { centroid, floorLevels, incompleteIndoorRelations, isBareOutlineTags, isOutlinePart, kindOf, markOutlinesWithParts, parseBuildings, parseLevels, withIndoorTags, pointInRing, pointOnSurface, type BuildingGroup, type Feature3D, type IndoorFeature, type IndoorKind, type LonLat, type MemberWay, type Polygon } from './osm/model';
import { RotateTool } from './edit/rotate-tool';
import { ScaleTool } from './edit/scale-tool';
import { featureRings, glueMoves, levelApart, ON_SIDE_M } from './edit/glue-plan';
import { MoveTool } from './edit/move-tool';
import type { UnderlayTarget } from './edit/underlay-target';
import * as THREE from 'three';
import { inheritedTags, inheritedValue } from './osm/inherit';
import { TileBorders } from './view/tile-borders';
import { RoadsLayer } from './render/roads-layer';
import type { TreePoint } from './osm/trees';
import { isBridge, isTunnel, roadLevel, type RoadWay } from './osm/roads';
import { indoorLevelInfo, partLevels, withIndoorLevels, MAX_LEVEL_STEP, MIN_LEVEL_STEP, type Level, type LevelInfo } from './osm/levels';
import { BuildingsLayer, TOILET_DOOR_WIDTH, entrancePlace, isHiddenUnderground, setInheritance, setLevelGrid, type EntrancePlace, type GraphicsOptions, type IndoorItem, type RenderedFeature, type SnapHit, type SnapKind } from './render/buildings-layer';
import { gridKeyOfPoint, queryTileBuildings, tileFeatureIdsByTile, type TileBuildingFeature } from './tiles/tile-features';
import { OverpassTiles, type TileSource } from './view/overpass-tiles';
import { CursorOrbit } from './view/orbit';
import { PushTool, type PushTarget } from './edit/push-tool';
import { pushHeightTags, lockedPushUnits, isFreshFlat, roofHeightTags, levelsNote, heightSplitTags } from './edit/push-height';
import { SplitTool, type CutPoint, type SideRange } from './edit/split-tool';
import { insertInLine, insertInRing, restructureRing, type Insert, type RingWay } from './edit/topology';
import { MAX_DEVIATION_DEG, orthogonalize } from './edit/orthogonalize';
import type { Pt } from './render/building-geometry';
import { MeasureTool } from './edit/measure-tool';
import { OffsetTool, type OffsetTarget } from './edit/offset-tool';
import { setToolCursor, type ToolCursor } from './view/cursors';
import { ShapeTool, type ShapeTarget } from './edit/shape-tool';
import { PAINT_TAGS, PaintTool, type PaintFace, type PaintSample } from './edit/paint-tool';
import { Eyedropper, glPixels, pickFieldHint } from './edit/eyedropper';
import { openColourPopover } from './edit/colour-popover';
import { loadRecentColours, recordColour } from './edit/recent-colours';
import { CIRCLE_LABELS, CIRCLE_MODES, CIRCLE_TITLES, DrawTool, RECT_LABELS, RECT_MODES, RECT_TITLES, type CircleMode, type DrawShape, type RectMode } from './edit/draw-tool';
import { suggestComment, isIndoorChange } from './edit/changeset-comment';
import { EditSession, type ObjectEdit, type SessionSnapshot, type Tagged, type TagChange } from './edit/session';
import { Autosave, type SavedEdits } from './edit/autosave';
import { onSkeletons } from './render/skeleton';
import { timed } from './perf';
import { JOSM_URL, josmApi, josmLayer, josmMode, josmPlugin, josmStatus, josmUndo, josmUnderlayHistory, josmUnderlayStep, watchJosmUnderlays, minElementId, refreshJosmStatus, sendJosmSelection, watchJosmSelection, type JosmChange, pollJosmLayer, writeJosmParam, type JosmLayer } from './osm/josm';
import { deprecations, idFieldLabel, loadDeprecated, loadPresets, matchPreset, type PresetGeometry } from './osm/presets';
import { bindTagForms, renderValueCombo, renderMultiTagForm, renderTagForm, setDateFields, type InheritSource } from './edit/tag-form';
import { computeOutlineRemainders, inPolygon, interiorPoint, polygonsOf } from './tiles/outlines';
import { LANGS, lang, localizeDom, tr, trn, locale, type Lang } from './i18n';
import { registerSetting, saveLang, saveSetting, syncPrefs, syncStatus } from './settings';
import { LOADER_TIMING, CUBE_SHAPES, MorphLoader } from './view/morph-loader';
import { createUnderlay, deleteUnderlay, fitToBuilding, fitToView, isUnderlayFile, loadUnderlays, saveUnderlay, type Underlay } from './view/underlays';
import { UnderlayMenu } from './view/underlay-menu';

// Статичная разметка index.html — до того, как код ниже начнёт менять тексты
localizeDom(document.body);

const BUILDINGS_LAYER = 'simple3d-buildings';
const REMAINDERS_LAYER = 'simple3d-outline-remainders';
const MERGED_LAYER = 'simple3d-merged-exploded';
const MERGED_HIGHLIGHT_LAYER = 'simple3d-merged-highlight';
const TILE_LAYERS = [BUILDINGS_LAYER, REMAINDERS_LAYER, MERGED_LAYER];
/** Выбранное здание из тайлов (подсвечено). */
let highlightedTile: number | undefined;

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
/** id тайлов в кодировке OpenFreeMap (у OGF — imposm/OpenMapTiles: без склеенных фич, тип — 0/1). */
const OFM_IDS = server().tileIds !== 'openmaptiles';
const BASE_FILTER: ExpressionSpecification = OFM_IDS
  ? ['all', ['!=', ['get', 'hide_3d'], true], ['!=', ['%', ['id'], 10], 0]]
  : ['!=', ['get', 'hide_3d'], true];

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

/** tileBorders — отладка: границы тайлов данных; bridges3d, tunnels3d — объёмные мосты и тоннели (эксперимент). */
interface GraphicsSettings extends GraphicsOptions { antialias: boolean; monochrome: boolean; tileBorders: boolean; bridges3d: boolean; tunnels3d: boolean }
const GFX_KEY = 'osm3d.graphics';
const gfx: GraphicsSettings = { antialias: true, monochrome: false, hemisphere: false, groundAO: false, edges: true, partSeams: false, noGlass: false, defaultHeight: true, trees: true, seasons: false, tileBorders: false, bridges3d: false, tunnels3d: false, ...loadGraphics() };

function loadGraphics(): Partial<GraphicsSettings> {
  try {
    // orbitAtCursor — бывшая галка «Вращение вокруг точки под курсором»: теперь так всегда
    const { orbitAtCursor: _, ...saved } = JSON.parse(localStorage.getItem(GFX_KEY) ?? '{}');
    return saved;
  } catch { return {}; }
}
function saveGraphics() {
  try { localStorage.setItem(GFX_KEY, JSON.stringify(gfx)); } catch { /* приватный режим и т.п. */ }
  if (keepGraphics()) void saveSetting('graphics');
}

/**
 * «Хранить графические настройки» (окно настроек пользователя): галки графики уходят в профиль на сервере
 * (simple3d:graphics, JSON ~120 символов) и приходят оттуда на других устройствах. Выключено — только в браузере.
 */
const KEEP_GFX_KEY = 'osm3d.prefs.graphics';
function keepGraphics(): boolean {
  try { return localStorage.getItem(KEEP_GFX_KEY) === '1'; } catch { return false; }
}
function setKeepGraphics(on: boolean) {
  try { if (on) localStorage.setItem(KEEP_GFX_KEY, '1'); else localStorage.removeItem(KEEP_GFX_KEY); } catch { /* без хранилища */ }
}
registerSetting({
  key: 'graphics',
  local: () => (keepGraphics() ? JSON.stringify(gfx) : undefined),
  apply: (v) => {
    if (v === undefined) { setKeepGraphics(false); return 'same'; } // на другом устройстве выключили
    let saved: Record<string, unknown>;
    try { saved = JSON.parse(v); } catch { return 'same'; }
    setKeepGraphics(true);
    let changed = false, reload = false;
    for (const k of Object.keys(gfx) as (keyof GraphicsSettings)[]) {
      if (typeof saved[k] !== 'boolean' || saved[k] === gfx[k]) continue;
      gfx[k] = saved[k];
      changed = true;
      if (k === 'antialias') reload = true; // контекст WebGL создаётся при старте
    }
    if (!changed) return 'same';
    try { localStorage.setItem(GFX_KEY, JSON.stringify(gfx)); } catch { /* приватный режим */ }
    syncGraphicsInputs(); applyMonochrome(); applyGraphics(); // сверка идёт после загрузки модуля
    return reload ? 'reload' : 'live';
  },
});

// В сборке воркер MapLibre лежит в maplibre/ рядом со страницей (см. vite.config.ts); в dev — штатно из node_modules
if (import.meta.env.PROD) maplibregl.setWorkerUrl(new URL('maplibre/maplibre-gl-worker.mjs', document.baseURI).href);

/** Хэш карты из адреса до создания карты: в режиме здания наклон бывает больше, чем MapLibre примет вне его. */
const startHash = location.hash.slice(1).split('/').map(Number);
const startHashValid = startHash.length >= 3 && startHash.every(Number.isFinite);
const savedCamera = startHashValid ? undefined : await loadCamera();
const mapContainer = document.getElementById('map')!;
const worldZoom = Math.min(0, Math.log2(Math.min(mapContainer.clientWidth, mapContainer.clientHeight) / 512));

const map = new maplibregl.Map({
  container: 'map',
  // MSAA задаётся только при создании контекста — переключение требует перезагрузки
  canvasContextAttributes: { antialias: gfx.antialias },
  style: server().style, // подложка — своя у каждого сервера; смена сервера с другой подложкой перезагружает страницу
  transformRequest: (url) => new URL(url, location.href).host === server().noReferrerHost
    ? { url, referrerPolicy: 'no-referrer' }
    : { url },
  // Shift+клик — множественное выделение; зум рамкой с Shift перехватывал бы клик
  boxZoom: false,
  center: savedCamera?.center ?? [0, 0],
  zoom: savedCamera?.zoom ?? Math.max(-2, worldZoom),
  minZoom: -2,
  // Предел MapLibre (по умолчанию 22): к отдельным вершинам и стыкам нужно подходить ближе
  maxZoom: 24,
  pitch: savedCamera?.pitch ?? 0,
  bearing: savedCamera?.bearing ?? 0,
  hash: true,
  maxPitch: 175, // хэш из ссылки на здание (наклон до 175°) не должен отбрасываться; потом ограничит orbit
  // Без «прилипания к северу»: после сдвига или зума при азимуте в ±7° MapLibre сам плавно доворачивал камеру на север
  bearingSnap: 0,
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
// Браузер запросит доступ к местоположению при нажатии штатной кнопки MapLibre.
map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: false }));
// В режиме здания вместо компаса — кнопка куба вида (показать / скрыть), выбор запоминается
const cubeBtn = document.createElement('button');
cubeBtn.type = 'button';
cubeBtn.className = 'maplibregl-ctrl-cube';
cubeBtn.title = tr('Куб вида');
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

// Подложка: карта или спутниковые снимки (у OSM — разрешённые для обводки, у OHM — Esri Wayback по дате
// слайдера, у OGF — нет). Выбор — в localStorage (у OHM — свой) и у OSM в профиле (simple3d:basemap)
const imageryList = server().imagery ? IMAGERY : server().id === 'ohm' ? [WAYBACK] : [];
const basemapScope = server().imagery ? '' : `.${server().id}`;
let basemap = imageryList.length ? storedBasemap(basemapScope) : MAP_BASEMAP;
let gpsTraces = server().imagery ? storedGps() : false;
/** Векторная карта в здании скрыта по умолчанию; снимки и треки общие для обоих режимов. */
let focusVectorMap = false;
let mapLoaded = false;
/** Сцена режима здания (окружение скрыто). */
const focusScene = () => focusHiddenLayers.length > 0;
// Кнопка — в блоке кнопок масштаба и компаса, последней
const navGroup = document.querySelector<HTMLElement>('.maplibregl-ctrl-compass')?.parentElement;
// Слой 3D-зданий: показан ли и прозрачность — в localStorage; применяется к слою при его создании
const buildingsView = storedBuildings();
const basemapCtrl = navGroup ? new BasemapButton(navGroup, basemap, (id) => {
  pickBasemap(id);
}, gpsTraces, (on) => {
  setGpsTraces(on);
  void saveSetting('gps-traces');
}, (id) => {
  // Настройки снимка: показать его (если выбран другой) и открыть панель
  if (basemap !== id) pickBasemap(id);
  offsetPanel.show(id);
}, imageryList, !!server().imagery, { ...buildingsView }, (v) => setBuildingsView(v), (id, edit) => {
  // Поля сдвига и прозрачности в меню: инструмент сдвига закрыть (иначе он перезапишет своё), записать и показать
  offsetPanel.hide();
  edit();
  refreshImagery(map, id);
  setImageryOpacity(map, getOpacity(id));
  basemapCtrl?.sync();
}) : undefined;

// Уличные фото Panoramax и Mapillary (только OSM): слои точек снимков — группой с общим фильтром — и одно окно
// просмотра. Окно открывается кликом по снимку на карте; закрыли окно — слои остаются, выключили слой его снимка — окно закрывается
const PHOTOS_KEY = { id: 'photos' };
let photoFilter = storedFilter(PHOTOS_KEY) ?? storedFilter(panoramax) ?? { type: 'all', from: '', to: '' };
const photoViewer = new PhotoViewer(map, (service) => usedStreet.add(service.name));
const photoLayers = [
  { service: panoramax, label: 'Panoramax',
    title: tr('Открытые уличные фото и панорамы 360°, разрешённые для OSM. Клик по стрелке — открыть снимок') },
  ...(mapillary ? [{ service: mapillary, label: 'Mapillary',
    title: tr('Уличные фото и панорамы 360° Mapillary, разрешённые для OSM. Клик по стрелке — открыть снимок') }] : []),
].map(({ service, label, title }) => ({
  service, label, title, layer: new PhotoLayer(map, service), on: server().imagery ? storedOn(service) : false,
}));
type PhotoLayerState = typeof photoLayers[number];
basemapCtrl?.addOverlayGroup(tr('Фото и панорамы'), tr('Уличные фото и панорамы 360°, разрешённые для OSM'), {
  title: tr('Фильтр снимков: тип и даты съёмки'),
  filtered: () => isPhotoFiltered(photoFilter),
  el: photoFilterSettings(photoFilter, (f) => {
    photoFilter = f;
    storeFilter(PHOTOS_KEY, f);
    basemapCtrl?.sync();
    if (mapLoaded) for (const p of photoLayers) p.layer.setFilter(f);
  }),
}, photoLayers.map((p) => ({ id: p.service.id, label: p.label, title: p.title, on: p.on, onChange: (on: boolean) => setPhotos(p, on) })));
function setPhotos(p: PhotoLayerState, on: boolean) {
  p.on = on;
  storeOn(p.service, on);
  basemapCtrl?.setOverlay(p.service.id, on);
  if (!on) photoViewer.drop(p.layer);
  syncPhotos();
}

/** Слои уличных фото; в режиме здания — обрезаны областью вокруг здания, как снимки подложки. */
function syncPhotos() {
  if (!mapLoaded || !server().imagery) return;
  const bounds = focusScene() ? focusImageryBounds() : undefined;
  // Под зданиями: под объёмами стиля (первый fill-extrusion) или под слоями дорог и зданий редактора
  const under = map.getStyle().layers.find((l) => l.type === 'fill-extrusion' && !photoLayers.some((p) => p.layer.isLayer(l.id)))?.id
    ?? (map.getLayer(roadsLayer.id) ? roadsLayer.id : undefined);
  for (const p of photoLayers) p.layer.apply(p.on, photoFilter, map.getLayer(UNDERGROUND_LAYER) ? UNDERGROUND_LAYER : undefined, bounds, under);
  photoViewer.syncCone();
}

function setBuildingsView(v: typeof buildingsView) {
  const toggled = buildingsView.shown !== v.shown;
  Object.assign(buildingsView, v);
  storeBuildings(buildingsView);
  overpassLayer.setVisible(v.shown);
  overpassLayer.setOpacity(v.opacity);
  overpassLayer.setWireframe(v.wireframe);
  applyTileBuildingsView();
  syncWireBtn();
  if (toggled && !focus) { mapIssuesDirty = true; renderIssues(); refreshOverpass(); scheduleIndoorBadges(); }
}

/** В режиме контуров рёбер у объёмов тайлов нет — только бледная заливка, чтобы было видно, что здесь здание. */
const TILE_WIRE_OPACITY = 0.3;

/** Множитель непрозрачности объёмов из тайлов (до загрузки данных API) по настройке слоя зданий. */
const tileOpacity = () => (!buildingsView.shown ? 0 : buildingsView.wireframe ? TILE_WIRE_OPACITY : buildingsView.opacity);

/**
 * Объёмы из тайлов и их подсветка — тоже 3D-здания: та же видимость и прозрачность. Видимостью слоёв ведает режим
 * здания (прячет и возвращает), поэтому скрываем непрозрачностью, а выбор кликом отключает queryTileLayers.
 */
function applyTileBuildingsView() {
  if (!mapLoaded) return;
  updateDraftStyle();
  // Подсветка выбранного — заметнее: не бледнее половины
  const k = buildingsView.shown ? Math.max(0.9 * tileOpacity(), 0.5) : 0;
  for (const id of [MERGED_HIGHLIGHT_LAYER, HIGHLIGHT_LAYER]) if (map.getLayer(id)) map.setPaintProperty(id, 'fill-extrusion-opacity', k);
}

// Геолокация — в том же вертикальном блоке, сразу под кнопкой слоёв.
const geolocateButton = document.querySelector<HTMLElement>('.maplibregl-ctrl-geolocate');
if (navGroup && geolocateButton) {
  const oldGroup = geolocateButton.parentElement;
  navGroup.appendChild(geolocateButton);
  if (oldGroup !== navGroup) oldGroup?.remove();
}

// Режим контуров (W) — последней кнопкой того же блока: переключают часто, в меню слоёв далеко
const wireBtn = document.createElement('button');
wireBtn.type = 'button';
wireBtn.className = 'maplibregl-ctrl-basemap maplibregl-ctrl-wireframe';
wireBtn.title = tr('Только рёбра зданий, без заливки (W)');
// Каркас куба: передние рёбра сплошные, задние — пунктиром
wireBtn.innerHTML = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M3 6.5 10 3l7 3.5v7L10 17l-7-3.5z"/><path d="M3 6.5 10 10l7-3.5M10 10v7"/><path d="M3 13.5 10 10" stroke-dasharray="1.6 1.4" opacity=".6"/></svg>';
wireBtn.addEventListener('click', () => toggleWireframe());
navGroup?.appendChild(wireBtn);
const syncWireBtn = () => {
  wireBtn.classList.toggle('active', buildingsView.wireframe);
  wireBtn.setAttribute('aria-pressed', String(buildingsView.wireframe));
};
syncWireBtn();

function toggleWireframe() {
  setBuildingsView({ ...buildingsView, wireframe: !buildingsView.wireframe });
  basemapCtrl?.setBuildings({ ...buildingsView });
}

/** Выбор снимков общий; векторную карту в здании включают явно. */
function pickBasemap(id: string) {
  if (focusScene()) focusVectorMap = id === MAP_BASEMAP;
  setBasemap(id);
  void saveSetting('basemap');
}

/** Область снимков в режиме здания: здание с запасом FOCUS_IMAGERY_PAD_M; дальше — по границе тайлов. */
const FOCUS_IMAGERY_PAD_M = 40;
function focusImageryBounds(): [number, number, number, number] | undefined {
  if (!focus) return;
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const f of groupFeatures(focus)) for (const p of f.polygons ?? []) for (const [lng, lat] of p.outer) {
    w = Math.min(w, lng); e = Math.max(e, lng); s = Math.min(s, lat); n = Math.max(n, lat);
  }
  if (!Number.isFinite(w)) return;
  const dLat = FOCUS_IMAGERY_PAD_M / 111320, dLng = dLat / Math.cos(((s + n) / 2) * Math.PI / 180);
  return [w - dLng, s - dLat, e + dLng, n + dLat];
}

/**
 * Источники правок: спутниковые снимки, включённые с прошлой отправки, и открытые уличные фото — в теги changeset
 * (imagery_used — названия, source — «aerial imagery» / «streetlevel imagery», как в iD).
 */
const usedImagery = new Set<string>();
const usedStreet = new Set<string>();
function noteSources() {
  const id = basemap;
  if (id !== MAP_BASEMAP) usedImagery.add(findImagery(id)?.name ?? id);
  const shown = photoViewer.service;
  if (shown) usedStreet.add(shown.name);
}
function sourceTags(): Record<string, string> {
  // Свои подложки — без имён файлов (в них бывает лишнее), как «Custom» у iD
  const used = [...usedImagery, ...usedStreet, ...(usedUnderlay ? ['Custom'] : [])];
  if (!used.length) return {};
  const source = [usedImagery.size ? 'aerial imagery' : '', usedStreet.size ? 'streetlevel imagery' : '', usedUnderlay ? 'custom imagery' : ''].filter(Boolean);
  return { imagery_used: used.join(';').slice(0, 255), source: source.join(';') };
}

/** Слои снимков и треков — по режиму (карта или здание). */
function syncBasemapLayers() {
  const f = focusScene();
  const id = basemap;
  // Ни один radio не выбран, пока векторная карта в здании скрыта.
  basemapCtrl?.set(f && id === MAP_BASEMAP && !focusVectorMap ? '' : id);
  basemapCtrl?.setGps(gpsTraces);
  if (!mapLoaded) return; // слои добавит обработчик load
  const bounds = f ? focusImageryBounds() : undefined;
  applyGpsTraces(map, gpsTraces && (!f || !!bounds), bounds);
  applyBasemap(map, f && !bounds ? MAP_BASEMAP : id, bounds);
  syncPhotos();
  noteSources();
  applyVectorStyle(id !== MAP_BASEMAP || (f && !focusVectorMap));
}

/** Слои стиля карты (без фона и экструзий) и их видимость в стиле — запоминаются при загрузке. */
let styleLayers: { id: string; visibility: 'visible' | 'none' }[] = [];

/**
 * Под снимками стиль карты не нужен (сквозь прозрачный снимок проглядывал бы): скрыть его заливки, линии и подписи,
 * оставив здания (наши слои). В режиме здания векторную карту можно включить явно.
 */
function applyVectorStyle(hidden: boolean) {
  for (const l of styleLayers) if (map.getLayer(l.id)) map.setLayoutProperty(l.id, 'visibility', hidden ? 'none' : l.visibility);
}

const offsetPanel = new ImageryOffsetPanel(map, {
  onChange: () => basemapCtrl?.sync(),
  // Кнопка привязок — на время смещения снимка и вне режима здания (там её панель скрыта): переносим её на панель карты
  onOpen: (open) => {
    if (open && !focus) mapToolbar.querySelector('[data-help]')!.before(snapsBtn);
    else if (!open && snapsBtn.parentElement === mapToolbar) focusToolbar.querySelector('[data-help]')!.before(snapsBtn);
  },
  snap: (pt) => snapGround(pt),
  // После клика: иначе этот же клик закрыл бы меню как «мимо него»
  onConfirm: () => setTimeout(() => basemapCtrl?.openImagery()),
});

/**
 * Привязка конца сдвига снимка: вершины и середины рёбер контуров зданий на земле (по ним сверяют снимок).
 * Те же переключатели, что у привязок режима здания: кнопка (S), Alt, типы вершин и середин.
 */
function snapGround(pt: [number, number]): OffsetSnap | undefined {
  const off = overpassLayer.snapKindsOff;
  if (!overpassLayer.snapsEnabled || overpassLayer.snapsSuspended || (off.has('vertex') && off.has('midpoint'))) return;
  const R = 12;
  const a = map.unproject([pt[0] - R, pt[1] - R]), b = map.unproject([pt[0] + R, pt[1] + R]);
  const c = map.unproject([pt[0] - R, pt[1] + R]), d = map.unproject([pt[0] + R, pt[1] - R]);
  const w = Math.min(a.lng, b.lng, c.lng, d.lng), e = Math.max(a.lng, b.lng, c.lng, d.lng);
  const s = Math.min(a.lat, b.lat, c.lat, d.lat), n = Math.max(a.lat, b.lat, c.lat, d.lat);
  let best: { p: LonLat; d: number; kind: 'vertex' | 'midpoint' } | undefined;
  const test = (p: LonLat, kind: 'vertex' | 'midpoint') => {
    if (off.has(kind) || p[0] < w || p[0] > e || p[1] < s || p[1] > n) return;
    const q = map.project(p);
    const dist = Math.hypot(q.x - pt[0], q.y - pt[1]) + (kind === 'midpoint' ? 6 : 0); // вершины важнее
    if (dist <= R + (kind === 'midpoint' ? 6 : 0) && (!best || dist < best.d)) best = { p, d: dist, kind };
  };
  for (const { feature } of overpass.renderedFeatures()) {
    for (const poly of feature.polygons ?? []) for (const ring of [poly.outer, ...poly.inners]) {
      for (let i = 0; i < ring.length; i++) {
        const p = ring[i], q = ring[(i + 1) % ring.length];
        test(p, 'vertex');
        test([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2], 'midpoint');
      }
    }
  }
  if (!best) return;
  const q = map.project(best.p);
  return { lngLat: new maplibregl.LngLat(best.p[0], best.p[1]), point: [q.x, q.y], kind: best.kind, label: SNAP_LABELS[best.kind] };
}

function setGpsTraces(on: boolean) {
  gpsTraces = on;
  storeGps(on);
  syncBasemapLayers();
}

function setBasemap(id: string) {
  if (id !== basemap) offsetPanel.hide();
  basemap = id;
  storeBasemap(id, basemapScope);
  syncBasemapLayers();
}

if (server().imagery) registerSetting({
  key: 'basemap',
  local: () => (basemap === MAP_BASEMAP ? undefined : basemap),
  apply: (v) => {
    const id = isBasemap(v) ? v : MAP_BASEMAP;
    if (id === basemap) return 'same';
    setBasemap(id);
    return 'live';
  },
});
if (server().imagery) registerSetting({
  key: 'gps-traces',
  local: () => (gpsTraces ? '1' : undefined),
  apply: (v) => {
    if ((v === '1') === gpsTraces) return 'same';
    setGpsTraces(v === '1');
    return 'live';
  },
});

const infoEl = document.getElementById('info')!;
// Копировать и вставить теги — кнопки в шапке «Свойств» (обработчики — у renderSelected)
const tagsClip = document.getElementById('tags-clip')!;
const copyTagsBtn = tagsClip.querySelector<HTMLButtonElement>('[data-copy-tags]')!;
const pasteTagsBtn = tagsClip.querySelector<HTMLButtonElement>('[data-paste-tags]')!;
/** Скопированные теги и откуда. */
let copiedTags: { from: string; tags: Record<string, string> } | undefined;

// Сворачивание панелей в заголовок; состояние запоминается.
function setCollapsed(panel: HTMLElement, collapsed: boolean) {
  const btn = panel.querySelector<HTMLButtonElement>('.collapse-btn')!;
  panel.classList.toggle('collapsed', collapsed);
  btn.setAttribute('aria-expanded', String(!collapsed));
  btn.title = collapsed ? tr('Развернуть') : tr('Свернуть');
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
const issuesPanel = document.getElementById('issues-panel')!;
const issuesEl = document.getElementById('issues')!;
const issuesCount = document.getElementById('issues-count')!;
const issuesAll = document.getElementById('issues-all') as HTMLInputElement;
const issuesFixAll = document.getElementById('issues-fix-all') as HTMLButtonElement;
const issuesAllMapKey = 'osm3d.issues-all.map';
const issuesAllBuildingKey = 'osm3d.issues-all.building';
function storedIssuesAll(building: boolean): boolean {
  try {
    const value = localStorage.getItem(building ? issuesAllBuildingKey : issuesAllMapKey)
      ?? (building ? localStorage.getItem('osm3d.issues-all') : null);
    return value === '1';
  } catch { return false; }
}
issuesAll.checked = storedIssuesAll(false);
const outlinerEl = document.getElementById('outliner')!;
const outlinerCount = document.getElementById('outliner-count')!;
/** Скрытые глазиком части в режиме здания — только показ, на данные не влияет. */
const focusHidden = new Set<string>();
/** Indoor-объекты, временно скрытые для осмотра этажа. */
const indoorHidden = new Set<string>();
/** Части здания, которых нет в году слайдера времени (OHM), — скрыты в сцене, как глазиком; на данные не влияет. */
let focusDated = new Set<string>();
/** Часть скрыта в режиме здания: глазиком или по дате — её не выделить и не править в сцене. */
const hiddenInFocus = (k: string) => focusHidden.has(k) || focusDated.has(k);
const editsCount = document.getElementById('edits-count')!;
/** Было ли в панели правок что показать при прошлой отрисовке: раскрываем/сворачиваем только на переходе. */
let editsHadContent = false;
const statusEl = document.getElementById('status')!;
const statusCopy = document.getElementById('status-copy') as HTMLButtonElement;
statusCopy.title = tr('Копировать сообщение');
// Вместе со строкой индикатора загрузки («Не удалось загрузить…»), если она показана
statusCopy.addEventListener('click', async () => {
  const label = document.querySelector<HTMLElement>('#op-indicator:not([hidden]) .label')?.innerText.trim();
  const text = [label, statusEl.innerText.trim()].filter(Boolean).join('\n');
  try {
    await navigator.clipboard.writeText(text);
    statusCopy.dataset.done = '';
    statusCopy.title = tr('Скопировано');
  } catch {
    statusCopy.title = tr('Не удалось скопировать');
  }
  setTimeout(() => { delete statusCopy.dataset.done; statusCopy.title = tr('Копировать сообщение'); }, 1500);
});
const toasts = new Toasts(map.getContainer());
const opIndicator = document.getElementById('op-indicator')!;
opIndicator.querySelector('.retry')!.addEventListener('click', () => overpass.retryFailed());
const monoToggle = document.getElementById('mono-toggle') as HTMLInputElement;

/**
 * Правки поверх данных тайлов. Объект попадает в сессию (копией), когда его выделяют;
 * при отрисовке тайлов отслеживаемые объекты подменяются этими копиями — правки переживают перезагрузку тайлов.
 */
let session = new EditSession([], onSessionChange);
session.beforeStep = (keys) => autoRelation(keys);
const overpassLayer = new BuildingsLayer('osm-overpass-buildings');
overpassLayer.visible = buildingsView.shown;
overpassLayer.setOpacity(buildingsView.opacity);
overpassLayer.setWireframe(buildingsView.wireframe);
const tileBorders = new TileBorders(map);
const roadsLayer = new RoadsLayer('osm-roads-3d');
const indoorPois = new IndoorPois(map, overpassLayer, (f, add) => selectIndoor(f, add));
const overpass = new OverpassTiles(map, overpassLayer, () => {
  updateTileFilter();
  showOverpassStatus();
  if (focus) { renderLevels(); renderIssues(); }
  else scheduleMapIssues(); // пришли здания видимых тайлов
  scheduleIndoorBadges();
  tileBorders.setTiles(overpass.tiles());
  scheduleRoads();
}, (f) => (session.isDeleted(f.key) ? { ...f, polygons: [] } : (session.get(f.key) as Feature3D | undefined) ?? f));
roadsLayer.onBuilt = () => overpass.setTreeCuts(roadsLayer.treeCuts);
// В режиме здания карта вокруг убрана — мосты и тоннели тоже
roadsLayer.hidden = () => focusScene();
/**
 * Созданные в сессии здания и части (с контуром). Новые indoor-объекты (помещения, площадки, этажи) — не объёмы:
 * они живут в плане этажа (indoorCreated), в 3D-слой зданий не идут.
 */
function createdShapes(): Feature3D[] {
  return session.createdAlive().filter((t): t is Feature3D => 'polygons' in t && !!t.polygons?.length
    && !t.key.startsWith('node/') && !(t.tags.indoor && !t.tags.building && !t.tags['building:part']));
}
overpass.setExtras(createdShapes);
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
function syncIssuesAllSetting() { issuesAll.checked = storedIssuesAll(!!focus); }
// Подложки пользователя (этап 20): свои картинки — в IndexedDB, показ — слоем зданий. Общие (добавлены на карте)
// видны на карте и в режиме любого здания, подложки здания — только в его режиме
/** Общие подложки (карта и все здания). */
let sharedUnderlays: Underlay[] = [];
/** Подложки здания режима; undefined — ещё не загружены или не в режиме здания. */
let focusUnderlays: Underlay[] | undefined;
/** С прошлой отправки были видны свои подложки — в теги changeset. */
let usedUnderlay = false;
/** Подложки, которые сейчас в работе: общие и (в режиме здания) этого здания. */
const currentUnderlays = () => [...sharedUnderlays, ...(focus ? focusUnderlays ?? [] : [])];
/** Выделенные подложки (id) — отдельно от объектов OSM; выделение может быть смешанным. */
let underlaySelection: string[] = [];
/** Ключ подложки в списке Alt+клика (рядом с ключами объектов OSM). */
const UNDERLAY_KEY = 'underlay:';
const underlayKey = (id: string) => UNDERLAY_KEY + id;
const underlayOf = (key: string | undefined) => (key?.startsWith(UNDERLAY_KEY) ? key.slice(UNDERLAY_KEY.length) : undefined);
const underlayMenu = new UnderlayMenu({
  add: (files) => void addUnderlays(files),
  change: (changed) => {
    // Из меню — видимость, прозрачность, этаж и где видна: положение могли изменить инструменты
    const cur = currentUnderlays().find((x) => x.id === changed.id);
    const u = cur ? { ...cur, visible: changed.visible, opacity: changed.opacity, level: changed.level, building: changed.building } : changed;
    replaceUnderlay(u, u.level !== cur?.level || u.building !== cur?.building);
    if (underlaySelection.includes(u.id)) renderSelected();
    scheduleUnderlaySave(u);
  },
  // «Выбрать»: выделить подложку — инструменты и свойства
  select: (u) => { basemapCtrl?.closeMenu(); selectUnderlay(u.id); },
  remove: (u) => {
    sharedUnderlays = sharedUnderlays.filter((x) => x.id !== u.id);
    focusUnderlays = focusUnderlays?.filter((x) => x.id !== u.id);
    clearTimeout(underlaySaves.get(u.id));
    underlaySaves.delete(u.id);
    showUnderlays();
    void deleteUnderlay(u.id);
  },
});
basemapCtrl?.addSection(underlayMenu.el);
/** Подложка изменилась: в своём списке и на сцене (меню — только если menu: ползунок может быть под мышью). */
function replaceUnderlay(u: Underlay, menu = false) {
  sharedUnderlays = sharedUnderlays.filter((x) => x.id !== u.id);
  focusUnderlays = focusUnderlays?.filter((x) => x.id !== u.id);
  // Порядок — по времени добавления
  const byAdded = (list: Underlay[]) => [...list, u].sort((a, b) => a.added - b.added);
  if (u.building === undefined) sharedUnderlays = byAdded(sharedUnderlays);
  else if (focusUnderlays && u.building === focus?.key) focusUnderlays = byAdded(focusUnderlays);
  showUnderlays(menu);
}

/** Этажи здания режима — для подложек этажей (отметки полов); сигнатура — показывать заново, только если поменялись. */
let underlayLevels: Level[] = [];
let underlayLevelsSig = '';
function syncUnderlayLevels(levels: Level[]) {
  const sig = `${currentLevel}|${levels.map((l) => `${l.n}:${l.floor}`).join(',')}`;
  underlayLevels = levels;
  if (sig === underlayLevelsSig) return;
  underlayLevelsSig = sig;
  showUnderlays();
}

/** Высота центра подложки над землёй: основание (земля или пол этажа) плюс её elevation; undefined — этажа нет в здании. */
function underlayElevation(u: Underlay): number | undefined {
  const base = u.level === undefined ? 0 : underlayLevels.find((l) => l.n === u.level)?.floor;
  return base === undefined ? undefined : base + u.elevation;
}

/** Показать подложки (слой и меню); menu = false — меню не пересобирать (ползунок под мышью). */
function showUnderlays(menu = true) {
  const list = currentUnderlays();
  if (menu) underlayMenu.set(list, focus?.key, focus ? underlayLevels.map((l) => ({ n: l.n, label: levelLabel(l.n) })) : [], currentLevel);
  // Подложка этажа — только на выбранном этаже, на отметке его пола
  const shown = list.flatMap((u) => {
    const v = underlayPreview?.ids.has(u.id) ? transformUnderlay(u, underlayPreview.m) : u;
    const elevation = v.level === undefined || v.level === currentLevel ? underlayElevation(v) : undefined;
    return elevation === undefined ? [] : [{ ...v, elevation }];
  });
  overpassLayer.underlays.set(shown);
  // Выделенную подложку больше не видно (скрыли, сменили этаж или режим, удалили) — снять с выделения
  const kept = underlaySelection.filter((id) => shown.some((u) => u.id === id && u.visible));
  if (kept.length !== underlaySelection.length) { underlaySelection = kept; paintSelection(); renderSelected(); }
  if (shown.some((u) => u.visible)) usedUnderlay = true;
  // Подгоняемую подложку больше не видно (сменили этаж, режим) — подгонку закончить
}

/** Подложки, показанные преобразованными (превью инструмента), и преобразование, м сцены. */
let underlayPreview: { ids: Set<string>; m: THREE.Matrix4 } | undefined;

const UNDERLAY_X = new THREE.Vector3(1, 0, 0), UNDERLAY_Z = new THREE.Vector3(0, 0, 1);
/** Ориентация картинки, как на сцене (underlay-meshes): R_z(rotation)·R_x(tilt)·R_z(spin). */
const underlayQuaternion = (u: Underlay) => new THREE.Quaternion().setFromAxisAngle(UNDERLAY_Z, u.rotation)
  .multiply(new THREE.Quaternion().setFromAxisAngle(UNDERLAY_X, u.tilt))
  .multiply(new THREE.Quaternion().setFromAxisAngle(UNDERLAY_Z, u.spin ?? 0));

/**
 * Подложка, преобразованная матрицей m (метры сцены режима здания): перенос, поворот вокруг любой оси, единый
 * масштаб. Ориентация раскладывается обратно в R_z(rotation)·R_x(tilt)·R_z(spin), tilt — 0…π.
 */
function transformUnderlay(u: Underlay, m: THREE.Matrix4): Underlay {
  const f = underlayFrame(u);
  if (!f) return u;
  const c = f.center.clone().applyMatrix4(m);
  // Оси картинки после преобразования (линейная часть m): масштаб — по ширине, ориентация — по осям (в плоскости
  // картинки m — подобие; масштаб по нормали, как у «Масштаба» в плоскости, на ориентацию не влияет)
  const lin = new THREE.Matrix3().setFromMatrix4(m);
  const a = f.a.clone().applyMatrix3(lin), b = f.b.clone().applyMatrix3(lin);
  const k = a.length() / f.a.length();
  const x = a.clone().normalize(), y = b.clone().sub(x.clone().multiplyScalar(b.dot(x))).normalize(), z = x.clone().cross(y);
  const e = new THREE.Matrix4().makeBasis(x, y, z).elements; // по столбцам
  const m00 = e[0], m10 = e[1], m20 = e[2], m21 = e[6], m02 = e[8], m12 = e[9], m22 = e[10];
  let tilt = Math.acos(Math.max(-1, Math.min(1, m22))), rotation: number, spin: number;
  // Почти лежит (наклон — погрешность счёта): rotation и spin из шума по отдельности случайны и картинка дрожит —
  // весь поворот в rotation, наклон ровно 0 или π
  if (Math.sin(tilt) > 1e-6) { rotation = Math.atan2(m02, -m12); spin = Math.atan2(m20, m21); }
  else { rotation = Math.atan2(m10, m00); spin = 0; tilt = tilt < Math.PI / 2 ? 0 : Math.PI; }
  const center = overpassLayer.focusToLngLat(c.x, c.y);
  return center ? { ...u, center, elevation: u.elevation + c.z - f.center.z, rotation, tilt, spin, scale: u.scale * k } : u;
}

/** Подложка в метрах сцены режима здания: центр, полуоси вдоль ширины и высоты картинки, нормаль. */
function underlayFrame(u: Underlay) {
  const c = overpassLayer.focusToLocal(u.center), z = underlayElevation(u);
  if (!c || z === undefined) return;
  const q = underlayQuaternion(u);
  return {
    center: new THREE.Vector3(c[0], c[1], z),
    a: new THREE.Vector3(1, 0, 0).applyQuaternion(q).multiplyScalar(u.width * u.scale / 2),
    b: new THREE.Vector3(0, 1, 0).applyQuaternion(q).multiplyScalar(u.height * u.scale / 2),
    n: new THREE.Vector3(0, 0, 1).applyQuaternion(q),
  };
}

/** Показанные подложки из ids. */
const shownUnderlays = (ids: Set<string>) => currentUnderlays().filter((u) => ids.has(u.id) && u.visible && (u.level === undefined || u.level === currentLevel));

// Подложки — цель «Переместить»: привязки — углы, середины сторон, центр; захват — и за любую точку картинки
const underlayTarget: UnderlayTarget = {
  snap(point, ids) {
    let best: SnapHit | undefined, bestD = 12;
    for (const u of shownUnderlays(ids)) {
      const f = underlayFrame(u);
      if (!f) continue;
      const { center: c, a, b } = f;
      const pts: [SnapKind, THREE.Vector3][] = [
        ...[[1, 1], [-1, 1], [-1, -1], [1, -1]].map(([i, j]): [SnapKind, THREE.Vector3] => ['vertex', c.clone().addScaledVector(a, i).addScaledVector(b, j)]),
        ...[[1, 0], [-1, 0], [0, 1], [0, -1]].map(([i, j]): [SnapKind, THREE.Vector3] => ['midpoint', c.clone().addScaledVector(a, i).addScaledVector(b, j)]),
        ['center', c.clone()],
      ];
      for (const [kind, p] of pts) {
        const px = overpassLayer.focusProject(p);
        const d = px && Math.hypot(px[0] - point[0], px[1] - point[1]);
        if (!px || d === undefined || d >= bestD) continue;
        const ll = overpassLayer.focusToLngLat(p.x, p.y)!;
        bestD = d;
        best = { kind, key: '', local: p, lngLat: new maplibregl.LngLat(ll[0], ll[1]), altitude: p.z, point: px };
      }
    }
    return best;
  },
  hit(point, ids) {
    const ray = overpassLayer.focusRay(point);
    if (!ray) return;
    let best: { p: THREE.Vector3; n: THREE.Vector3 } | undefined, bestT = Infinity;
    for (const u of shownUnderlays(ids)) {
      const f = underlayFrame(u);
      const p = f && ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(f.n, f.center), new THREE.Vector3());
      if (!f || !p) continue;
      const d = p.clone().sub(f.center), t = p.distanceTo(ray.origin);
      if (Math.abs(d.dot(f.a)) <= f.a.lengthSq() && Math.abs(d.dot(f.b)) <= f.b.lengthSq() && t < bestT) { best = { p, n: f.n.clone() }; bestT = t; }
    }
    return best;
  },
  axes(ids) {
    const u = shownUnderlays(ids)[0], f = u && underlayFrame(u);
    return f ? [f.a.clone().normalize(), f.b.clone().normalize(), f.n.clone().normalize()] : undefined;
  },
  preview(ids, m) {
    underlayPreview = m && { ids, m: m.clone() };
    showUnderlays(false);
  },
};

/**
 * Шаги подложек в истории JOSM (плагин, протокол 3): id → отменить/повторить. JOSM сообщает об отмене и повторе —
 * подложки и правки данных отменяются одним Ctrl+Z в общем порядке. После перезагрузки страницы шаги забываются.
 */
const josmUnderlaySteps = new Map<string, { undo(): void; redo(): void }>();
/** Шаги подложек, сделанные вместе с правками данных: уйдут в JOSM той же командой (с их отправкой). */
let pendingJosmUnderlays: { id: string; applied: boolean }[] = [];
if (josmMode) watchJosmUnderlays((id, redo) => { const s = josmUnderlaySteps.get(id); if (s) { if (redo) s.redo(); else s.undo(); } });

/** Правка подложек одним шагом истории вместе с правками объектов edit (отменяются вместе); name — название шага. */
function editUnderlays(before: Underlay[], after: Underlay[], edit: () => void = () => {}, name = tr('подложка')) {
  const apply = (list: Underlay[]) => {
    for (const u of list) { replaceUnderlay(u); scheduleUnderlaySave(u); }
    if (list.some((u) => underlaySelection.includes(u.id))) renderSelected(); // свойства — по новому положению
  };
  apply(after);
  if (!josmUnderlayHistory()) {
    session.editWithView({ keep: true, undo: () => apply(before), redo: () => apply(after) }, edit);
    return;
  }
  // С плагином JOSM история — его: правки данных уходят туда, шаг подложки — следом за ними или сразу (один)
  const id = crypto.randomUUID(), pending = { id, applied: true };
  josmUnderlaySteps.set(id, { undo: () => apply(before), redo: () => apply(after) });
  const attached = session.editWithView({ keep: true, undo: () => { pending.applied = false; apply(before); }, redo: () => { pending.applied = true; apply(after); } }, edit, false);
  if (attached) pendingJosmUnderlays.push(pending);
  else void josmUnderlayStep(id, name).catch((err) => setStatus((err as Error).message, true));
}

/** Загрузить подложки здания режима (при входе в здание). */
async function loadFocusUnderlays() {
  const key = focus?.key;
  focusUnderlays = undefined;
  showUnderlays();
  if (!key) return;
  const list = await loadUnderlays(key);
  if (focus?.key !== key) return;
  // Добавленные, пока база отвечала, — после сохранённых
  focusUnderlays = [...list, ...((focusUnderlays as Underlay[] | undefined) ?? []).filter((u) => !list.some((x) => x.id === u.id))];
  showUnderlays();
}

// Общие подложки — сразу при запуске
void loadUnderlays(undefined).then((list) => {
  sharedUnderlays = [...list, ...sharedUnderlays.filter((u) => !list.some((x) => x.id === u.id))];
  showUnderlays();
});

/** Запись подложки после правки — не чаще, мс (ползунок прозрачности). */
const UNDERLAY_SAVE_MS = 400;
const underlaySaves = new Map<string, ReturnType<typeof setTimeout>>();
function scheduleUnderlaySave(u: Underlay) {
  clearTimeout(underlaySaves.get(u.id));
  underlaySaves.set(u.id, setTimeout(() => { underlaySaves.delete(u.id); void saveUnderlay(u); }, UNDERLAY_SAVE_MS));
}

/** Метров на пиксель экрана в его центре (по горизонтали). */
function metersPerPixel(): number {
  const c = map.getCanvas(), x = c.clientWidth / 2, y = c.clientHeight / 2;
  const a = map.unproject([x - 50, y]), b = map.unproject([x + 50, y]);
  return a.distanceTo(b) / 100;
}

/**
 * Добавить картинки подложками: в режиме здания — этого здания (вписаны в него по его осям; выбран этаж — этого
 * этажа), на карте — общие (в центре вида, по осям экрана). Полупрозрачные.
 */
async function addUnderlays(files: File[]) {
  const key = focus?.key;
  const outline = focus ? groupFeatures(focus).flatMap((f) => (f.polygons ?? []).flatMap((p) => p.outer)) : [];
  const c = map.getCenter(), canvas = map.getCanvas();
  const view: [LonLat, number, number, [number, number]] = [[c.lng, c.lat], metersPerPixel(), map.getBearing(), [canvas.clientWidth, canvas.clientHeight]];
  const bad: string[] = [];
  for (const file of files) {
    const u = await createUnderlay(file, (w, h) => (key ? fitToBuilding(outline, w, h) : fitToView(...view, w, h)), key, key ? currentLevel : undefined);
    if (focus?.key !== key) return; // за время чтения файла сменили режим
    if (!u) { bad.push(file.name || tr('картинка')); continue; }
    replaceUnderlay(u, true);
    if (!await saveUnderlay(u)) setStatus(tr('Подложку не удалось сохранить в браузере — после перезагрузки её не будет.'), true);
  }
  if (bad.length) setStatus(tr('Не открылось как картинка (PNG, JPG, WebP, SVG): {names}', { names: bad.join(', ') }), true);
}

/** Картинки из перетаскивания или вставки: на карте — общие подложки, в режиме здания — его. */
const underlayFiles = (data: DataTransfer | null) => [...data?.files ?? []].filter(isUnderlayFile);
map.getCanvasContainer().addEventListener('dragover', (e) => {
  if (![...e.dataTransfer?.items ?? []].some((i) => i.kind === 'file')) return;
  e.preventDefault();
  e.dataTransfer!.dropEffect = 'copy';
});
map.getCanvasContainer().addEventListener('drop', (e) => {
  if (![...e.dataTransfer?.items ?? []].some((i) => i.kind === 'file')) return;
  const files = underlayFiles(e.dataTransfer);
  e.preventDefault();
  if (files.length) void addUnderlays(files);
  else setStatus(tr('Подложкой можно добавить картинку: PNG, JPG, WebP, SVG.'), true);
});
document.addEventListener('paste', (e) => {
  const t = e.target as HTMLElement | null;
  if (t?.closest('input, textarea, [contenteditable]')) return;
  const files = underlayFiles(e.clipboardData);
  if (!files.length) return;
  e.preventDefault();
  void addUnderlays(files);
});
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
  styleLayers = map.getStyle().layers.filter((l) => l.type !== 'background')
    .map((l) => ({ id: l.id, visibility: l.layout?.visibility === 'none' ? 'none' as const : 'visible' as const }));

  const extrusion: FillExtrusionLayerSpecification['paint'] = {
    'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 5],
    'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
    'fill-extrusion-opacity': 0.9 * tileOpacity(),
  };

  // Здания из тайлов OpenFreeMap — только для серверов OSM; у OGF и OHM здания лишь из данных API
  if (server().tileBuildings) map.addLayer({
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

  if (server().tileBuildings) map.addLayer({
    id: HIGHLIGHT_LAYER,
    type: 'fill-extrusion',
    source: 'openmaptiles',
    'source-layer': 'building',
    minzoom: 14,
    filter: ['==', ['id'], -1],
    paint: { ...extrusion, 'fill-extrusion-color': '#ff7a00' },
  });

  map.addLayer(roadsLayer);
  map.addLayer(overpassLayer);
  tileBorders.addLayer();
  tileBorders.setEnabled(gfx.tileBorders);
  // Подземные здания без объёма — пунктирный контур на поверхности (поверх объёмов не прячется: рисуется после)
  map.addSource('underground-outlines', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({
    id: UNDERGROUND_LAYER,
    type: 'line',
    source: 'underground-outlines',
    minzoom: 15,
    paint: { 'line-color': '#5a5f66', 'line-width': 1.5, 'line-dasharray': [3, 2], 'line-opacity': 0.85 },
  });
  mapLoaded = true;
  applyTileBuildingsView();
  syncBasemapLayers();
  overpass.setSource(tileSource());
  applyDate();
  refreshOverpass();
  if (josmMode) void loadJosm();
});

let cameraWrite = Promise.resolve();
map.on('moveend', () => {
  refreshOverpass(); scheduleIndoorBadges(); showOverpassStatus();
  if (!focus && !new URLSearchParams(location.search).has('edit')) {
    const c = map.getCenter();
    const camera = { center: [c.lng, c.lat] as [number, number], zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() };
    cameraWrite = cameraWrite.then(() => saveCamera(camera));
  }
});

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
  // План этажа: мимо стен — точка на полу этажа под курсором (а не центр всего здания)
  if (!hit && focus && shownLevel) {
    const p = overpassLayer.focusRay([x, y])?.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -shownLevel.floor), new THREE.Vector3());
    const ll = p && overpassLayer.focusToLngLat(p.x, p.y);
    if (ll) return { lngLat: new maplibregl.LngLat(ll[0], ll[1]), altitude: shownLevel.floor };
  }
  // В режиме здания мимо геометрии — вокруг центра здания
  if (!hit && focus) { const c = overpassLayer.focusCenter(); if (c) return c; }
  // Не попали в 3D-слой (тайловое здание или пусто) — точка на земле
  return hit ?? { lngLat: map.unproject([x, y]), altitude: 0 };
}, (x, y) => overpassLayer.pickHit([x, y]) ?? undefined);

function applyMonochrome() {
  overpassLayer.setMonochrome(gfx.monochrome);
  roadsLayer.setMonochrome(gfx.monochrome);
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
  tileBorders.setEnabled(gfx.tileBorders);
  tileBorders.setTiles(overpass.tiles());
  const roadsOn = gfx.bridges3d || gfx.tunnels3d;
  roadsLayer.setKinds(gfx.bridges3d, gfx.tunnels3d);
  scheduleRoads();
  if (roadsLayer.isEnabled !== roadsOn) {
    roadsLayer.setEnabled(roadsOn);
    if (!roadsOn) overpass.setTreeCuts(new Float64Array(0));
    overpass.roadsWanted = roadsOn;
    // Тайлы из кеша без дорог перезапросятся в фоне
    if (mapLoaded) refreshOverpass();
    scheduleRoads();
  }
}

/** Мосты и развязки — по дорогам показанных тайлов; пересборка не чаще раза в 300 мс. */
let roadsTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleRoads() {
  if (!roadsLayer.isEnabled || roadsTimer) return;
  roadsTimer = setTimeout(() => {
    roadsTimer = undefined;
    // Здания — для подъёма мостов над крышами (контур с частями не рисуется — берём части)
    const obstacles = overpass.allFeatures()
      // building=bridge / man_made=bridge / bridge:support — сам мост или его опора, не препятствие
      // Подземные (location=underground, layer<0 — ТЦ под площадью) — тоже нет: мост над ними на земле
      .filter((f) => overpass.isVisible(f) && !f.hasParts && f.tags.building !== 'bridge' && f.tags.man_made !== 'bridge' && !f.tags['bridge:support']
        && f.tags.location !== 'underground' && !(Number(f.tags.layer) < 0)).map((f) => {
      const h = computeHeights(f.tags);
      return { rings: f.polygons.map((p) => p.outer), min: h.min, top: h.top };
    });
    roadsLayer.setRoads(overpass.roads(), obstacles);
  }, 300);
}
applyGraphics();

/** Галки графики — по gfx (после значений из профиля). */
function syncGraphicsInputs() {
  monoToggle.checked = gfx.monochrome;
  for (const input of document.querySelectorAll<HTMLInputElement>('[data-gfx]')) input.checked = !!gfx[input.dataset.gfx as keyof GraphicsSettings];
}

// Постоянный кеш тайлов OSM API (IndexedDB)
const cacheInfo = document.getElementById('cache-info')!;
async function showCacheInfo() {
  cacheInfo.textContent = tr('Кэш тайлов: {n}', { n: await overpass.store.count() });
}
document.getElementById('cache-clear')!.addEventListener('click', async () => {
  await overpass.clearStore();
  await showCacheInfo();
});
const tilesReload = document.getElementById('tiles-reload')!;
/** В режиме здания кнопка обновляет только его: части, отношение и внутренние планы. */
function syncReloadButton() {
  tilesReload.textContent = focus ? tr('Обновить здание') : tr('Перезагрузить видимые тайлы');
  tilesReload.title = focus ? tr('Заново запросить из OSM API это здание, его части и внутренние планы') : tr('Отладка: заново запросить из OSM API тайлы на экране');
}
tilesReload.addEventListener('click', () => {
  if (focus) {
    if (josmMode) return setStatus(tr('Слой JOSM обновляется сам.'));
    setStatus(tr('Обновляем здание…'));
    focusIndoor.delete(focus.key);
    loadFocusIndoor(focus);
    void refreshFocusedBuilding(focus, ++focusRefreshId, true);
    return;
  }
  if (overpass.mode !== 'full') return setStatus(tr('Тайлы загружаются с z ≥ {z}.', { z: OVERPASS_MIN_ZOOM }), true);
  setStatus(tr('Перезапрашиваем тайлов ({src}): {n}.', { src: overpass.sourceLabel, n: overpass.reloadVisible() }));
});
document.getElementById('gfx')!.addEventListener('toggle', () => void showCacheInfo());
void showCacheInfo();

// FPS считаем по кадрам MapLibre (рисует по требованию — смотреть при движении карты)
const perfEl = document.getElementById('perf')!;
let frames = 0;
map.on('render', () => frames++);
setInterval(() => {
  const triangles = overpassLayer.lastTriangles;
  perfEl.textContent = tr('FPS: {fps} · треугольников: {n}', { fps: frames, n: triangles.toLocaleString(locale) });
  frames = 0;
}, 1000);

function refreshOverpass() {
  // В режиме здания окружение не видно — тайлы не грузим и не собираем (у горизонта их в кадре десятки)
  // Слой зданий выключен — тоже: догрузим при включении
  if (!map.getLayer(overpassLayer.id) || focus || !buildingsView.shown) return;
  timed('refreshOverpass', refreshOverpassImpl);
}

function refreshOverpassImpl() {
  const z = map.getZoom();
  overpass.mode = z >= OVERPASS_MIN_ZOOM ? 'full' : z >= CACHED_MIN_ZOOM ? 'cached' : 'off';
  overpass.update();
}

/** Сколько сообщение (setStatus) держится в строке состояния, мс. */
const MESSAGE_MS = 6000, MESSAGE_ERROR_MS = 12000;
let messageUntil = 0;
let messageTimer: ReturnType<typeof setTimeout> | undefined;
function showOverpassStatus() {
  updateOverpassIndicator();
  updateDraftStyle();
  if (uploading || Date.now() < messageUntil) return;
  if (!focus && map.getZoom() < CACHED_MIN_ZOOM) return panelStatus(tr('Приблизьте карту для просмотра и редактирования.'));
  const src = overpass.sourceLabel;
  if (!overpass.enabled) return panelStatus(tr('Здания из тайлов. С z ≥ {z} — из {src}.', { z: OVERPASS_MIN_ZOOM, src }));
  const { ready, total, loading, waiting } = overpass.status();
  if (overpass.mode === 'cached') {
    return panelStatus(ready
      ? trn(ready, 'Здания из тайлов, рядом с центром — из кеша {src} ({n} тайл). С z ≥ {z} — из {src}.|Здания из тайлов, рядом с центром — из кеша {src} ({n} тайла). С z ≥ {z} — из {src}.|Здания из тайлов, рядом с центром — из кеша {src} ({n} тайлов). С z ≥ {z} — из {src}.', { src, z: OVERPASS_MIN_ZOOM })
      : tr('Здания из тайлов. С z ≥ {z} — из {src}.', { z: OVERPASS_MIN_ZOOM, src }));
  }
  // Всё загружено — строка не нужна (индикатор ещё немного показывает «Данные загружены»)
  if (!loading && !waiting) return panelStatus('');
  panelStatus(tr('{src}: {ready}/{total} тайлов', { src, ready, total })
    + (loading ? tr(', загружается {n}', { n: loading }) : '')
    + (waiting ? tr(', ждут повтора {n} (лимит/ошибка, см. консоль)', { n: waiting }) : '') + '.');
}

// Пересчитываем контуры с частями, когда догрузились новые тайлы
let tilesChanged = false;
let lastMergedSig = '';
const isMergedId = (id: number) => OFM_IDS && id % 10 === 0;
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
  mergedKeys = merged.map((f) => {
    const [lon, lat] = String(f.properties!.key).split('@')[1].split(',').map(Number);
    return { key: f.properties!.key, tile: f.properties!.tile, lon, lat };
  });
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
    if (!isMergedId(f.id)) continue;
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
/** Области загрузки слоя JOSM: он скачан не по тайлам — тайловые здания прячем только внутри областей, иначе на
 * краю слоя прогал до границы тайла. Пусто (JOSM не отдал <bounds>) — прячем тайлы целиком, как у Overpass. */
let josmAreas: Bbox[] = [];
let mergedKeys: { key: string; tile: string; lon: number; lat: number }[] = [];
const inJosmAreas = (lon: number, lat: number) => josmAreas.some(([w, s, e, n]) => lon >= w && lon <= e && lat >= s && lat <= n);

function updateTileFilter() {
  if (!map.getLayer(BUILDINGS_LAYER)) return; // сервер без тайловых зданий
  const notIn = (ids: number[]): ExpressionSpecification => ['!', ['in', ['id'], ['literal', ids]]];
  const hiddenIds = [...userHidden].map(Number).filter(Number.isFinite);
  // Тайлы, здания которых уже нарисованы из данных API
  const overpassTiles = overpass.displayed();
  const byAreas = josmMode && josmAreas.length > 0;
  const byTile = overpassTiles.length ? timed('тайлы: id по клеткам', () => tileFeatureIdsByTile(map, 'openmaptiles', 'building', byAreas ? inJosmAreas : undefined)) : new Map<string, number[]>();
  const overpassIds = overpassTiles.flatMap((k) => byTile.get(k) ?? []);
  // setFilter перестраивает бакеты всех тайлов слоя — вызываем, только если набор скрытого изменился
  const tileSet = new Set(overpassTiles);
  const hiddenMerged = byAreas ? mergedKeys.filter((m) => tileSet.has(m.tile) && inJosmAreas(m.lon, m.lat)).map((m) => m.key) : [];
  const sig = [replacedIds.length, hiddenIds.join(), overpassTiles.sort().join(), overpassIds.length, byAreas, hiddenMerged.length].join('|');
  if (sig === lastFilterSig) return;
  lastFilterSig = sig;
  console.debug(`[perf] setFilter: скрыто ${overpassIds.length} фич тайлов под Overpass`);
  map.setFilter(BUILDINGS_LAYER, ['all', BASE_FILTER, notIn([...replacedIds, ...hiddenIds, ...overpassIds])]);
  // Выбранное здание тайла заменили данные API: его подсветка осталась бы внутри здания (видна сквозь прозрачные)
  if (highlightedTile !== undefined && [...replacedIds, ...hiddenIds, ...overpassIds].includes(highlightedTile)) clearTileHighlight();
  map.setFilter(REMAINDERS_LAYER, notIn(hiddenIds));
  map.setFilter(MERGED_LAYER, ['all',
    byAreas ? ['!', ['in', ['get', 'key'], ['literal', hiddenMerged]]] : ['!', ['in', ['get', 'tile'], ['literal', overpassTiles]]],
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
  return key ? buildingKey(key) : undefined;
}

/** Здание объекта в режиме карты: отношение type=building, контур здания без отношения или сам объект. */
function buildingKey(key: string): string {
  const g = groupOf(key);
  if (g) return g.key;
  const f = entity(key) as Feature3D | undefined;
  return (f?.polygons?.length && implicitBuilding(f)?.outline) || key;
}

/** Ключи для подсветки: у группы — все её члены, у контура здания без отношения — и части внутри. */
function highlightKeys(key: string | undefined): string[] {
  if (!key) return [];
  const g = groupOf(key);
  if (g) return g.key === key ? g.members : [key];
  const f = entity(key) as Feature3D | undefined;
  const implicit = f?.polygons?.length ? implicitBuilding(f) : undefined;
  return implicit?.outline === key ? [key, ...implicit.parts] : [key];
}

map.on('click', (e) => {
  if (e.originalEvent.button !== 0) return;
  if (suppressClick) return;
  // Этим нажатием пипетка взяла цвет — не выделять и не заливать
  if (performance.now() - eyedropper.pickedAt < 600) return;
  if (copyPick) { pickCopyBase([e.point.x, e.point.y]); return; }
  if (pointPick) { placePoint([e.point.x, e.point.y]); return; }
  if (entranceDrag) { commitEntrance([e.point.x, e.point.y]); return; }
  if (drawTool.active) { drawTool.click([e.point.x, e.point.y]); updateSnap([e.point.x, e.point.y]); return; }
  if (measureTool.active) { measureTool.click([e.point.x, e.point.y]); updateSnap([e.point.x, e.point.y]); return; }
  if (rotateTool.active) { rotateTool.click([e.point.x, e.point.y]); updateSnap([e.point.x, e.point.y]); return; }
  if (scaleTool.active) { scaleTool.click([e.point.x, e.point.y]); updateSnap([e.point.x, e.point.y]); return; }
  if (offsetTool.active) { offsetTool.click([e.point.x, e.point.y], e.originalEvent.shiftKey); return; }
  if (paintTool.active) {
    paintTool.click([e.point.x, e.point.y], false);
    return;
  }
  if (splitTool.active) {
    const p: [number, number] = [e.point.x, e.point.y];
    if (!splitTool.click(p) && splitTool.state === 'pick') { splitTool.stop(); measureTool.stop(); rotateTool.stop(); scaleTool.stop(); paintTool.stop(); offsetTool.stop(); select(undefined); }
    return;
  }
  if (shapeTool.active) {
    const p: [number, number] = [e.point.x, e.point.y];
    // Не по вершине выделенной части — выбрать объект под курсором (Shift — добавить к выделению или убрать;
    // мимо — снять выделение), инструмент остаётся
    if (!shapeTool.click(p, e.originalEvent.shiftKey)) {
      const key = resolveClick(e.originalEvent.altKey ? cyclePick(e.point) : overpassLayer.pick(e.point));
      const member = key && focus?.members.includes(key) ? key : undefined;
      if (e.originalEvent.shiftKey) { if (member) toggleSelection(member); }
      else select(member);
    }
    updateSnap(p);
    return;
  }
  if (pushTool.active) {
    const p: [number, number] = [e.point.x, e.point.y];
    // Мимо объектов при невыбранной грани — выключить инструмент
    if (!pushTool.click(p, e.originalEvent.shiftKey) && pushTool.state === 'pick' && !overpassLayer.pickHit(e.point)) { pushTool.stop(); select(undefined); }
    updateSnap(p);
    return;
  }
  // Снимок уличных фото под курсором — открыть вместо выбора здания
  for (const p of photoLayers) {
    const picId = p.layer.pick(e.point);
    if (picId) { void photoViewer.open(p.layer, picId); return; }
  }
  // Вход на фасаде: клик — выбрать, клик по точке выбранного (узел у основания) — перенести
  if (focus && !toolActive() && !e.originalEvent.shiftKey && !e.originalEvent.altKey) {
    if (overpassLayer.pickEntrancePoint([e.point.x, e.point.y])) { startEntranceDrag(); return; }
    const id = overpassLayer.pickEntrance([e.point.x, e.point.y]);
    if (id !== undefined) { if (id !== selectedEntrance) selectEntrance(id); return; }
  }
  if (moveTool.state === 'select') {
    const doorKey = overpassLayer.pickDoor([e.point.x, e.point.y]);
    const door = shownIndoor.find(f => f.key === doorKey && isDoor(f));
    if (door) { selectIndoor(door); startMove(); moveSelectedByClick = true; updateSnap([e.point.x, e.point.y]); return; }
    // Инструмент включён без выделения: клик выбирает объект, дальше — точка захвата на нём
    const key = resolveClick(e.originalEvent.altKey ? cyclePick(e.point) : overpassLayer.pick(e.point));
    if (!key) { moveTool.stop(); select(undefined); updateSnap(undefined); return; }
    select(key);
    startMove();
    moveSelectedByClick = true;
    updateSnap([e.point.x, e.point.y]);
    return;
  }
  if (moveTool.state === 'pick' && moveSelectedByClick && !moveTool.keys.has(overpassLayer.pickDoor([e.point.x, e.point.y]) ?? '') && !overpassLayer.snapAt([e.point.x, e.point.y], moveTool.pickFilter)) {
    // Объект выбран самим инструментом — клик по другому объекту здания выбирает его вместо прежнего
    const key = resolveClick(e.originalEvent.altKey ? cyclePick(e.point) : overpassLayer.pick(e.point));
    if (key && !moveTool.keys.has(key)) {
      select(key);
      startMove();
      moveSelectedByClick = true;
      updateSnap([e.point.x, e.point.y]);
      return;
    }
  }
  if (moveTool.active) {
    // Перемещение не начато, клик мимо всех объектов — выключаем инструмент и снимаем выделение
    if (moveTool.state === 'pick' && !overpassLayer.snapAt([e.point.x, e.point.y], moveTool.pickFilter) && !overpassLayer.pickHit(e.point) && !overpassLayer.pickDoor([e.point.x, e.point.y]) && !moveTool.grabsUnderlay([e.point.x, e.point.y])) {
      moveTool.stop();
      select(undefined);
      updateSnap(undefined);
      return;
    }
    moveTool.click([e.point.x, e.point.y]);
    updateSnap([e.point.x, e.point.y]);
    return;
  }
  // План этажа: клик по полу помещения — его теги в свойствах
  // Shift+клик при выбранном indoor-объекте — добавить к выбранным или убрать (иначе Shift — части здания)
  const indoorAdd = e.originalEvent.shiftKey && (indoorSelection.length > 0 || selectedRoomWalls.length > 0);
  if (focus && shownLevel && !addingTo && (!e.originalEvent.shiftKey || indoorAdd) && !e.originalEvent.altKey) {
    const wall = roomWallAt([e.point.x, e.point.y]);
    if (wall) { selectRoomWall(wall, e.originalEvent.shiftKey); return; }
    // На этаже приоритет у помещений: части здания — Shift/Alt-кликом или при «Всё здание»
    const room = indoorAt([e.point.x, e.point.y]);
    if (room) { selectIndoor(room, indoorAdd); return; }
    if (indoorAdd) return; // Shift+клик мимо — выбор не сбрасываем
    const free = freeAreaAt([e.point.x, e.point.y]);
    if (free) { selectFreeArea(free); return; }
  }
  if (selectedIndoor || selectedRoomWalls.length) selectIndoor(undefined);
  // Контур подземной части (режим здания, всё здание): только подсветка, объекта OSM за ним нет
  const under = !!focus && !shownLevel && !addingTo && !e.originalEvent.shiftKey && overpassLayer.pickUnderground(e.point);
  overpassLayer.selectUnderground(under);
  if (under) {
    select(undefined);
    const depth = Math.min(0, ...buildingLevels(focus!, buildingIndoor(focus!)).filter((l) => l.n < 0).map((l) => l.floor));
    setStatus(tr('Подземная часть здания: до {d} м под землёй.', { d: (-depth).toFixed(1) }));
    return;
  }
  const key = e.originalEvent.altKey ? cyclePick(e.point) : overpassLayer.pick(e.point);
  if (addingTo) {
    if (e.originalEvent.shiftKey) { if (key) toggleAddPending(key); return; }
    stopAdding(); // обычный клик — выходим из режима добавления
  }
  // Подложка (только Alt+кликом): Shift — добавить к выделению или убрать, вместе с частями здания
  const underlayId = underlayOf(key);
  if (underlayId) {
    if (e.originalEvent.shiftKey) toggleUnderlay(underlayId); else selectUnderlay(underlayId);
    return;
  }
  // Подложка под курсором — если нет геометрии (у неё приоритет)
  const underlayHit = key && (!focus || focus.members.includes(key)) ? undefined : topUnderlay(e.point);
  if (e.originalEvent.shiftKey && underlayHit) { toggleUnderlay(underlayHit); return; }
  if (e.originalEvent.shiftKey && key) {
    // Shift+клик: добавить/убрать объект; внутри группы — только её члены
    const k = drill ? (drill.members.includes(key) ? key : undefined) : buildingKey(key);
    if (k) toggleSelection(k);
    return;
  }
  const treeKey = !focus && gfx.trees ? overpassLayer.pickTree(e.point) : undefined;
  const tree = treeKey ? overpass.treePoints().find((point) => point.key === treeKey) : !focus && gfx.trees ? overpass.treePoints().map((point) => {
    const screen = map.project({ lng: point.p[0], lat: point.p[1] });
    return { point, distance: Math.hypot(screen.x - e.point.x, screen.y - e.point.y) };
  }).filter((hit) => hit.distance <= 14).sort((a, b) => a.distance - b.distance)[0]?.point : undefined;
  if (tree) { selectTree(tree); return; }
  // Мост или тоннель под курсором ближе здания — его теги (только просмотр)
  const road = addingTo ? undefined : roadsLayer.pick(e.point.x, e.point.y);
  if (road) {
    const hit = key ? overpassLayer.pickHit(e.point) : undefined;
    if (!hit || road.depth < roadsLayer.depthOf(hit.lngLat, hit.altitude)) { selectRoad(road.way, e.originalEvent.shiftKey); return; }
  }
  // Shift-клик мимо объектов сохраняет выделение и текущую группу.
  if (e.originalEvent.shiftKey) return;
  const resolved = resolveClick(key);
  if (!resolved && underlayHit) { selectUnderlay(underlayHit); return; }
  if (select(resolved)) return;
  const f = queryTileLayers(e.point)[0];
  infoEl.innerHTML = f ? describeTile(f) : '';
  highlightedTile = f?.layer.id === MERGED_LAYER ? undefined : f?.id as number | undefined;
  if (map.getLayer(HIGHLIGHT_LAYER)) map.setFilter(HIGHLIGHT_LAYER, ['==', ['id'], highlightedTile ?? -1]);
  map.setFilter(MERGED_HIGHLIGHT_LAYER, ['==', ['get', 'key'], f?.layer.id === MERGED_LAYER ? f.properties.key : '']);
  if (f) resolveTileFeature(f);
});

/** Свои подложки под точкой экрана, от ближней к дальней. */
function underlaysAt(p: { x: number; y: number }): string[] {
  const canvas = map.getCanvas();
  return overpassLayer.underlays.pickAll([p.x, p.y], [canvas.clientWidth, canvas.clientHeight]);
}
const topUnderlay = (p: { x: number; y: number }) => underlaysAt(p)[0];

/** Alt+клик: повторные клики в ту же точку по очереди выбирают объекты под курсором, от ближнего к дальнему. */
let altCycle: { x: number; y: number; keys: string[]; i: number } | undefined;
function cyclePick(p: { x: number; y: number }): string | undefined {
  const same = altCycle && Math.hypot(p.x - altCycle.x, p.y - altCycle.y) < 5;
  // Вне группы клик выделяет всё здание — перебираем разные результаты, а не части одного здания
  // (resolveClick не годится — он выходит из группы)
  const keys = overpassLayer.pickAll([p.x, p.y]).filter((k) => !focus || focus.members.includes(k));
  // Свои подложки — в конце перебора: у частей здания приоритет
  const underlays = underlaysAt(p).map(underlayKey);
  if (!keys.length && !underlays.length) { altCycle = undefined; return; }
  const resolved = (k: string) => focus || drill?.members.includes(k) ? k : groupOf(k)?.key ?? k;
  const uniq: string[] = [];
  for (const k of keys) if (!uniq.some((u) => resolved(u) === resolved(k))) uniq.push(k);
  uniq.push(...underlays);
  // Первый Alt+клик после обычного: верхний уже выделен — сразу следующий
  const start = uniq.length > 1 && selection.length === 1 && resolved(uniq[0]) === selection[0] ? 1 : 0;
  const i = same && altCycle!.keys.join() === uniq.join() ? (altCycle!.i + 1) % uniq.length : start;
  altCycle = { x: p.x, y: p.y, keys: uniq, i };
  setStatus(tr('Alt+клик: объект {i} из {n} под курсором.', { i: i + 1, n: uniq.length }));
  return uniq[i];
}

// Двойной клик по группе — режим одного здания (вместо приближения карты); ничего не выделяется
map.on('dblclick', (e) => {
  const key = overpassLayer.pick(e.point);
  if (focus) {
    // Двойной клик по части — изолировать её; мимо — показать скрытые, а если скрытых нет — назад к карте
    e.preventDefault();
    if (toolActive()) return;
    if (key && inFocus(key)) {
      if (focus.members.every((k) => k === key || focusHidden.has(k))) return; // уже изолирована
      changeFocusHidden(new Set(focus.members.filter((k) => k !== key)));
      setStatus(tr('Изолирована часть {key}. Двойной клик по пустому месту — показать все части, Ctrl+Z — отменить.', { key }));
      return;
    }
    if (key) return;
    if (focusHidden.size) {
      changeFocusHidden(new Set());
      setStatus(tr('Показаны все части. Двойной клик по пустому месту ещё раз — выйти из режима здания.'));
      return;
    }
    closeFocus();
    return;
  }
  const k = key ?? undergroundAt(e.point, e.lngLat);
  if (!k) return;
  const g = groupOf(k) ?? soloGroup(k);
  if (!g) return;
  e.preventDefault();
  enterFocus(g);
});

/** Подземное здание под курсором: на пунктирном контуре (±6 px) или внутри него. */
function undergroundAt(pt: maplibregl.Point, ll: maplibregl.LngLat): string | undefined {
  if (!map.getLayer(UNDERGROUND_LAYER)) return;
  const r = 6;
  const hit = map.queryRenderedFeatures([[pt.x - r, pt.y - r], [pt.x + r, pt.y + r]], { layers: [UNDERGROUND_LAYER] })[0];
  if (hit) return hit.properties?.key as string;
  return hiddenUnderground().find((f) => f.polygons.some((p) => pointInRing([ll.lng, ll.lat], p.outer)))?.key;
}

/** Здание режима здания в адресе: ?edit=w123 / ?edit=r456 (хэш карты не трогаем, в историю не пишем). */
function setEditParam(key: string | undefined) {
  const m = key?.match(/^(way|relation)\/(\d+)$/); // новые (отрицательные id) — не в адрес
  const url = new URL(location.href);
  if (m) url.searchParams.set('edit', m[1][0] + m[2]);
  else url.searchParams.delete('edit');
  if (url.href !== location.href) history.replaceState(history.state, '', url);
}

/** Этаж режима здания в адресе: &level=N (вместе с ?edit=); undefined — убрать. */
function setLevelParam(n: number | undefined) {
  const url = new URL(location.href);
  if (n !== undefined && url.searchParams.has('edit')) url.searchParams.set('level', String(n));
  else url.searchParams.delete('level');
  if (url.href !== location.href) history.replaceState(history.state, '', url);
}

/** Этаж из ссылки: включается, когда здание открылось и этаж появился в панели (indoor-данные догружаются). */
let linkLevel: number | undefined = (() => {
  const v = new URLSearchParams(location.search).get('level');
  return v !== null && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined;
})();

/** Сервер данных не отвечает: последний запрос к нему не дошёл (успешный ответ снимает признак). */
const serverDown = () => overpass.pool.endpoints.some((e) => e.unreachable);

/** Карточка по центру: что сейчас происходит (открытие здания по ссылке). undefined — убрать. */
const loadingCard = document.getElementById('loading-card')!;
const loadingAnim = new MorphLoader(loadingCard.querySelector('canvas')!, { shapes: CUBE_SHAPES, ...LOADER_TIMING });
/** Лоадер виден не меньше этого от начала показа: при быстрой загрузке не мелькает, мс. */
const LOADING_MIN_MS = 3000;
let loadingHold: ReturnType<typeof setTimeout> | undefined;
let loadingSince = 0;
function showLoading(text: string | undefined, down = false) {
  clearTimeout(loadingHold);
  if (text !== undefined && loadingCard.hidden) loadingSince = performance.now();
  const left = loadingSince + LOADING_MIN_MS - performance.now();
  if (text === undefined && !loadingCard.hidden && left > 0) {
    loadingHold = setTimeout(() => { loadingCard.hidden = true; loadingAnim.stop(); }, left);
    return;
  }
  loadingCard.hidden = text === undefined;
  if (text === undefined) loadingAnim.stop(); else loadingAnim.start();
  loadingCard.classList.toggle('down', down);
  if (text !== undefined) loadingCard.querySelector('.text')!.textContent = text;
}

/** Открыть здание из ссылки ?edit=: без хэша — подлёт к объекту, вход — когда он появится в данных тайлов. */
async function openEditLink() {
  const m = new URLSearchParams(location.search).get('edit')?.match(/^([wr])(\d+)$/);
  if (!m) return;
  const type = m[1] === 'w' ? 'way' : 'relation', key = `${type}/${m[2]}`;
  const linked = startHashValid;
  const what = type === 'way' ? tr('Линия {id}', { id: m[2] }) : tr('Отношение {id}', { id: m[2] });
  if (!linked) {
    showLoading(tr('{what}: ищу объект на сервере {server}…', { what, server: server().short }));
    try {
      const full = async (t: string, id: number | string) => {
        const res = await fetch(`${server().api}/${t}/${id}/full.json`);
        if (!res.ok) throw new Error(`API ${res.status}`);
        return ((await res.json()) as { elements: OsmElement[] }).elements;
      };
      const elements = await full(type, m[2]);
      let nodes = elements.filter((e): e is OsmNode => e.type === 'node');
      // full.json не раскрывает вложенные отношения: здание из частей-мультиполигонов приходит без узлов —
      // берём узлы нескольких вложенных отношений (для подлёта хватит)
      if (!nodes.length) {
        const subs = elements.filter((e) => e.type === 'relation' && e.id !== Number(m[2])).slice(0, 5);
        nodes = (await Promise.all(subs.map((e) => full('relation', e.id)))).flat().filter((e): e is OsmNode => e.type === 'node');
      }
      if (!nodes.length) throw new Error(tr('нет узлов'));
      const lon = nodes.map((n) => n.lon), lat = nodes.map((n) => n.lat);
      map.fitBounds([[Math.min(...lon), Math.min(...lat)], [Math.max(...lon), Math.max(...lat)]], { padding: 80, maxZoom: 18, pitch: map.getPitch(), bearing: map.getBearing(), duration: 0 });
    } catch (err) {
      setEditParam(undefined);
      showLoading(undefined);
      return setStatus(tr('Ссылка на {key}: объект не загрузился ({error}).', { key, error: (err as Error).message }), true);
    }
  }
  // «Не найдено» — только когда все участки карты загрузились (плюс пауза: отношение собирается из соседних тайлов),
  // а здания так и нет; медленный сервер ждём, но не бесконечно
  const hardDeadline = Date.now() + 300_000;
  let loadedSince: number | undefined;
  const tryEnter = () => {
    if (focus) { showLoading(undefined); return clearInterval(timer); }
    if (!map.getLayer(overpassLayer.id)) return showLoading(tr('{what}: загружаю карту…', { what })); // стиль и слой зданий ещё не готовы
    const { ready, total, loading, waiting } = overpass.status();
    loadedSince = total && !loading && !waiting ? loadedSince ?? Date.now() : undefined;
    if (serverDown()) showLoading(tr('Сервер {server} не отвечает — повторяю…', { server: server().short }), true);
    else if (loadedSince !== undefined) showLoading(tr('{what}: собираю здание из частей…', { what }));
    else showLoading(total
      ? tr('{what}: загружаю данные здания ({ready} из {total} участков карты)…', { what, ready, total })
      : tr('{what}: загружаю данные здания…', { what }));
    // Карту не показываем вовсе: пустая сцена режима здания, пока здание не пришло
    if (!focusHiddenLayers.length) { hideMapLayers(); overpassLayer.setFocus([]); }
    const g = type === 'relation' ? (groupOf(key)?.key === key ? groupOf(key) : soloGroup(key)) : groupOf(key) ?? soloGroup(key);
    // Отношение может прийти с соседним тайлом раньше своих частей — ждём, пока появится хоть одна
    if (g && groupFeatures(g).length) {
      clearInterval(timer);
      showLoading(undefined);
      enterFocus(g, !linked);
      // Ракурс ссылки: наклон вне режима здания урезан, в режиме здания он снова допустим
      if (linked) map.jumpTo({ center: [startHash[2], startHash[1]], zoom: startHash[0], bearing: startHash[3] || 0, pitch: Math.min(startHash[4] || 0, map.getMaxPitch()) });
    }
    else if ((loadedSince !== undefined && Date.now() - loadedSince > 10_000) || Date.now() > hardDeadline) {
      clearInterval(timer);
      showLoading(undefined);
      setEditParam(undefined);
      overpassLayer.setFocus(undefined);
      for (const { id, visibility } of focusHiddenLayers) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visibility as 'visible' | 'none');
      focusHiddenLayers = [];
      offsetPanel.hide();
      syncBasemapLayers();
  offsetPanel.hide();
  syncBasemapLayers();
      setFocusBackground(false);
      setStatus(tr('{key}: здание не найдено в загруженных данных.', { key }), true);
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
  // Схема Simple 3D: части внутри контура здания — уже одно здание, отношение необязательно
  const implicit = implicitBuilding(f);
  if (implicit) return { key: SOLO + implicit.outline, type: 'relation', id: 0, version: 0, tags: {},
    members: [implicit.outline, ...implicit.parts], roles: ['outline', ...implicit.parts.map(() => 'part')] };
  return { key: SOLO + key, type: 'relation', id: 0, version: 0, tags: {}, members: [key], roles: [''] };
}

/** Живые объекты с контуром вне отношений type=building, чья рамка задевает near (данные тайлов с правками сессии). */
function looseFeatures(near: { w: number; s: number; e: number; n: number }, pool = loosePool()): Feature3D[] {
  return pool.filter((f) => { const r = bboxOf(f); return r.w <= near.e && r.e >= near.w && r.s <= near.n && r.n >= near.s; });
}

/** Все объекты вне отношений (с правками сессии) — один раз на серию поисков looseFeatures. */
function loosePool(): Feature3D[] {
  const all = [...overpass.allFeatures(), ...createdShapes()];
  return all.filter((f) => f.polygons?.length && !session.isDeleted(f.key) && !groupOf(f.key))
    .map((f) => (session.has(f.key) ? (session.get(f.key) as Feature3D | undefined) ?? f : f))
    .filter((f) => f.polygons?.length);
}

const bboxCache = new WeakMap<Feature3D, { w: number; s: number; e: number; n: number }>();
const bboxOf = (f: Feature3D) => {
  const hit = bboxCache.get(f);
  if (hit) return hit;
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const p of f.polygons) for (const [x, y] of p.outer) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }
  const r = { w, s, e, n };
  bboxCache.set(f, r);
  return r;
};
const insideFeature = (c: LonLat, f: Feature3D) => f.polygons.some((p) => pointInRing(c, p.outer) && !p.inners.some((h) => pointInRing(c, h)));

/**
 * Здание без отношения: контур (building=*) и части (building:part) вне отношений, чья точка на поверхности
 * лежит внутри контура. f — контур или одна из частей; частей нет — undefined.
 */
function implicitBuilding(f: Feature3D, pool?: Feature3D[]): { outline: string; parts: string[] } | undefined {
  if (groupOf(f.key)) return;
  const isOutline = (b: Feature3D) => !!b.tags.building && b.tags.building !== 'no' && !b.tags['building:part'];
  let outline: Feature3D | undefined = isOutline(f) ? f : undefined;
  if (!outline && f.tags['building:part']) {
    const c = pointOnSurface(f.polygons[0]);
    const loose = looseFeatures({ w: c[0], e: c[0], s: c[1], n: c[1] }, pool);
    // Несколько контуров вокруг (вложенные здания) — ближайший, т. е. наименьший
    const area = (b: Feature3D) => { const r = bboxOf(b); return (r.e - r.w) * (r.n - r.s); };
    outline = loose.filter((b) => b.key !== f.key && isOutline(b) && insideFeature(c, b)).sort((a, b) => area(a) - area(b))[0];
  }
  if (!outline) return;
  const r = bboxOf(outline);
  const parts = looseFeatures(r, pool).filter((p) => {
    if (p.key === outline!.key || !p.tags['building:part'] || p.tags.building) return false;
    const c = pointOnSurface(p.polygons[0]);
    return c[0] >= r.w && c[0] <= r.e && c[1] >= r.s && c[1] <= r.n && insideFeature(c, outline!);
  }).map((p) => p.key);
  return parts.length ? { outline: outline.key, parts } : undefined;
}

/** Новое отношение type=building из контура и частей (зарегистрировано в editGroups, в сессию не записано). */
function implicitRelation(outline: string, parts: string[]): EditGroup {
  const relId = nextNewId--;
  const relMembers = [outline, ...parts].map((k, i) => {
    const [type, ref] = k.split('/');
    return { type: type as 'way' | 'relation', ref: Number(ref), role: i ? 'part' : 'outline' };
  });
  const group: EditGroup = { key: `relation/${relId}`, type: 'relation', id: relId, version: 0, tags: { type: 'building' },
    members: relMembers.map((m) => `${m.type}/${m.ref}`), roles: relMembers.map((m) => m.role), relMembers };
  editGroups.set(group.key, group);
  return group;
}

/** Части здания режима без отношения (кроме вставленных рядом копий). */
const implicitParts = (g: BuildingGroup) => g.members.filter((_, i) => g.roles[i] === 'part');

/** Собрать отношение type=building из здания без отношения (контур и части внутри него). */
function createImplicitRelation() {
  if (!focus || !isSolo(focus) || !focus.roles.includes('part')) return;
  const group = implicitRelation(focus.members[0], implicitParts(focus));
  session.editMany([{ key: group.key, create: group }]);
  setStatus(tr('Создано отношение {key} (type=building).', { key: group.key }));
}

/** Правка контура или части здания без отношения в режиме здания — отношение собирается тем же шагом. */
function autoRelation(keys: string[]): EditGroup | undefined {
  // Шаг сам создаёт отношение здания (кнопка, новая часть) — второе не нужно
  if (keys.some((k) => editGroups.has(k))) return;
  if (!focus || !isSolo(focus) || !focus.roles.includes('part')) return;
  const members = new Set([focus.members[0], ...implicitParts(focus)]);
  if (!keys.some((k) => members.has(k))) return;
  return implicitRelation(focus.members[0], implicitParts(focus));
}

/** Здание без отношения в режиме здания: предложение собрать отношение. */
function implicitWarning(g: BuildingGroup): string {
  if (!isSolo(g) || !g.roles.includes('part')) return '';
  return `<p class="hint">${tr('Части лежат внутри контура здания без отношения type=building — по схеме Simple 3D это уже одно здание. Отношение делает состав явным для других редакторов.')}
    <button type="button" data-implicit-relation>${tr('Собрать отношение type=building')}</button></p>`;
}

/** Члены группы для отрисовки: из сессии (с правками) или из тайлов. */
function groupFeatures(g: BuildingGroup): Feature3D[] {
  // Не нарисованные объёмом (подземные) — из загруженных данных
  return g.members.map((k, i) => {
    // Удалённый в сессии — нет (иначе подставился бы загруженный исходник: виден, но не выделяется)
    if (session.isDeleted(k)) return undefined;
    const f = (session.get(k) as Feature3D | undefined) ?? overpass.get(k)?.feature ?? overpass.findFeature(k);
    return f && focusFeature(g, f, g.roles[i]);
  }).filter((f): f is Feature3D => !!f);
}

/**
 * Член группы для сцены режима здания: вид — по роли; контур с building:part (не входящий ещё и ролью part) —
 * объёмом, остальные контуры при частях — плоским следом (hasParts у объекта сессии мог устареть после правки тегов).
 */
function focusFeature(g: BuildingGroup, f: Feature3D, role = g.roles[g.members.indexOf(f.key)]): Feature3D {
  const kind = role === 'part' ? 'part' : role === 'outline' ? 'building' : undefined;
  const hasParts = role === 'outline' ? !outlineVolume(g, f.key, f.tags) && (f.hasParts || g.roles.includes('part')) : f.hasParts;
  return (kind && f.kind !== kind) || hasParts !== f.hasParts ? { ...f, kind: kind ?? f.kind, hasParts } : f;
}

/** Объект на месте в сцене режима здания (превью инструментов, правка тегов) — с видом и следом по роли. */
function previewFocus(f: Feature3D) {
  overpassLayer.previewFocusFeature(focus ? focusFeature(focus, f) : f);
}

/** Контур рисуется своим объёмом: у него building:part, и он не входит в отношение ещё и ролью part (тогда объём — у той). */
function outlineVolume(g: BuildingGroup, key: string, tags: Record<string, string> | undefined): boolean {
  return !!tags && isOutlinePart(tags) && !g.members.some((k, i) => k === key && g.roles[i] === 'part');
}

/** Контуры отношения без своей высоты — в режиме здания рисуются плоским полигоном. */
function bareOutlines(g: BuildingGroup): string[] {
  return g.members.filter((k, i) => {
    if (g.roles[i] !== 'outline') return false;
    const t = entity(k)?.tags;
    // Контур нового отношения, покрытый частями (рассекли отдельное здание), — плоским следом; часть
    // поменьше (надстройка, пристройка) — нет: объём по-прежнему задаёт контур
    // Контур, входящий ещё и ролью part, — тоже: объём рисует его копия-часть
    return !!t && !outlineVolume(g, k, t) && (isBareOutlineTags(t) || isOutlinePart(t) || ((g.id < 0 || isSolo(g)) && outlineCovered(g, k)));
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
/** Фон сцены режима здания: у OHM фон стиля — цвет воды (суша — отдельным слоем), берём нейтральный. */
const FOCUS_BACKGROUND = '#f8f4f0';
let savedBackgrounds: { id: string; color: unknown }[] = [];

function setFocusBackground(on: boolean) {
  if (on && !savedBackgrounds.length) {
    for (const l of map.getStyle().layers) {
      if (l.type !== 'background') continue;
      savedBackgrounds.push({ id: l.id, color: map.getPaintProperty(l.id, 'background-color') });
      map.setPaintProperty(l.id, 'background-color', FOCUS_BACKGROUND);
    }
  }
  if (!on) {
    for (const { id, color } of savedBackgrounds) if (map.getLayer(id)) map.setPaintProperty(id, 'background-color', color as string);
    savedBackgrounds = [];
  }
}

function hideMapLayers() {
  if (focusHiddenLayers.length) return;
  setFocusBackground(true);
  for (const l of map.getStyle().layers) {
    // Снимки и треки в режиме здания — свои (syncBasemapLayers), отметка сдвига — у панели настроек
    if (l.id === overpassLayer.id || l.type === 'background' || l.id === IMAGERY_LAYER || l.id === GPS_LAYER || l.id.startsWith('imagery-offset') || photoLayers.some((p) => p.layer.isLayer(l.id))) continue;
    const pending = pendingTileLayers.find((p) => p.id === l.id);
    focusHiddenLayers.push(pending ?? { id: l.id, visibility: (map.getLayoutProperty(l.id, 'visibility') as string | undefined) ?? 'visible' });
    map.setLayoutProperty(l.id, 'visibility', 'none');
  }
  // Только векторную карту скрываем при входе; снимки и треки сохраняем.
  offsetPanel.hide();
  focusVectorMap = false;
  syncBasemapLayers();
}

let focusRefreshId = 0;

/** manual — по кнопке «Обновить здание»: сообщить и об актуальных данных. */
async function refreshFocusedBuilding(g: BuildingGroup, requestId: number, manual = false) {
  // В слое JOSM есть неопубликованные правки: API сервера не может его обновлять.
  if (josmMode) return;
  const api = server().api;
  try {
    const root = isSolo(g) ? g.members[0] : g.key;
    // Здание создано в сессии (например, разрезом отдельного здания) — на сервере его ещё нет
    if (Number(root.split('/')[1]) < 0) return;
    const elements = await fetchBuildingElements(root, api);
    const parsed = parseBuildings(elements);
    if (api !== server().api) return;
    const freshGroup = isSolo(g) ? { ...g } : parsed.groups.find((item) => item.key === g.key);
    if (!freshGroup) throw new Error(`OSM: ${g.key} отсутствует в ответе API`);
    // fetchBuildingElements checks the download, including nested relations and way nodes.
    // Parsing may legitimately omit members that are not building volumes.
    // A standalone outline only fetches its own data; inferred parts are refreshed via tiles.
    const { features, unrendered } = isSolo(g)
      ? { features: parsed.features.filter((f) => freshGroup.members.includes(f.key)), unrendered: [] }
      : buildingRefreshMembers(freshGroup, parsed, elements);
    const warning = unrendered.length ? tr('Загружены, но не отображаются члены {building}: {members}', {
      building: g.key, members: unrendered.map((m) => `${m.key} (role=${m.role || '—'}${m.type ? `, type=${m.type}` : ''}${m.reason ? `, ${m.reason}` : ''})`).join('; '),
    }) : undefined;
    if (warning) console.warn('[building refresh]', warning, unrendered);
    const changed = features.filter((f) => {
      const old = overpass.cachedFeature(f.key);
      return !old || old.version !== f.version || JSON.stringify(old.polygons) !== JSON.stringify(f.polygons) ||
        JSON.stringify(old.tags) !== JSON.stringify(f.tags) || JSON.stringify(old.ways) !== JSON.stringify(f.ways);
    });
    const oldGroup = overpass.groupOf(g.key);
    const groupChanged = !isSolo(g) && JSON.stringify(oldGroup) !== JSON.stringify(freshGroup);
    if (!changed.length && !groupChanged) {
      if (requestId === focusRefreshId && focus?.key === g.key && (manual || warning)) setStatus(warning ?? tr('Данные здания актуальны.'), !!warning);
      return;
    }
    // Кеш тайлов (память и IndexedDB) хранит данные сервера, а не правки сессии — обновляем его всегда,
    // иначе после выхода в режим карты снова покажется старое здание
    const saved = new Map(changed.map((f) => [f.key, { version: f.version, tags: f.tags, polygons: f.polygons, ways: f.ways }]));
    await overpass.applySaved(saved, isSolo(g) ? [] : [freshGroup], changed);
    // Свежие версии запоминаем как отправленные: отстающий Overpass или старая запись IndexedDB не вернут прежнее здание
    overpass.noteUploaded(new Map([...changed, ...(groupChanged ? [freshGroup] : [])].map((f) => [f.key, f.version])));
    if (requestId !== focusRefreshId || focus?.key !== g.key) return;
    if (session.hasDataHistory() || [...new Set([...g.members, ...freshGroup.members, g.key])].some((key) => session.has(key) && session.isChanged(key))) {
      setStatus(tr('Данные здания изменились на сервере. Завершите или отмените текущие правки и войдите в здание снова.'), true);
      return;
    }
    for (const f of features) if (session.has(f.key)) session.refresh({ ...f, tags: { ...f.tags },
      ...(f.ways ? { relMembers: f.ways.map((w) => ({ type: 'way' as const, ref: w.id, role: w.role })) } : {}) });
    if (!isSolo(g)) {
      const copy = { ...freshGroup, tags: { ...freshGroup.tags }, members: [...freshGroup.members], roles: [...freshGroup.roles],
        relMembers: freshGroup.members.map((key, i) => { const [type, ref] = key.split('/'); return { type: type as 'way' | 'relation', ref: Number(ref), role: freshGroup.roles[i] ?? '' }; }) };
      if (session.has(g.key)) session.refresh(copy);
      if (editGroups.has(g.key)) { editGroups.set(g.key, copy); rebuildGroupIndex(); }
    }
    drill = focus = freshGroup;
    overpassLayer.setFocus(groupFeatures(freshGroup), bareOutlines(freshGroup));
    syncFocusHidden();
    paintSelection();
    renderSelected();
    setStatus(warning ? `${tr('Данные здания обновлены до актуальной версии OSM.')} ${warning}` : tr('Данные здания обновлены до актуальной версии OSM.'), !!warning);
  } catch (err) {
    if (requestId === focusRefreshId && focus?.key === g.key) setStatus(tr('Не удалось проверить актуальность здания: {error}', { error: (err as Error).message }), true);
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
    indoorHidden.clear();
    for (const k of bareOutlines(g)) focusHidden.add(k);
  }
  const sameBuilding = focus?.key === g.key;
  drill = focus = g;
  syncIssuesAllSetting();
  syncBasemapLayers(); // область снимков — вокруг этого здания
  if (!sameBuilding) void loadFocusUnderlays();
  focusToolbar.hidden = false;
  syncMapTools();
  orbit.setUnderground(true);
  overpassLayer.setFocus(groupFeatures(g), bareOutlines(g));
  syncFocusHidden();
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
  void refreshFocusedBuilding(g, ++focusRefreshId);
  syncReloadButton();
}

/** Доля экрана, которую занимает здание после подлёта. */
const FOCUS_FILL = 0.8;

/** Подлёт только к небольшому зданию: довести до 80% экрана, сохранив наклон и поворот. */
function flyToFocus() {
  const frame = overpassLayer.focusFrame();
  if (!frame) return;
  const { center, rect: currentRect } = frame;
  const canvas = map.getCanvas();
  // Уже крупное хотя бы по одной оси — сохраняем всю камеру, включая центр.
  if (currentRect[2] - currentRect[0] >= canvas.clientWidth * FOCUS_FILL
      || currentRect[3] - currentRect[1] >= canvas.clientHeight * FOCUS_FILL) return;
  // Центр и размер — по всему экрану, панели не вычитаем (так нагляднее)
  const availW = canvas.clientWidth, availH = canvas.clientHeight;
  // Размер на экране зависит от удалённости от камеры (перспектива) — меряем на пробной камере,
  // уже наведённой на здание, и уточняем зум несколько раз
  type Tr = { clone(): Tr; setCenter(c: maplibregl.LngLat): void; setZoom(z: number): void; getProjectionDataForCustomLayer(): { mainMatrix: ArrayLike<number> } };
  const measure = (z: number) => {
    // В maplibre-gl 6 состояние камеры — во внутреннем map._camera.transform
    const transform = (map as unknown as { _camera: { transform: Tr } })._camera.transform.clone();
    transform.setCenter(center);
    transform.setZoom(z);
    return overpassLayer.focusFrame(transform.getProjectionDataForCustomLayer().mainMatrix)?.rect;
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
    if (!k.startsWith('way/') && entity(k)?.tags.type !== 'multipolygon') return tr('{key}: удалять можно только пути и мультиполигоны.', { key: k });
    if (focus && !isSolo(focus)) {
      if (!inFocus(k)) return tr('{key} не входит в это здание.', { key: k });
      if (focus.roles[focus.members.indexOf(k)] === 'outline') return tr('Контур здания (outline) удалить нельзя — только части.');
    } else if (!focus && groupOf(k)) return tr('{key} входит в здание type=building — удалите его в режиме здания (двойной клик).', { key: k });
    return;
  };
  const err = keys.map(why).find(Boolean);
  if (err) return setStatus(err, true);
  const edits: Parameters<typeof session.editMany>[0] = keys.map((k) => { entity(k); return { key: k, delete: true }; });
  // Удалённые объекты убираются из состава всех отношений: группы фокуса и любых отслеживаемых (в т. ч. новых)
  const parents = new Map<string, Tagged>();
  if (focus && !isSolo(focus)) { const g = entity(focus.key); if (g) parents.set(g.key, g); }
  for (const k of keys) for (const p of session.parentsOf(k)) parents.set(p.key, p);
  for (const p of parents.values()) {
    if (keys.includes(p.key) || !p.relMembers) continue;
    const members = p.relMembers.filter((m) => !keys.includes(`${m.type}/${m.ref}`));
    if (members.length < p.relMembers.length) edits.push({ key: p.key, members });
  }
  // Удалили само отдельное здание (а не вставленную рядом копию) — выходим на карту
  const solo = isSolo(focus) && keys.includes(focus!.members[0]);
  select(undefined);
  session.editMany(edits);
  if (solo) leaveDrill();
  setStatus(tr('Удалено объектов: {n}. Отменить — Ctrl+Z.', { n: keys.length }));
}

/** Тайлы карты устарели (правки в режиме здания) — перерисовать при выходе. */
let tilesStale = false;
/** Объекты, правленные в режиме здания: при выходе перерисовываются только их тайлы. */
const staleKeys = new Set<string>();

function exitFocus() {
  if (!focus) return;
  focus = undefined;
  syncIssuesAllSetting();
  mapIssuesDirty = true;
  setEditParam(undefined);
  if (tilesStale) { tilesStale = false; overpass.rerenderFeatures(staleKeys); staleKeys.clear(); }
  focusHidden.clear();
  indoorHidden.clear();
  focusDated.clear();
  session.dropViewActions();
  overpassLayer.setHover(undefined);
  moveTool.stop(); shapeTool.stop();
  pushTool.stop();
  splitTool.stop(); measureTool.stop(); rotateTool.stop(); scaleTool.stop(); paintTool.stop(); offsetTool.stop();
  drawTool.stop();
  focusToolbar.hidden = true;
  syncMapTools();
  renderOutliner();
  updateSnap(undefined);
  orbit.setUnderground(false);
  overpassLayer.setFocus(undefined);
  scheduleMapIssues();
  const restore = (ls: typeof focusHiddenLayers) => {
    for (const { id, visibility } of ls) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visibility as 'visible' | 'none');
  };
  // Здания из векторных тайлов — только после того, как тайлы догрузятся и фильтр скроет то, что уже есть
  // из API; иначе на миг мелькает их грубая геометрия
  const tileLayers = pendingTileLayers = focusHiddenLayers.filter((l) => TILE_LAYERS.includes(l.id));
  restore(focusHiddenLayers.filter((l) => !TILE_LAYERS.includes(l.id)));
  focusHiddenLayers = [];
  offsetPanel.hide();
  syncBasemapLayers();
  focusUnderlays = undefined;
  showUnderlays();
  setFocusBackground(false);
  map.once('idle', () => {
    if (focus || pendingTileLayers !== tileLayers) return; // успели снова войти в режим здания — вернёт следующий выход
    pendingTileLayers = [];
    updateTileFilter();
    restore(tileLayers);
  });
  syncReloadButton();
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
const SNAP_LABELS = { vertex: tr('Вершина'), midpoint: tr('Середина'), center: tr('Центр'), shape: tr('Центр фигуры'), grid: tr('Сетка'), perpendicular: tr('Перпендикуляр'), edge: tr('На ребре'), extension: tr('Продолжение'), tracking: tr('От вершины'), tracked: tr('Отложенная точка') } as const;
/** Текущая привязка под курсором — для будущих инструментов геометрии. */
let currentSnap: SnapHit | undefined;

function updateSnap(point: [number, number] | undefined) {
  // Пока «Форма» тянет вершину, откладывание выключено: цифры — сдвигу вершины, а не оси якоря
  const tracking = !!focus && toolActive() && shapeTool.state !== 'drag';
  if (!tracking && (overpassLayer.tracking || trackTyped)) { overpassLayer.clearTracking(); trackTyped = ''; trackAxis = undefined; }
  overpassLayer.trackingEnabled = tracking;
  overpassLayer.trackVertical = splitTool.state === 'pick';
  updateSnapMarker(point);
  overpassLayer.setSnapLine(currentSnap?.along && [currentSnap.along, currentSnap.local]);
  updateTracking();
}

// Откладывание от вершины: задержка курсора над вершиной делает её якорем, число + Enter на оси — виртуальная точка
const trackAnchorEl = document.createElement('div');
trackAnchorEl.className = 'track-marker anchor';
trackAnchorEl.hidden = true;
const trackPointEl = document.createElement('div');
trackPointEl.className = 'track-marker point';
trackPointEl.hidden = true;
const trackVcb = document.createElement('div');
trackVcb.className = 'vcb vcb-track';
trackVcb.hidden = true;
map.getContainer().append(trackAnchorEl, trackPointEl, trackVcb);
/** Набранное расстояние и ось, на которой стоял курсор при первом символе (side — сторона курсора). */
let trackTyped = '';
let trackAxis: { axis: number; side: number } | undefined;
overpassLayer.onTrackArmed = () => { if (lastPointer) updateSnap(lastPointer); };

function updateTracking() {
  const t = overpassLayer.trackingEnabled ? overpassLayer.tracking : undefined;
  const place = (el: HTMLElement, px: [number, number] | undefined) => {
    el.hidden = !px;
    if (px) { el.style.left = `${px[0]}px`; el.style.top = `${px[1]}px`; }
  };
  place(trackAnchorEl, t?.px);
  place(trackPointEl, t?.point ? t.pointPx : undefined);
  const live = t && t.axis !== undefined && t.dist !== undefined;
  trackVcb.hidden = !t || (!trackTyped && !live);
  if (trackVcb.hidden) return;
  const value = trackTyped || Math.abs(t!.dist ?? 0).toFixed(2);
  trackVcb.innerHTML = `<span class="vcb-label">${tr('От вершины')}</span><span class="vcb-value${trackTyped ? ' typed' : ''}">${value}</span> ${tr('м')}
    <span class="vcb-axis">${tr('Enter — отложить точку, минус — в обратную сторону, Esc — сбросить')}</span>`;
}

/** true — клавиша ушла в откладывание (набор расстояния на оси якоря или Esc). */
function trackKey(e: KeyboardEvent): boolean {
  const t = overpassLayer.trackingEnabled ? overpassLayer.tracking : undefined;
  if (!t || e.ctrlKey || e.metaKey || e.altKey) return false;
  if (e.key === 'Escape') {
    overpassLayer.clearTracking();
    trackTyped = '';
    trackAxis = undefined;
    updateSnap(lastPointer);
    return true;
  }
  if (/^[\d.,-]$/.test(e.key) && (trackTyped || (t.axis !== undefined && t.dist !== undefined))) {
    if (!trackTyped) trackAxis = { axis: t.axis!, side: Math.sign(t.dist!) || 1 };
    trackTyped += e.key === ',' ? '.' : e.key;
    updateTracking();
    return true;
  }
  if (!trackTyped) return false;
  if (e.key === 'Backspace') {
    trackTyped = trackTyped.slice(0, -1);
    if (!trackTyped) trackAxis = undefined;
    updateTracking();
    return true;
  }
  if (e.key === 'Enter') {
    const v = Number(trackTyped);
    if (Number.isFinite(v) && trackAxis) {
      overpassLayer.placeTracked(v, trackAxis.axis, trackAxis.side);
      trackTyped = '';
      trackAxis = undefined;
      updateSnap(lastPointer);
    }
    return true;
  }
  return false;
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
  if (point && entranceDrag) moveEntrance(point);
  if (pointPick && (toolActiveExceptPoint() || !shownLevel)) stopPoint();
  if (point && pointPick) hoverPoint(point);
  if (point && shapeTool.active) shapeTool.move(point);
  if (point && pushTool.state === 'push') pushTool.move(point);
  if (pushTool.state === 'pick') pushTool.hover(point, shiftHeld);
  if (point && splitTool.state === 'cut') splitTool.move(point);
  if (point && drawTool.active) drawTool.move(point);
  if (point && measureTool.active) measureTool.move(point);
  if (point && rotateTool.active) rotateTool.move(point);
  if (point && scaleTool.active) scaleTool.move(point);
  if (point && offsetTool.active) offsetTool.move(point);
  if (pushTool.active || shapeTool.active || splitTool.active || drawTool.active || measureTool.active || rotateTool.active || scaleTool.active || copyPick) {
    // Рассечение: подсвечиваем вершины и середины рёбер объектов (концы разреза)
    currentSnap = pushTool.active ? (pushTool.state === 'push' ? pushTool.snap : undefined)
      : shapeTool.active ? (point ? shapeTool.snap : undefined)
      : drawTool.active ? (point ? drawTool.snap : undefined)
      : measureTool.active ? (point ? measureTool.snap : undefined)
      : rotateTool.active ? (point ? rotateTool.snap : undefined)
      : scaleTool.active ? (point ? scaleTool.snap : undefined)
      : splitTool.state === 'cut' ? (point ? splitTool.snap : undefined)
      : splitTool.active ? (point ? splitTool.hover(point) ?? overpassLayer.snapAt(point) : undefined)
      : point ? overpassLayer.snapAt(point) : undefined;
    if (currentSnap?.kind === 'center') currentSnap = undefined;
    snapEl.hidden = !currentSnap;
    if (currentSnap) {
      snapEl.className = `snap-marker ${currentSnap.kind}`;
      snapEl.dataset.label = currentSnap.kind === 'tracking' ? `${Math.abs(currentSnap.dist ?? 0).toFixed(2)} ${tr('м')}` : currentSnap.label ?? SNAP_LABELS[currentSnap.kind];
      snapEl.style.left = `${currentSnap.point[0]}px`;
      snapEl.style.top = `${currentSnap.point[1]}px`;
    }
    return;
  }
  // Привязки — только при активном инструменте
  currentSnap = !(focus || underlaySketch) || !point || !moveTool.active ? undefined
    : moveTool.state === 'move' ? moveTool.snap
    : overpassLayer.snapAt(point, moveTool.pickFilter) ?? moveTool.underlaySnap(point);
  snapEl.hidden = !currentSnap;
  if (!currentSnap) return;
  snapEl.className = `snap-marker ${currentSnap.kind}`;
  snapEl.dataset.label = currentSnap.label ?? SNAP_LABELS[currentSnap.kind];
  snapEl.style.left = `${currentSnap.point[0]}px`;
  snapEl.style.top = `${currentSnap.point[1]}px`;
}
/** Последняя точка курсора над картой — чтобы пересчитать привязку после S без движения мыши. */
let lastPointer: [number, number] | undefined;
// Клик в инструменте забирает отложенную точку (или уходит мимо неё) — якорь больше не нужен
map.on('click', () => {
  if (!overpassLayer.tracking && !trackTyped) return;
  overpassLayer.clearTracking();
  trackTyped = '';
  trackAxis = undefined;
  updateTracking();
});
map.on('mousemove', (e) => { lastPointer = [e.point.x, e.point.y]; updateSnap(lastPointer); });
map.on('movestart', () => { if (moveTool.state !== 'move') updateSnap(undefined); });
// Камера повернулась — заслонённость маркеров «Формы» поменялась: перерисовать (не чаще раза за кадр)
let shapeRedrawQueued = false;
map.on('move', () => {
  if (!shapeTool.active || shapeRedrawQueued) return;
  shapeRedrawQueued = true;
  requestAnimationFrame(() => { shapeRedrawQueued = false; shapeTool.redraw(); });
});
map.getCanvasContainer().addEventListener('mouseleave', () => updateSnap(undefined));

// --- Инструменты режима здания ---
const focusToolbar = document.getElementById('focus-tools')!;
const moveBtn = focusToolbar.querySelector<HTMLButtonElement>('[data-tool="move"]')!;
const popupEl = document.getElementById('popup')!;
/** Объект для перемещения выбран первым кликом инструмента (а не заранее). */
let moveSelectedByClick = false;
const moveTool = new MoveTool(overpassLayer, map.getContainer(), (keys, offset, glue, underlays) => {
  if (!underlays.length) return commitMove(keys, offset, glue);
  const before = currentUnderlays().filter((u) => underlays.includes(u.id));
  editUnderlays(before, before.map((u) => transformUnderlay(u, new THREE.Matrix4().makeTranslation(offset.x, offset.y, offset.z))), () => { if (keys.length) commitMove(keys, offset, glue); },
    tr('перемещение подложки'));
  if (!keys.length) setStatus(tr('Перемещено подложек: {n} на {d} м.', { n: before.length, d: offset.length().toFixed(2) }));
}, (hint) => {
  moveBtn.classList.toggle('active', moveTool.active);
  syncCursor();
  toolHint(hint);
  endUnderlaySketch();
  syncMapTools();
});

moveBtn.addEventListener('click', () => {
  if (entranceDrag) cancelEntranceDrag();
  else if (moveTool.active) moveTool.stop();
  else if (!startEntranceDrag('pick')) startMove();
});

// Инструмент «Повернуть» (Q): вокруг вертикальной оси на угол (курсором с прилипанием к 15° или числом)
const rotateBtn = focusToolbar.querySelector<HTMLButtonElement>('[data-tool="rotate"]')!;
const rotateTool = new RotateTool(overpassLayer, map.getContainer(), (keys, pivot, angle, glue, axis, underlays) => {
  if (!underlays.length) return commitRotate(keys, pivot, angle, glue);
  const m = new THREE.Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z).multiply(new THREE.Matrix4().makeRotationAxis(axis, angle))
    .multiply(new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));
  const before = currentUnderlays().filter((u) => underlays.includes(u.id));
  editUnderlays(before, before.map((u) => transformUnderlay(u, m)), () => { if (keys.length) commitRotate(keys, pivot, angle, glue); },
    tr('поворот подложки'));
  if (!keys.length) setStatus(tr('Повёрнуто подложек: {n} на {deg}°. Отменить — Ctrl+Z.', { n: before.length, deg: (angle * 180 / Math.PI).toFixed(1) }));
}, (hint) => {
  rotateBtn.classList.toggle('active', rotateTool.active);
  syncCursor();
  toolHint(hint);
  endUnderlaySketch();
  syncMapTools();
});
moveTool.linkPreview = rotateTool.linkPreview = previewGlued;
moveTool.underlays = rotateTool.underlays = underlayTarget;
rotateBtn.addEventListener('click', () => (rotateTool.active ? rotateTool.stop() : startRotate()));

function startRotate() {
  if (!focus) return;
  const keys = selection.filter((k) => focus!.members.includes(k));
  if (!keys.length && !underlaySelection.length) return setStatus(tr('Сначала выберите в здании объект (или несколько с Shift), затем инструмент «Повернуть».'), true);
  const features = keys.map((k) => entity(k) as Feature3D | undefined).filter((f): f is Feature3D => !!f?.polygons);
  if (features.some((f) => !nodeIds(f) || (f.type === 'relation' && !relWays(f)))) {
    return setStatus(tr('В кеше нет id узлов или путей этих объектов — нажмите «Перезагрузить видимые тайлы» в настройках графики.'), true);
  }
  moveTool.stop(); shapeTool.stop(); pushTool.stop(); splitTool.stop(); measureTool.stop(); scaleTool.stop(); paintTool.stop(); offsetTool.stop(); drawTool.stop();
  rotateTool.start(keys, underlaySelection);
}

// Инструмент «Масштаб» (E): в плане, от базовой точки множителем или по двум парам точек
const scaleBtn = focusToolbar.querySelector<HTMLButtonElement>('[data-tool="scale"]')!;
const scaleTool = new ScaleTool(overpassLayer, map.getContainer(), (keys, m, glue, underlays) => {
  if (!underlays.length) return commitScale(keys, m, glue);
  const before = currentUnderlays().filter((u) => underlays.includes(u.id));
  editUnderlays(before, before.map((u) => transformUnderlay(u, m)), () => { if (keys.length) commitScale(keys, m, glue); },
    tr('масштаб подложки'));
  if (!keys.length) setStatus(tr('Масштабировано подложек: {n}. Отменить — Ctrl+Z.', { n: before.length }));
}, (hint) => {
  scaleBtn.classList.toggle('active', scaleTool.active);
  syncCursor();
  toolHint(hint);
  endUnderlaySketch();
  syncMapTools();
});
scaleTool.linkPreview = previewGlued;
scaleTool.underlays = underlayTarget;
scaleBtn.addEventListener('click', () => (scaleTool.active ? scaleTool.stop() : startScale()));

function startScale() {
  if (!focus) return;
  const keys = selection.filter((k) => focus!.members.includes(k));
  if (!keys.length && !underlaySelection.length) return setStatus(tr('Сначала выберите в здании объект (или несколько с Shift), затем инструмент «Масштаб».'), true);
  const features = keys.map((k) => entity(k) as Feature3D | undefined).filter((f): f is Feature3D => !!f?.polygons);
  if (features.some((f) => !nodeIds(f) || (f.type === 'relation' && !relWays(f)))) {
    return setStatus(tr('В кеше нет id узлов или путей этих объектов — нажмите «Перезагрузить видимые тайлы» в настройках графики.'), true);
  }
  moveTool.stop(); shapeTool.stop(); pushTool.stop(); splitTool.stop(); measureTool.stop(); rotateTool.stop(); paintTool.stop(); offsetTool.stop(); drawTool.stop();
  scaleTool.start(keys, underlaySelection);
}

// «Выровнять углы» (A): все углы выделенных частей — 90°, одним шагом истории
const squareBtn = focusToolbar.querySelector<HTMLButtonElement>('[data-tool="square"]')!;
squareBtn.addEventListener('click', () => squareSelected());

/**
 * Выровнять углы выделенных частей (orthogonalize): узлы только сдвигаются — общие с соседями тянут соседей
 * следом (как «Вытянуть» с соседями), чужие узлы на наших сторонах (Т-образные стыки) остаются на этих сторонах.
 */
function squareSelected() {
  if (!focus) return;
  const keys = selection.filter((k) => focus!.members.includes(k));
  if (!keys.length) return setStatus(tr('Сначала выберите в здании части (или несколько с Shift), затем «Выровнять углы».'), true);
  const features = keys.map((k) => entity(k) as Feature3D | undefined).filter((f): f is Feature3D => !!f?.polygons);
  if (features.some((f) => !nodeIds(f))) {
    return setStatus(tr('В кеше нет id узлов или путей этих объектов — нажмите «Перезагрузить видимые тайлы» в настройках графики.'), true);
  }
  moveTool.stop(); shapeTool.stop(); pushTool.stop(); splitTool.stop(); measureTool.stop(); rotateTool.stop(); scaleTool.stop(); paintTool.stop(); offsetTool.stop(); drawTool.stop();
  const local = (c: LonLat) => overpassLayer.focusToLocal(c)!;
  // Новые места узлов; узел, общий у двух выделенных частей, — среднее их вариантов
  const acc = new Map<number, { x: number; y: number; n: number }>();
  /** Стороны колец: узлы концов (старые и новые места — после усреднения). */
  const sides: { u: number; v: number; a: Pt; b: Pt }[] = [];
  let skewed = 0;
  for (const f of features) {
    const rings: { ids: number[]; pts: Pt[] }[] = f.polygons.flatMap((p) => [
      { ids: p.outerIds!, pts: p.outer.map(local) },
      ...p.inners.map((r, j) => ({ ids: p.innerIds![j], pts: r.map(local) })),
    ]);
    const res = orthogonalize(rings.map((r) => r.pts));
    if (typeof res === 'string') {
      if (keys.length === 1) {
        return setStatus(res === 'skewed'
          ? tr('{key}: стороны слишком далеки от прямых углов (больше {deg}°) — выровнять нельзя.', { key: f.key, deg: MAX_DEVIATION_DEG })
          : tr('{key}: контур не похож на прямоугольный (мало сторон).', { key: f.key }), true);
      }
      skewed++;
      continue;
    }
    rings.forEach((r, ri) => r.ids.forEach((id, k) => {
      const [x, y] = res.rings[ri][k];
      const a = acc.get(id) ?? acc.set(id, { x: 0, y: 0, n: 0 }).get(id)!;
      a.x += x; a.y += y; a.n++;
      sides.push({ u: id, v: r.ids[(k + 1) % r.ids.length], a: r.pts[k], b: r.pts[(k + 1) % r.ids.length] });
    }));
  }
  if (!acc.size) return setStatus(tr('Ни одну из частей не выровнять: стороны слишком далеки от прямых углов.'), true);
  const target = new Map([...acc].map(([id, a]) => [id, [a.x / a.n, a.y / a.n] as Pt]));
  const moves = new Map<number, LonLat>();
  for (const f of features) for (const p of f.polygons) {
    [[p.outer, p.outerIds], ...p.inners.map((r, j) => [r, p.innerIds?.[j]] as const)].forEach(([ring, ids]) => (ids as number[] | undefined)?.forEach((id, k) => {
      const t = target.get(id), c = (ring as LonLat[])[k];
      if (!t || moves.has(id)) return;
      const [x, y] = local(c);
      if (Math.hypot(t[0] - x, t[1] - y) > 1e-3) moves.set(id, overpassLayer.focusToLngLat(t[0], t[1])!);
    }));
  }
  // Чужие узлы на наших сторонах — на то же место выровненной стороны
  for (const g of liveFeatures()) for (const r of g.polygons) {
    const rings: [LonLat[], number[] | undefined][] = [[r.outer, r.outerIds], ...r.inners.map((c, k): [LonLat[], number[] | undefined] => [c, r.innerIds?.[k]])];
    for (const [ring, rids] of rings) rids?.forEach((id, k) => {
      if (target.has(id) || moves.has(id)) return;
      const [px, py] = local(ring[k]);
      for (const sd of sides) {
        const ex = sd.b[0] - sd.a[0], ey = sd.b[1] - sd.a[1], len = Math.hypot(ex, ey);
        if (len < 1e-6) continue;
        const t = ((px - sd.a[0]) * ex + (py - sd.a[1]) * ey) / (len * len);
        if (Math.abs((px - sd.a[0]) * ey - (py - sd.a[1]) * ex) / len >= ON_SIDE_M || t <= 1e-6 || t >= 1 - 1e-6) continue;
        const a = target.get(sd.u)!, b = target.get(sd.v)!;
        moves.set(id, overpassLayer.focusToLngLat(a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]))!);
        break;
      }
    });
  }
  if (!moves.size) return setStatus(tr('Углы уже прямые.'));
  const edits = nodeMoveEdits(moves);
  if (typeof edits === 'string') return setStatus(edits, true);
  session.editMany(edits);
  const neighbours = edits.filter((e) => e.polygons && !keys.includes(e.key)).length;
  const done = trn(features.length - skewed, 'Углы выровнены у {n} объекта|Углы выровнены у {n} объектов|Углы выровнены у {n} объектов');
  setStatus(done + (neighbours ? tr(', соседи с общими узлами подтянуты следом: {n}', { n: neighbours }) : '')
    + (skewed ? tr(', пропущено {n} (стороны далеки от прямых углов)', { n: skewed }) : '') + tr('. Отменить — Ctrl+Z.'));
}

/** Цвет и материал: при объединении частей не заданный у части берётся у той, где задан. */
const LOOK_TAGS = /^(building:colou?r|building:material|roof:colou?r|roof:material|colou?r|material)$/;

// «Объединить» (J): выделенные части с одинаковыми тегами объёма — в одну, одним шагом истории
const mergeBtn = focusToolbar.querySelector<HTMLButtonElement>('[data-tool="merge"]')!;
mergeBtn.addEventListener('click', () => mergeSelected());

function mergeSelected() {
  if (!focus) return;
  // План этажа: выделены помещения — объединяем их
  if (shownLevel && !selection.length && indoorSelection.length) { void mergeIndoor().then((err) => { if (err) setStatus(err, true); }); return; }
  const pending = isSolo(focus) && focus.roles.includes('part') ? implicitRelation(focus.members[0], implicitParts(focus)) : undefined;
  const err = mergeIn(pending);
  if (pending && !session.get(pending.key)) editGroups.delete(pending.key);
  if (err) setStatus(err, true);
}

/**
 * Объединение выделенных частей: контур — polygonClipping.union, узлы — прежние там, где совпадают; узлы, что
 * остались на прямой и никому больше не нужны, убираются. Id сохраняет большая по площади часть, остальные
 * удаляются. Дыра в объединении — мультиполигон (путь становится его внешним кольцом). Строка — ошибка.
 */
function mergeIn(pending: EditGroup | undefined): string | undefined {
  const solo = isSolo(focus) && !pending;
  const g = pending ?? (!solo ? (entity(focus!.key) as EditGroup | undefined) : undefined);
  const keys = selection.filter((k) => focus!.members.includes(k) && !hiddenInFocus(k));
  if (keys.length < 2) return tr('Выделите две или больше частей (Shift+клик), затем «Объединить».');
  if (keys.some((k) => focus!.roles[focus!.members.indexOf(k)] !== 'part')) return tr('Объединять можно только части, контур здания (outline) — нет.');
  const features = keys.map((k) => entity(k) as Feature3D | undefined);
  if (features.some((f) => !f?.polygons?.length || !nodeIds(f))) {
    return tr('В кеше нет id узлов или путей этих объектов — нажмите «Перезагрузить видимые тайлы» в настройках графики.');
  }
  const parts = features as Feature3D[];
  if (parts.some((f) => f.type === 'relation' && (f.tags.type !== 'multipolygon' || !relWays(f)))) {
    return tr('Для объединения нужны пути-члены мультиполигона — перезагрузите видимые тайлы.');
  }
  const stacked = mergeStacked(parts, g);
  if (stacked !== false) return stacked;
  // Теги объёма должны совпадать: иначе неясно, чьи высоты и крышу оставить. Цвет и материал, заданные
  // только у части частей, не мешают — объединённая часть возьмёт их оттуда (различаться могут лишь заданные)
  const volume = (f: Feature3D) => Object.fromEntries(Object.entries(f.tags).filter(([k]) => PART_TAGS.test(k)));
  const vols = parts.map(volume);
  const differ = [...new Set(vols.flatMap(Object.keys))].filter((k) => (LOOK_TAGS.test(k)
    ? new Set(vols.map((v) => v[k]).filter((x) => x !== undefined)).size > 1
    : vols.some((v) => v[k] !== vols[0][k]))).sort();
  if (differ.length) {
    return tr('Объединять можно части с одинаковыми тегами объёма, различаются: {tags}.',
      { tags: differ.map((k) => `${k} (${vols.map((v) => v[k] ?? '—').join(' / ')})`).join(', ') });
  }

  const local = (c: LonLat) => overpassLayer.focusToLocal(c)!;
  const netArea = (f: Feature3D) => f.polygons.reduce((s, p) => s + ringArea(p.outer.map(local)) - p.inners.reduce((t, h) => t + ringArea(h.map(local)), 0), 0);
  const shapes = parts.map((f) => f.polygons.map((p) => [p.outer, ...p.inners].map((r) => {
    const q = r.map(local);
    return [...q, q[0]];
  })));
  let union: ReturnType<typeof polygonClipping.union>;
  try { union = polygonClipping.union(shapes[0], ...shapes.slice(1)); } catch { return tr('Не удалось объединить контуры.'); }
  if (union.length !== 1) return tr('Части не соприкасаются: объединить можно только части с общей стороной.');

  // Вершины объединения — прежние узлы, где совпадают, иначе новые
  type N = { id: number; c: LonLat; p: [number, number] };
  const known: N[] = [];
  for (const f of parts) for (const p of f.polygons) {
    p.outerIds!.forEach((id, i) => known.push({ id, c: p.outer[i], p: local(p.outer[i]) }));
    p.inners.forEach((r, j) => p.innerIds![j].forEach((id, i) => known.push({ id, c: r[i], p: local(r[i]) })));
  }
  const outsiders = nodesOutside(new Set(keys));
  const toRing = (r: [number, number][]): N[] => {
    const out: N[] = r.slice(0, -1).map((q) => known.find((n) => Math.hypot(n.p[0] - q[0], n.p[1] - q[1]) < SHARE_EPS)
      ?? { id: nextNewId--, c: overpassLayer.focusToLngLat(q[0], q[1])!, p: q });
    // Повторы и узлы на прямой (бывшие концы общих сторон) — убираем, если они не нужны соседям
    for (let i = 0; out.length > 3 && i < out.length;) {
      const a = out[(i - 1 + out.length) % out.length], b = out[i], c = out[(i + 1) % out.length];
      if (b.id === a.id || (!outsiders.has(b.id) && segDist2(b.p, a.p, c.p) < 0.01)) { out.splice(i, 1); i = Math.max(0, i - 1); } else i++;
    }
    return out;
  };
  const [outer, ...inners] = union[0].map(toRing);
  if (outer.length < 3 || inners.some((r) => r.length < 3)) return tr('Не удалось объединить контуры.');
  const closed = (r: N[]) => ({ ids: [...r.map((n) => n.id), r[0].id], coords: [...r.map((n) => n.c), r[0].c] });
  const polygon: Polygon = { outer: outer.map((n) => n.c), inners: inners.map((r) => r.map((n) => n.c)),
    outerIds: outer.map((n) => n.id), innerIds: inners.map((r) => r.map((n) => n.id)) };

  const keeper = parts.reduce((a, b) => (netArea(b) > netArea(a) ? b : a));
  // Цвет и материал, которых у остающейся части нет, — от той, где они заданы
  const look: Record<string, string> = {};
  for (const v of vols) for (const [k, x] of Object.entries(v)) if (LOOK_TAGS.test(k) && keeper.tags[k] === undefined) look[k] = x;
  const keeperTags = { ...keeper.tags, ...look };
  const others = parts.filter((f) => f !== keeper);
  const edits: ObjectEdit[] = others.map((f) => ({ key: f.key, delete: true }));
  let result = keeper.key;
  let groupMembers = g?.relMembers.filter((m) => !others.some((f) => f.key === `${m.type}/${m.ref}`));
  const newWay = (r: N[], role: string) => {
    const id = nextNewId--;
    edits.push({ key: `way/${id}`, create: { key: `way/${id}`, version: 0, tags: {}, line: closed(r) } });
    return { id, role, nodes: closed(r).ids };
  };

  if (keeper.type === 'way' && !inners.length) {
    edits.push({ key: keeper.key, polygons: [polygon], tags: keeperTags });
  } else if (keeper.type === 'way') {
    // Дыра — путь становится внешним кольцом мультиполигона, теги переезжают на отношение
    const ways = [{ id: keeper.id, role: 'outer', nodes: closed(outer).ids }, ...inners.map((r) => newWay(r, 'inner'))];
    const relId = nextNewId--;
    const relMembers = ways.map((w) => ({ type: 'way' as const, ref: w.id, role: w.role }));
    const rel: Feature3D & { relMembers: OsmMember[] } = { key: `relation/${relId}`, type: 'relation', id: relId, version: 0, kind: keeper.kind,
      tags: { type: 'multipolygon', ...keeperTags }, polygons: [polygon], hasParts: false, ways, relMembers };
    edits.push({ key: rel.key, create: rel });
    edits.push({ key: keeper.key, tags: {}, polygons: [], line: closed(outer) });
    groupMembers = groupMembers?.map((m) => (m.type === 'way' && m.ref === keeper.id ? { type: 'relation' as const, ref: relId, role: m.role } : m));
    result = rel.key;
  } else {
    // Мультиполигон: внешнее кольцо — через topologyEdits (пути, общие с соседями, режутся, куски — соседям; пути
    // удаляемых частей берутся в кольцо, а не дублируются), внутренние — прежние пути, если кольцо то же
    const members = (keeper as Tagged).relMembers ?? session.get(keeper.key)?.relMembers;
    if (!members || keeper.polygons.length !== 1) return tr('Для объединения нужны пути-члены мультиполигона — перезагрузите видимые тайлы.');
    const lineNodes = new Map((keeper.ways ?? []).map((w) => [w.id, w.nodes] as const));
    for (const line of session.lineEntities()) lineNodes.set(Number(line.key.split('/')[1]), line.line!.ids);
    const own = members.filter((m) => m.type === 'way');
    if (own.some((m) => !lineNodes.has(m.ref))) return tr('Для объединения нужны пути-члены мультиполигона — перезагрузите видимые тайлы.');
    const at = new Map(known.map((n) => [n.id, n.c] as const));
    for (const n of [...outer, ...inners.flat()]) at.set(n.id, n.c);
    const gone = new Set(others.map((f) => f.key));
    const adopt = others.flatMap((f) => (f.type === 'relation' ? relWays(f)?.filter((w) => w.role !== 'inner').map((w) => w.id) ?? [] : []));
    const topo = topologyEdits([{ f: keeper, rewrites: [{ poly: 0, ring: 0, ids: polygon.outerIds!, coords: polygon.outer, adopt }] }], [], at, gone);
    if (typeof topo === 'string') return topo;
    const mine = topo.find((e) => e.key === keeper.key)!;
    edits.push(...topo.filter((e) => e !== mine));
    const tagsOf = (id: number) => session.get(`way/${id}`)?.tags ?? keeper.ways?.find((w) => w.id === id)?.tags;
    const track = (id: number) => {
      const key = `way/${id}`;
      const ids = lineNodes.get(id)!;
      if (!session.has(key)) session.track({ key, version: 0, tags: { ...(tagsOf(id) ?? {}) }, line: { ids, coords: ids.map((n) => at.get(n)!) } });
      return key;
    };
    const innerMembers: { id: number; role: string }[] = [];
    for (const r of inners) {
      const ring = new Set(r.map((n) => n.id));
      const same = own.filter((m) => m.role === 'inner' && lineNodes.get(m.ref)!.every((id) => ring.has(id)));
      const covered = new Set(same.flatMap((m) => lineNodes.get(m.ref)!));
      if (same.length && covered.size === ring.size) innerMembers.push(...same.map((m) => ({ id: m.ref, role: 'inner' })));
      else innerMembers.push(newWay(r, 'inner'));
    }
    // Прежние внутренние пути, что больше не на кольцах, — удаляем (если без тегов и не нужны другим отношениям)
    const usedElsewhere = (id: number) => liveFeatures().some((o) => o.type === 'relation' && o.key !== keeper.key && !gone.has(o.key) && relWays(o)?.some((w) => w.id === id));
    for (const m of own) {
      if (m.role !== 'inner' || innerMembers.some((x) => x.id === m.ref) || Object.keys(tagsOf(m.ref) ?? {}).length || usedElsewhere(m.ref)) continue;
      edits.push({ key: track(m.ref), delete: true });
    }
    edits.push({ ...mine, polygons: [polygon], tags: keeperTags, members: [
      ...(mine.members ?? members).filter((m) => m.type !== 'way' || m.role !== 'inner'),
      ...innerMembers.map((m) => ({ type: 'way' as const, ref: m.id, role: m.role }))] });
  }
  if (g && groupMembers) edits.push(groupMembersEdit(g, groupMembers));
  moveTool.stop(); shapeTool.stop(); pushTool.stop(); splitTool.stop(); measureTool.stop(); rotateTool.stop(); scaleTool.stop(); paintTool.stop(); offsetTool.stop(); drawTool.stop();
  session.editMany(edits);
  select(result);
  setStatus(tr('Объединено частей: {n} → {key}. Отменить — Ctrl+Z.', { n: parts.length, key: result }));
  return;
}

/** Теги высоты: при объединении частей одна над другой низ берётся у нижней, верх и крыша — у верхней. */
const STACK_TAGS = /^(height|min_height|building:levels|building:min_level|roof:)/;
const STACK_TOP_TAGS = /^(height|building:levels|roof:)/;
/** Расхождение контуров частей одна над другой, м² (и доля площади): больше — контуры разные. */
const STACK_PLAN_EPS_M2 = 0.05;
const STACK_PLAN_EPS = 0.002;
/** Зазор или нахлёст по высоте между частями одна над другой, м. */
const STACK_GAP_M = 0.05;

/**
 * Объединить части с одним контуром, стоящие одна на другой: остаётся одна (существующая, иначе нижняя) с низом
 * нижней и верхом и крышей верхней, остальные удаляются. false — контуры разные (обычное объединение в плане).
 */
function mergeStacked(parts: Feature3D[], g: EditGroup | undefined): string | undefined | false {
  const local = (c: LonLat) => overpassLayer.focusToLocal(c)!;
  const shape = (f: Feature3D) => f.polygons.map((p) => [p.outer, ...p.inners].map((r) => {
    const q = r.map(local);
    return [...q, q[0]] as [number, number][];
  }));
  const area = (mp: ReturnType<typeof polygonClipping.union>) => mp.reduce((s, poly) => s + poly.reduce((t, r, i) => t + (i ? -1 : 1) * ringArea(r.slice(0, -1)), 0), 0);
  const base = shape(parts[0]);
  const baseArea = area(base);
  try {
    for (const f of parts.slice(1)) {
      const diff = area(polygonClipping.xor(base, shape(f)));
      if (diff > Math.max(STACK_PLAN_EPS_M2, baseArea * STACK_PLAN_EPS)) return false;
    }
  } catch { return false; }
  const order = parts.map((f) => ({ f, h: computeHeights(f.tags) })).sort((a, b) => a.h.min - b.h.min);
  for (let i = 1; i < order.length; i++) {
    if (Math.abs(order[i].h.min - order[i - 1].h.top) > STACK_GAP_M) {
      return tr('Части с одним контуром объединяются, только если стоят одна на другой: {a} — до {top} м, {b} — от {min} м.',
        { a: order[i - 1].f.key, top: Math.round(order[i - 1].h.top * 100) / 100, b: order[i].f.key, min: Math.round(order[i].h.min * 100) / 100 });
    }
  }
  // Остальные теги объёма должны совпадать; цвет и материал, заданные только у части частей, — берутся оттуда
  const vols = parts.map((f) => Object.fromEntries(Object.entries(f.tags).filter(([k]) => PART_TAGS.test(k) && !STACK_TAGS.test(k))));
  const differ = [...new Set(vols.flatMap(Object.keys))].filter((k) => (LOOK_TAGS.test(k)
    ? new Set(vols.map((v) => v[k]).filter((x) => x !== undefined)).size > 1
    : vols.some((v) => v[k] !== vols[0][k]))).sort();
  if (differ.length) {
    return tr('Объединять можно части с одинаковыми тегами объёма, различаются: {tags}.',
      { tags: differ.map((k) => `${k} (${vols.map((v) => v[k] ?? '—').join(' / ')})`).join(', ') });
  }
  const lower = order[0].f, upper = order[order.length - 1].f;
  const keeper = order.find((o) => o.f.id > 0)?.f ?? lower;
  const tags: Record<string, string> = Object.fromEntries(Object.entries(keeper.tags).filter(([k]) => !STACK_TAGS.test(k)));
  for (const v of vols) for (const [k, x] of Object.entries(v)) if (LOOK_TAGS.test(k) && tags[k] === undefined) tags[k] = x;
  for (const [k, x] of Object.entries(lower.tags)) if (STACK_TAGS.test(k) && !STACK_TOP_TAGS.test(k)) tags[k] = x;
  for (const [k, x] of Object.entries(upper.tags)) if (STACK_TOP_TAGS.test(k)) tags[k] = x;
  // Крыша (building:part=roof) со стенами под ней — уже не просто крыша: вид части — от нижней
  if (tags['building:part'] === 'roof' && lower.tags['building:part'] !== 'roof') tags['building:part'] = lower.tags['building:part'] ?? 'yes';
  // Верх задан этажами, а низ — метрами (или наоборот): верх в метрах тоже, иначе этажи считались бы от земли не так
  if (tags.height === undefined && tags['building:levels'] === undefined) tags.height = String(Math.round(order[order.length - 1].h.top * 100) / 100);
  const others = parts.filter((f) => f !== keeper);
  const edits: ObjectEdit[] = [{ key: keeper.key, tags }, ...others.map((f) => ({ key: f.key, delete: true }))];
  if (g) edits.push(groupMembersEdit(g, g.relMembers.filter((m) => !others.some((f) => f.key === `${m.type}/${m.ref}`))));
  moveTool.stop(); shapeTool.stop(); pushTool.stop(); splitTool.stop(); measureTool.stop(); rotateTool.stop(); scaleTool.stop(); paintTool.stop(); offsetTool.stop(); drawTool.stop();
  session.editMany(edits);
  select(keeper.key);
  const h = computeHeights(tags);
  setStatus(tr('Объединено частей одна над другой: {n} → {key}, высоты {from}–{to} м. Отменить — Ctrl+Z.',
    { n: parts.length, key: keeper.key, from: Math.round(h.min * 100) / 100, to: Math.round(h.top * 100) / 100 }));
  return;
}

// Инструмент «Вытянуть»: верх/низ по вертикали (height / min_height) и стены по нормали (узлы контура)
const pushBtn = focusToolbar.querySelector<HTMLButtonElement>('[data-tool="push"]')!;
const pushTool = new PushTool(overpassLayer, map.getContainer(),
  (key) => !!focus?.members.includes(key) && !hiddenInFocus(key),
  () => selection,
  allowPushSide, clampPush, previewPush, commitPush,
  (hint) => {
    pushBtn.classList.toggle('active', pushTool.active);
    syncCursor();
    toolHint(hint);
  });
pushTool.unitConstraint = (t) => {
  const f = entity(t.key) as Feature3D | undefined;
  return f && t.face !== 'side' ? lockedPushUnits(f.tags, f.version) : undefined;
};
pushTool.onUnitBlocked = () => setStatus(tr('Единицы нельзя переключить: высота объекта задана только в метрах или только в этажах. Добавьте второй тег высоты в свойствах.'), true);
pushBtn.addEventListener('click', () => (pushTool.active ? pushTool.stop() : startPush()));
// Контур грани для подсветки при Shift: верх — по верху стен, низ — по основанию, стена — прямоугольник стены
pushTool.faceOutline = (t) => {
  const f = entity(t.key) as Feature3D | undefined;
  const polys = overpassLayer.focusPolygons(t.key);
  if (!f || !polys) return [];
  const h = drawnHeights(f);
  const at = (z: number) => (r: [number, number][]) => r.map(([x, y]) => new THREE.Vector3(x, y, z));
  if (t.face !== 'side') return polys.flatMap((p) => [p.outer, ...p.inners].map(at(t.face === 'top' ? h.wallTop : h.min)));
  const p = polys[t.edge!.poly];
  const ring = t.edge!.ring ? p?.inners[t.edge!.ring - 1] : p?.outer;
  if (!ring) return [];
  const [a, b] = [ring[t.edge!.i], ring[(t.edge!.i + 1) % ring.length]];
  // Над стеной — фронтон (или высокая сторона односкатной крыши): стена тянется вместе с ним
  const gable = overpassLayer.focusWallProfile(t.key, a, b, h.wallTop);
  return [[new THREE.Vector3(a[0], a[1], h.min), new THREE.Vector3(b[0], b[1], h.min), new THREE.Vector3(b[0], b[1], h.wallTop),
    ...gable, new THREE.Vector3(a[0], a[1], h.wallTop)]];
};
// Shift в «Вытянуть»: подсветить заднюю грань под курсором, пока клавиша зажата
let shiftHeld = false;
for (const type of ['keydown', 'keyup'] as const) {
  window.addEventListener(type, (e) => {
    if (e.key !== 'Shift' || shiftHeld === (type === 'keydown')) return;
    shiftHeld = type === 'keydown';
    if (pushTool.state === 'pick') pushTool.hover(lastPointer, shiftHeld);
  });
}
window.addEventListener('blur', () => { shiftHeld = false; if (pushTool.state === 'pick') pushTool.hover(undefined, false); });

/**
 * Высоты объекта, как он нарисован в режиме здания: часть без height и этажей там плоская (см. noDefaultHeight
 * в слое) — инструменты меряют от её основания, а не от высоты по умолчанию.
 */
function drawnHeights(f: Feature3D) {
  const h = computeHeights(f.tags);
  if (!focus || f.kind !== 'part' || h.source !== 'default') return h;
  return { ...h, wallTop: h.min, top: h.min, roofHeight: 0, roofShape: 'flat' };
}

function startPush() {
  if (!focus) return;
  moveTool.stop(); shapeTool.stop();
  splitTool.stop(); measureTool.stop(); rotateTool.stop(); scaleTool.stop(); paintTool.stop(); offsetTool.stop();
  drawTool.stop();
  pushTool.start();
}

// Инструмент «Форма» (V): вершины контура выделенной части — только в плане
const shapeBtn = focusToolbar.querySelector<HTMLButtonElement>('[data-tool="shape"]')!;
/** Части, которые правит «Форма»: выделенные видимые члены здания. */
const shapeSelected = () => selection.filter((k) => focus?.members.includes(k) && !hiddenInFocus(k));
/** Низ и верх стен части и высота крыши, м сцены (для «Формы»). */
function shapeWalls(key: string) {
  const f = entity(key) as Feature3D | undefined;
  if (!f?.polygons) return;
  // Плоский след (контур без building:part под частями) — высоту не рисуем, ручек высоты нет
  if (overpassLayer.focusFlat(key)) return { min: 0, top: 0, roof: 0 };
  const h = drawnHeights(f);
  return { min: h.min, top: Math.max(h.min, h.wallTop), roof: h.roofHeight };
}
const shapeTool = new ShapeTool(overpassLayer, map.getContainer(), shapeSelected, shapeWalls,
  () => new Set([...shapePreviewed, ...selection]),
  previewShape, commitShape, removeShapeVertex,
  (hint, error) => {
    shapeBtn.classList.toggle('active', shapeTool.active);
    syncCursor();
    toolHint(hint, error);
  });
shapeBtn.addEventListener('click', () => (shapeTool.active ? shapeTool.stop() : startShape()));
// Что меняет сдвиг ручки: «тег: было → станет» для панели инструмента
shapeTool.tagChanges = (t, dz) => {
  const f = entity(t.key) as Feature3D | undefined;
  if (!f) return '';
  const after = shapeHeightTags(f, t, dz);
  return Object.entries(diffTags(f.tags, after)).map(([k, v]) => `${esc(k)}: ${esc(f.tags[k] ?? '—')} → ${esc(v ?? '—')}`).join(' · ');
};


function startShape() {
  if (!focus) return;
  moveTool.stop(); pushTool.stop();
  splitTool.stop(); measureTool.stop(); rotateTool.stop(); scaleTool.stop(); paintTool.stop(); offsetTool.stop();
  drawTool.stop();
  shapeTool.start();
}

// Инструмент «Рассечь»: прямой разрез верхней грани делит путь на два (больший сохраняет историю)
const splitBtn = focusToolbar.querySelector<HTMLButtonElement>('[data-tool="split"]')!;
const splitTool = new SplitTool(overpassLayer, () => selectedKey, () => focus?.members ?? [], splitReason, splitFeature, cutHole, { range: sideCutRange, split: splitAtHeight }, (hint, error) => {
  splitBtn.classList.toggle('active', splitTool.active);
  syncCursor();
  toolHint(hint, error);
});
splitBtn.addEventListener('click', () => (splitTool.active ? splitTool.stop() : drawTool.active && drawTool.shape === 'line' ? drawTool.stop() : startSplit()));

function startSplit() {
  if (!focus) return;
  // План этажа: разрез ломаной по полу — помещения и пустая площадь
  if (shownLevel) {
    moveTool.stop(); shapeTool.stop(); pushTool.stop(); splitTool.stop();
    measureTool.stop(); rotateTool.stop(); scaleTool.stop(); paintTool.stop(); offsetTool.stop();
    select(undefined);
    drawTool.begin('line');
    return;
  }
  moveTool.stop(); shapeTool.stop();
  pushTool.stop();
  drawTool.stop();
  measureTool.stop(); rotateTool.stop(); scaleTool.stop();
  paintTool.stop();
  offsetTool.stop();
  splitTool.begin();
}

// Инструмент «Рулетка» (T): расстояние между двумя точками
const measureBtn = focusToolbar.querySelector<HTMLButtonElement>('[data-tool="measure"]')!;
const measureTool = new MeasureTool(overpassLayer, map.getContainer(), (hint) => {
  measureBtn.classList.toggle('active', measureTool.active && !measureTool.picking);
  for (const b of infoEl.querySelectorAll('[data-pick-direction]')) b.classList.toggle('active', measureTool.picking);
  syncCursor();
  toolHint(hint);
});
measureBtn.addEventListener('click', () => (measureTool.active ? measureTool.stop() : startMeasure()));

/** Направление ската двумя точками в 3D — для объектов формы, где нажата кнопка у поля roof:direction. */
function startDirectionPick(keys: string[]) {
  if (!focus) { setStatus(tr('Направление двумя точками задаётся в режиме здания.')); return; }
  moveTool.stop(); shapeTool.stop(); pushTool.stop(); splitTool.stop(); drawTool.stop(); paintTool.stop(); offsetTool.stop(); rotateTool.stop(); scaleTool.stop(); measureTool.stop();
  measureTool.startDirection((deg) => {
    const value = String(deg);
    const edits = keys.filter((k) => session.get(k) && session.get(k)!.tags['roof:direction'] !== value)
      .map((k) => ({ key: k, tags: { ...session.get(k)!.tags, 'roof:direction': value } }));
    if (edits.length === 1) session.setTags(edits[0].key, { 'roof:direction': value });
    else if (edits.length) session.editMany(edits);
    setStatus(tr('roof:direction={value}. Отменить — Ctrl+Z.', { value }));
  });
}

function startMeasure() {
  if (!focus) return;
  moveTool.stop(); shapeTool.stop(); pushTool.stop(); splitTool.stop(); drawTool.stop(); paintTool.stop(); offsetTool.stop(); rotateTool.stop(); scaleTool.stop();
  measureTool.start();
}

// Инструмент «Заливка» (B): Ctrl+клик — взять цвет и материал поверхности, клик — назначить
const paintBtn = focusToolbar.querySelector<HTMLButtonElement>('[data-tool="paint"]')!;
/** Цвет и материал поверхности (крыши или фасада): свои, иначе — с чем объект нарисован (унаследованные). */
function readSurface(key: string, face: PaintFace): PaintSample {
  const t = PAINT_TAGS[face];
  const own = entity(key)?.tags ?? {};
  const inh = (tag: string) => own[tag] ?? inheritSources(key).map((s) => inheritedValue(s.tags, tag)).find((v) => v !== undefined);
  return { from: face, colour: inh(t.colour), material: inh(t.material) };
}
const paintTool = new PaintTool(overpassLayer,
  (key) => !!focus?.members.includes(key) && !hiddenInFocus(key),
  readSurface,
  (key, face, sample) => {
    const t = PAINT_TAGS[face];
    if (!entity(key)) return;
    // Образец с фото — только цвет: материал поверхности оставляем как есть
    const photo = sample.from === 'photo';
    recordColour(sample.colour);
    session.setTags(key, photo ? { [t.colour]: sample.colour } : { [t.colour]: sample.colour, [t.material]: sample.material });
    const material = photo ? entity(key)?.tags[t.material] : sample.material;
    const params = { key, colour: sample.colour ?? '—', material: material ?? '—' };
    setStatus(face === 'roof'
      ? tr('Крыша {key}: цвет {colour}, материал {material}. Отменить — Ctrl+Z.', params)
      : tr('Фасад {key}: цвет {colour}, материал {material}. Отменить — Ctrl+Z.', params));
  },
  (hint, error) => {
    paintBtn.classList.toggle('active', paintTool.active);
    syncEyedropper();
    syncCursor();
    toolHint(hint, error);
  });
paintBtn.addEventListener('click', () => (paintTool.active ? paintTool.stop() : startPaint()));

function startPaint() {
  if (!focus) return;
  moveTool.stop(); shapeTool.stop(); pushTool.stop(); splitTool.stop(); drawTool.stop(); measureTool.stop(); rotateTool.stop(); scaleTool.stop(); offsetTool.stop();
  paintTool.start();
}

// Инструмент «Отступ» (O): от контура плоской крыши или низа (Shift) — новый плоский контур наружу или внутрь
const offsetBtn = focusToolbar.querySelector<HTMLButtonElement>('[data-tool="offset"]')!;
const offsetTool = new OffsetTool(overpassLayer, map.getContainer(),
  (point, back) => {
    const member = (k: string) => !!focus?.members.includes(k) && !hiddenInFocus(k);
    // Ребро (вершина, середина) верхнего или нижнего контура плоской грани — сразу эта грань
    const snap = overpassLayer.snapAt(point, member);
    if (snap && (snap.kind === 'edge' || snap.kind === 'vertex' || snap.kind === 'midpoint')) {
      const t = faceTarget(snap.key, [snap.local.x, snap.local.y], snap.local.z);
      if (t) return t;
    }
    const hits = overpassLayer.focusRayHits(point, member);
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
        return tr('Отступ — от плоской крыши (или Shift+клик — от низа).');
      }
      face = 'top';
    }
    const poly = nearestPoly(polys, [hits[0].local.x, hits[0].local.y]);
    return { key, face, z: face === 'top' ? box.max.z : box.min.z, ring: poly.outer, inners: poly.inners };
  },
  (t, shape) => {
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
    return shape.length === 1 && shape[0].length === 1 ? createDrawn(shape[0][0], t.z, out) : createDrawnMultipolygon(shape, t.z, out);
  },
  (hint, error) => {
    offsetBtn.classList.toggle('active', offsetTool.active);
    syncCursor();
    toolHint(hint, error);
  });
offsetBtn.addEventListener('click', () => (offsetTool.active ? offsetTool.stop() : startOffset()));

/**
 * Новая часть с дырами — мультиполигон: пути колец без тегов (outer / inner) и отношение type=multipolygon
 * с тегами части. Узлы — новые (у контура отступа общих с соседями нет).
 */
function createDrawnMultipolygon(shape: [number, number][][][], z: number, tags: Record<string, string>): string | undefined {
  if (!focus) return tr('Нет здания.');
  const ring = (pts: [number, number][]) => {
    const coords = pts.map((p) => overpassLayer.focusToLngLat(p[0], p[1])!);
    return { ids: coords.map(() => nextNewId--), coords };
  };
  const relId = nextNewId--;
  const key = `relation/${relId}`;
  const edits: Parameters<typeof session.editMany>[0] = [];
  const ways: MemberWay[] = [];
  const polygons: Polygon[] = [];
  const inners = shape.reduce((n, p) => n + p.length - 1, 0);
  for (const poly of shape) {
    const [o, ...ins] = poly.map(ring);
    polygons.push({ outer: o.coords, inners: ins.map((x) => x.coords), outerIds: o.ids, innerIds: ins.map((x) => x.ids) });
    for (const [r, role] of [[o, 'outer'], ...ins.map((x) => [x, 'inner'] as const)] as const) {
      const id = nextNewId--;
      const line = { ids: [...r.ids, r.ids[0]], coords: [...r.coords, r.coords[0]] };
      edits.push({ key: `way/${id}`, create: { key: `way/${id}`, version: 0, tags: {}, line } });
      ways.push({ id, role, nodes: line.ids });
    }
  }
  const part: Feature3D = { key, type: 'relation', id: relId, version: 0, kind: 'part', tags: { type: 'multipolygon', ...tags },
    polygons, hasParts: false, ways };
  edits.push({ key, create: { ...part, relMembers: ways.map((w) => ({ type: 'way' as const, ref: w.id, role: w.role })) } as Feature3D });
  const group = attachParts(edits, [{ type: 'relation', ref: relId }]);
  if (typeof group === 'string') return group;
  session.editMany(edits);
  if (group) enterFocus(group);
  select(key);
  setStatus(tr('Создана часть {key} (мультиполигон: частей {parts}, внутренних колец {inners}). Высоту задайте «Вытянуть» (P).', { key, parts: shape.length, inners }));
  return;
}

/** Внешний контур полигона, внутри которого точка (или ближайший к ней — точка на ребре). */
function nearestPoly<P extends { outer: [number, number][]; inners: [number, number][][] }>(polys: P[], at: [number, number]): P {
  const inside = polys.find((p) => pointInRing(at, p.outer));
  if (inside) return inside;
  let best = polys[0], bd = Infinity;
  for (const p of polys) for (const ring of [p.outer, ...p.inners]) for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((at[0] - a[0]) * dx + (at[1] - a[1]) * dy) / l2));
    const d = Math.hypot(at[0] - a[0] - dx * t, at[1] - a[1] - dy * t);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}

/** Грань объекта key по точке на её ребре: верх плоской крыши или низ (по высоте z). */
function faceTarget(key: string, at: [number, number], z: number): OffsetTarget | undefined {
  const box = overpassLayer.focusItemBox(key);
  const polys = overpassLayer.focusPolygons(key);
  const f = entity(key) as Feature3D | undefined;
  if (!box || !polys?.length || !f) return;
  const shape = f.tags['roof:shape'];
  const top = Math.abs(z - box.max.z) < 0.05 && (!shape || shape === 'flat');
  const bottom = Math.abs(z - box.min.z) < 0.05;
  if (!top && !bottom) return;
  const poly = nearestPoly(polys, at);
  return { key, face: top ? 'top' : 'bottom', z: top ? box.max.z : box.min.z, ring: poly.outer, inners: poly.inners };
}

function startOffset() {
  if (!focus) return;
  moveTool.stop(); shapeTool.stop(); pushTool.stop(); splitTool.stop(); drawTool.stop(); measureTool.stop(); rotateTool.stop(); scaleTool.stop(); paintTool.stop();
  offsetTool.start();
}

/**
 * Универсальная пипетка (src/edit/eyedropper.ts): у заливки — образец (Ctrl/Cmd/Alt+клик; пока образца нет — любой
 * клик), у цветового поля в свойствах — кнопкой рядом с ним. Здание на карте — его цвет, иначе — пиксели под курсором.
 */
const eyedropper = new Eyedropper(
  {
    el: map.getCanvasContainer(),
    pixels: (x, y, R) => {
      map.redraw(); // кадр рисуем сейчас — буфер WebGL читаем в той же задаче
      const c = map.getCanvas();
      const gl = (c.getContext('webgl2') ?? c.getContext('webgl')) as WebGL2RenderingContext | null;
      return gl ? glPixels(gl, x, y, R, map.getPixelRatio()) : undefined;
    },
  },
  [{ el: photoViewer.photoEl, pixels: (x, y, R) => photoViewer.pixelsAt(x, y, R) }],
  (x, y) => {
    if (focus) {
      const hit = overpassLayer.focusRayHits([x, y], (key) => !hiddenInFocus(key))[0];
      return hit && { key: hit.key, face: hit.face === 'wall' ? 'wall' : 'roof' };
    }
    const key = overpassLayer.pick(new maplibregl.Point(x, y));
    return key ? { key } : undefined;
  },
  () => syncCursor(),
);
/** Пипетка цветового поля в свойствах: тег, в который пишем взятый цвет. */
let fieldPick: string | undefined;

function syncEyedropper() {
  if (fieldPick) return; // режим поля главнее — после него вернёмся сюда
  eyedropper.set(paintTool.active ? {
    modifier: !!paintTool.sample, // пока образца нет — берём любым кликом
    building: (key, face) => paintTool.pickBuilding(key, face ?? 'wall'),
    colour: (c) => paintTool.pickColour(c),
  } : undefined);
}

/** Кнопка-пипетка у цветового поля: следующий клик — цвет в это поле. */
function startFieldPick(tag: string) {
  fieldPick = tag;
  const swatch = () => infoEl.querySelector(`[data-picker-for="${CSS.escape(tag)}"]`);
  swatch()?.classList.add('picking');
  const end = () => { fieldPick = undefined; swatch()?.classList.remove('picking'); toolHint(''); syncEyedropper(); };
  const put = (c: string) => { end(); putFieldColour(tag, c); };
  // Поверхность — по тегу поля (крыша или фасад), иначе — куда кликнули
  const face = (hit: PaintFace | undefined): PaintFace => (tag.startsWith('roof:') ? 'roof' : tag.startsWith('building:') ? 'wall' : hit ?? 'wall');
  eyedropper.set({
    modifier: false,
    building: (key, hit) => {
      const c = readSurface(key, face(hit)).colour;
      if (c) put(c);
      else { end(); setStatus(tr('У {key} цвет не задан.', { key })); }
    },
    colour: put,
    cancel: end,
  });
  toolHint(pickFieldHint());
}
// Последние использованные цвета (окно выбора цвета): что записали в цветовое поле — текстом, палитрой, пипеткой
void loadRecentColours();
infoEl.addEventListener('change', (e) => {
  const el = e.target as HTMLInputElement;
  const v = el.dataset.type === 'colour' || el.dataset.pickerFor ? el.value.trim() : '';
  if (v && CSS.supports('color', v)) recordColour(v);
});

/** Записать цвет в поле свойств (через текстовое поле — как ввод руками). */
function putFieldColour(tag: string, c: string) {
  const text = infoEl.querySelector<HTMLInputElement>(`.colour-field [data-tag="${CSS.escape(tag)}"]`);
  if (!text) return;
  text.value = c;
  text.dispatchEvent(new Event('change', { bubbles: true }));
}
// Плашка цвета в свойствах: вместо системного окна — своё, с универсальной пипеткой (системную подменить нельзя);
// системное — пунктом «Другой цвет…»
infoEl.addEventListener('click', (e) => {
  const picker = (e.target as HTMLElement).closest<HTMLInputElement>('input[type="color"][data-picker-for]');
  if (!picker) return;
  e.preventDefault();
  const tag = picker.dataset.pickerFor!;
  if (fieldPick === tag) { fieldPick = undefined; picker.classList.remove('picking'); toolHint(''); syncEyedropper(); return; }
  openColourPopover(picker, picker, { pick: (c) => putFieldColour(tag, c), eyedropper: () => startFieldPick(tag) });
});

/** Курсор над картой — по включённому инструменту; у заливки — пипетка, пока нет образца или зажат Ctrl/Cmd/Alt. */
let pickModifier = false;
function syncCursor() {
  const tool: ToolCursor | undefined = moveTool.active || entranceDrag ? 'move' : rotateTool.active ? 'rotate' : scaleTool.active ? 'scale' : pushTool.active ? 'push' : shapeTool.active ? 'shape' : splitTool.active ? 'split'
    : pointPick ? 'measure' : drawTool.active ? (drawTool.shape === 'line' ? 'split' : drawTool.shape) : measureTool.active ? 'measure' : offsetTool.active ? 'offset'
    : paintTool.active ? (pickModifier || !paintTool.sample ? 'pick' : 'paint') : undefined;
  setToolCursor(map.getCanvasContainer(), fieldPick ? 'pick' : tool);
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
/**
 * Инструмент посреди действия (тянут, режут, рисуют): подменять данные под ним нельзя. Включённый, но ждущий
 * (перемещение в режиме здания включено всегда) — можно: иначе в режиме здания не доходили бы правки из JOSM.
 */
function toolBusy(): boolean {
  return moveTool.state === 'move' || pushTool.state === 'push' || shapeTool.state === 'drag' || rotateTool.state === 'ref' || rotateTool.state === 'rotate' || scaleTool.busy
    || offsetTool.state === 'offset' || splitTool.state === 'cut' || drawTool.active || measureTool.state === 'second' || !!copyPick;
}

function toolActive(): boolean {
  return pointPick || toolActiveExceptPoint();
}

function toolActiveExceptPoint(): boolean {
  return moveTool.active || pushTool.active || shapeTool.active || splitTool.active || drawTool.active || measureTool.active || rotateTool.active || scaleTool.active || paintTool.active || offsetTool.active || !!copyPick || !!entranceDrag;
}

// Инструменты «Прямоугольник» (R) и «Полигон» (L): новая часть здания — плоский контур нулевой толщины
const rectBtn = focusToolbar.querySelector<HTMLButtonElement>('[data-tool="rect"]')!;
const polyBtn = focusToolbar.querySelector<HTMLButtonElement>('[data-tool="polygon"]')!;
// «Круг» (C) и «Правильный многоугольник» (N): центр и точка на окружности; число углов — в поле у инструмента
const circleBtn = focusToolbar.querySelector<HTMLButtonElement>('[data-tool="circle"]')!;
const ngonBtn = focusToolbar.querySelector<HTMLButtonElement>('[data-tool="ngon"]')!;
map.on('move', () => { if (drawTool.active) drawTool.relabel(); });
const drawTool = new DrawTool(overpassLayer, map.getContainer(), createDrawn, (hint, error) => {
  // Инструмент выключили посреди наброска (Esc, пробел) — набросок тоже
  if (!drawTool.active && sketching) endSketch();
  else syncMapTools();
  rectBtn.classList.toggle('active', drawTool.active && drawTool.shape === 'rect');
  syncRectIcons();
  polyBtn.classList.toggle('active', drawTool.active && drawTool.shape === 'polygon');
  circleBtn.classList.toggle('active', drawTool.active && drawTool.shape === 'circle');
  ngonBtn.classList.toggle('active', drawTool.active && drawTool.shape === 'ngon');
  splitBtn.classList.toggle('active', splitTool.active || (drawTool.active && drawTool.shape === 'line'));
  try { localStorage.setItem('ngon-sides', String(drawTool.sides)); } catch { /* нет хранилища */ }
  syncCursor();
  toolHint(hint, error);
});
rectBtn.addEventListener('click', () => toggleDraw('rect'));
polyBtn.addEventListener('click', () => toggleDraw('polygon'));
circleBtn.addEventListener('click', () => toggleDraw('circle'));
ngonBtn.addEventListener('click', () => toggleDraw('ngon'));
try { const n = Number(localStorage.getItem('ngon-sides')); if (n) drawTool.sides = n; } catch { /* нет хранилища */ }
// На плане этажа рисуем в плоскости его пола
drawTool.plane = () => (focus && shownLevel ? shownLevel.floor : undefined);


// Новое здание прямо с карты: «Прямоугольник» и «Полигон» рисуют контур на земле поверх карты (набросок),
// готовый контур — отдельное здание building=yes нулевой высоты; сразу открывается в режиме здания с «Вытянуть»
const mapToolbar = document.getElementById('map-tools')!;
const mapRectBtn = mapToolbar.querySelector<HTMLButtonElement>('[data-tool="rect"]')!;
const mapPolyBtn = mapToolbar.querySelector<HTMLButtonElement>('[data-tool="polygon"]')!;
let sketching = false;
mapRectBtn.addEventListener('click', () => toggleSketch('rect'));
mapPolyBtn.addEventListener('click', () => toggleSketch('polygon'));
const mapCircleBtn = mapToolbar.querySelector<HTMLButtonElement>('[data-tool="circle"]')!;
const mapNgonBtn = mapToolbar.querySelector<HTMLButtonElement>('[data-tool="ngon"]')!;
mapCircleBtn.addEventListener('click', () => toggleSketch('circle'));
mapNgonBtn.addEventListener('click', () => toggleSketch('ngon'));

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
  for (const [btn, part] of [[rectBtn, true], [mapRectBtn, false]] as const) {
    btn.innerHTML = `${rectSvg(drawTool.rectMode)}<span class="flyout-arrow" data-flyout title="${tr('Способ построения')}"></span>`;
    const tool = RECT_TITLES[drawTool.rectMode];
    btn.title = part
      ? tr('{tool}: новая часть (R; Tab или стрелка в углу — способ построения)', { tool })
      : tr('{tool}: новое здание (R; Tab или стрелка в углу — способ построения)', { tool });
  }
  try { localStorage.setItem('rect-mode', drawTool.rectMode); } catch { /* нет хранилища */ }
}
function openRectFlyout(btn: HTMLButtonElement, start: () => void) {
  closeRectFlyout();
  const fly = document.createElement('div');
  fly.className = 'tool-flyout';
  fly.innerHTML = RECT_MODES.map((m) => `<button type="button" data-mode="${m}" class="${m === drawTool.rectMode ? 'active' : ''}" title="${RECT_TITLES[m]}">${rectSvg(m)}<span>${RECT_LABELS[m]}</span></button>`).join('');
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
  placeFlyout(fly, btn);
  rectFlyout = fly;
}

/** Отступ всплывашки от краёв окна, px. */
const FLYOUT_MARGIN = 8;

/**
 * Всплывашка у кнопки — вровень с ней, но целиком в окне: у нижнего края сдвигается вверх, а не выше окна —
 * ограничивается по высоте с прокруткой внутри (иначе у страницы появляется прокрутка).
 */
function placeFlyout(fly: HTMLElement, btn: HTMLElement) {
  const pr = btn.offsetParent!.getBoundingClientRect();
  const want = btn.getBoundingClientRect().top;
  fly.style.maxHeight = `${innerHeight - 2 * FLYOUT_MARGIN}px`;
  fly.style.overflowY = 'auto';
  const h = fly.getBoundingClientRect().height;
  const top = Math.max(FLYOUT_MARGIN, Math.min(want, innerHeight - FLYOUT_MARGIN - h));
  fly.style.top = `${top - pr.top}px`;
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

// Способ построения круга — так же: всплывашка у кнопки, Tab — следующий способ
const CIRCLE_ICONS: Record<CircleMode, string> = {
  center: '<circle cx="10" cy="10" r="7"/><circle cx="10" cy="10" r="1.2" fill="currentColor"/>',
  corner: '<circle cx="10.5" cy="9.5" r="6"/><path d="M3 2.5v14.5h14.5" stroke-width="1.3"/>',
  three: '<circle cx="10" cy="10" r="7"/><circle cx="4" cy="6.4" r="1.4" fill="currentColor"/><circle cx="16" cy="6.4" r="1.4" fill="currentColor"/><circle cx="10" cy="17" r="1.4" fill="currentColor"/>',
};
const circleSvg = (m: CircleMode) => `<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round">${CIRCLE_ICONS[m]}</svg>`;
try { const m = localStorage.getItem('circle-mode') as CircleMode | null; if (m && CIRCLE_MODES.includes(m)) drawTool.circleMode = m; } catch { /* нет хранилища */ }
function syncCircleIcons() {
  for (const [btn, part] of [[circleBtn, true], [mapCircleBtn, false]] as const) {
    btn.innerHTML = `${circleSvg(drawTool.circleMode)}<span class="flyout-arrow" data-flyout title="${tr('Способ построения')}"></span>`;
    const tool = CIRCLE_TITLES[drawTool.circleMode];
    btn.title = part
      ? tr('{tool}: новая часть (C; Tab или стрелка в углу — способ построения)', { tool })
      : tr('{tool}: новое здание (C; Tab или стрелка в углу — способ построения)', { tool });
  }
  try { localStorage.setItem('circle-mode', drawTool.circleMode); } catch { /* нет хранилища */ }
}
drawTool.onModeChange = syncCircleIcons;
for (const [btn, start] of [[circleBtn, () => startDraw('circle')], [mapCircleBtn, () => startSketch('circle')]] as const) {
  btn.addEventListener('click', (e) => {
    if (!(e.target as HTMLElement).closest('[data-flyout]')) { closeRectFlyout(); return; }
    e.stopImmediatePropagation();
    if (rectFlyout && rectFlyout.previousElementSibling === btn) { closeRectFlyout(); return; }
    closeRectFlyout();
    const fly = document.createElement('div');
    fly.className = 'tool-flyout';
    fly.innerHTML = CIRCLE_MODES.map((m) => `<button type="button" data-mode="${m}" class="${m === drawTool.circleMode ? 'active' : ''}" title="${CIRCLE_TITLES[m]}">${circleSvg(m)}<span>${CIRCLE_LABELS[m]}</span></button>`).join('');
    fly.addEventListener('click', (ev) => {
      const m = (ev.target as HTMLElement).closest<HTMLElement>('[data-mode]')?.dataset.mode as CircleMode | undefined;
      if (!m) return;
      ev.stopPropagation();
      closeRectFlyout();
      drawTool.setCircleMode(m);
      syncCircleIcons();
      if (!(drawTool.active && drawTool.shape === 'circle')) start();
    });
    btn.after(fly);
    placeFlyout(fly, btn);
    rectFlyout = fly;
  }, true);
}
syncCircleIcons();

// Подложки на карте: «Переместить», «Повернуть», «Масштаб» — в сцене наброска вокруг подложки (как рисование здания)
const mapUMoveBtn = mapToolbar.querySelector<HTMLButtonElement>('[data-tool="umove"]')!;
const mapURotateBtn = mapToolbar.querySelector<HTMLButtonElement>('[data-tool="urotate"]')!;
const mapUScaleBtn = mapToolbar.querySelector<HTMLButtonElement>('[data-tool="uscale"]')!;
/** Сцена наброска открыта для инструментов подложек на карте. */
let underlaySketch = false;
mapUMoveBtn.addEventListener('click', () => (moveTool.active ? moveTool.stop() : startMapUnderlayTool('move')));
mapURotateBtn.addEventListener('click', () => (rotateTool.active ? rotateTool.stop() : startMapUnderlayTool('rotate')));
mapUScaleBtn.addEventListener('click', () => (scaleTool.active ? scaleTool.stop() : startMapUnderlayTool('scale')));

/** Инструмент для выделенных подложек на карте: сцена наброска с началом в первой из них. */
function startMapUnderlayTool(tool: 'move' | 'rotate' | 'scale') {
  const ids = [...underlaySelection];
  const u = currentUnderlays().find((x) => ids.includes(x.id));
  if (focus || !u) return;
  cancelCopyPick();
  drawTool.stop(); moveTool.stop(); rotateTool.stop(); scaleTool.stop(); measureTool.stop();
  if (!underlaySketch) {
    overpassLayer.setSketch(u.center);
    underlaySketch = true;
    // Кнопка привязок (панель режима здания скрыта) — на время инструментов на панель карты, как при смещении снимка
    mapToolbar.querySelector('[data-help]')!.before(snapsBtn);
  }
  if (tool === 'move') moveTool.start([], false, ids);
  else if (tool === 'rotate') rotateTool.start([], ids);
  else scaleTool.start([], ids);
  syncMapTools();
}

// Инструменты подложек на карте прилипают к контурам зданий карты (вершины и середины сторон на земле)
overpassLayer.sketchSnap = (pt) => {
  if (!underlaySketch) return;
  const s = snapGround(pt), local = s && overpassLayer.focusToLocal([s.lngLat.lng, s.lngLat.lat]);
  if (!s || !local) return;
  return { kind: s.kind as SnapKind, key: '', local: new THREE.Vector3(local[0], local[1], 0), lngLat: s.lngLat, altitude: 0, point: s.point, label: s.label };
};

/** Инструменты подложек на карте выключены — закрыть их сцену наброска. */
function endUnderlaySketch() {
  if (!underlaySketch || moveTool.active || rotateTool.active || scaleTool.active) return;
  underlaySketch = false;
  overpassLayer.setSketch(undefined);
  if (snapsBtn.parentElement === mapToolbar) focusToolbar.querySelector('[data-help]')!.before(snapsBtn);
  updateSnap(undefined);
  syncMapTools();
}

function toggleSketch(shape: DrawShape) {
  if (sketching && drawTool.shape === shape) return drawTool.stop();
  startSketch(shape);
}

function startSketch(shape: DrawShape) {
  if (focus) return startDraw(shape);
  if (map.getZoom() < 15) return setStatus(tr('Приблизьте карту (z ≥ 15), чтобы нарисовать здание.'), true);
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
  // Инструменты подложек на карте — только когда выделена подложка
  const u = !focus && underlaySelection.length > 0;
  for (const [btn, on] of [[mapUMoveBtn, moveTool.active], [mapURotateBtn, rotateTool.active], [mapUScaleBtn, scaleTool.active]] as const) {
    btn.hidden = !u;
    btn.classList.toggle('active', underlaySketch && on);
  }
  renderHelp();
  mapRectBtn.classList.toggle('active', sketching && drawTool.shape === 'rect');
  mapPolyBtn.classList.toggle('active', sketching && drawTool.shape === 'polygon');
  mapCircleBtn.classList.toggle('active', sketching && drawTool.shape === 'circle');
  mapNgonBtn.classList.toggle('active', sketching && drawTool.shape === 'ngon');
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
    setStatus(tr('Новое здание {key}. Задайте высоту: клик по крыше и тяните вверх (или число + Enter).', { key }));
  });
  return;
}

function toggleDraw(shape: DrawShape) {
  if (drawTool.active && drawTool.shape === shape) return drawTool.stop();
  startDraw(shape);
}

function startDraw(shape: DrawShape) {
  if (!focus) return;
  moveTool.stop(); shapeTool.stop();
  pushTool.stop();
  splitTool.stop(); measureTool.stop(); rotateTool.stop(); scaleTool.stop(); paintTool.stop(); offsetTool.stop();
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
  if (drawTool.shape === 'line') return cutPlan(ring);
  if (focus && shownLevel && !tagsFor) return createIndoorDrawn(ring);
  if (!focus) return tr('Нет здания.');
  const lngLat = (p: [number, number]) => overpassLayer.focusToLngLat(p[0], p[1])!;
  // Кандидаты на общие узлы — пути рядом с контуром (грубый отбор по габаритам в градусах)
  const ll = ring.map(lngLat);
  const pad = 2e-5;
  const [w, so, e, n] = [Math.min(...ll.map((c) => c[0])) - pad, Math.min(...ll.map((c) => c[1])) - pad, Math.max(...ll.map((c) => c[0])) + pad, Math.max(...ll.map((c) => c[1])) + pad];
  // Сторона рядом — её габариты пересекают габариты контура (у длинной стороны концы бывают далеко)
  const near = (a: LonLat, b: LonLat) => Math.max(a[0], b[0]) >= w && Math.min(a[0], b[0]) <= e && Math.max(a[1], b[1]) >= so && Math.min(a[1], b[1]) <= n;
  const rings: { ids: number[]; pts: [number, number][]; coords: LonLat[] }[] = [];
  const seen = new Set<string>();
  for (const f of [...focus.members.map((k) => entity(k) as Feature3D | undefined), ...overpass.allFeatures()]) {
    if (!f?.polygons || seen.has(f.key) || !f.key.startsWith('way/')) continue;
    seen.add(f.key);
    const cur = (session.has(f.key) ? session.get(f.key) as Feature3D : f);
    adoptNodeIds(cur);
    for (const p of cur.polygons) {
      if (!p.outerIds || !p.outer.some((c, i) => near(c, p.outer[(i + 1) % p.outer.length]))) continue;
      rings.push({ ids: p.outerIds, coords: p.outer, pts: p.outer.map((c) => overpassLayer.focusToLocal(c)!) });
    }
  }
  // Координаты узлов соседних колец — для вставки новых узлов на их стороны
  const coord = new Map<number, LonLat>(rings.flatMap((r) => r.ids.map((id, i) => [id, r.coords[i]] as const)));
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
        if (segDist2(q, a, b) >= SHARE_EPS) continue;
        // У самого угла стороны — сам угол, а не новый узел рядом с ним (вычисленный угол прямоугольника ложится
        // в сантиметрах от угла соседа; двойник рядом потом рвал контур соседа при вытягивании)
        const near = Math.sqrt(SHARE_EPS);
        if (Math.hypot(q[0] - a[0], q[1] - a[1]) < near) { coord.delete(id); coord.set(r.ids[k], r.coords[k]); return r.ids[k]; }
        if (Math.hypot(q[0] - b[0], q[1] - b[1]) < near) { const j = (k + 1) % r.pts.length; coord.delete(id); coord.set(r.ids[j], r.coords[j]); return r.ids[j]; }
        fresh.push({ id, p: q, u: r.ids[k], v: r.ids[(k + 1) % r.ids.length] });
        return id;
      }
    }
    return id;
  });
  if (new Set(ids).size !== ids.length) return tr('Две точки контура попали в один узел.');
  const wayId = nextNewId--;
  const key = `way/${wayId}`;
  const neighbours = insertIntoNeighbours(key, fresh, coord);
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
    ...neighbours,
  ];
  const group = attachParts(edits, [wayId]);
  if (typeof group === 'string') return group;
  session.editMany(edits);
  if (group) enterFocus(group);
  select(key);
  const shared = ids.filter((id) => id > 0).length;
  setStatus(shared || fresh.length
    ? tr('Создана часть {key} (общих узлов: {shared}, новых на сторонах соседей: {fresh}). Высоту задайте «Вытянуть» (P).', { key, shared, fresh: fresh.length })
    : tr('Создана часть {key}. Высоту задайте «Вытянуть» (P).', { key }));
  return;
}

/**
 * Добавить новые пути частями здания режима: в его отношение, а у отдельного здания — в новое отношение
 * (исходный путь — контур). Правки дописываются в edits; созданное отношение возвращается (в него потом входим).
 */
function attachParts(edits: Parameters<typeof session.editMany>[0], wayIds: (number | { type: 'way' | 'relation'; ref: number })[]): EditGroup | undefined | string {
  if (!focus) return tr('Нет здания.');
  const parts = wayIds.map((m) => (typeof m === 'number' ? { type: 'way' as const, ref: m, role: 'part' } : { ...m, role: 'part' }));
  if (isSolo(focus)) {
    const relId = nextNewId--;
    // Части, найденные внутри контура без отношения, тоже входят в новое отношение
    const own = focus.members.flatMap((k, i) => {
      if (i > 0 && focus!.roles[i] !== 'part') return [];
      const [type, ref] = k.split('/');
      return [{ type: type as 'way' | 'relation', ref: Number(ref), role: i ? 'part' : 'outline' }];
    });
    const relMembers = [...own, ...parts];
    const group: EditGroup = { key: `relation/${relId}`, type: 'relation', id: relId, version: 0, tags: { type: 'building' },
      members: relMembers.map((m) => `${m.type}/${m.ref}`), roles: relMembers.map((m) => m.role), relMembers };
    editGroups.set(group.key, group);
    edits.push({ key: group.key, create: group });
    return group;
  }
  const g = entity(focus.key) as EditGroup | undefined;
  if (!g) return tr('Отношение здания не найдено.');
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
  if (!items.length) return setStatus(keys.length ? tr('Копируются только части-пути (не контур здания и не мультиполигоны).') : tr('Выберите части здания, затем Ctrl+C.'), true);
  moveTool.stop(); shapeTool.stop(); pushTool.stop(); splitTool.stop(); measureTool.stop(); rotateTool.stop(); scaleTool.stop(); paintTool.stop(); offsetTool.stop(); drawTool.stop();
  copyPick = { items };
  setStatus(skipped
    ? tr('Копирование ({n}, пропущено {skipped} — контур или мультиполигон): кликните базовую точку — за неё копия будет привязана к курсору при вставке. Esc — отмена.', { n: items.length, skipped })
    : tr('Копирование ({n}): кликните базовую точку — за неё копия будет привязана к курсору при вставке. Esc — отмена.', { n: items.length }));
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
  if (!p) return setStatus(tr('Кликните по точке здания или земли.'), true);
  const ll = overpassLayer.focusToLngLat(p.x, p.y);
  if (!ll) return;
  clipboard = { items: copyPick.items, base: { lngLat: ll, z: p.z } };
  copyPick = undefined;
  updateSnap(undefined);
  setStatus(tr('Скопировано частей: {n}. Ctrl+V — вставить (копия поедет за курсором).', { n: clipboard.items.length }));
}

function cancelCopyPick() {
  if (!copyPick) return;
  copyPick = undefined;
  updateSnap(undefined);
  setStatus(tr('Копирование отменено.'));
}

/**
 * Ctrl+V в режиме здания: копии частей новыми путями (свои узлы, без общих с соседями) в отношение здания,
 * сразу привязаны к курсору за базовую точку; клик — место базовой точки. Esc — вставка отменяется целиком.
 */
function pasteClipboard() {
  if (!focus || !clipboard) return setStatus(tr('Буфер пуст: выберите части, Ctrl+C и клик по базовой точке.'), true);
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
  pushTool.stop(); shapeTool.stop(); splitTool.stop(); measureTool.stop(); rotateTool.stop(); scaleTool.stop(); paintTool.stop(); offsetTool.stop(); drawTool.stop();
  moveTool.drag(keys, new THREE.Vector3(b[0], b[1], clipboard.base.z),
    tr('Вставка ({n}): кликните, куда поставить базовую точку. Shift/стрелки — ось, число + Enter — сдвиг. Esc — отмена вставки.', { n: keys.length }),
    () => setStatus(tr('Вставлено частей: {n}.', { n: keys.length })),
    () => { selectAfterHistory(session.undo()); setStatus(tr('Вставка отменена.')); });
}

function segDist2([px, py]: [number, number], [ax, ay]: [number, number], [bx, by]: [number, number]): number {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

/** Почему объект нельзя рассечь (undefined — можно). */
function splitReason(key: string): string | undefined {
  if (isSolo(focus) && key !== focus!.members[0] && focus!.roles[focus!.members.indexOf(key)] !== 'part') return tr('Копию режьте отдельно: выйдите и откройте её двойным кликом.');
  if (!focus?.members.includes(key) || hiddenInFocus(key)) return tr('Резать можно только части этого здания.');
  const f = entity(key) as Feature3D | undefined;
  if (!f?.polygons) return tr('Объект не найден.');
  if (f.type === 'relation' && (f.tags.type !== 'multipolygon' || !relWays(f))) return tr('Для рассечения нужны пути-члены мультиполигона — перезагрузите видимые тайлы.');
  // Контур здания (outline): только вырезать кольцо (splitFeatureIn), плоскому следу крыша не мешает
  const outline = isOutlineIn(focus, key);
  const shape = f.tags['roof:shape'];
  const h = computeHeights(f.tags);
  if (!(outline && overpassLayer.focusFlat(key)) && shape && shape !== 'flat' && h.top - h.min > 0.1) return tr('Резать можно плоский объект или с плоской крышей, здесь roof:shape={shape}.', { shape });
  if (!nodeIds(f)) return tr('В кеше нет id узлов этого объекта — нажмите «Перезагрузить видимые тайлы» в настройках графики.');
  return;
}

/** key — контур (роль outline) здания g. */
function isOutlineIn(g: BuildingGroup | undefined, key: string): boolean {
  return !!g && g.members.some((k, i) => k === key && g.roles[i] === 'outline');
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
function splitFeature(key: string, a: CutPoint, b: CutPoint, bends: [number, number][]): string | undefined {
  // Здание без отношения: отношение из контура и частей создаётся тем же шагом, что и разрез
  const pending = isSolo(focus) && focus!.roles.includes('part') ? implicitRelation(focus!.members[0], implicitParts(focus!)) : undefined;
  const result = splitFeatureIn(key, a, b, bends, pending);
  if (pending && !session.get(pending.key)) editGroups.delete(pending.key);
  return result;
}

/** Горизонтальный разрез с бокового ребра: высоты стен объекта в сцене и отметки привязки; строка — почему нельзя. */
function sideCutRange(key: string): SideRange | string {
  if (isSolo(focus) && key !== focus!.members[0] && focus!.roles[focus!.members.indexOf(key)] !== 'part') return tr('Копию режьте отдельно: выйдите и откройте её двойным кликом.');
  if (!focus?.members.includes(key) || hiddenInFocus(key)) return tr('Резать можно только части этого здания.');
  const f = entity(key) as Feature3D | undefined;
  const box = overpassLayer.focusItemBox(key);
  if (!f?.polygons || !box) return tr('Объект не найден.');
  if (overpassLayer.focusFlat(key) || (isOutlineIn(focus, key) && !isSolo(focus)) || (isSolo(focus) && key === focus.members[0] && focus.roles.includes('part')))
    return tr('Контур здания (outline) по высоте не делится — режьте его части.');
  if (f.type === 'relation' && (f.tags.type !== 'multipolygon' || !relWays(f))) return tr('Для рассечения нужны пути-члены мультиполигона — перезагрузите видимые тайлы.');
  if (!nodeIds(f)) return tr('В кеше нет id узлов этого объекта — нажмите «Перезагрузить видимые тайлы» в настройках графики.');
  const h = computeHeights(f.tags);
  const base = box.min.z - h.min;
  const lo = box.min.z, hi = base + h.wallTop;
  if (hi - lo < 0.1) return tr('У объекта нет стен — делить по высоте нечего.');
  const marks: SideRange['marks'] = [];
  const levels = Number(f.tags['building:levels']), minLevel = Number(f.tags['building:min_level'] ?? 0);
  if (Number.isFinite(levels) && Number.isFinite(minLevel) && levels - minLevel > 1 && levels - minLevel <= 200) {
    const step = (h.wallTop - h.min) / (levels - minLevel);
    for (let k = 1; k < levels - minLevel; k++) marks.push({ z: lo + k * step, label: tr('Этаж {n}', { n: minLevel + k + 1 }) });
  }
  // Вровень с соседними частями: их низ, верх стен и верх
  for (const other of focus.members) {
    const ob = other !== key && !hiddenInFocus(other) ? overpassLayer.focusItemBox(other) : undefined;
    const of = ob && (entity(other) as Feature3D | undefined);
    if (!ob || !of?.tags) continue;
    const oh = computeHeights(of.tags);
    for (const z of [ob.min.z, ob.min.z - oh.min + oh.wallTop, ob.max.z]) marks.push({ z, label: tr('Вровень с {key}', { key: other }) });
  }
  const roofBase = h.roofHeight > 0.05 && h.top - h.wallTop > 0.05 ? tr('Основание крыши') : undefined;
  return { lo, hi, marks: marks.filter((m) => m.z > lo + 0.05 && m.z < hi - 0.05), roofBase };
}

/**
 * Рассечь объём по высоте z (метры сцены): нижняя часть — исходный объект (без крыши), верхняя — новая часть
 * на тех же узлах (путь или мультиполигон с теми же путями-членами), с крышей. Отдельное здание — как у разреза:
 * контур остаётся, обе части — в новом отношении здания. Одним шагом истории.
 */
function splitAtHeight(key: string, z: number): string | undefined {
  const pending = isSolo(focus) && focus!.roles.includes('part') ? implicitRelation(focus!.members[0], implicitParts(focus!)) : undefined;
  const result = splitAtHeightIn(key, z, pending);
  if (pending && !session.get(pending.key)) editGroups.delete(pending.key);
  return result;
}

function splitAtHeightIn(key: string, z: number, pending: EditGroup | undefined): string | undefined {
  const f = entity(key) as Feature3D | undefined;
  const solo = isSolo(focus) && !pending;
  const g = pending ?? (focus && !solo ? (entity(focus.key) as EditGroup | undefined) : undefined);
  if (!f || (!g && !solo)) return tr('Объект не найден.');
  const range = sideCutRange(key);
  if (typeof range === 'string') return range;
  // По основанию скатной крыши — тоже: объём без крыши и крыша без стен
  const roofCut = !!range.roofBase && Math.abs(z - range.hi) < 0.05;
  if (z <= range.lo + 0.05 || (z >= range.hi - 0.05 && !roofCut)) return tr('Разрез по высоте — между низом и верхом стен.');
  const h = computeHeights(f.tags);
  const at = roofCut ? h.wallTop : h.min + (z - range.lo);
  const source: Record<string, string> = solo ? { 'building:part': 'yes' } : { ...f.tags };
  if (solo) for (const [k, v] of Object.entries(f.tags)) if (PART_TAGS.test(k)) source[k] = v;
  const { lower, upper } = heightSplitTags(source, at, computeHeights(source));
  // Мультиполигон: та же разметка путей-членов у второго отношения
  const members = f.type === 'relation' ? (session.get(f.key)?.relMembers ?? f.ways?.map((w) => ({ type: 'way' as const, ref: w.id, role: w.role })))?.filter((m) => m.type === 'way') : undefined;
  if (f.type === 'relation' && !members?.length) return tr('Для рассечения нужны пути-члены мультиполигона — перезагрузите видимые тайлы.');
  const lineNodes = new Map((f.ways ?? []).map((w) => [w.id, w.nodes] as const));
  for (const line of session.lineEntities()) lineNodes.set(Number(line.key.split('/')[1]), line.line!.ids);
  if (members?.some((m) => !lineNodes.has(m.ref))) return tr('Для рассечения нужны пути-члены мультиполигона — перезагрузите видимые тайлы.');
  const kind = solo ? 'part' : f.kind;
  const copyOf = (tags: Record<string, string>): Feature3D => {
    const id = nextNewId--;
    const polygons = structuredClone(f.polygons);
    if (f.type === 'way') return { key: `way/${id}`, type: 'way', id, version: 0, kind, tags, polygons, hasParts: false };
    const relMembers = members!.map((m) => ({ ...m }));
    const created: Feature3D & { relMembers: OsmMember[] } = { key: `relation/${id}`, type: 'relation', id, version: 0, kind,
      tags: { ...tags, type: 'multipolygon' }, polygons, hasParts: false,
      ways: relMembers.map((m) => ({ id: m.ref, role: m.role, nodes: lineNodes.get(m.ref)! })), relMembers };
    return created;
  };
  const fmt = (n: number) => `${Math.round(n * 100) / 100} ${tr('м')}`;

  if (solo) {
    const parts = [copyOf(lower), copyOf(upper)];
    const relId = nextNewId--;
    const [type, ref] = f.key.split('/');
    const relMembers: OsmMember[] = [
      { type: type as 'way' | 'relation', ref: Number(ref), role: 'outline' },
      ...parts.map((p) => ({ type: p.type as 'way' | 'relation', ref: p.id, role: 'part' })),
    ];
    const group: EditGroup = { key: `relation/${relId}`, type: 'relation', id: relId, version: 0, tags: { type: 'building' },
      members: relMembers.map((m) => `${m.type}/${m.ref}`), roles: relMembers.map((m) => m.role), relMembers };
    editGroups.set(group.key, group);
    session.editMany([...parts.map((p) => ({ key: p.key, create: p })), { key: group.key, create: group }]);
    enterFocus(group);
    select(parts[1].key);
    setStatus(tr('Рассечено на высоте {h}: здание {key}, контур {outline} и части {parts}.', { h: fmt(at), key: group.key, outline: f.key, parts: parts.map((p) => p.key).join(', ') }));
    return;
  }

  const created = copyOf(f.kind === 'part' ? upper : Object.fromEntries(Object.entries(upper).filter(([k]) => !IDENTITY_TAGS.test(k))));
  session.editMany([
    { key, tags: lower },
    { key: created.key, create: created },
    groupMembersEdit(g!, [...g!.relMembers, { type: created.type as 'way' | 'relation', ref: created.id, role: 'part' }]),
  ]);
  select(created.key);
  setStatus(tr('Рассечено на высоте {h}: {key} снизу и новая часть {part} сверху.', { h: fmt(at), key, part: created.key }));
  return;
}

/** Состав отношения здания в шаге разреза: у ещё не созданного (здание без отношения) — создание с этим составом. */
function groupMembersEdit(g: EditGroup, members: OsmMember[]): ObjectEdit {
  if (session.get(g.key)) return { key: g.key, members };
  const rel = members.filter((m) => m.type !== 'node');
  // Тот же объект, что в editGroups: сессия и индекс групп видят один состав
  Object.assign(g, { relMembers: members, members: rel.map((m) => `${m.type}/${m.ref}`), roles: rel.map((m) => m.role) });
  return { key: g.key, create: g };
}

function splitFeatureIn(key: string, a: CutPoint, b: CutPoint, bends: [number, number][], pending: EditGroup | undefined): string | undefined {
  const f = entity(key) as Feature3D | undefined;
  const solo = isSolo(focus) && !pending;
  const g = pending ?? (focus && !solo ? (entity(focus.key) as EditGroup | undefined) : undefined);
  if (!f || (!g && !solo)) return tr('Объект не найден.');
  if (a.poly !== b.poly) return tr('Начало и конец разреза должны быть на одной грани.');
  const poly = f.polygons[a.poly];
  if (!poly) return tr('Грань не найдена.');
  // Разрез вернулся в свою начальную точку — кольцо, касающееся контура в ней (так в мультиполигоне можно)
  const sameSpot = a.ring === b.ring && (a.vertex !== undefined ? a.vertex === b.vertex
    : b.vertex === undefined && a.edge === b.edge && Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1]) < 0.05);
  if (sameSpot) {
    if (bends.length < 2) return tr('Начало и конец разреза совпадают.');
    return cutHoleIn(key, a.poly, [a.p, ...bends], pending, a);
  }
  // Контур на два не делим: у здания был бы второй outline или кусок вне контура
  if (isOutlineIn(focus, key)) return tr('Контур здания (outline) на части не делится — только вырезать внутреннее кольцо: кликните внутри грани или вернитесь разрезом в начальную точку.');
  if (a.ring || b.ring) {
    if (solo) return tr('Резать у внутреннего кольца отдельного здания пока нельзя: сначала рассеките его на части.');
    // Между разными кольцами: делит грань, только если кольца уже соприкасаются (кусок между ними замыкается)
    return a.ring !== b.ring ? splitBetweenRings(f, g!, a, b, bends) : splitAtHole(f, g!, a, b, bends);
  }
  const ids = poly.outerIds!;
  const local = poly.outer.map((c) => overpassLayer.focusToLocal(c)!);
  const n = local.length;
  if (a.vertex !== undefined && b.vertex !== undefined && a.vertex === b.vertex) return tr('Начало и конец разреза совпадают.');
  if (a.edge === b.edge && a.vertex === undefined && b.vertex === undefined && !bends.length) return tr('Разрез идёт по стороне контура — делить нечего.');
  const path = [a.p, ...bends, b.p];
  for (let j = 0; j < path.length - 1; j++) {
    const u = path[j], v = path[j + 1];
    if (Math.hypot(u[0] - v[0], u[1] - v[1]) < 0.05) return tr('Соседние точки разреза совпадают.');
    const mid: [number, number] = [(u[0] + v[0]) / 2, (u[1] + v[1]) / 2];
    if (!inLocalRing(mid, local)) return tr('Разрез проходит снаружи контура.');
    for (let i = 0; i < n; i++) if (segCross(u, v, local[i], local[(i + 1) % n])) return tr('Разрез пересекает стороны контура.');
    for (const hole of poly.inners) {
      const h = hole.map((c) => overpassLayer.focusToLocal(c)!);
      if (inLocalRing(mid, h) || h.some((p, i) => segCross(u, v, p, h[(i + 1) % h.length])
        || segDist2(p, u, v) < 0.05 || segDist2(u, p, h[(i + 1) % h.length]) < 0.05
        || segDist2(v, p, h[(i + 1) % h.length]) < 0.05)) return tr('Разрез пересекает внутреннее кольцо.');
    }
    for (let i = 0; i < j - 1; i++) if (segCross(u, v, path[i], path[i + 1])) return tr('Разрез пересекает сам себя.');
  }

  // Кольцо с новыми узлами: вставляем с конца, чтобы номера сторон не съезжали
  type V = { p: [number, number]; id: number };
  const ring: V[] = local.map((p, i) => ({ p, id: ids[i] }));
  const fresh: { id: number; p: [number, number]; u: number; v: number }[] = [];
  const cuts = [a, b].map((c) => ({ c, id: c.vertex !== undefined ? ids[c.vertex] : nextNewId-- }));
  for (const { c, id } of [...cuts].sort((x, y) => y.c.edge - x.c.edge ||
    Math.hypot(y.c.p[0] - local[y.c.edge][0], y.c.p[1] - local[y.c.edge][1]) -
    Math.hypot(x.c.p[0] - local[x.c.edge][0], x.c.p[1] - local[x.c.edge][1]))) {
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
  const interior: V[] = bends.map((p) => ({ p, id: nextNewId-- }));
  const r1 = [...walk(ia, ib), ...interior.slice().reverse()];
  const r2 = [...walk(ib, ia), ...interior];
  if (r1.length < 3 || r2.length < 3) return tr('Разрез идёт по стороне контура — делить нечего.');
  const [keep, part] = ringArea(r1.map((v) => v.p)) >= ringArea(r2.map((v) => v.p)) ? [r1, r2] : [r2, r1];
  const lngLat = (p: [number, number]) => overpassLayer.focusToLngLat(p[0], p[1])!;
  const coord = new Map<number, LonLat>(ids.map((id, i) => [id, poly.outer[i]]));
  for (const polygon of f.polygons) {
    polygon.outerIds?.forEach((id, i) => coord.set(id, polygon.outer[i]));
    polygon.innerIds?.forEach((ring, j) => ring.forEach((id, i) => coord.set(id, polygon.inners[j][i])));
  }
  for (const x of fresh) coord.set(x.id, lngLat(x.p));
  for (const x of interior) coord.set(x.id, lngLat(x.p));
  const toPoly = (vs: V[]): Polygon => ({ outer: vs.map((v) => coord.get(v.id)!), inners: [], outerIds: vs.map((v) => v.id), innerIds: [] });
  let keepPoly = toPoly(keep), partPoly = toPoly(part);
  for (let j = 0; j < poly.inners.length; j++) {
    const h = poly.inners[j], hp = overpassLayer.focusToLocal(h[0])!;
    const dst = inLocalRing(hp, keep.map((v) => v.p)) ? keepPoly : inLocalRing(hp, part.map((v) => v.p)) ? partPoly : undefined;
    if (!dst) return tr('Внутреннее кольцо пересекает разрез.');
    dst.inners.push(h);
    dst.innerIds!.push(poly.innerIds![j]);
  }
  const netArea = (p: Polygon) => ringArea(p.outer.map((c) => overpassLayer.focusToLocal(c)!))
    - p.inners.reduce((sum, h) => sum + ringArea(h.map((c) => overpassLayer.focusToLocal(c)!)), 0);
  if (netArea(partPoly) > netArea(keepPoly)) {
    [keepPoly, partPoly] = [partPoly, keepPoly];
  }

  if (f.type === 'relation') return splitMultipolygon(f, g, a.poly, keepPoly, partPoly, fresh, coord, solo);

  if (solo) return splitSolo(f, toPoly(ring), keepPoly, partPoly, fresh, coord);
  const wayId = nextNewId--;
  const created: Feature3D = { key: `way/${wayId}`, type: 'way', id: wayId, version: 0, kind: f.kind, tags: copyTags(f), polygons: [partPoly], hasParts: false };

  const neighbours = insertIntoNeighbours(key, fresh, coord);
  if (typeof neighbours === 'string') return neighbours;
  const members = [...g!.relMembers, { type: 'way' as const, ref: wayId, role: 'part' }];
  session.editMany([
    { key, polygons: [keepPoly] },
    { key: created.key, create: created },
    ...neighbours,
    groupMembersEdit(g!, members),
  ]);
  select(created.key);
  const touched = neighbours.filter((e) => e.polygons).length;
  setStatus(touched
    ? tr('Рассечено: {key} и новая часть {part}, узлы добавлены в соседей: {n}.', { key, part: created.key, n: touched })
    : tr('Рассечено: {key} и новая часть {part}.', { key, part: created.key }));
  return;
}

/**
 * «Рассечь» кольцом: полигон polyIndex объекта key получает дыру ring (метры сцены), внутри — новая часть с теми
 * же тегами на тех же узлах. Путь-часть становится мультиполигоном (путь — внешнее кольцо без тегов, теги — на
 * отношении); у мультиполигона просто добавляется внутренний путь. Отдельное здание без частей — как у разреза:
 * контур остаётся, часть с дырой и внутренняя — в новом отношении здания. Одним шагом истории.
 */
function cutHole(key: string, polyIndex: number, ring: [number, number][]): string | undefined {
  const pending = isSolo(focus) && focus!.roles.includes('part') ? implicitRelation(focus!.members[0], implicitParts(focus!)) : undefined;
  const result = cutHoleIn(key, polyIndex, ring, pending);
  if (pending && !session.get(pending.key)) editGroups.delete(pending.key);
  return result;
}

/**
 * Почему кольцо ring нельзя вырезать из полигона (метры сцены); undefined — можно. touch — первая точка кольца
 * лежит на контуре (кольцо касается его в ней одной: так в мультиполигоне можно).
 */
function holeError(poly: Polygon, ring: [number, number][], touch = false): string | undefined {
  const outer = poly.outer.map((c) => overpassLayer.focusToLocal(c)!);
  const holes = poly.inners.map((h) => h.map((c) => overpassLayer.focusToLocal(c)!));
  const n = ring.length;
  if (n < 3 || ringArea(ring) < 0.01) return tr('Кольцу нужно хотя бы три точки.');
  const seg = (r: [number, number][], i: number): [[number, number], [number, number]] => [r[i], r[(i + 1) % r.length]];
  for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
    if (i === 0 && j === n - 1) continue;
    if (segCross(...seg(ring, i), ...seg(ring, j))) return tr('Кольцо пересекает само себя.');
  }
  const atTouch = (p: [number, number]) => touch && Math.hypot(p[0] - ring[0][0], p[1] - ring[0][1]) < 0.05;
  for (const r of [outer, ...holes]) {
    for (let i = 0; i < n; i++) for (let j = 0; j < r.length; j++) {
      const [a, b] = seg(ring, i), [c, d] = seg(r, j);
      if (segCross(a, b, c, d) || (segDist2(a, c, d) < 0.05 && !atTouch(a)) || (segDist2(c, a, b) < 0.05 && !atTouch(c))) {
        return tr('Кольцо касается контура или пересекает его — оно должно лежать внутри грани.');
      }
    }
  }
  if (ring.some((p) => !atTouch(p) && (!inLocalRing(p, outer) || holes.some((h) => inLocalRing(p, h))))) return tr('Кольцо должно лежать внутри грани.');
  if (holes.some((h) => { const q = h.find((p) => !atTouch(p)); return !!q && inLocalRing(q, ring); })) {
    return tr('Внутри кольца уже есть внутреннее кольцо — так вырезать пока нельзя.');
  }
  return;
}

/**
 * touch — первая точка кольца на контуре (разрез вернулся в свою начальную точку): кольцо касается контура в этом
 * узле — прежнем, если это вершина, или новом на стороне (он вставляется и в соседей с этой стороной).
 */
function cutHoleIn(key: string, polyIndex: number, ring: [number, number][], pending: EditGroup | undefined, touch?: CutPoint): string | undefined {
  const f = entity(key) as Feature3D | undefined;
  const solo = isSolo(focus) && !pending;
  const g = pending ?? (focus && !solo ? (entity(focus.key) as EditGroup | undefined) : undefined);
  if (!f || (!g && !solo)) return tr('Объект не найден.');
  let polygons = f.polygons;
  const edits: ObjectEdit[] = [];
  let touchId: number | undefined, touchAt: LonLat | undefined;
  if (touch) {
    const tp = polygons[polyIndex];
    const rIds = touch.ring ? tp?.innerIds?.[touch.ring - 1] : tp?.outerIds;
    const rCoords = touch.ring ? tp?.inners[touch.ring - 1] : tp?.outer;
    if (!rIds || !rCoords) return tr('В кеше нет id узлов этого объекта — нажмите «Перезагрузить видимые тайлы» в настройках графики.');
    if (touch.vertex !== undefined) { touchId = rIds[touch.vertex]; touchAt = rCoords[touch.vertex]; }
    else {
      // Новый узел на стороне — в контур этого объекта и во все пути и объекты с этой стороной
      touchId = nextNewId--;
      touchAt = overpassLayer.focusToLngLat(ring[0][0], ring[0][1])!;
      const coord = new Map<number, LonLat>([[touchId, touchAt]]);
      for (const p of polygons) {
        p.outerIds?.forEach((id, i) => coord.set(id, p.outer[i]));
        p.innerIds?.forEach((r, j) => r.forEach((id, i) => coord.set(id, p.inners[j][i])));
      }
      const fresh = [{ id: touchId, p: ring[0], u: rIds[touch.edge], v: rIds[(touch.edge + 1) % rIds.length] }];
      const inserted = topologyEdits([], freshInserts(fresh, coord), coord);
      if (typeof inserted === 'string') return inserted;
      polygons = inserted.find((e) => e.key === f.key)?.polygons ?? polygons;
      edits.push(...inserted.filter((e) => e.key !== f.key));
    }
  }
  const poly = polygons[polyIndex];
  if (!poly?.outerIds) return tr('Грань не найдена.');
  const err = holeError(poly, ring, !!touch);
  if (err) return err;
  // Контур здания (outline): только дыра — внутри не здание, новой части там нет
  const outline = isOutlineIn(focus, key);

  const coords = ring.map((p, i) => (i === 0 && touchAt ? touchAt : overpassLayer.focusToLngLat(p[0], p[1])!));
  const ids = ring.map((_, i) => (i === 0 && touchId !== undefined ? touchId : nextNewId--));
  const innerWay = nextNewId--;
  edits.push({ key: `way/${innerWay}`, create: { key: `way/${innerWay}`, version: 0, tags: {},
    line: { ids: [...ids, ids[0]], coords: [...coords, coords[0]] } } });
  const withHole: Polygon = { ...poly, inners: [...poly.inners, coords], innerIds: [...(poly.innerIds ?? []), ids] };
  // Внутренняя часть — на тех же узлах, что и внутренний путь
  const partTags: Record<string, string> = solo ? { 'building:part': 'yes' } : copyTags(f);
  if (solo) for (const [tag, value] of Object.entries(f.tags)) if (PART_TAGS.test(tag)) partTags[tag] = value;
  delete partTags.type;
  const partId = nextNewId--;
  const inner: Feature3D = { key: `way/${partId}`, type: 'way', id: partId, version: 0, kind: solo ? 'part' : f.kind, tags: partTags,
    polygons: [{ outer: coords, inners: [], outerIds: ids, innerIds: [] }], hasParts: false };
  if (!outline) edits.push({ key: inner.key, create: inner });
  const innerPart = { type: 'way' as const, ref: partId, role: 'part' };
  const innerMember = { type: 'way' as const, ref: innerWay, role: 'inner' };

  const done = (outer: string) => {
    if (outline) {
      select(outer);
      setStatus(tr('Вырезано кольцо: у контура здания {key} — внутренний двор.', { key: outer }));
      return;
    }
    select(inner.key);
    setStatus(tr('Вырезано кольцо: у {key} дыра, внутри — новая часть {part}. Удалите её (Del) — будет двор, или тяните (P) — башня, атриум.',
      { key: outer, part: inner.key }));
  };

  if (f.type === 'relation') {
    if (solo) return tr('Кольцо в отдельном здании-мультиполигоне пока не вырезается: сначала рассеките его на части.');
    const members = (f as Tagged).relMembers ?? session.get(f.key)?.relMembers;
    if (!members) return tr('Для рассечения нужны пути-члены мультиполигона — перезагрузите видимые тайлы.');
    edits.push({ key: f.key, polygons: polygons.map((p, i) => (i === polyIndex ? withHole : p)), members: [...members, innerMember] });
    if (!outline) edits.push(groupMembersEdit(g!, [...g!.relMembers, innerPart]));
    else if (!session.get(g!.key)) edits.push(groupMembersEdit(g!, g!.relMembers));
    session.editMany(edits);
    done(f.key);
    return;
  }

  // Путь — внешнее кольцо нового мультиполигона
  const outerNodes = [...poly.outerIds, poly.outerIds[0]];
  const relId = nextNewId--;
  const relMembers = [{ type: 'way' as const, ref: f.id, role: 'outer' }, innerMember];
  const tags = solo ? { ...partTags } : { ...f.tags };
  const rel: Feature3D & { relMembers: typeof relMembers } = { key: `relation/${relId}`, type: 'relation', id: relId, version: 0,
    kind: solo ? 'part' : f.kind, tags: { type: 'multipolygon', ...tags }, polygons: [withHole], hasParts: false,
    ways: [{ id: f.id, role: 'outer', nodes: outerNodes }, { id: innerWay, role: 'inner', nodes: [...ids, ids[0]] }], relMembers };
  edits.push({ key: rel.key, create: rel });
  const relPart = { type: 'relation' as const, ref: relId, role: 'part' };

  if (solo) {
    // Отдельное здание остаётся контуром; часть с дырой (на его же пути) и внутренняя — в новом отношении
    const id = nextNewId--;
    const members: OsmMember[] = [{ type: 'way', ref: f.id, role: 'outline' }, relPart, innerPart];
    const building: EditGroup = { key: `relation/${id}`, type: 'relation', id, version: 0, tags: { type: 'building' },
      members: members.map((m) => `${m.type}/${m.ref}`), roles: members.map((m) => m.role), relMembers: members };
    edits.push({ key: building.key, create: building });
    // Новый узел касания на стороне контура — и в самом контуре
    if (polygons !== f.polygons) edits.push({ key: f.key, polygons });
    editGroups.set(building.key, building);
    session.editMany(edits);
    enterFocus(building);
    done(rel.key);
    return;
  }

  // Теги переезжают на отношение; путь остаётся внешним кольцом (без своей геометрии здания)
  edits.push({ key: f.key, tags: {}, polygons: [], line: { ids: outerNodes, coords: [...poly.outer, poly.outer[0]] } });
  const relOutline = { type: 'relation' as const, ref: relId, role: 'outline' };
  const moved = g!.relMembers.map((m) => (m.type !== 'way' || m.ref !== f.id ? m : m.role === 'part' ? relPart : m.role === 'outline' ? relOutline : m));
  edits.push(groupMembersEdit(g!, outline ? moved : [...moved, innerPart]));
  session.editMany(edits);
  done(rel.key);
  return;
}

/** Ширина полосы вдоль разреза, которую вычитаем из грани, чтобы узнать, на сколько кусков он её делит, м. */
const CUT_STRIP_M = 0.002;

/**
 * Разрез между разными кольцами (внутреннее — внешнее, два внутренних). Грань делится, только если кольца уже
 * соприкасаются: из грани вычитается тонкая полоса вдоль разреза, кусков должно стать ровно два. Вершины кусков
 * сопоставляются с узлами (прежние, концы и изгибы разреза), больший кусок остаётся частью — её внутренние
 * кольца перестраиваются (касавшиеся сливаются в одно через место отрезанного куска), меньший — новая часть.
 */
function splitBetweenRings(f: Feature3D, g: EditGroup, a: CutPoint, b: CutPoint, bends: [number, number][]): string | undefined {
  const noDivide = tr('Разрез от внутреннего кольца до внешнего (или до другого внутреннего) грань не делит — начните и закончите его на одном кольце.');
  const poly = f.polygons[a.poly];
  if (f.type !== 'relation' || !poly.outerIds || !poly.innerIds) return noDivide;
  const local = (c: LonLat) => overpassLayer.focusToLocal(c)!;
  const ringIds = [poly.outerIds, ...poly.innerIds];
  const rings = [poly.outer, ...poly.inners].map((r) => r.map(local));
  const path = [a.p, ...bends, b.p];
  const near = (p: [number, number], q: [number, number]) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 0.05;
  for (let j = 0; j < path.length - 1; j++) {
    const u = path[j], v = path[j + 1];
    if (near(u, v)) return tr('Соседние точки разреза совпадают.');
    const mid: [number, number] = [(u[0] + v[0]) / 2, (u[1] + v[1]) / 2];
    if (!inLocalRing(mid, rings[0]) || rings.slice(1).some((h) => inLocalRing(mid, h))) return tr('Разрез проходит снаружи грани.');
    for (const r of rings) for (let i = 0; i < r.length; i++) {
      if (segCross(u, v, r[i], r[(i + 1) % r.length])) return tr('Разрез пересекает стороны контура.');
    }
    for (let i = 0; i < j - 1; i++) if (segCross(u, v, path[i], path[i + 1])) return tr('Разрез пересекает сам себя.');
  }

  // Узлы концов разреза: вершина — прежний узел, точка на стороне — новый (вставляется и в соседей)
  const coord = new Map<number, LonLat>();
  [poly.outer, ...poly.inners].forEach((r, ri) => ringIds[ri].forEach((id, i) => coord.set(id, r[i])));
  const known: { id: number; p: [number, number] }[] = rings.flatMap((r, ri) => r.map((p, i) => ({ id: ringIds[ri][i], p })));
  const fresh: FreshNode[] = [];
  for (const c of [a, b]) {
    if (c.vertex !== undefined) continue;
    const ids = ringIds[c.ring], id = nextNewId--;
    fresh.push({ id, p: c.p, u: ids[c.edge], v: ids[(c.edge + 1) % ids.length] });
    known.push({ id, p: c.p });
    coord.set(id, overpassLayer.focusToLngLat(c.p[0], c.p[1])!);
  }
  for (const p of bends) {
    const id = nextNewId--;
    known.push({ id, p });
    coord.set(id, overpassLayer.focusToLngLat(p[0], p[1])!);
  }

  // Полоса вдоль разреза (с запасом за концы), вычтенная из грани
  const strip = path.slice(1).map((v, j) => {
    const u = path[j], len = Math.hypot(v[0] - u[0], v[1] - u[1]);
    const dx = (v[0] - u[0]) / len, dy = (v[1] - u[1]) / len, w = CUT_STRIP_M / 2;
    const a0: [number, number] = [u[0] - dx * w, u[1] - dy * w], b0: [number, number] = [v[0] + dx * w, v[1] + dy * w];
    const ring: [number, number][] = [[a0[0] - dy * w, a0[1] + dx * w], [b0[0] - dy * w, b0[1] + dx * w], [b0[0] + dy * w, b0[1] - dx * w], [a0[0] + dy * w, a0[1] - dx * w]];
    return [[...ring, ring[0]]];
  });
  let pieces: ReturnType<typeof polygonClipping.difference>;
  try {
    pieces = polygonClipping.difference([rings.map((r) => [...r, r[0]] as [number, number][])], ...strip as [number, number][][][]);
  } catch { return tr('Не удалось разрезать грань.'); }
  if (pieces.length !== 2) return noDivide;

  // Вершины кусков — в узлы; совпавшие подряд (две стороны полосы у одного конца) — один узел
  const toIds = (r: [number, number][]): number[] | undefined => {
    const out: number[] = [];
    for (const q of r.slice(0, -1)) {
      let best: { id: number; d: number } | undefined;
      for (const k of known) { const d = Math.hypot(k.p[0] - q[0], k.p[1] - q[1]); if (!best || d < best.d) best = { id: k.id, d }; }
      if (!best || best.d > 0.01) return;
      if (out.at(-1) !== best.id) out.push(best.id);
    }
    while (out.length > 1 && out[0] === out.at(-1)) out.pop();
    return out.length >= 3 ? out : undefined;
  };
  const mapped = pieces.map((p) => p.map(toIds));
  if (mapped.some((p) => p.some((r) => !r))) return tr('Не удалось разрезать грань.');
  const area = (p: (typeof pieces)[number]) => ringArea(p[0].slice(0, -1) as [number, number][]) - p.slice(1).reduce((s, r) => s + ringArea(r.slice(0, -1) as [number, number][]), 0);
  const [ki, pi] = area(pieces[0]) >= area(pieces[1]) ? [0, 1] : [1, 0];
  const keep = mapped[ki] as number[][], piece = mapped[pi] as number[][];
  if (piece.length > 1) return tr('Внутри отрезаемого куска есть другое внутреннее кольцо — так резать пока нельзя.');
  const sameSet = (x: number[], y: number[]) => x.length === y.length && x.every((id) => y.includes(id));
  if (!sameSet(keep[0], poly.outerIds)) return tr('Не удалось разрезать грань.');

  // Внутренние кольца остающейся части: прежнее без изменений — как было; новое — переписывает первое из прежних,
  // что в нём оказались (по площади: вершины прежнего, например угол выреза в Г-образном дворе, могут уйти
  // внутрь нового), а остальные такие прежние (слитые в него) из полигона убираются
  const at = new Map(known.map((k) => [k.id, k.p] as const));
  const closedPts = (ids: number[]) => { const r = ids.map((id) => at.get(id)!); return [[...r, r[0]]] as [number, number][][]; };
  const inside = (old: number[], r: number[]) => {
    try {
      const common = polygonClipping.intersection(closedPts(old), closedPts(r));
      const s = common.reduce((t, p) => t + ringArea(p[0].slice(0, -1) as [number, number][]) - p.slice(1).reduce((u, h) => u + ringArea(h.slice(0, -1) as [number, number][]), 0), 0);
      return s >= 0.9 * ringArea(old.map((id) => at.get(id)!));
    } catch { return old.every((id) => r.includes(id)); }
  };
  const rewrites: RingRewrite[] = [];
  const consumed = new Set<number>();
  for (const r of keep.slice(1)) {
    const olds = poly.innerIds.map((ids, j) => ({ ids, j })).filter(({ ids }) => inside(ids, r));
    if (olds.length === 1 && sameSet(olds[0].ids, r)) continue;
    if (!olds.length) return tr('Не удалось разрезать грань.');
    rewrites.push({ poly: a.poly, ring: olds[0].j + 1, ids: r, coords: r.map((id) => coord.get(id)!), absorbs: olds.slice(1).map((o) => o.j + 1) });
    for (const o of olds.slice(1)) consumed.add(o.j);
  }
  const edits = topologyEdits([{ f, rewrites }], freshInserts(fresh, coord), coord);
  if (typeof edits === 'string') return edits;
  if (consumed.size) {
    const e = edits.find((x) => x.key === f.key);
    if (e?.polygons) e.polygons = e.polygons.map((p, i) => (i !== a.poly ? p
      : { ...p, inners: p.inners.filter((_, j) => !consumed.has(j)), innerIds: p.innerIds?.filter((_, j) => !consumed.has(j)) }));
  }
  const wayId = nextNewId--;
  const tags = copyTags(f);
  delete tags.type;
  const ids = piece[0];
  const created: Feature3D = { key: `way/${wayId}`, type: 'way', id: wayId, version: 0, kind: f.kind, tags,
    polygons: [{ outer: ids.map((id) => coord.get(id)!), inners: [], outerIds: ids, innerIds: [] }], hasParts: false };
  session.editMany([...edits, { key: created.key, create: created }, groupMembersEdit(g, [...g.relMembers, { type: 'way', ref: wayId, role: 'part' }])]);
  select(created.key);
  setStatus(tr('Рассечено: {key} и новая часть {part}.', { key: f.key, part: created.key }));
  return;
}

/**
 * Разрез с обоими концами на одном внутреннем кольце: кусок между разрезом и кольцом — новая часть (путь),
 * а внутреннее кольцо исходной части обходит его (пути-члены перестраивает topologyEdits). Строка — ошибка.
 */
function splitAtHole(f: Feature3D, g: EditGroup, a: CutPoint, b: CutPoint, bends: [number, number][]): string | undefined {
  const poly = f.polygons[a.poly];
  const k = a.ring - 1;
  const hIds = poly.innerIds?.[k];
  if (!hIds || f.type !== 'relation') return tr('В кеше нет id узлов этого объекта — нажмите «Перезагрузить видимые тайлы» в настройках графики.');
  const local = (c: LonLat) => overpassLayer.focusToLocal(c)!;
  const outer = poly.outer.map(local);
  const holes = poly.inners.map((h) => h.map(local));
  const hole = holes[k], n = hole.length;
  if (a.vertex !== undefined && a.vertex === b.vertex) return tr('Начало и конец разреза совпадают.');
  const path = [a.p, ...bends, b.p];
  const near = (p: [number, number], q: [number, number]) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 0.05;
  for (let j = 0; j < path.length - 1; j++) {
    const u = path[j], v = path[j + 1];
    if (near(u, v)) return tr('Соседние точки разреза совпадают.');
    const mid: [number, number] = [(u[0] + v[0]) / 2, (u[1] + v[1]) / 2];
    if (!inLocalRing(mid, outer) || holes.some((h) => inLocalRing(mid, h))) return tr('Разрез проходит снаружи грани.');
    for (let i = 0; i < outer.length; i++) if (segCross(u, v, outer[i], outer[(i + 1) % outer.length])) return tr('Разрез пересекает стороны контура.');
    for (let h = 0; h < holes.length; h++) {
      const r = holes[h];
      for (let i = 0; i < r.length; i++) {
        const p = r[i], q = r[(i + 1) % r.length];
        if (segCross(u, v, p, q)) return tr('Разрез пересекает внутреннее кольцо.');
        // Касаться кольца можно только концами разреза на нём
        const isEnd = (x: [number, number]) => h === k && (near(x, a.p) || near(x, b.p));
        if ((segDist2(p, u, v) < 0.05 && !isEnd(p)) || (segDist2(u, p, q) < 0.05 && !isEnd(u)) || (segDist2(v, p, q) < 0.05 && !isEnd(v))) {
          return tr('Разрез касается внутреннего кольца не концом.');
        }
      }
    }
    for (let i = 0; i < j - 1; i++) if (segCross(u, v, path[i], path[i + 1])) return tr('Разрез пересекает сам себя.');
  }

  // Кольцо с новыми узлами концов разреза: вставляем с конца, чтобы номера сторон не съезжали
  type V = { p: [number, number]; id: number };
  const ring: V[] = hole.map((p, i) => ({ p, id: hIds[i] }));
  const fresh: FreshNode[] = [];
  const cuts = [a, b].map((c) => ({ c, id: c.vertex !== undefined ? hIds[c.vertex] : nextNewId-- }));
  for (const { c, id } of [...cuts].sort((x, y) => y.c.edge - x.c.edge ||
    Math.hypot(y.c.p[0] - hole[y.c.edge][0], y.c.p[1] - hole[y.c.edge][1]) - Math.hypot(x.c.p[0] - hole[x.c.edge][0], x.c.p[1] - hole[x.c.edge][1]))) {
    if (c.vertex !== undefined) continue;
    ring.splice(c.edge + 1, 0, { p: c.p, id });
    fresh.push({ id, p: c.p, u: hIds[c.edge], v: hIds[(c.edge + 1) % n] });
  }
  const ia = ring.findIndex((v) => v.id === cuts[0].id), ib = ring.findIndex((v) => v.id === cuts[1].id);
  const walk = (from: number, to: number) => {
    const out: V[] = [];
    for (let i = from; ; i = (i + 1) % ring.length) { out.push(ring[i]); if (i === to) break; }
    return out;
  };
  const interior: V[] = bends.map((p) => ({ p, id: nextNewId-- }));
  const l1 = [...walk(ia, ib), ...interior.slice().reverse()];
  const l2 = [...walk(ib, ia), ...interior];
  // Один из обходов — кусок между разрезом и кольцом, другой — он вместе с дырой (новое внутреннее кольцо)
  const [piece, grown] = ringArea(l1.map((v) => v.p)) <= ringArea(l2.map((v) => v.p)) ? [l1, l2] : [l2, l1];
  if (piece.length < 3 || ringArea(piece.map((v) => v.p)) < 0.01) return tr('Разрез идёт по стороне кольца — отрезать нечего.');
  if (holes.some((h, j) => j !== k && inLocalRing(h[0], piece.map((v) => v.p)))) return tr('Внутри отрезаемого куска есть другое внутреннее кольцо — так резать пока нельзя.');

  const coord = new Map<number, LonLat>();
  for (const p of f.polygons) {
    p.outerIds?.forEach((id, i) => coord.set(id, p.outer[i]));
    p.innerIds?.forEach((r, j) => r.forEach((id, i) => coord.set(id, p.inners[j][i])));
  }
  for (const v of [...fresh, ...interior]) coord.set(v.id, overpassLayer.focusToLngLat(v.p[0], v.p[1])!);
  const edits = topologyEdits([{ f, rewrites: [{ poly: a.poly, ring: a.ring, ids: grown.map((v) => v.id), coords: grown.map((v) => coord.get(v.id)!) }] }],
    freshInserts(fresh, coord), coord);
  if (typeof edits === 'string') return edits;
  const wayId = nextNewId--;
  const tags = copyTags(f);
  delete tags.type;
  const created: Feature3D = { key: `way/${wayId}`, type: 'way', id: wayId, version: 0, kind: f.kind, tags,
    polygons: [{ outer: piece.map((v) => coord.get(v.id)!), inners: [], outerIds: piece.map((v) => v.id), innerIds: [] }], hasParts: false };
  session.editMany([...edits, { key: created.key, create: created }, groupMembersEdit(g, [...g.relMembers, { type: 'way', ref: wayId, role: 'part' }])]);
  select(created.key);
  setStatus(tr('Рассечено: {key} и новая часть {part}.', { key: f.key, part: created.key }));
  return;
}

/** Разделить часть-мультиполигон, сохранив её прочие внешние кольца и пути отверстий. */
function splitMultipolygon(f: Feature3D, group: EditGroup | undefined, polyIndex: number, keep: Polygon, part: Polygon,
  fresh: FreshNode[], coord: Map<number, LonLat>, solo: boolean): string | undefined {
  const members = session.get(f.key)?.relMembers;
  if (!members) return tr('Для рассечения нужны пути-члены мультиполигона — перезагрузите видимые тайлы.');
  const lineNodes = new Map((f.ways ?? []).map((w) => [w.id, w.nodes] as const));
  for (const line of session.lineEntities()) lineNodes.set(Number(line.key.split('/')[1]), line.line!.ids);
  const original = f.polygons[polyIndex];
  const onRing = (ids: number[] | undefined, role: string) => {
    const ring = new Set(ids);
    return members.filter((m) => m.type === 'way' && (role === 'outer' ? m.role !== 'inner' : m.role === 'inner')
      && lineNodes.get(m.ref)?.every((id) => ring.has(id)));
  };
  const oldOuter = onRing(original.outerIds, 'outer');
  if (!oldOuter.length) return tr('Не удалось определить внешние пути мультиполигона для разреза.');
  const innerWays = (poly: Polygon) => poly.innerIds!.map((ids) => onRing(ids, 'inner'));
  const partInnerGroups = innerWays(part), keepInnerGroups = innerWays(keep);
  if ([...partInnerGroups, ...keepInnerGroups, ...(solo ? f.polygons.flatMap((p, i) => i === polyIndex ? [] : innerWays(p)) : [])]
    .some((ways) => !ways.length)) return tr('Не удалось определить внутренние пути мультиполигона для разреза.');
  const partInner = partInnerGroups.flat();
  const at = (id: number) => coord.get(id)!;
  const insertions = freshInserts(fresh, coord);
  const propagated = topologyEdits([], insertions, coord);
  if (typeof propagated === 'string') return propagated;
  const edits = new Map(propagated.map((e) => [e.key, e] as const));
  const put = (e: ObjectEdit) => edits.set(e.key, { ...edits.get(e.key), ...e });
  const newOuter = (poly: Polygon) => {
    const id = nextNewId--;
    const ids = [...poly.outerIds!, poly.outerIds![0]];
    lineNodes.set(id, ids);
    put({ key: `way/${id}`, create: { key: `way/${id}`, version: 0, tags: {}, line: { ids, coords: ids.map(at) } } });
    return { type: 'way' as const, ref: id, role: 'outer' };
  };
  const createPart = (poly: Polygon, inners: OsmMember[], outers?: OsmMember[]) => {
    const outer = outers ?? [newOuter(poly)];
    const id = nextNewId--;
    const key = `relation/${id}`;
    const relMembers = [...outer, ...inners];
    const partTags: Record<string, string> = solo ? { 'building:part': 'yes' } : copyTags(f);
    if (solo) for (const [tag, value] of Object.entries(f.tags)) if (PART_TAGS.test(tag)) partTags[tag] = value;
    const created: Feature3D & { relMembers: OsmMember[] } = { key, type: 'relation', id, version: 0, kind: solo ? 'part' : f.kind,
      tags: { ...partTags, type: 'multipolygon' }, polygons: [poly], hasParts: false,
      ways: relMembers.map((m) => ({ id: m.ref, role: m.role, nodes: lineNodes.get(m.ref)! })), relMembers };
    put({ key, create: created });
    return created;
  };

  if (solo) {
    // Отдельное здание остаётся контуром; две новые части получают собственные отношения.
    const inserted = insertInRing(original.outerIds!, original.outer, insertions, at);
    const whole = inserted ? { ...original, outer: inserted.coords, outerIds: inserted.ids } : original;
    put({ key: f.key, polygons: f.polygons.map((p, i) => i === polyIndex ? whole : p) });
    const first = createPart(keep, keepInnerGroups.flat());
    const second = createPart(part, partInner);
    const unchanged = f.polygons.flatMap((p, i) => i === polyIndex ? [] : [createPart(p, innerWays(p).flat())]);
    const id = nextNewId--;
    const relMembers: OsmMember[] = [{ type: 'relation', ref: f.id, role: 'outline' },
      ...[first, second, ...unchanged].map((p) => ({ type: 'relation' as const, ref: p.id, role: 'part' }))];
    const building: EditGroup = { key: `relation/${id}`, type: 'relation', id, version: 0, tags: { type: 'building' },
      members: relMembers.map((m) => `${m.type}/${m.ref}`), roles: relMembers.map((m) => m.role), relMembers };
    put({ key: building.key, create: building });
    session.editMany([...edits.values()]);
    editGroups.set(building.key, building);
    enterFocus(building);
    select(first.key);
    setStatus(tr('Создано здание {key}: контур {outline} и части {parts}.', { key: building.key, outline: f.key,
      parts: [first, second, ...unchanged].map((p) => p.key).join(', ') }));
    return;
  }

  const sourceWays: RingWay[] = oldOuter.map((m) => ({ id: m.ref, role: m.role,
    nodes: insertInLine(lineNodes.get(m.ref)!, insertions) ?? lineNodes.get(m.ref)!,
    tags: session.get(`way/${m.ref}`)?.tags ?? f.ways?.find((w) => w.id === m.ref)?.tags }));
  for (const w of sourceWays) lineNodes.set(w.id, w.nodes);
  const keepWays = restructureRing(sourceWays, keep.outerIds!, 'outer', () => nextNewId--);
  const afterKeep = sourceWays.map((w) => ({ ...w, nodes: keepWays.lines.get(w.id) ?? w.nodes }));
  afterKeep.push(...keepWays.created.map((w) => ({ id: w.id, role: 'outer', nodes: w.nodes, tags: w.tags })));
  const partWays = restructureRing(afterKeep, part.outerIds!, 'outer', () => nextNewId--);
  const createdWays = [...keepWays.created, ...partWays.created];
  const finalLines = new Map([...keepWays.lines, ...partWays.lines]);
  // Исходный путь → все его куски. И созданные в сессии пути (линия прошлого разреза — общая с соседней частью),
  // и кусок первого прохода, разрезанный вторым: сосед получает всё, что было его путём
  const split = new Map<number, number[]>();
  for (const result of [keepWays, partWays]) for (const [id, ids] of result.pieces) split.set(id, [...(split.get(id) ?? []), ...ids]);
  const allPieces = (id: number): number[] => (split.get(id) ?? []).flatMap((x) => [x, ...allPieces(x)]);
  const pieces = new Map(sourceWays.filter((w) => split.has(w.id)).map((w) => [w.id, allPieces(w.id)] as const));
  const createdFrom = new Map(createdWays.map((w) => [w.id, w.splitFrom] as const));
  for (const w of createdWays) {
    const root = w.splitFrom === undefined ? undefined : splitRoot(w.splitFrom, createdFrom);
    const nodes = finalLines.get(w.id) ?? w.nodes;
    lineNodes.set(w.id, nodes);
    put({ key: `way/${w.id}`, create: { key: `way/${w.id}`, version: 0, tags: { ...(w.tags ?? {}) },
      line: { ids: nodes, coords: nodes.map(at) }, ...(root !== undefined ? { splitFrom: root } : {}) } });
  }
  for (const w of sourceWays) {
    const nodes = finalLines.get(w.id);
    if (!nodes) continue;
    lineNodes.set(w.id, nodes);
    const key = `way/${w.id}`;
    if (!session.has(key)) {
      const originalNodes = f.ways?.find((source) => source.id === w.id)?.nodes ?? w.nodes;
      session.track({ key, version: 0, tags: { ...(w.tags ?? {}) },
        line: { ids: originalNodes, coords: originalNodes.map(at) } });
    }
    put({ key, line: { ids: nodes, coords: nodes.map(at) } });
  }
  const edges = (ids: number[]) => ids.slice(1).map((id, i) => [ids[i], id].sort((a, b) => a - b).join(','));
  const validRing = (poly: Polygon, ringMembers: { id: number }[]) => {
    const expected = new Set(edges([...poly.outerIds!, poly.outerIds![0]]));
    const actual = ringMembers.flatMap((m) => edges(lineNodes.get(m.id) ?? []));
    return actual.length === expected.size && actual.every((edge) => expected.has(edge));
  };
  if (!validRing(keep, keepWays.members) || !validRing(part, partWays.members))
    return tr('Не удалось собрать пути разрезанного мультиполигона.');
  const created = createPart(part, partInner, partWays.members.map((m) => ({ type: 'way' as const, ref: m.id, role: m.role })));
  const removed = new Set([...oldOuter, ...partInner].map((m) => m.ref));
  const nextMembers = [...members.filter((m) => m.type !== 'way' || !removed.has(m.ref)),
    ...keepWays.members.map((m) => ({ type: 'way' as const, ref: m.id, role: m.role }))];
  put({ key: f.key, polygons: f.polygons.map((p, i) => i === polyIndex ? keep : p), members: nextMembers });
  // Если исходный путь участвует в других загруженных отношениях, добавляем рядом с ним его новые куски.
  for (const other of liveFeatures()) {
    if (other.key === f.key || other.type !== 'relation' || !relWays(other)?.some((w) => pieces.has(w.id))) continue;
    const current = entity(other.key)?.relMembers;
    if (!current) return tr('Для соседнего отношения нужны пути-члены — перезагрузите видимые тайлы.');
    put({ key: other.key, members: current.flatMap((m) => m.type === 'way' && pieces.has(m.ref)
      ? [m, ...pieces.get(m.ref)!.map((ref) => ({ type: 'way' as const, ref, role: m.role }))] : [m]) });
  }
  const groupMembers = [...group!.relMembers, { type: 'relation' as const, ref: created.id, role: 'part' }];
  put(groupMembersEdit(group!, groupMembers));
  session.editMany([...edits.values()]);
  select(created.key);
  setStatus(tr('Рассечено: {key} и новая часть {part}.', { key: f.key, part: created.key }));
}

type FreshNode = { id: number; p: [number, number]; u: number; v: number };

/**
 * Новые узлы fresh на сторонах u–v — во все объекты с этой стороной и в пути-члены мультиполигонов (через
 * topologyEdits: пути, в которых сторона, получают узел, контуры отношений — тоже). Правки самого key не
 * входят: его контур собирает вызывающий. Строка — ошибка.
 */
function insertIntoNeighbours(key: string, fresh: FreshNode[], coord: Map<number, LonLat>): ObjectEdit[] | string {
  if (!fresh.length) return [];
  const edits = topologyEdits([], freshInserts(fresh, coord), coord);
  return typeof edits === 'string' ? edits : edits.filter((e) => e.key !== key);
}

/** Координаты узлов всех колец объектов. */
function nodeCoordsOf(features: Feature3D[]): Map<number, LonLat> {
  const out = new Map<number, LonLat>();
  for (const f of features) for (const p of f.polygons) {
    p.outerIds?.forEach((id, i) => out.set(id, p.outer[i]));
    p.innerIds?.forEach((r, j) => r.forEach((id, i) => out.set(id, p.inners[j][i])));
  }
  return out;
}

/** Новые узлы на сторонах как вставки: положение t на стороне u→v (координаты концов — из coord или объектов). */
function freshInserts(fresh: FreshNode[], coord: Map<number, LonLat>): Insert[] {
  let all: Map<number, LonLat> | undefined;
  const at = (id: number) => coord.get(id) ?? (all ??= nodeCoordsOf(liveFeatures())).get(id);
  return fresh.map((x) => {
    const cu = at(x.u), cv = at(x.v);
    if (!cu || !cv) return { id: x.id, u: x.u, v: x.v }; // без положения — вставится по порядку
    const u = overpassLayer.focusToLocal(cu)!, v = overpassLayer.focusToLocal(cv)!;
    const dx = v[0] - u[0], dy = v[1] - u[1];
    return { id: x.id, u: x.u, v: x.v, t: ((x.p[0] - u[0]) * dx + (x.p[1] - u[1]) * dy) / (dx * dx + dy * dy || 1) };
  });
}

/** Допуск «часть внутри контура», м: общие стороны и узлы, погрешность координат. */
const OUTLINE_EPS = 0.05;

/**
 * Контур отношения и части, стоящие на земле (приподнятые и подземные выходить за след на земле могут — partGround),
 * и те из них, что выходят за контур хоть одной вершиной.
 */
function partsOutsideOutline(g: BuildingGroup): { outline: Feature3D; parts: Feature3D[]; out: Feature3D[] } | undefined {
  const oi = g.roles.indexOf('outline');
  const outline = oi >= 0 ? entity(g.members[oi]) as Feature3D | undefined : undefined;
  if (!outline?.polygons?.length || !overpassLayer.focusToLocal([0, 0])) return;
  const rings = outline.polygons.map((p) => p.outer.map((c) => overpassLayer.focusToLocal(c)!));
  const parts = g.members.filter((k, i) => g.roles[i] === 'part' && !session.isDeleted(k))
    .map((k) => entity(k) as Feature3D | undefined).filter((f): f is Feature3D => !!f?.polygons?.length && partGround(f.tags) === 'ground');
  const inside = (q: [number, number]) => rings.some((ring) => pointInRing(q, ring)
    || ring.some((a, i) => segDist2(q, a, ring[(i + 1) % ring.length]) < OUTLINE_EPS));
  const out = parts.filter((f) => f.polygons.some((p) => p.outer.some((c) => !inside(overpassLayer.focusToLocal(c)!))));
  return { outline, parts, out };
}

/**
 * Новый контур: объединение контура и всех частей (метры сцены) — внешнее кольцо и дворы (их сохраняет только
 * контур-мультиполигон, у пути они под контуром); строка — почему нельзя.
 */
function unitedOutline(outline: Feature3D, parts: Feature3D[]): { outer: [number, number][]; holes: [number, number][][] } | string {
  const toRing = (outer: LonLat[]) => {
    const r = outer.map((c) => overpassLayer.focusToLocal(c)!);
    return [[...r, r[0]]] as [number, number][][];
  };
  const polys = [outline, ...parts].flatMap((f) => f.polygons.map((p) => toRing(p.outer)));
  const u = polygonClipping.union(polys[0], ...polys.slice(1));
  if (u.length !== 1) return tr('Части не соприкасаются с контуром: контур из нескольких кусков (мультиполигон) пока не поддерживается — соедините части.');
  // Лишние точки на прямых — убираем
  const clean = (closed: number[][]) => {
    const ring = closed.slice(0, -1) as [number, number][];
    const out: [number, number][] = [];
    for (let i = 0; i < ring.length; i++) {
      const a = out.length ? out[out.length - 1] : ring[ring.length - 1], b = ring[i], c = ring[(i + 1) % ring.length];
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 0.01) continue;
      if (segDist2(b, a, c) < 0.01) continue; // на прямой a–c
      out.push(b);
    }
    return out;
  };
  const outer = clean(u[0][0]);
  if (outer.length < 3) return tr('Не удалось построить контур.');
  return { outer, holes: outline.type === 'relation' ? u[0].slice(1).map(clean).filter((h) => h.length >= 3) : [] };
}

/**
 * «Обновить контур»: контур отношения — объединение его и всех частей (новые вершины — узлы частей там, где
 * совпадают, иначе новые узлы). Если у контура был свой объём, он переходит в новую часть по прежней форме,
 * а на контуре остаются только теги здания (название, адрес…). Одним шагом истории.
 */
function fixOutline() {
  if (!focus || isSolo(focus)) return;
  const r = partsOutsideOutline(focus);
  if (!r) return setStatus(tr('Контур здания — не простой путь: обновить его пока нельзя.'), true);
  const united = unitedOutline(r.outline, r.parts);
  if (typeof united === 'string') return setStatus(united, true);
  // Узлы: существующие узлы контура и частей в тех же точках, иначе новые
  const known: { id: number; c: LonLat; p: [number, number] }[] = [];
  for (const f of [r.outline, ...r.parts]) {
    for (const p of f.polygons) {
      (p.outerIds ?? []).forEach((id, i) => known.push({ id, c: p.outer[i], p: overpassLayer.focusToLocal(p.outer[i])! }));
      p.inners.forEach((h, j) => p.innerIds?.[j]?.forEach((id, i) => known.push({ id, c: h[i], p: overpassLayer.focusToLocal(h[i])! })));
    }
  }
  const toNodes = (ring: [number, number][]) => {
    const ids: number[] = [], coords: LonLat[] = [];
    for (const q of ring) {
      const k = known.find((n) => Math.hypot(n.p[0] - q[0], n.p[1] - q[1]) < SHARE_EPS);
      if (k && !ids.includes(k.id)) { ids.push(k.id); coords.push(k.c); continue; }
      ids.push(nextNewId--);
      coords.push(overpassLayer.focusToLngLat(q[0], q[1])!);
    }
    return { ids, coords };
  };
  const { ids, coords } = toNodes(united.outer);
  const holes = united.holes.map(toNodes);
  const edits: Parameters<typeof session.editMany>[0] = [];
  const g = entity(focus.key) as EditGroup | undefined;
  if (!g) return setStatus(tr('Отношение здания не найдено.'), true);
  const outlineTags = { ...r.outline.tags };
  if (r.outline.type === 'relation') {
    const res = relationOutlineEdits(r.outline, outlineTags, { ids, coords }, holes, g);
    if (typeof res === 'string') return setStatus(res, true);
    edits.push(...res);
  } else if (outlineHasVolume(outlineTags)) {
    // Объём контура — новой частью прежней формы (на тех же узлах)
    const id = nextNewId--;
    const tags: Record<string, string> = { 'building:part': 'yes' };
    for (const [k, v] of Object.entries(outlineTags)) if (PART_TAGS.test(k)) { tags[k] = v; delete outlineTags[k]; }
    const part: Feature3D = { key: `way/${id}`, type: 'way', id, version: 0, kind: 'part', tags,
      polygons: r.outline.polygons.map((p) => ({ ...p, outer: [...p.outer], outerIds: p.outerIds && [...p.outerIds] })), hasParts: false };
    edits.push({ key: part.key, create: part });
    edits.push({ key: g.key, members: [...g.relMembers, { type: 'way', ref: id, role: 'part' }] });
  }
  if (r.outline.type !== 'relation') edits.push({ key: r.outline.key, polygons: [{ outer: coords, inners: [], outerIds: ids, innerIds: [] }], tags: outlineTags });
  overpassLayer.setDrawPreview(undefined);
  session.editMany(edits);
  renderSelected();
  setStatus(tr('Контур {key} обновлён: охватывает все части на земле ({n}). Отменить — Ctrl+Z.', { key: r.outline.key, n: r.parts.length }));
}

/** У контура свой объём (переносится в часть при «Обновить контур»); height=0 — явно без объёма, так и остаётся. */
const outlineHasVolume = (t: Record<string, string>) => !isBareOutlineTags(t) && !(Number(t.height) === 0 && !isOutlinePart(t));

/**
 * Контур-мультиполигон для «Обновить контур» — локально, без правки соседей: внешнее кольцо — один новый путь,
 * дворы — прежние пути-члены, если кольцо то же, иначе новые. Прежние пути, больше никому не нужные (без тегов, не
 * в других загруженных отношениях), удаляются (if-unused: занятый незагруженным отношением сервер оставит). Объём
 * контура (не голые теги здания) — новой частью-мультиполигоном на прежних путях.
 */
function relationOutlineEdits(outline: Feature3D, outlineTags: Record<string, string>, outer: { ids: number[]; coords: LonLat[] },
  holes: { ids: number[]; coords: LonLat[] }[], g: EditGroup): ObjectEdit[] | string {
  const members = session.get(outline.key)?.relMembers ?? (outline as Tagged).relMembers;
  const lineNodes = new Map((outline.ways ?? []).map((w) => [w.id, { nodes: w.nodes, tags: w.tags ?? {} }] as const));
  for (const line of session.lineEntities()) lineNodes.set(Number(line.key.split('/')[1]), { nodes: line.line!.ids, tags: line.tags });
  const at = new Map<number, LonLat>();
  for (const p of outline.polygons) {
    p.outerIds?.forEach((id, i) => at.set(id, p.outer[i]));
    p.inners.forEach((h, j) => p.innerIds?.[j]?.forEach((id, i) => at.set(id, h[i])));
  }
  for (const line of session.lineEntities()) line.line!.ids.forEach((id, i) => at.set(id, line.line!.coords[i]));
  const wayMembers = members?.filter((m) => m.type === 'way') ?? [];
  if (!members || wayMembers.some((m) => !lineNodes.has(m.ref))) return tr('Для обновления контура нужны пути-члены мультиполигона — перезагрузите видимые тайлы.');
  const edits: ObjectEdit[] = [];
  const newWay = (ring: { ids: number[]; coords: LonLat[] }) => {
    const id = nextNewId--, key = `way/${id}`;
    edits.push({ key, create: { key, version: 0, tags: {}, line: { ids: [...ring.ids, ring.ids[0]], coords: [...ring.coords, ring.coords[0]] } } });
    return id;
  };
  const next: OsmMember[] = [{ type: 'way', ref: newWay(outer), role: 'outer' }];
  // Двор — тот же, если его узлы — узлы прежнего внутреннего кольца и площадь та же
  const oldInners = outline.polygons.flatMap((p) => p.inners.map((h, j) => ({ h, ids: p.innerIds?.[j] })));
  const area = (c: LonLat[]) => ringArea(c.map((x) => overpassLayer.focusToLocal(x)!));
  for (const hole of holes) {
    const same = oldInners.find((o) => o.ids && hole.ids.every((id) => o.ids!.includes(id)) && Math.abs(area(o.h) - area(hole.coords)) < 0.01 * area(o.h));
    const ways = same && wayMembers.filter((m) => m.role === 'inner' && lineNodes.get(m.ref)!.nodes.every((id) => same.ids!.includes(id)));
    if (ways?.length) next.push(...ways);
    else next.push({ type: 'way', ref: newWay(hole), role: 'inner' });
  }
  const kept = new Set(next.map((m) => m.ref));
  const gone = wayMembers.filter((m) => !kept.has(m.ref));
  const others = members.filter((m) => m.type !== 'way');
  if (outlineHasVolume(outlineTags)) {
    // Объём контура — новой частью прежней формы на прежних путях
    const relId = nextNewId--, key = `relation/${relId}`;
    const tags: Record<string, string> = { type: 'multipolygon', 'building:part': 'yes' };
    for (const [k, v] of Object.entries(outlineTags)) if (PART_TAGS.test(k)) { tags[k] = v; delete outlineTags[k]; }
    const relMembers = wayMembers.map((m) => ({ ...m }));
    edits.push({ key, create: { key, type: 'relation', id: relId, version: 0, kind: 'part', tags, hasParts: false,
      polygons: outline.polygons.map((p) => ({ ...p })), ways: outline.ways, relMembers } as Feature3D });
    edits.push({ key: g.key, members: [...g.relMembers, { type: 'relation', ref: relId, role: 'part' }] });
  } else {
    const live = liveFeatures();
    const shared = (id: number) => live.some((f) => f.type === 'relation' && f.key !== outline.key && relWays(f)?.some((w) => w.id === id));
    for (const m of gone) {
      const w = lineNodes.get(m.ref)!, key = `way/${m.ref}`;
      if (Object.keys(w.tags).length || shared(m.ref) || session.get(key)?.polygons?.length) continue;
      if (!session.has(key)) session.track({ key, version: 0, tags: {}, line: { ids: w.nodes, coords: w.nodes.map((id) => at.get(id)!) } });
      edits.push({ key, delete: true });
    }
  }
  edits.push({ key: outline.key, tags: outlineTags, members: [...next, ...others],
    polygons: [{ outer: outer.coords, outerIds: outer.ids, inners: holes.map((h) => h.coords), innerIds: holes.map((h) => h.ids) }] });
  return edits;

}

/** На какую долю площади вырастет контур после «Обновить контур»; undefined — построить нельзя. */
function outlineGrowth(r: { outline: Feature3D; parts: Feature3D[] }): number | undefined {
  const u = unitedOutline(r.outline, r.parts);
  if (typeof u === 'string') return;
  const area = (c: LonLat[]) => ringArea(c.map((x) => overpassLayer.focusToLocal(x)!));
  const was = r.outline.polygons.reduce((s, p) => s + area(p.outer) - p.inners.reduce((t, h) => t + area(h), 0), 0);
  const now = ringArea(u.outer) - u.holes.reduce((t, h) => t + ringArea(h), 0);
  return was > 0 ? now / was - 1 : undefined;
}

/** Предупреждение в панели режима здания: части за контуром и кнопка «Обновить контур». */
function outlineWarning(g: BuildingGroup): string {
  if (isSolo(g)) return '';
  const r = partsOutsideOutline(g);
  const above = partsAboveOutline(g);
  const share = r?.out.length ? outlineGrowth(r) : undefined;
  return (r?.out.length ? `<p class="warn">⚠ ${tr('Частей за контуром здания: {n}. Контур должен охватывать все части.', { n: r.out.length })}
    ${share !== undefined && share <= OUTLINE_GROW_SHARE
      ? `<button type="button" data-outline-fix title="${tr('Контур вырастет на {pct}% площади. Наведите — предпросмотр нового контура', { pct: (Math.round(share * 1000) / 10).toString() })}">${tr('Обновить контур')}</button>`
      : share !== undefined ? tr('Контур пришлось бы увеличить на {pct}% площади — проверьте сами части.', { pct: Math.round(share * 100).toString() }) : ''}</p>` : '')
    + (above ? `<p class="warn">⚠ ${aboveOutlineText(above)}</p>` : '');
}

/**
 * Части с building:levels больше, чем у контура: по конвенции на контуре — максимальная этажность здания.
 * undefined — всё в порядке (или у контура этажность не указана).
 */
function partsAboveOutline(g: BuildingGroup): { outline: number; max: number; keys: string[] } | undefined {
  const outline = Number(outlineTags(g)?.['building:levels']);
  if (!Number.isFinite(outline)) return;
  const outlineKey = g.members.find((_, i) => g.roles[i] === 'outline');
  const keys: string[] = [];
  let max = outline;
  for (const f of groupFeatures(g)) {
    if (f.key === outlineKey) continue;
    const n = Number(f.tags['building:levels']);
    if (Number.isFinite(n) && n > outline) { keys.push(f.key); max = Math.max(max, n); }
  }
  return keys.length ? { outline, max, keys } : undefined;
}

function aboveOutlineText(a: { outline: number; max: number; keys: string[] }): string {
  const list = a.keys.slice(0, 5).map((k) => `<a href="${server().web}/${k}" target="_blank" rel="noopener">${k}</a>`).join(', ')
    + (a.keys.length > 5 ? ' ' + tr('и ещё {n}', { n: a.keys.length - 5 }) : '');
  return tr('У контура building:levels={outline}, а у частей больше (до {max}): {list}.', { outline: a.outline, max: a.max, list })
    + ' ' + tr('На контуре принято указывать максимальную этажность здания.');
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
    ...neighbours,
  ]);
  enterFocus(group);
  select(parts[0].key);
  setStatus(tr('Создано здание {key}: контур {outline} и части {parts}.', { key: group.key, outline: f.key, parts: parts.map((p) => p.key).join(', ') }));
  return;
}

/** Минимальная толщина объекта при вытягивании, м: вдавливается хоть в ноль (стены нулевой высоты). */
const MIN_THICKNESS = 0;

/** Узлы стены (два узла стороны контура); undefined — в кеше нет id узлов. */
function sideNodes(f: Feature3D, edge: NonNullable<PushTarget['edge']>): [number, number] | undefined {
  adoptNodeIds(f);
  const p = f.polygons[edge.poly];
  const ids = edge.ring ? p?.innerIds?.[edge.ring - 1] : p?.outerIds;
  if (!ids?.length) return;
  return [ids[edge.i], ids[(edge.i + 1) % ids.length]];
}

/**
 * Стену можно тянуть всегда: общие с соседями узлы едут вместе с ней (соседи тянутся следом) или, в режиме
 * «отдельно», при применении разводятся (topologyEdits).
 */
function allowPushSide(t: PushTarget): boolean {
  const f = entity(t.key) as Feature3D | undefined;
  const nodes = f && t.edge ? sideNodes(f, t.edge) : undefined;
  if (!nodes || (f!.type === 'relation' && !relWays(f!))) {
    setStatus(tr('В кеше нет id узлов или путей этого объекта — нажмите «Перезагрузить видимые тайлы» в настройках графики.'), true);
    return false;
  }
  return true;
}

// ── Правка контуров без нахлёстов ──
// Общий узел нельзя сдвинуть (деформируется сосед), поэтому вместо него ставится новый. Новый угол на общей
// стороне вставляется во все пути с этой стороной; пути мультиполигона, которые лишь частью остаются в его
// новом кольце, режутся (свои куски — себе, остальное — соседям), новые стороны — новыми путями.

/** Новое кольцо объекта: узлы по порядку (новые — отрицательные id) и их координаты. */
interface RingRewrite {
  poly: number; ring: number; ids: number[]; coords: LonLat[];
  /** Внутренние кольца (номера, как ring), слитые в это: их пути-члены тоже перестраиваются под новое кольцо. */
  absorbs?: number[];
  /** Кольцо распалось (двор перегородили): остальные куски — новыми внутренними кольцами этого полигона. */
  extra?: { ids: number[]; coords: LonLat[] }[];
  /** Пути других (уходящих) отношений, которые можно взять в кольцо, а не рисовать там новые (объединение частей). */
  adopt?: number[];
}

/** Объекты с геометрией как сейчас (правки сессии поверх данных) и созданные в сессии. */
function liveFeatures(): Feature3D[] {
  const out = overpass.allFeatures();
  const have = new Set(out.map((f) => f.key));
  for (const c of createdShapes()) if (!have.has(c.key)) out.push(c);
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
 * Серверный путь, от которого (через цепочку разрезов) отрезан путь id: кусок куска ведём сразу к нему —
 * промежуточный кусок может исчезнуть из сессии, а при отправке куски встают во все отношения серверного пути.
 */
function splitRoot(id: number, local?: Map<number, number | undefined>): number | undefined {
  for (let i = 0; id < 0 && i < 100; i++) {
    const up = local?.has(id) ? local.get(id) : session.splitFromOf(`way/${id}`);
    if (up === undefined) return undefined;
    id = up;
  }
  return id > 0 ? id : undefined;
}

/**
 * Правки (одним шагом истории) для новых колец объектов items и вставки новых узлов в общие стороны.
 * Строка — почему нельзя.
 */
function topologyEdits(items: { f: Feature3D; rewrites: RingRewrite[] }[], inserts: Insert[], newCoords: Map<number, LonLat>,
  /** Объекты, удаляемые этим же шагом: им не нужны ни куски путей, ни сами пути. */
  gone = new Set<string>()): ObjectEdit[] | string {
  const all = liveFeatures();
  const live = all.filter((g) => !gone.has(g.key));
  const coords = new Map<number, LonLat>();
  const ways = new Map<number, { nodes: number[]; tags: Record<string, string> }>();
  for (const g of all) {
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
  /** Серверный путь куска — и созданного этим же шагом (у него splitFrom уже серверный). */
  const rootOf = (id: number) => { const r = created.has(id) ? created.get(id)!.splitFrom : splitRoot(id); return r !== undefined && r > 0 ? r : undefined; };
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
  /** Новые стороны колец (не куски): узлы в любом направлении → id. */
  const freeWays = new Map<string, number>();
  const lineKey = (nodes: number[]) => (nodes[0] <= nodes[nodes.length - 1] ? nodes : [...nodes].reverse()).join(',');
  /** Пути-члены, ушедшие с колец и больше никому не нужные, — удалить. */
  const dropped = new Set<number>();
  for (const { f, rewrites } of items) {
    edit(f.key).polygons = f.polygons.map((p, pi) => {
      const q = withInserts(p);
      const outer = rewrites.find((r) => r.poly === pi && r.ring === 0);
      return {
        ...q,
        ...(outer ? { outer: outer.coords, outerIds: outer.ids } : {}),
        inners: [...q.inners.map((r, j) => rewrites.find((w) => w.poly === pi && w.ring === j + 1)?.coords ?? r),
          ...rewrites.filter((w) => w.poly === pi).flatMap((w) => w.extra ?? []).map((x) => x.coords)],
        innerIds: q.innerIds && [...q.innerIds.map((r, j) => rewrites.find((w) => w.poly === pi && w.ring === j + 1)?.ids ?? r),
          ...rewrites.filter((w) => w.poly === pi).flatMap((w) => w.extra ?? []).map((x) => x.ids)],
      };
    });
    if (f.type !== 'relation') continue;
    const rw = relWays(f);
    if (!rw) return tr('{key}: в кеше нет путей-членов — перезагрузите видимые тайлы.', { key: f.key });
    let members: OsmMember[] = session.get(f.key)?.relMembers ?? rw.map((w) => ({ type: 'way' as const, ref: w.id, role: w.role }));
    for (const r of rewrites) {
      const p = f.polygons[r.poly];
      const old = r.ring ? p.innerIds?.[r.ring - 1] : p.outerIds;
      if (!old) return tr('{key}: в кеше нет id узлов.', { key: f.key });
      // Узлы, вставленные этим же шагом в пути кольца, — тоже свои (даже если с отпавшей части кольца)
      const adopted = (r.adopt ?? []).filter((id) => !members.some((m) => m.type === 'way' && m.ref === id));
      const allowed = new Set([...old, ...r.ids, ...inserts.map((x) => x.id), ...(r.extra ?? []).flatMap((x) => x.ids),
        ...(r.absorbs ?? []).flatMap((k) => p.innerIds?.[k - 1] ?? []), ...adopted.flatMap((id) => lineOf(id) ?? [])]);
      const role = r.ring ? 'inner' : 'outer';
      const ringWays: RingWay[] = [];
      for (const m of [...members, ...adopted.map((ref) => ({ type: 'way' as const, ref, role }))]) {
        if (m.type !== 'way' || (m.role === 'inner') !== (role === 'inner')) continue;
        const nodes = lineOf(m.ref);
        if (!nodes) return tr('{key}: нет данных пути way/{ref} — перезагрузите видимые тайлы.', { key: f.key, ref: m.ref });
        if (nodes.every((id) => allowed.has(id))) ringWays.push({ id: m.ref, role: m.role, nodes, tags: ways.get(m.ref)?.tags });
      }
      const res = restructureRing(ringWays, [r.ids, ...(r.extra ?? []).map((x) => x.ids)], role, () => nextNewId--);
      // Новая сторона, которую этим же шагом уже завёл сосед (удалили общий узел у нескольких отношений), — его путь
      for (const c of [...res.created]) {
        if (c.splitFrom !== undefined) continue;
        const same = freeWays.get(lineKey(c.nodes));
        if (same === undefined) { freeWays.set(lineKey(c.nodes), c.id); continue; }
        res.created.splice(res.created.indexOf(c), 1);
        for (const m of res.members) if (m.id === c.id) m.id = same;
      }
      // Кусок пути, ушедший с кольца, создаём всегда: путь может быть и в незагруженных отношениях (площадь,
      // территория) — при отправке кусок встанет во все отношения исходного на сервере, а не нужный никому отбросится
      const inRing = new Set(res.members.map((m) => m.id));
      const shared = (orig: number) => live.some((g) => g.type === 'relation' && g.key !== f.key && relWays(g)?.some((w) => w.id === orig));
      // Путь целиком ушёл с кольца и без тегов — лишний (удаление if-unused: занятый чужим отношением сервер оставит)
      // Новый кусок серверного пути не выкидываем: он может быть нужен незагруженному отношению (площади) — при
      // отправке встанет туда или отбросится сам
      for (const w of ringWays) if (!inRing.has(w.id) && !res.lines.has(w.id) && !shared(w.id) && !Object.keys(w.tags ?? {}).length
        && !(w.id < 0 && rootOf(w.id) !== undefined)) dropped.add(w.id);
      for (const [id, nodes] of res.lines) lines.set(id, nodes);
      for (const c of res.created) { lines.set(c.id, c.nodes); created.set(c.id, { tags: c.tags, splitFrom: c.splitFrom === undefined ? undefined : rootOf(c.splitFrom) ?? c.splitFrom }); }
      for (const [orig, ids] of res.pieces) if (ids.length) pieces.set(orig, [...(pieces.get(orig) ?? []), ...ids]);
      const ringIds = new Set(ringWays.map((w) => w.id));
      const keep = new Set(res.members.map((m) => m.id));
      const had = new Set(members.filter((m) => m.type === 'way').map((m) => m.ref));
      members = [
        ...members.filter((m) => m.type !== 'way' || !ringIds.has(m.ref) || keep.has(m.ref)),
        ...res.members.filter((m) => !had.has(m.id)).map((m) => ({ type: 'way' as const, ref: m.id, role: m.role })),
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
    if (!e) return tr('{key}: нет в данных.', { key });
    // У мультиполигона в сессии должен быть состав, иначе его правку не с чем сравнить
    if (edits.get(key)!.members && !e.relMembers) return tr('{key}: нет состава отношения.', { key });
  }
  const out = [...edits.values()];
  for (const [id, nodes] of lines) {
    const key = `way/${id}`;
    const line = { ids: nodes, coords: nodes.map(at) };
    const c = created.get(id);
    if (c) { out.push({ key, create: { key, version: 0, tags: { ...(c.tags ?? {}) }, line, splitFrom: c.splitFrom } }); continue; }
    const known = session.get(key);
    if (known && !known.line) return tr('{key} — сам по себе здание или часть, его не разрезать.', { key });
    if (!known) {
      const w = ways.get(id)!;
      session.track({ key, version: 0, tags: { ...w.tags }, line: { ids: w.nodes, coords: w.nodes.map(at) } });
    }
    out.push({ key, line });
  }
  for (const id of dropped) {
    if (lines.has(id)) continue;
    const key = `way/${id}`, w = ways.get(id);
    if (!w) continue;
    if (!session.has(key)) session.track({ key, version: 0, tags: { ...w.tags }, line: { ids: w.nodes, coords: w.nodes.map(at) } });
    out.push({ key, delete: true });
  }
  return out;
}

/**
 * Концы вытягиваемой стены: новые места (сторона сдвигается на d по нормали, концы скользят по соседним сторонам —
 * соседние стены сохраняют направление, как в SketchUp) и keep — соседняя сторона на одной прямой со стеной
 * (промежуточный узел, например общий угол с соседней частью на этой стороне): такой угол не скользит, старый
 * узел остаётся на месте, а новый угол встаёт рядом — между ними новая сторона поперёк.
 */
interface SideEnds { ids: number[]; was: LonLat[]; i: number; j: number; a: LonLat; b: LonLat; keepA: boolean; keepB: boolean }

function pushSideEnds(f: Feature3D, edge: NonNullable<PushTarget['edge']>, d: number): SideEnds | undefined {
  const p = f.polygons[edge.poly];
  const ids = edge.ring ? p?.innerIds?.[edge.ring - 1] : p?.outerIds;
  const was = edge.ring ? p?.inners[edge.ring - 1] : p?.outer;
  if (!ids || !was) return;
  const local = (c: LonLat) => overpassLayer.focusToLocal(c)!;
  const pts = was.map(local), n = pts.length;
  const i = edge.i, j = (i + 1) % n;
  const [nx, ny] = [edge.n.x * d, edge.n.y * d];
  const a2: [number, number] = [pts[i][0] + nx, pts[i][1] + ny], b2: [number, number] = [pts[j][0] + nx, pts[j][1] + ny];
  const ex = b2[0] - a2[0], ey = b2[1] - a2[1];
  // Новый конец — пересечение сдвинутой стороны с прямой соседней стороны; почти параллельная — keep
  const slide = (moved: [number, number], other: [number, number], self: [number, number]): { at: [number, number]; keep: boolean } => {
    const sx = self[0] - other[0], sy = self[1] - other[1];
    const den = ex * sy - ey * sx;
    if (Math.hypot(sx, sy) < 1e-6) return { at: moved, keep: false };
    if (Math.abs(den) < 1e-3 * Math.hypot(ex, ey) * Math.hypot(sx, sy)) return { at: moved, keep: Math.abs(d) > 1e-6 };
    const t = ((other[0] - a2[0]) * sy - (other[1] - a2[1]) * sx) / den;
    return { at: [a2[0] + t * ex, a2[1] + t * ey], keep: false };
  };
  const sa = slide(a2, pts[(i - 1 + n) % n], pts[i]), sb = slide(b2, pts[(j + 1) % n], pts[j]);
  const ll = (q: [number, number]) => overpassLayer.focusToLngLat(q[0], q[1])!;
  return { ids, was, i, j, a: ll(sa.at), b: ll(sb.at), keepA: sa.keep, keepB: sb.keep };
}

/** Кольцо стены после вытягивания: узлы (новые — из fresh) и координаты; fresh — новые id углов keep. */
function pushedRing(e: SideEnds, fresh: Map<number, LonLat>): { ids: number[]; coords: LonLat[] } {
  const ids: number[] = [], coords: LonLat[] = [];
  const put = (id: number, c: LonLat) => { ids.push(id); coords.push(c); };
  const add = (c: LonLat) => { const id = nextNewId--; fresh.set(id, c); put(id, c); };
  for (let k = 0; k < e.ids.length; k++) {
    if (k === e.i) { if (e.keepA) { put(e.ids[k], e.was[k]); add(e.a); } else put(e.ids[k], e.a); }
    else if (k === e.j) { if (e.keepB) { add(e.b); put(e.ids[k], e.was[k]); } else put(e.ids[k], e.b); }
    else put(e.ids[k], e.was[k]);
  }
  return { ids, coords };
}

/** Правки вытягивания стены: свободные углы двигаются, общие — заменяются новыми узлами (см. topologyEdits). */
function pushSideEdits(f: Feature3D, edge: NonNullable<PushTarget['edge']>, dz: number): ObjectEdit[] | string {
  const e = pushSideEnds(f, edge, dz);
  if (!e) return tr('В кеше нет id узлов этого объекта.');
  const { ids, was, i, j } = e;
  const n = ids.length;
  const shared = nodesOutside(new Set([f.key]));
  // Узел, общий с другим кольцом этой же части (дворы, касающиеся в точке), — тоже общий: двигать его нельзя
  f.polygons.forEach((p, pi) => [p.outerIds, ...(p.innerIds ?? [])].forEach((r, ri) => {
    if (pi !== edge.poly || ri !== edge.ring) for (const id of r ?? []) shared.add(id);
  }));
  // «С соседями» — только если есть кого тянуть; иначе это то же, что «отдельно» (там кольца ещё и приводятся в порядок)
  if (pushTool.glue && [...gluedSideMoves(e).keys()].some((id) => shared.has(id))) return levelSafeEdits([f.key], gluedSideEdits(f, edge, e), gluedSideMoves(e));
  const outIds: number[] = [], outC: LonLat[] = [], inserts: Insert[] = [], fresh = new Map<number, LonLat>();
  /** Сдвинутые прежние узлы — их новые места нужны и путям-членам. */
  const moved = new Map<number, LonLat>();
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
    if (k !== i && k !== j) { put(ids[k], was[k]); continue; }
    const at = k === i ? e.a : e.b;
    // Угол на прямой с соседней стороной — старый остаётся, новый рядом (поперечная сторона)
    if (k === i ? e.keepA : e.keepB) { if (k === i) { put(ids[k], was[k]); add(at); } else { add(at); put(ids[k], was[k]); } continue; }
    if (!shared.has(ids[k])) { put(ids[k], at); moved.set(ids[k], at); continue; } // свободный угол — просто сдвинуть
    // Соседняя сторона: у начала стены — предыдущая, у конца — следующая
    const nb = k === i ? (i - 1 + n) % n : (j + 1) % n;
    const { t, off } = along(was[nb], was[k], at);
    if (off < 1e-3 && t > 1e-6 && t < 1 - 1e-6) {
      // Внутрь: новый угол на соседней стороне — вставить его во все пути с этой стороной
      inserts.push({ id: add(at), u: ids[nb], v: ids[k] });
    } else if (k === i) { put(ids[k], was[k]); add(at); } // наружу: старый угол остаётся, новый — следом
    else { add(at); put(ids[k], was[k]); }
  }
  const norm = mergeTouchingRings(f, { poly: edge.poly, ring: edge.ring, ids: outIds, coords: outC });
  const edits = topologyEdits([{ f, rewrites: norm.rewrites }], [...inserts, ...norm.inserts], new Map([...fresh, ...moved]));
  if (typeof edits === 'string') return edits;
  dropRings(edits, f.key, edge.poly, norm.consumed);
  pruneMembers(edits, f);
  if (norm.holes) {
    const err = addHoles(edits, f, edge.poly, norm.holes);
    if (err) return err;
  }
  if (norm.islands) {
    const err = addIslands(edits, f, norm.islands);
    if (err) return err;
  }
  return edits;
}

/**
 * Островки стены между слитыми дворами (держатся на точке) — отдельными внешними кольцами мультиполигона:
 * новый полигон и новый внешний путь на тех же узлах (прежние куски внутренних путей с них уже сняты).
 */
function addIslands(edits: ObjectEdit[], f: Feature3D, islands: { ids: number[]; coords: LonLat[] }[]): string | undefined {
  const own = edits.find((x) => x.key === f.key) ?? edits[edits.push({ key: f.key }) - 1];
  const members = own.members ?? (f as Tagged).relMembers ?? session.get(f.key)?.relMembers;
  if (f.type !== 'relation' || !members) return tr('Для рассечения нужны пути-члены мультиполигона — перезагрузите видимые тайлы.');
  const outer = islands.map((h) => {
    const id = nextNewId--;
    edits.push({ key: `way/${id}`, create: { key: `way/${id}`, version: 0, tags: {}, line: { ids: [...h.ids, h.ids[0]], coords: [...h.coords, h.coords[0]] } } });
    return { type: 'way' as const, ref: id, role: 'outer' };
  });
  own.polygons = [...(own.polygons ?? f.polygons), ...islands.map((h) => ({ outer: h.coords, inners: [], outerIds: h.ids, innerIds: [] }))];
  own.members = [...members, ...outer];
  return;
}

/**
 * Пути-члены мультиполигона f, ни одна сторона которых больше не на кольцах (кольцо схлопнулось, слилось),
 * — из отношения долой; без тегов и не нужные другим отношениям — удалить (созданные этим же шагом — не создавать).
 */
function pruneMembers(edits: ObjectEdit[], f: Feature3D) {
  if (f.type !== 'relation') return;
  const e = edits.find((x) => x.key === f.key);
  const polygons = e?.polygons ?? f.polygons;
  const members = e?.members ?? (f as Tagged).relMembers ?? session.get(f.key)?.relMembers;
  if (!members) return;
  const ek = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
  const ringEdges = new Set<string>();
  for (const p of polygons) for (const ids of [p.outerIds, ...(p.innerIds ?? [])]) ids?.forEach((u, i) => ringEdges.add(ek(u, ids[(i + 1) % ids.length])));
  const lineNodes = new Map((f.ways ?? []).map((w) => [w.id, w.nodes] as const));
  for (const l of session.lineEntities()) lineNodes.set(Number(l.key.split('/')[1]), l.line!.ids);
  for (const x of edits) {
    const line = x.line ?? x.create?.line;
    if (line && x.key.startsWith('way/')) lineNodes.set(Number(x.key.split('/')[1]), line.ids);
  }
  const off = (ref: number) => {
    const ids = lineNodes.get(ref);
    return !!ids && ids.slice(1).every((b, i) => !ringEdges.has(ek(ids[i], b)) || ids[i] === b);
  };
  const gone = members.filter((m) => m.type === 'way' && off(m.ref)).map((m) => m.ref);
  if (!gone.length) return;
  const others = liveFeatures().filter((g) => g.type === 'relation' && g.key !== f.key);
  const edit = e ?? (edits.push({ key: f.key }), edits[edits.length - 1]);
  edit.members = members.filter((m) => m.type !== 'way' || !gone.includes(m.ref));
  for (const id of gone) {
    const key = `way/${id}`;
    const at = edits.findIndex((x) => x.key === key);
    const created = at >= 0 && edits[at].create;
    if (at >= 0) edits.splice(at, 1);
    if (created || others.some((g) => relWays(g)?.some((w) => w.id === id))) continue;
    const t = session.get(key);
    if (Object.keys(t?.tags ?? {}).length) continue;
    if (!t) {
      const nodes = lineNodes.get(id)!;
      const coords = nodeCoordsOf([f]);
      session.track({ key, version: 0, tags: {}, line: { ids: nodes, coords: nodes.map((n) => coords.get(n)!) } });
    }
    edits.push({ key, delete: true });
  }
}

/**
 * Кольца полигонов части после правки пересекаются или внутренние наезжают друг на друга — правку не применять:
 * у мультиполигона так нельзя (касаться кольца могут только в точке или, слившись, — уже одним кольцом).
 */
function ringsClash(polygons: Polygon[]): boolean {
  const local = (c: LonLat) => overpassLayer.focusToLocal(c)!;
  for (const p of polygons) {
    // Узел дважды в одном кольце — кольцо касается само себя
    if ([p.outerIds, ...(p.innerIds ?? [])].some((ids) => ids && new Set(ids).size !== ids.length)) return true;
    const rings = [p.outer, ...p.inners].map((r) => r.map(local));
    for (let i = 0; i < rings.length; i++) for (let j = i; j < rings.length; j++) {
      const a = rings[i], b = rings[j];
      for (let x = 0; x < a.length; x++) for (let y = 0; y < b.length; y++) {
        if (i === j && (Math.abs(x - y) <= 1 || Math.abs(x - y) === a.length - 1)) continue;
        if (segCross(a[x], a[(x + 1) % a.length], b[y], b[(y + 1) % b.length])) return true;
      }
    }
    for (let i = 1; i < rings.length; i++) for (let j = i + 1; j < rings.length; j++) {
      try {
        const common = polygonClipping.intersection([[...rings[i], rings[i][0]]], [[...rings[j], rings[j][0]]]);
        if (common.reduce((s, q) => s + ringArea(q[0].slice(0, -1) as [number, number][]), 0) > 0.01) return true;
      } catch { /* вырожденные — не мешаем */ }
    }
  }
  return false;
}

/** Убрать из полигона poly объекта key в правках внутренние кольца consumed (номера, как ring). */
function dropRings(edits: ObjectEdit[], key: string, poly: number, consumed: number[]) {
  if (!consumed.length) return;
  const e = edits.find((x) => x.key === key);
  if (e?.polygons) e.polygons = e.polygons.map((p, i) => (i !== poly ? p
    : { ...p, inners: p.inners.filter((_, j) => !consumed.includes(j + 1)), innerIds: p.innerIds?.filter((_, j) => !consumed.includes(j + 1)) }));
}

/**
 * Внутренние кольца части после правки кольца rw: вершина rw на стороне другого внутреннего кольца вставляется и
 * в него, а кольца, у которых теперь общая сторона (дворы сошлись по отрезку), сливаются в одно — общие стороны
 * взаимно уничтожаются. Иначе у мультиполигона два кольца с общим отрезком: так нельзя, и крыша рисуется с изъянами.
 */
function mergeTouchingRings(f: Feature3D, rw: RingRewrite): { rewrites: RingRewrite[]; consumed: number[]; inserts: Insert[]; holes?: { ids: number[]; coords: LonLat[] }[]; islands?: { ids: number[]; coords: LonLat[] }[] } {
  const p = f.polygons[rw.poly];
  if (!rw.ring) return tidyOuter(f, rw);
  if (!p?.innerIds) return { rewrites: [rw], consumed: [], inserts: [] };
  const local = (c: LonLat) => overpassLayer.focusToLocal(c)!;
  type R = { ring: number; ids: number[]; coords: LonLat[]; changed: boolean };
  const rings: R[] = p.inners.map((cs, j) => (j + 1 === rw.ring
    ? { ring: rw.ring, ids: [...rw.ids], coords: [...rw.coords], changed: true }
    : { ring: j + 1, ids: [...p.innerIds![j]], coords: [...cs], changed: false }));
  const me = rings.find((r) => r.ring === rw.ring)!;
  const near = (a: LonLat, b: LonLat) => { const p = local(a), q = local(b); return Math.hypot(p[0] - q[0], p[1] - q[1]) < 0.01; };
  // Вершина правленого кольца на месте вершины другого (стену дотянули до угла соседнего двора) — тот же узел
  me.ids.forEach((id, vi) => {
    for (const o of rings) {
      if (o === me || o.ids.includes(id)) continue;
      const k = o.coords.findIndex((c) => near(c, me.coords[vi]));
      if (k >= 0) { me.ids[vi] = o.ids[k]; me.coords[vi] = o.coords[k]; return; }
    }
  });
  // Совпавшие вершины самого кольца (стену дотянули до его же угла) — один узел: прежний или нужный другим кольцам
  const inOthers = (id: number) => rings.some((o) => o !== me && o.ids.includes(id));
  const old = new Set(p.innerIds[rw.ring - 1]);
  const keep = (x: number, y: number) => (inOthers(y) && !inOthers(x)) || (old.has(y) && !old.has(x));
  for (let i = 0; i < me.ids.length; i++) for (let j = i + 1; j < me.ids.length; j++) {
    if (me.ids[i] === me.ids[j] || !near(me.coords[i], me.coords[j])) continue;
    const [from, to] = keep(me.ids[i], me.ids[j]) ? [me.ids[i], me.ids[j]] : [me.ids[j], me.ids[i]];
    const at = me.coords[me.ids.indexOf(to)];
    me.ids.forEach((id, k) => { if (id === from) { me.ids[k] = to; me.coords[k] = at; } });
  }
  // Сторона нулевой длины (A, A), «шип» туда-обратно по узлам (A, B, A) и по прямой (B за A и C на одной прямой:
  // стену дотянули до параллельной стены) — убрать, пока есть
  const reverses = (a: LonLat, b: LonLat, c: LonLat) => {
    const [ax, ay] = local(a), [bx, by] = local(b), [cx, cy] = local(c);
    const ux = bx - ax, uy = by - ay, vx = cx - bx, vy = cy - by, lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
    return lu > 1e-6 && lv > 1e-6 && Math.abs(ux * vy - uy * vx) / (lu * lv) < 0.01 && ux * vx + uy * vy < 0;
  };
  for (let changed = true; changed && me.ids.length > 3;) {
    changed = false;
    const n = me.ids.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n, k = (i + 2) % n;
      const cut = me.ids[i] === me.ids[j] ? [j] : me.ids[i] === me.ids[k] ? [j, k]
        : reverses(me.coords[i], me.coords[j], me.coords[k]) && !inOthers(me.ids[j]) ? [j] : undefined;
      if (!cut) continue;
      for (const x of cut.sort((u, v) => v - u)) { me.ids.splice(x, 1); me.coords.splice(x, 1); }
      changed = true;
      break;
    }
  }
  const { inserts, extra: split } = splitSelfTouching(me);
  const extra = [...split];
  // Вершины правленого кольца (и отделившихся от него) на сторонах других — и в них (без Т-стыков)
  for (const o of rings) for (const m of [me, ...extra]) {
    if (o === me) continue;
    m.ids.forEach((id, vi) => {
      if (o.ids.includes(id)) return;
      const q = local(m.coords[vi]);
      for (let e = 0; e < o.ids.length; e++) {
        const a = local(o.coords[e]), b = local(o.coords[(e + 1) % o.ids.length]);
        if (segDist2(q, a, b) < 0.01 && Math.hypot(q[0] - a[0], q[1] - a[1]) > 0.01 && Math.hypot(q[0] - b[0], q[1] - b[1]) > 0.01) {
          o.ids.splice(e + 1, 0, id);
          o.coords.splice(e + 1, 0, m.coords[vi]);
          o.changed = true;
          break;
        }
      }
    });
  }
  // Кольцо схлопнулось (стену дотянули до противоположной) — убрать целиком; его пути-члены уберёт pruneMembers
  if (me.ids.length < 3 || ringArea(me.coords.map(local)) < COLLAPSED_HOLE_M2) {
    const rewrites = rings.filter((o) => o !== me && o.changed).map((o) => ({ poly: rw.poly, ring: o.ring, ids: o.ids, coords: o.coords }));
    return { rewrites, consumed: [me.ring], inserts };
  }
  // Кольца с общей стороной — слить: одинаково ориентированные кольца проходят её навстречу, такие пары убираем
  const consumed: number[] = [];
  const islands: { ids: number[]; coords: LonLat[] }[] = [];
  const coordOf = new Map<number, LonLat>();
  for (const r of rings) r.ids.forEach((id, i) => coordOf.set(id, r.coords[i]));
  const ccw = (r: R) => { let a = 0; const pts = r.coords.map(local); for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] - pts[i][0]) * (pts[j][1] + pts[i][1]); return a > 0; };
  const edgesOf = (r: R) => { const ids = ccw(r) ? r.ids : [...r.ids].reverse(); return ids.map((u, i) => [u, ids[(i + 1) % ids.length]] as const); };
  for (const o of rings) {
    if (o === me) continue;
    const mine = edgesOf(me), theirs = edgesOf(o);
    const back = new Set(theirs.map(([u, v]) => `${v},${u}`));
    if (!mine.some(([u, v]) => back.has(`${u},${v}`))) continue;
    const fwd = new Set(mine.map(([u, v]) => `${u},${v}`));
    const left = [...mine.filter(([u, v]) => !back.has(`${u},${v}`)), ...theirs.filter(([u, v]) => !fwd.has(`${v},${u}`))];
    const next = new Map<number, number>();
    let fork = false;
    for (const [u, v] of left) { if (next.has(u)) fork = true; next.set(u, v); }
    if (fork) {
      // Кольца ещё и касаются в точке: обход по самому левому повороту — кольца (против часовой) остаются
      // дворами, касающимися в точках; обходимое по часовой — островок стены между дворами, держится на точке:
      // он — отдельным внешним кольцом (addIslands)
      const loops = traceLoops(left, coordOf);
      if (!loops || !loops.some((l) => l.ccw)) continue;
      islands.push(...loops.filter((l) => !l.ccw).map((l) => ({ ids: l.ids, coords: l.ids.map((id) => coordOf.get(id)!) })));
      const sorted = loops.filter((l) => l.ccw).map((l) => l.ids).sort((x, y) => Math.abs(ringArea(y.map((id) => local(coordOf.get(id)!)))) - Math.abs(ringArea(x.map((id) => local(coordOf.get(id)!)))));
      me.ids = sorted[0];
      me.coords = me.ids.map((id) => coordOf.get(id)!);
      extra.push(...sorted.slice(1).map((ids) => ({ ids, coords: ids.map((id) => coordOf.get(id)!) })));
      consumed.push(o.ring);
      o.changed = false;
      continue;
    }
    const ids = [left[0][0]];
    for (let id = next.get(ids[0])!; id !== ids[0] && ids.length <= left.length; id = next.get(id)!) ids.push(id);
    if (ids.length !== left.length) continue; // распалось на несколько колец
    me.ids = ids;
    me.coords = ids.map((id) => coordOf.get(id)!);
    consumed.push(o.ring);
    o.changed = false;
  }
  const rewrites: RingRewrite[] = [{ poly: rw.poly, ring: me.ring, ids: me.ids, coords: me.coords,
    ...(consumed.length ? { absorbs: consumed } : {}), ...(extra.length ? { extra } : {}) }];
  for (const o of rings) if (o !== me && o.changed && !consumed.includes(o.ring)) rewrites.push({ poly: rw.poly, ring: o.ring, ids: o.ids, coords: o.coords });
  return { rewrites, consumed, inserts, ...(islands.length ? { islands } : {}) };
}

/**
 * Кольца из направленных сторон (кольца против часовой): в узле-развилке — самый левый поворот, так касающиеся
 * в точке кольца не слипаются; обход, вернувшийся в пройденный узел, отделяет петлю. ccw — обход против часовой.
 * undefined — не сошлось.
 */
function traceLoops(edges: (readonly [number, number])[], coordOf: Map<number, LonLat>): { ids: number[]; ccw: boolean }[] | undefined {
  const xy = (id: number) => overpassLayer.focusToLocal(coordOf.get(id)!)!;
  const list = edges.map(([u, v]) => ({ u, v, used: false }));
  const found: number[][] = [];
  for (const first of list) {
    if (first.used) continue;
    first.used = true;
    const ids = [first.u];
    let cur = first;
    for (let steps = 0; ; steps++) {
      if (steps > list.length) return;
      const at = cur.v;
      // Вернулись в пройденный узел (касание в точке) — петля от него отделяется, обход идёт дальше
      const k = ids.indexOf(at);
      if (k >= 0) {
        found.push(ids.splice(k));
        if (!ids.length) break;
      }
      ids.push(at);
      const outs = list.filter((x) => !x.used && x.u === at);
      if (!outs.length) return;
      const [px, py] = xy(cur.u), [cx, cy] = xy(at);
      const turn = (x: typeof cur) => { const [nx, ny] = xy(x.v); const ax = cx - px, ay = cy - py, bx = nx - cx, by = ny - cy; return Math.atan2(ax * by - ay * bx, ax * bx + ay * by); };
      const next = outs.reduce((best, x) => (turn(x) > turn(best) ? x : best));
      next.used = true;
      cur = next;
    }
  }
  if (found.some((ids) => ids.length < 3)) return;
  return found.map((ids) => {
    let a = 0;
    for (let i = 0, j = ids.length - 1; i < ids.length; j = i++) { const [xi, yi] = xy(ids[i]), [xj, yj] = xy(ids[j]); a += (xj - xi) * (yj + yi); }
    return { ids, ccw: a > 0 };
  });
}

/**
 * Внешнее кольцо после «Вытянуть»: совпавшие вершины — один узел (прежний), шипы долой; щель, сомкнутая до нуля
 * (сторону выреза дотянули до противоположной), отделяет дыру — она в holes (внутренним кольцом её делает addHoles).
 * Распалось на несколько внешних — как было (отклонит ringsClash).
 */
function tidyOuter(f: Feature3D, rw: RingRewrite): { rewrites: RingRewrite[]; consumed: number[]; inserts: Insert[]; holes?: { ids: number[]; coords: LonLat[] }[] } {
  const local = (c: LonLat) => overpassLayer.focusToLocal(c)!;
  const near = (a: LonLat, b: LonLat) => { const p = local(a), q = local(b); return Math.hypot(p[0] - q[0], p[1] - q[1]) < 0.01; };
  const me = { ids: [...rw.ids], coords: [...rw.coords] };
  const old = new Set(f.polygons[rw.poly]?.outerIds ?? []);
  const outside = nodesOutside(new Set([f.key]));
  for (let i = 0; i < me.ids.length; i++) for (let j = i + 1; j < me.ids.length; j++) {
    if (me.ids[i] === me.ids[j] || !near(me.coords[i], me.coords[j])) continue;
    const x = me.ids[i], y = me.ids[j];
    const keepY = (outside.has(y) && !outside.has(x)) || (old.has(y) && !old.has(x));
    const [from, to] = keepY ? [x, y] : [y, x];
    const at = me.coords[me.ids.indexOf(to)];
    me.ids.forEach((id, k) => { if (id === from) { me.ids[k] = to; me.coords[k] = at; } });
  }
  // Сторона нулевой длины (A, A) и шип туда-обратно (A, B, A) — убрать, пока есть
  for (let changed = true; changed && me.ids.length > 3;) {
    changed = false;
    const n = me.ids.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n, k = (i + 2) % n;
      const cut = me.ids[i] === me.ids[j] ? [j] : me.ids[i] === me.ids[k] ? [j, k] : undefined;
      if (!cut) continue;
      for (const x of cut.sort((u, v) => v - u)) { me.ids.splice(x, 1); me.coords.splice(x, 1); }
      changed = true;
      break;
    }
  }
  const { inserts, extra, holes } = splitSelfTouching(me, true);
  if (extra.length) return { rewrites: [rw], consumed: [], inserts: [] };
  // Узел, которого ещё нет на сервере, оставшийся на прямой (бывшее устье щели), никому больше не нужен — убрать
  if (holes.length) {
    const inHoles = new Set(holes.flatMap((h) => h.ids));
    for (let i = 0; me.ids.length > 3 && i < me.ids.length;) {
      const n = me.ids.length, id = me.ids[i];
      const a = local(me.coords[(i - 1 + n) % n]), b = local(me.coords[i]), c = local(me.coords[(i + 1) % n]);
      if (id < 0 && !outside.has(id) && !inHoles.has(id) && segDist2(b, a, c) < 0.01) { me.ids.splice(i, 1); me.coords.splice(i, 1); } else i++;
    }
  }
  return { rewrites: [{ ...rw, ids: me.ids, coords: me.coords }], consumed: [], inserts, ...(holes.length ? { holes } : {}) };
}

/**
 * Дыры, отделившиеся от внешнего кольца (щель сомкнули), — внутренними кольцами полигона poly: у мультиполигона —
 * новые внутренние пути, путь (часть здания) становится внешним кольцом нового мультиполигона, как при вырезе кольца.
 * Строка — почему нельзя.
 */
function addHoles(edits: ObjectEdit[], f: Feature3D, poly: number, holes: { ids: number[]; coords: LonLat[] }[]): string | undefined {
  const own = edits.find((x) => x.key === f.key) ?? edits[edits.push({ key: f.key }) - 1];
  const polygons = own.polygons ?? f.polygons;
  const p = polygons[poly];
  if (!p?.outerIds) return tr('В кеше нет id узлов этого объекта.');
  const inner = holes.map((h) => {
    const id = nextNewId--;
    const line = { ids: [...h.ids, h.ids[0]], coords: [...h.coords, h.coords[0]] };
    edits.push({ key: `way/${id}`, create: { key: `way/${id}`, version: 0, tags: {}, line } });
    return { id, role: 'inner', nodes: line.ids };
  });
  const withHoles = polygons.map((q, i) => (i === poly
    ? { ...q, inners: [...q.inners, ...holes.map((h) => h.coords)], innerIds: [...(q.innerIds ?? []), ...holes.map((h) => h.ids)] } : q));
  const innerMembers = inner.map((w) => ({ type: 'way' as const, ref: w.id, role: 'inner' }));
  if (f.type === 'relation') {
    const members = own.members ?? (f as Tagged).relMembers ?? session.get(f.key)?.relMembers;
    if (!members) return tr('Для рассечения нужны пути-члены мультиполигона — перезагрузите видимые тайлы.');
    own.polygons = withHoles;
    own.members = [...members, ...innerMembers];
    return;
  }
  const g = focus && !isSolo(focus) ? (entity(focus.key) as EditGroup | undefined) : undefined;
  if (!g || polygons.length !== 1) return tr('Сомкнуть вырез во двор у отдельного здания пока нельзя — сначала соберите отношение здания.');
  // Путь — внешнее кольцо нового мультиполигона, теги переезжают на отношение
  const outer = { ids: [...p.outerIds, p.outerIds[0]], coords: [...p.outer, p.outer[0]] };
  const relId = nextNewId--;
  const ways = [{ id: f.id, role: 'outer', nodes: outer.ids }, ...inner];
  const relMembers = ways.map((w) => ({ type: 'way' as const, ref: w.id, role: w.role }));
  const rel: Feature3D & { relMembers: OsmMember[] } = { key: `relation/${relId}`, type: 'relation', id: relId, version: 0, kind: f.kind,
    tags: { type: 'multipolygon', ...f.tags }, polygons: withHoles, hasParts: false, ways, relMembers };
  edits.push({ key: rel.key, create: rel });
  own.tags = {};
  own.polygons = [];
  own.line = outer;
  edits.push(groupMembersEdit(g, g.relMembers.map((m) => (m.type === 'way' && m.ref === f.id ? { type: 'relation' as const, ref: relId, role: m.role } : m))));
  return;
}

/**
 * Вершина кольца легла на его же сторону (выступ двора дотянули до противоположной стены) — двор перегорожен.
 * Вершина вставляется в сторону (inserts — и в пути с ней), встречные стороны перемычки взаимно уничтожаются,
 * оставшиеся стороны собираются в кольца (в узле-развилке — самый левый поворот для кольца против часовой,
 * так касающиеся в точке кольца не слипаются; не вышло — самый правый). Кольца, обходимые в обратную сторону
 * (выступ, перекрытый стеной, — это стена, а не двор), и схлопнутые — долой. Самое большое остаётся в r,
 * остальные — extra. Кольцо с повтором узла всё равно осталось — его отклонит ringsClash.
 */
function splitSelfTouching(r: { ids: number[]; coords: LonLat[] }, keepHoles = false): { inserts: Insert[]; extra: { ids: number[]; coords: LonLat[] }[]; holes: { ids: number[]; coords: LonLat[] }[] } {
  const local = (c: LonLat) => overpassLayer.focusToLocal(c)!;
  const n = r.ids.length, pts = r.coords.map(local);
  const ids: number[] = [], coords: LonLat[] = [], inserts: Insert[] = [];
  for (let u = 0; u < n; u++) {
    const v = (u + 1) % n, a = pts[u], b = pts[v];
    ids.push(r.ids[u]); coords.push(r.coords[u]);
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
    if (l2 < 1e-8) continue;
    const on: { k: number; t: number }[] = [];
    for (let k = 0; k < n; k++) {
      if (r.ids[k] === r.ids[u] || r.ids[k] === r.ids[v] || on.some((o) => r.ids[o.k] === r.ids[k])) continue;
      const q = pts[k];
      if (segDist2(q, a, b) >= 0.01 || Math.hypot(q[0] - a[0], q[1] - a[1]) < 0.01 || Math.hypot(q[0] - b[0], q[1] - b[1]) < 0.01) continue;
      on.push({ k, t: ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / l2 });
    }
    for (const { k, t } of on.sort((x, y) => x.t - y.t)) {
      ids.push(r.ids[k]); coords.push(r.coords[k]);
      inserts.push({ id: r.ids[k], u: r.ids[u], v: r.ids[v], t });
    }
  }
  if (new Set(ids).size === ids.length) return { inserts: [], extra: [], holes: [] };
  const at = new Map(ids.map((id, i) => [id, coords[i]] as const));
  const xy = new Map(ids.map((id, i) => [id, local(coords[i])] as const));
  const signed = (ring: number[]) => { let s = 0; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) s += (xy.get(ring[j])![0] - xy.get(ring[i])![0]) * (xy.get(ring[j])![1] + xy.get(ring[i])![1]); return s / 2; };
  const sign = Math.sign(signed(ids));
  const trace = (left: boolean): number[][] | undefined => {
    const edges = ids.map((u, i) => ({ u, v: ids[(i + 1) % ids.length], used: false }));
    for (const e of edges) {
      if (e.used) continue;
      const back = edges.find((x) => !x.used && x !== e && x.u === e.v && x.v === e.u);
      if (back) e.used = back.used = true;
    }
    const loops: number[][] = [];
    for (const first of edges) {
      if (first.used) continue;
      first.used = true;
      const loop = [first.u];
      let cur = first;
      while (cur.v !== first.u) {
        const outs = edges.filter((x) => !x.used && x.u === cur.v);
        if (!outs.length || loop.length > edges.length) return; // не сошлось
        const [px, py] = xy.get(cur.u)!, [cx, cy] = xy.get(cur.v)!;
        const turn = (x: typeof cur) => { const [nx, ny] = xy.get(x.v)!; const ax = cx - px, ay = cy - py, bx = nx - cx, by = ny - cy; return Math.atan2(ax * by - ay * bx, ax * bx + ay * by); };
        const next = outs.reduce((best, x) => ((left ? turn(x) > turn(best) : turn(x) < turn(best)) ? x : best));
        next.used = true;
        loop.push(cur.v);
        cur = next;
      }
      loops.push(loop);
    }
    return loops.filter((l) => l.length >= 3 && Math.abs(signed(l)) >= COLLAPSED_HOLE_M2);
  };
  const simple = (ls: number[][] | undefined) => !!ls && ls.every((l) => new Set(l).size === l.length);
  const first = trace(sign > 0), second = simple(first) ? undefined : trace(sign < 0);
  const all = simple(first) || !simple(second) ? first : second;
  if (!all) return { inserts: [], extra: [], holes: [] }; // не сошлось — как было
  // Обходимые в ту же сторону — кольца; в обратную — у двора это стена, у внешнего кольца (keepHoles) — дыра
  const kept = all.filter((l) => Math.sign(signed(l)) === sign).sort((x, y) => Math.abs(signed(y)) - Math.abs(signed(x)));
  const ring = (l: number[]) => ({ ids: l, coords: l.map((id) => at.get(id)!) });
  r.ids = kept[0] ?? [];
  r.coords = r.ids.map((id) => at.get(id)!);
  return { inserts, extra: kept.slice(1).map(ring), holes: keepHoles ? all.filter((l) => Math.sign(signed(l)) !== sign).map(ring) : [] };
}

/**
 * Вытягивание стены «с соседями»: общие узлы не заменяются — соседи с ними тянутся следом (moves из gluedSideMoves).
 * Углы на прямой с соседней стороной (keep) остаются, новый угол — новым узлом только у этого объекта.
 */
function gluedSideEdits(f: Feature3D, edge: NonNullable<PushTarget['edge']>, e: SideEnds): ObjectEdit[] | string {
  const moves = gluedSideMoves(e);
  if (!e.keepA && !e.keepB) return nodeMoveEdits(moves);
  const fresh = new Map<number, LonLat>();
  const ring = pushedRing(e, fresh);
  const edits = topologyEdits([{ f, rewrites: [{ poly: edge.poly, ring: edge.ring, ...ring }] }], [], new Map([...fresh, ...moves]));
  if (typeof edits === 'string') return edits;
  const others = nodeMoveEdits(moves);
  if (typeof others === 'string') return others;
  const byKey = new Map(edits.map((x) => [x.key, x] as const));
  // Сдвинутые узлы — и в других кольцах этой части (узел, где касаются дворы)
  const own = byKey.get(f.key);
  if (own?.polygons) {
    const ring = (cs: LonLat[], ids: number[] | undefined) => cs.map((c, k) => (ids && moves.get(ids[k])) || c);
    own.polygons = own.polygons.map((p) => ({ ...p, outer: ring(p.outer, p.outerIds), inners: p.inners.map((r, k) => ring(r, p.innerIds?.[k])) }));
  }
  for (const o of others) {
    if (o.key === f.key) continue;
    const x = byKey.get(o.key);
    if (!x) { edits.push(o); continue; }
    // Путь-член, уже переписанный разводкой, — сдвинутые узлы в его новых координатах; у отношения — контур
    if (x.line) x.line = { ids: x.line.ids, coords: x.line.ids.map((id, k) => moves.get(id) ?? x.line!.coords[k]) };
    if (o.polygons && !x.polygons) x.polygons = o.polygons;
  }
  return edits;
}

/**
 * Вытягивание стены «с соседями»: концы стены (кроме keep) едут на новые места, общие узлы не заменяются —
 * соседи с этими узлами тянутся следом. Чужие узлы на самой стене (Т-образные стыки, вставленные соседями
 * углы) переносятся на то же место новой стены. Узел → новые координаты.
 */
function gluedSideMoves(e: SideEnds): Map<number, LonLat> {
  const { ids, was, i, j } = e;
  const moves = new Map<number, LonLat>();
  if (!e.keepA) moves.set(ids[i], e.a);
  if (!e.keepB) moves.set(ids[j], e.b);
  const local = (c: LonLat) => overpassLayer.focusToLocal(c)!;
  const [ax, ay] = local(was[i]), [bx, by] = local(was[j]), [cx, cy] = local(e.a), [dx, dy] = local(e.b);
  const ex = bx - ax, ey = by - ay, len = Math.hypot(ex, ey);
  if (len < 1e-6) return moves;
  for (const g of liveFeatures()) {
    for (const r of g.polygons) {
      const rings: [LonLat[], number[] | undefined][] = [[r.outer, r.outerIds], ...r.inners.map((c, k): [LonLat[], number[] | undefined] => [c, r.innerIds?.[k]])];
      for (const [ring, rids] of rings) {
        rids?.forEach((id, k) => {
          if (moves.has(id) || id === ids[i] || id === ids[j]) return;
          const [px, py] = local(ring[k]);
          // На стене или у её конца (почти совпадающий угол соседа) — едет как ближайшая точка стены
          const t = Math.min(1, Math.max(0, ((px - ax) * ex + (py - ay) * ey) / (len * len)));
          if (Math.hypot(px - ax - t * ex, py - ay - t * ey) >= ON_SIDE_M) return;
          if ((t === 0 && e.keepA) || (t === 1 && e.keepB)) return;
          const mx = (cx - ax) * (1 - t) + (dx - bx) * t, my = (cy - ay) * (1 - t) + (dy - by) * t;
          moves.set(id, overpassLayer.focusToLngLat(px + mx, py + my)!);
        });
      }
    }
  }
  return moves;
}

/**
 * Правки «узлы moves — на новые места» у всех объектов и путей-членов с этими узлами (соседи — следом).
 * preview — только посчитать, не начиная отслеживать соседей в сессии.
 */
function nodeMoveEdits(moves: Map<number, LonLat>, preview = false): ObjectEdit[] | string {
  const out: ObjectEdit[] = [];
  const ring = (cs: LonLat[], ids: number[] | undefined) => (ids?.some((id) => moves.has(id)) ? cs.map((c, k) => moves.get(ids[k]) ?? c) : cs);
  for (const g of liveFeatures()) {
    if (!g.polygons.some((r) => [r.outerIds, ...(r.innerIds ?? [])].some((ids) => ids?.some((id) => moves.has(id))))) continue;
    if (!preview && !entity(g.key)) return tr('{key}: нет в данных.', { key: g.key });
    out.push({ key: g.key, polygons: g.polygons.map((r) => ({ ...r, outer: ring(r.outer, r.outerIds), inners: r.inners.map((c, k) => ring(c, r.innerIds?.[k])) })) });
  }
  for (const t of session.lineEntities()) {
    const l = t.line!;
    if (l.ids.some((id) => moves.has(id))) out.push({ key: t.key, line: { ids: l.ids, coords: l.ids.map((id, k) => moves.get(id) ?? l.coords[k]) } });
  }
  return out;
}

/** Соседи, перестроенные в превью вытягивания «с соседями», — вернуть их при сбросе превью. */
let pushPreviewed: string[] = [];

/** Контур с вытянутой стеной (для превью): углы — как в pushSideEnds, у углов keep — старый и новый. */
function pushSidePolygons(f: Feature3D, edge: NonNullable<PushTarget['edge']>, d: number): Feature3D['polygons'] {
  const e = pushSideEnds(f, edge, d);
  if (!e) return f.polygons;
  const ring = pushedRing(e, new Map()).coords;
  return f.polygons.map((p, pi) => (pi !== edge.poly ? p : edge.ring
    ? { ...p, inners: p.inners.map((r, ri) => (ri === edge.ring - 1 ? ring : r)) }
    : { ...p, outer: ring }));
}

function clampPush(t: PushTarget, dz: number): number {
  const f = entity(t.key) as Feature3D | undefined;
  if (!f) return 0;
  if (t.face === 'side') return dz;
  const h = drawnHeights(f);
  // Верх не ниже низа + крыша; низ — не ниже земли и не выше верха стен
  let lower = t.face === 'top' ? h.min + h.roofHeight + MIN_THICKNESS - h.top : -h.min;
  let upper = t.face === 'top' ? Infinity : h.wallTop - MIN_THICKNESS - h.min;
  if (pushTool.units === 'levels') {
    lower = Math.ceil(lower / LEVEL_HEIGHT) * LEVEL_HEIGHT;
    upper = Math.floor(upper / LEVEL_HEIGHT) * LEVEL_HEIGHT;
  }
  return Math.min(Math.max(dz, lower), upper);
}

function previewPush(t: PushTarget, dz: number | undefined) {
  const f = entity(t.key) as Feature3D | undefined;
  if (!f) return;
  const restore = (keep: Set<string>) => {
    const live = pushPreviewed.length ? new Map(liveFeatures().map((g) => [g.key, g] as const)) : undefined;
    for (const k of pushPreviewed) { const g = live?.get(k); if (!keep.has(k) && g) previewFocus(g); }
    pushPreviewed = pushPreviewed.filter((k) => keep.has(k));
  };
  pushTool.linked = 0;
  if (dz === undefined) { restore(new Set()); overpassLayer.setLinked([]); return previewFocus(f); }
  overpassLayer.setLinked([]);
  if (t.face === 'side' && pushTool.glue) {
    const e = pushSideEnds(f, t.edge!, dz);
    const edits = e ? nodeMoveEdits(gluedSideMoves(e), true) : undefined;
    if (Array.isArray(edits)) {
      const live = new Map(liveFeatures().map((g) => [g.key, g] as const));
      // Сам объект — со своими новыми углами (у углов на прямой с соседней стороной — старый и новый)
      const keys = new Set<string>([f.key]);
      previewFocus({ ...f, polygons: pushSidePolygons(f, t.edge!, dz) });
      const apart = levelApartKeys([f.key]);
      for (const x of edits) {
        const g = live.get(x.key);
        if (x.key === f.key || apart.has(x.key) || !x.polygons || !g) continue;
        keys.add(x.key);
        previewFocus({ ...g, polygons: x.polygons });
      }
      restore(keys);
      pushPreviewed = [...keys].filter((k) => k !== t.key);
      // Соседи, которых стена тянет за собой, — фиолетовыми рёбрами (как общие узлы на схемах) и числом в панели
      overpassLayer.setLinked(pushPreviewed);
      pushTool.linked = pushPreviewed.length;
      return;
    }
  }
  previewFocus(t.face === 'side'
    ? { ...f, polygons: pushSidePolygons(f, t.edge!, dz) }
    : { ...f, tags: pushHeightTags(f.tags, t.face, dz, pushTool.units, isFreshFlat(f.tags, f.version, drawnHeights(f)), drawnHeights(f)) });
}

function commitPush(t: PushTarget, dz: number) {
  const f = entity(t.key) as Feature3D | undefined;
  if (!f) return;
  if (t.face === 'side') {
    const edits = pushSideEdits(f, t.edge!, dz);
    if (typeof edits === 'string') return setStatus(edits, true);
    dropCollapsedHoles(edits);
    const own = edits.find((e) => e.key === t.key)?.polygons;
    if (own && ringsClash(own)) return setStatus(tr('Стена заходит в соседний двор или пересекает другие стены части — так вытянуть нельзя.'), true);
    session.editMany(edits);
    // Вырез сомкнули во двор — путь стал внешним кольцом нового мультиполигона: выделить его
    const rel = edits.find((e) => e.create && e.key.startsWith('relation/') && (e.create as Feature3D).ways?.some((w) => w.id === f.id && w.role === 'outer'));
    if (rel) select(rel.key);
  }
  else session.setTags(t.key, diffTags(f.tags, pushHeightTags(f.tags, t.face, dz, pushTool.units, isFreshFlat(f.tags, f.version, drawnHeights(f)), drawnHeights(f))));
  const levels = t.face !== 'side' && pushTool.units === 'levels' ? ' ' + tr('({n} эт.)', { n: `${dz >= 0 ? '+' : ''}${Math.round(dz / LEVEL_HEIGHT)}` }) : '';
  const params = { key: t.key, d: `${dz >= 0 ? '+' : ''}${dz.toFixed(2)}`, levels };
  setStatus(t.face === 'top' ? tr('Верх {key} сдвинут на {d} м{levels}.', params)
    : t.face === 'bottom' ? tr('Низ {key} сдвинут на {d} м{levels}.', params)
    : tr('Стена {key} сдвинута на {d} м{levels}.', params));
}

// ── «Форма»: сдвиг вершин контура и новая вершина на стороне ──

/** Кольцо захваченной вершины в данных: объект, координаты и id узлов. */
type ShapeRing = { f: Feature3D; ring: LonLat[]; ids: number[] };

function shapeRing(t: ShapeTarget): ShapeRing | undefined {
  const f = entity(t.key) as Feature3D | undefined;
  if (!f?.polygons) return;
  adoptNodeIds(f);
  const p = f.polygons[t.poly];
  const ring = t.ring ? p?.inners[t.ring - 1] : p?.outer;
  const ids = t.ring ? p?.innerIds?.[t.ring - 1] : p?.outerIds;
  if (!ring?.[t.i] || !ids || ids.length !== ring.length) return;
  return { f, ring, ids };
}

/** Кольца объекта с правлеными вершинами: координаты, id узлов и номера вершин (ks). */
type ShapeRings = { poly: number; ring: number; coords: LonLat[]; ids: number[]; ks: number[] }[];

/** Вершины t (захваченная и выбранные вместе с ней) по кольцам; undefined — нет id узлов. */
function shapeRings(f: Feature3D, t: ShapeTarget): ShapeRings | undefined {
  adoptNodeIds(f);
  const out: ShapeRings = [];
  for (const v of [t, ...(t.also ?? [])]) {
    let r = out.find((x) => x.poly === v.poly && x.ring === v.ring);
    if (!r) {
      const p = f.polygons[v.poly];
      const coords = v.ring ? p?.inners[v.ring - 1] : p?.outer;
      const ids = v.ring ? p?.innerIds?.[v.ring - 1] : p?.outerIds;
      if (!coords || !ids || ids.length !== coords.length) return;
      out.push(r = { poly: v.poly, ring: v.ring, coords, ids, ks: [] });
    }
    if (!r.coords[v.i]) return;
    r.ks.push(v.i);
  }
  return out;
}

const shapeShift = (c: LonLat, offset: THREE.Vector3): LonLat => {
  const [x, y] = overpassLayer.focusToLocal(c)!;
  return overpassLayer.focusToLngLat(x + offset.x, y + offset.y)!;
};

/** Кольца после сдвига вершин ks на offset. */
const shapeMoved = (rings: ShapeRings, offset: THREE.Vector3) =>
  rings.map((r) => ({ ...r, coords: r.coords.map((c, k) => (r.ks.includes(k) ? shapeShift(c, offset) : c)) }));

/** Почему так нельзя: две соседние вершины совпали или контур пересекает сам себя. */
function shapeProblem(rings: { coords: LonLat[] }[], before: { coords: LonLat[] }[]): string | undefined {
  const short = (pts: Pt[], k: number) => Math.hypot(pts[(k + 1) % pts.length][0] - pts[k][0], pts[(k + 1) % pts.length][1] - pts[k][1]) < 0.05;
  for (let ri = 0; ri < rings.length; ri++) {
    const pts = rings[ri].coords.map((c) => overpassLayer.focusToLocal(c)!);
    const was = before[ri].coords.map((c) => overpassLayer.focusToLocal(c)!);
    // Вырожденное уже до правки (схлопнутая дыра, совпавшие узлы в данных) — не мешает его исправлять
    for (let k = 0; k < pts.length; k++) {
      if (short(pts, k) && !short(was, k)) return tr('Вершина совпала с соседней — слияние вершин пока не поддерживается.');
    }
    if (selfIntersects(pts) && !selfIntersects(was)) return tr('Контур пересекает сам себя.');
  }
}

/**
 * Сдвиг вершин «с соседями»: узлы едут на новые места, соседи с этими узлами — следом. Чужие узлы на сторонах у этих
 * вершин (Т-образные стыки, не в наших кольцах) остаются на тех же местах сторон. Узел → координаты.
 */
function shapeMoves(rings: ShapeRings, offset: THREE.Vector3): Map<number, LonLat> {
  const moves = new Map<number, LonLat>();
  const local = (c: LonLat) => overpassLayer.focusToLocal(c)!;
  const own = new Set(rings.flatMap((r) => r.ids));
  /** Стороны у едущих вершин: концы до и после сдвига (метры). */
  const sides: { a: Pt; b: Pt; a2: Pt; b2: Pt }[] = [];
  const seen = new Set<string>();
  for (const r of rings) {
    const n = r.coords.length;
    for (const k of r.ks) {
      moves.set(r.ids[k], shapeShift(r.coords[k], offset));
      for (const j of [(k - 1 + n) % n, (k + 1) % n]) {
        const id = k < j ? `${r.poly}:${r.ring}:${k}:${j}` : `${r.poly}:${r.ring}:${j}:${k}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const a = local(r.coords[k]), b = local(r.coords[j]);
        const bMoves = r.ks.includes(j);
        sides.push({ a, b, a2: [a[0] + offset.x, a[1] + offset.y], b2: bMoves ? [b[0] + offset.x, b[1] + offset.y] : b });
      }
    }
  }
  for (const g of liveFeatures()) for (const p of g.polygons) {
    const all: [LonLat[], number[] | undefined][] = [[p.outer, p.outerIds], ...p.inners.map((c, k): [LonLat[], number[] | undefined] => [c, p.innerIds?.[k]])];
    for (const [ring, rids] of all) rids?.forEach((nid, k) => {
      if (own.has(nid) || moves.has(nid)) return;
      const [px, py] = local(ring[k]);
      for (const { a, b, a2, b2 } of sides) {
        const ex = b[0] - a[0], ey = b[1] - a[1], len = Math.hypot(ex, ey);
        if (len < 1e-6) continue;
        // На стороне или у её конца (почти совпадающий угол соседа) — едет как ближайшая точка стороны
        const s = Math.min(1, Math.max(0, ((px - a[0]) * ex + (py - a[1]) * ey) / (len * len)));
        if (Math.hypot(px - a[0] - s * ex, py - a[1] - s * ey) >= ON_SIDE_M) continue;
        const mx = (a2[0] - a[0]) * (1 - s) + (b2[0] - b[0]) * s, my = (a2[1] - a[1]) * (1 - s) + (b2[1] - b[1]) * s;
        moves.set(nid, overpassLayer.focusToLngLat(px + mx, py + my)!);
        break;
      }
    });
  }
  return moves;
}

/** Только свои узлы на новые места (без соседей). */
const shapeOwnMoves = (rings: ShapeRings, offset: THREE.Vector3) =>
  new Map(rings.flatMap((r) => r.ks.map((k) => [r.ids[k], shapeShift(r.coords[k], offset)] as const)));

/** Ближе этого к чужому узлу вершина встаёт в сам узел (привязка к углу соседа), а не рядом с ним новым. */
const LAND_ON_NODE_M = 0.05;

/**
 * Узлы, на которые встают сдвинутые вершины: «ri,k» → узел другого объекта (или своего другого кольца) в пределах
 * LAND_ON_NODE_M. Узел, который уже есть в том же кольце, не берём — кольцо коснулось бы себя.
 */
function shapeLandings(moved: ShapeRings): Map<string, { id: number; at: LonLat }> {
  const out = new Map<string, { id: number; at: LonLat }>();
  const movedIds = new Set(moved.flatMap((r) => r.ks.map((k) => r.ids[k])));
  const nodes = new Map<number, LonLat>();
  for (const g of liveFeatures()) for (const p of g.polygons) {
    p.outerIds?.forEach((id, i) => nodes.set(id, p.outer[i]));
    p.inners.forEach((r, j) => p.innerIds?.[j]?.forEach((id, i) => nodes.set(id, r[i])));
  }
  const local = new Map<number, Pt>();
  for (const [id, c] of nodes) if (!movedIds.has(id)) { const l = overpassLayer.focusToLocal(c); if (l) local.set(id, l); }
  moved.forEach((r, ri) => {
    for (const k of r.ks) {
      const q = overpassLayer.focusToLocal(r.coords[k]);
      if (!q) continue;
      let best: number | undefined, bd = LAND_ON_NODE_M;
      for (const [id, l] of local) {
        const d = Math.hypot(l[0] - q[0], l[1] - q[1]);
        if (d < bd && !r.ids.includes(id)) { bd = d; best = id; }
      }
      if (best !== undefined) out.set(`${ri},${k}`, { id: best, at: nodes.get(best)! });
    }
  });
  return out;
}

/**
 * Сдвиг вершин «отдельно»: общие с соседями узлы остаются им, у части на новых местах — новые узлы. Вершина,
 * отпущенная на чужой узел (угол соседа), становится этим узлом — иначе рядом с ним вырос бы двойник.
 * together — части, выделенные вместе с f: общие с ними узлы едут у них тоже (новый узел — общий для них).
 */
function shapeSeparateEdits(f: Feature3D, rings: ShapeRings, offset: THREE.Vector3, together = new Set([f.key])): ObjectEdit[] | string {
  const outside = nodesOutside(new Set([...together, f.key]));
  const moved = shapeMoved(rings, offset);
  const land = shapeLandings(moved);
  if (!land.size && !rings.some((r) => r.ks.some((k) => outside.has(r.ids[k])))) return nodeMoveEdits(shapeOwnMoves(rings, offset));
  const fresh = new Map<number, LonLat>();
  const rewrites = moved.map((r, ri) => {
    const coords = r.coords.map((c, k) => land.get(`${ri},${k}`)?.at ?? c);
    return { poly: r.poly, ring: r.ring, coords,
      ids: r.ids.map((n, k) => {
        if (!r.ks.includes(k)) return n;
        const to = land.get(`${ri},${k}`);
        if (to) return to.id;
        if (!outside.has(n)) return n;
        const id = nextNewId--;
        fresh.set(id, r.coords[k]);
        return id;
      }) };
  });
  // Свои узлы, сдвинутые без слияния, — на новые места (в кольце уже стоят новые координаты)
  for (const r of rewrites) r.ids.forEach((n, k) => { if (n > 0 && !fresh.has(n)) fresh.set(n, r.coords[k]); });
  // Выделенные вместе с f части с теми же узлами: в их кольцах — те же замены и новые места
  const swap = new Map<number, { id: number; at: LonLat }>();
  rings.forEach((r, ri) => r.ks.forEach((k) => swap.set(r.ids[k], { id: rewrites[ri].ids[k], at: rewrites[ri].coords[k] })));
  const items: { f: Feature3D; rewrites: RingRewrite[] }[] = [{ f, rewrites }];
  for (const g of liveFeatures()) {
    if (g.key === f.key || !together.has(g.key)) continue;
    const rw: RingRewrite[] = [];
    g.polygons.forEach((p, poly) => [[p.outer, p.outerIds] as const, ...p.inners.map((c, j) => [c, p.innerIds?.[j]] as const)].forEach(([coords, ids], ring) => {
      if (!ids?.some((n) => swap.has(n))) return;
      rw.push({ poly, ring, ids: ids.map((n) => swap.get(n)?.id ?? n), coords: coords.map((c, k) => swap.get(ids[k])?.at ?? c) });
    }));
    if (rw.length) items.push({ f: g, rewrites: rw });
  }
  return topologyEdits(items, [], fresh);
}

/** Точность совпадения ручек крыши и верха стен у разных частей, м. */
const SAME_HANDLE_M = 0.01;
/** Ручка, взятая в начале сдвига → части с ней же (неизменно, пока тянем: превью двигает и их ручки). */
const shapeHeightCache = new WeakMap<ShapeTarget, string[]>();

/**
 * Части, которые меняет ручка крыши или верха стен t: сама часть и выделенные вместе с ней, у которых в том же месте
 * та же ручка (общий узел на той же высоте верха стен, общая верхняя точка крыши).
 */
function shapeHeightKeys(t: ShapeTarget): string[] {
  const cached = shapeHeightCache.get(t);
  if (cached) return cached;
  const near = (p: THREE.Vector3) => p.distanceTo(t.from) < SAME_HANDLE_M;
  const keys = [t.key, ...shapeSelected().filter((k) => {
    if (k === t.key) return false;
    if (t.roof) return overpassLayer.focusRoofTop(k).some(near);
    const w = shapeWalls(k), polys = overpassLayer.focusPolygons(k);
    return !!w && !!polys && w.top - w.min >= 0.2 && polys.some((p) => [p.outer, ...p.inners].some((r) => r.some(([x, y]) => near(new THREE.Vector3(x, y, w.top)))));
  })];
  shapeHeightCache.set(t, keys);
  return keys;
}

/** Сторона u–v есть у других объектов (общая с соседями). */
function sideShared(r: ShapeRing, ins: Insert): boolean {
  return liveFeatures().some((g) => g.key !== r.f.key && g.polygons.some((p) =>
    [[p.outerIds, p.outer] as const, ...p.inners.map((c, k) => [p.innerIds?.[k], c] as const)]
      .some(([ids, ring]) => !!ids && !!insertInRing(ids, ring, [ins], () => ring[0]))));
}

/**
 * Новая вершина ровно на стороне: «с соседями» (или сторона только наша) — узел встаёт и в пути соседей с этой
 * стороной; «отдельно» на общей стороне — только себе.
 */
function shapeInsertEdits(r: ShapeRing, t: ShapeTarget): ObjectEdit[] | string {
  const [ax, ay] = overpassLayer.focusToLocal(r.ring[t.i])!, [bx, by] = overpassLayer.focusToLocal(r.ring[(t.i + 1) % r.ring.length])!;
  const at = overpassLayer.focusToLngLat(ax + t.insert! * (bx - ax), ay + t.insert! * (by - ay))!;
  const id = nextNewId--;
  const ins: Insert = { id, u: r.ids[t.i], v: r.ids[(t.i + 1) % r.ids.length], t: t.insert };
  const { ids, coords } = insertInRing(r.ids, r.ring, [ins], () => at)!;
  const inserts = shapeTool.glue || !sideShared(r, ins) ? [ins] : [];
  return topologyEdits([{ f: r.f, rewrites: [{ poly: t.poly, ring: t.ring, ids, coords }] }], inserts, new Map([[id, at]]));
}

/**
 * Убрать узлы ids отовсюду: из колец всех объектов и из путей-членов (соседи с этими узлами — тоже). Строка — почему
 * нельзя (в кольце осталось бы меньше трёх вершин). Узлы без ссылок и тегов при отправке удаляются.
 */
function nodeRemoveEdits(ids: Set<number>): ObjectEdit[] | string {
  const out: ObjectEdit[] = [];
  const live = liveFeatures();
  for (const g of live) {
    if (!g.polygons.some((p) => [p.outerIds, ...(p.innerIds ?? [])].some((r) => r?.some((n) => ids.has(n))))) continue;
    if (!entity(g.key)) return tr('{key}: нет в данных.', { key: g.key });
    let small = false;
    const cut = (cs: LonLat[], rids: number[] | undefined): [LonLat[], number[] | undefined] => {
      if (!rids?.some((n) => ids.has(n))) return [cs, rids];
      const keep = rids.map((n, k) => (ids.has(n) ? -1 : k)).filter((k) => k >= 0);
      if (keep.length < 3) small = true;
      return [keep.map((k) => cs[k]), keep.map((k) => rids[k])];
    };
    const polygons = g.polygons.map((p) => {
      const [outer, outerIds] = cut(p.outer, p.outerIds);
      const inn = p.inners.map((c, k) => cut(c, p.innerIds?.[k]));
      return { ...p, outer, outerIds, inners: inn.map((x) => x[0]), innerIds: p.innerIds ? inn.map((x) => x[1]!) : undefined };
    });
    if (small) return tr('{key}: в кольце останется меньше трёх вершин.', { key: g.key });
    out.push({ key: g.key, polygons });
  }
  // Пути-члены мультиполигонов: узлы убираются из списка узлов (путь не режется)
  const coords = new Map<number, LonLat>();
  const ways = new Map<number, { nodes: number[]; tags: Record<string, string> }>();
  for (const g of live) {
    for (const p of g.polygons) {
      p.outerIds?.forEach((n, i) => coords.set(n, p.outer[i]));
      p.inners.forEach((r, j) => p.innerIds?.[j]?.forEach((n, i) => coords.set(n, r[i])));
    }
    for (const w of g.ways ?? []) if (!ways.has(w.id)) ways.set(w.id, { nodes: w.nodes, tags: w.tags ?? {} });
  }
  for (const t of session.lineEntities()) ways.set(Number(t.key.split('/')[1]), { nodes: t.line!.ids, tags: t.tags });
  for (const [wid, w] of ways) {
    if (!w.nodes.some((n) => ids.has(n))) continue;
    const closed = w.nodes.length > 1 && w.nodes[0] === w.nodes[w.nodes.length - 1];
    let nodes = w.nodes.filter((n) => !ids.has(n));
    if (closed && nodes.length && nodes[0] !== nodes[nodes.length - 1]) nodes = [...nodes, nodes[0]];
    if (nodes.length < 2) return tr('{key}: в пути останется меньше двух узлов.', { key: `way/${wid}` });
    const key = `way/${wid}`;
    const known = session.get(key);
    if (known && !known.line) continue; // сам по себе здание или часть — уже в правке колец выше
    if (nodes.some((n) => !coords.has(n))) return tr('{key}: нет данных пути way/{ref} — перезагрузите видимые тайлы.', { key, ref: wid });
    if (!known) session.track({ key, version: 0, tags: { ...w.tags }, line: { ids: w.nodes, coords: w.nodes.map((n) => coords.get(n)!) } });
    out.push({ key, line: { ids: nodes, coords: nodes.map((n) => coords.get(n)!) } });
  }
  return out;
}

/** Вход на фасаде (entrance=*), выбранный кликом в режиме здания: id узла. */
let selectedEntrance: number | undefined;
/** Куда встанет переносимый вход: сторона edge кольца ring полигона poly объекта key, точка at. */
interface EntranceTarget { key: string; poly: number; ring: number; edge: number; at: LonLat; place: Omit<EntrancePlace, 'id'> }
/** Перенос входа вдоль стен: pick — после M ждём клика по точке входа (как «Переместить» у других объектов), move — едет за курсором. */
let entranceDrag: { id: number; phase: 'pick' | 'move'; target?: EntranceTarget } | undefined;

function entranceTags(id: number): Record<string, string> | undefined {
  for (const g of liveFeatures()) { const e = g.entrances?.find((x) => x.id === id); if (e) return e.tags; }
}

function selectEntrance(id: number) {
  select(undefined);
  selectedEntrance = id;
  overpassLayer.setEntranceSelection(id);
  renderSelected();
  renderOutliner();
}

function renderEntrance(id: number) {
  const t = entranceTags(id) ?? {};
  const name = t.ref ? ` ${esc(t.ref)}` : t.name ? ' ' + tr('«{name}»', { name: esc(t.name) }) : '';
  infoEl.innerHTML = `<h2>${tr('Вход')}${name} — <a href="${server().web}/node/${id}" target="_blank" rel="noopener">node/${id}</a></h2>`
    + `<p class="hint">${tr('Перенести вдоль стен здания: клик по точке входа у основания стены (или M, затем клик по ней) — вход едет за курсором, клик — поставить, Esc — отмена.')}</p>`
    + `<details class="all-tags" open><summary>${tr('Все теги')}</summary><table>${Object.entries(t).sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table></details>`;
}

/** phase pick — M: сначала клик по точке входа; move — клик по точке уже был, вход сразу едет за курсором. */
function startEntranceDrag(phase: 'pick' | 'move' = 'move'): boolean {
  if (selectedEntrance === undefined || !focus || !overpassLayer.focusEntrance(selectedEntrance)) return false;
  moveTool.stop(); shapeTool.stop(); pushTool.stop(); splitTool.stop(); measureTool.stop(); rotateTool.stop(); scaleTool.stop(); paintTool.stop(); offsetTool.stop();
  drawTool.stop();
  entranceDrag = { id: selectedEntrance, phase };
  syncEntranceTool();
  setStatus(phase === 'pick' ? tr('Переместить вход: кликните по его точке у основания стены, затем — по месту на стене. Esc — отмена.')
    : tr('Ведите курсор по стене здания — вход едет за ним. Клик — поставить, Esc — отмена.'));
  return true;
}

function cancelEntranceDrag() {
  if (!entranceDrag) return;
  entranceDrag = undefined;
  overpassLayer.previewEntrance(undefined);
  syncEntranceTool();
}

/** Перенос входа — тот же «Переместить»: кнопка нажата, курсор со значком перемещения. */
function syncEntranceTool() {
  moveBtn.classList.toggle('active', moveTool.active || !!entranceDrag);
  syncCursor();
}

function moveEntrance(point: [number, number]) {
  const d = entranceDrag;
  if (!d || d.phase !== 'move') return;
  d.target = entranceTargetAt(point);
  overpassLayer.previewEntrance(d.target ? { id: d.id, place: d.target.place } : undefined);
}

/** Сторона контура под курсором (стена, а мимо стен — ближайшая к точке на земле не дальше 3 м) и точка на ней. */
function entranceTargetAt(point: [number, number]): EntranceTarget | undefined {
  if (!focus) return;
  const members = focus.members.filter((k) => !focusHidden.has(k));
  const wall = overpassLayer.focusRayHits(point, (k) => members.includes(k)).find((h) => h.face === 'wall');
  let at: [number, number];
  if (wall) at = [wall.local.x, wall.local.y];
  else {
    const hit = overpassLayer.focusRay(point)?.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), new THREE.Vector3());
    if (!hit) return;
    at = [hit.x, hit.y];
  }
  let best: { key: string; poly: number; ring: number; edge: number; s: number; d: number; rings: [number, number][][]; f: Feature3D } | undefined;
  for (const key of wall ? [wall.key] : members) {
    const f = entity(key) as Feature3D | undefined;
    const polys = overpassLayer.focusPolygons(key);
    if (!f?.polygons || !polys) continue;
    polys.forEach((p, poly) => [p.outer, ...p.inners].forEach((r, ring) => r.forEach((a, edge) => {
      const b = r[(edge + 1) % r.length], dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
      if (!l2) return;
      const s = Math.max(0, Math.min(1, ((at[0] - a[0]) * dx + (at[1] - a[1]) * dy) / l2));
      const d = Math.hypot(a[0] + dx * s - at[0], a[1] + dy * s - at[1]);
      if (!best || d < best.d) best = { key, poly, ring, edge, s, d, rings: [p.outer, ...p.inners] as [number, number][][], f };
    })));
  }
  if (!best || (!wall && best.d > 3)) return;
  const { rings, ring, edge, f } = best;
  const a = rings[ring][edge], b = rings[ring][(edge + 1) % rings[ring].length];
  // Вход целиком на стене: середина не ближе полуширины к углам
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]), m = len > 1 ? 0.5 / len : 0.5;
  const s = Math.max(m, Math.min(1 - m, best.s));
  const p: [number, number] = [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s];
  const withP = rings.map((r, k) => (k === ring ? [...r.slice(0, edge + 1), p, ...r.slice(edge + 1)] : r));
  const place = entrancePlace(withP, ring, edge + 1, computeHeights(f.tags).min);
  const lonLat = overpassLayer.focusToLngLat(p[0], p[1]);
  return place && lonLat ? { key: best.key, poly: best.poly, ring, edge, at: lonLat, place } : undefined;
}

function commitEntrance(point: [number, number]) {
  const d = entranceDrag;
  if (!d) return;
  if (d.phase === 'pick') {
    // Мимо точки — перенос отменяется, вход остаётся выбранным (как у «Переместить»)
    if (!overpassLayer.pickEntrancePoint(point)) { cancelEntranceDrag(); setStatus(tr('Перенос входа отменён.')); return; }
    d.phase = 'move';
    setStatus(tr('Ведите курсор по стене здания — вход едет за ним. Клик — поставить, Esc — отмена.'));
    return;
  }
  if (!d.target) return setStatus(tr('Наведите курсор на стену здания.'), true);
  const edits = entranceMoveEdits(d.id, d.target);
  if (typeof edits === 'string') return setStatus(edits, true);
  cancelEntranceDrag();
  session.editMany(edits);
  setStatus(tr('Вход node/{id} перенесён. Отменить — Ctrl+Z.', { id: d.id }));
}

/**
 * Перенос узла входа N на сторону контура: из старого места узел уходит (на прямой стене — просто убирается,
 * на углу или стыке путей-членов вместо него — новый узел, форма не меняется) и встаёт на сторону во всех
 * объектах и путях-членах с этой стороной. Теги узла не трогаем — он тот же.
 */
function entranceMoveEdits(n: number, t: EntranceTarget): ObjectEdit[] | string {
  const f = entity(t.key) as Feature3D | undefined;
  const p = f?.polygons?.[t.poly];
  const rids = p && (t.ring ? p.innerIds?.[t.ring - 1] : p.outerIds);
  if (!rids) return tr('В кеше нет id узлов или путей этих объектов — нажмите «Перезагрузить видимые тайлы» в настройках графики.');
  const live = liveFeatures();
  const coords = new Map<number, LonLat>();
  const ways = new Map<number, { nodes: number[]; tags: Record<string, string> }>();
  for (const g of live) {
    for (const q of g.polygons) {
      q.outerIds?.forEach((id, i) => coords.set(id, q.outer[i]));
      q.inners.forEach((r, j) => q.innerIds?.[j]?.forEach((id, i) => coords.set(id, r[i])));
    }
    for (const w of g.ways ?? []) if (!ways.has(w.id)) ways.set(w.id, { nodes: w.nodes, tags: w.tags ?? {} });
  }
  for (const l of session.lineEntities()) ways.set(Number(l.key.split('/')[1]), { nodes: l.line!.ids, tags: l.tags });
  // Угол (узел не на прямой между соседями) или конец пути-члена — на старом месте остаётся новый узел k
  const local = (id: number) => overpassLayer.focusToLocal(coords.get(id)!)!;
  const corner = live.some((g) => g.polygons.some((q) => [q.outerIds, ...(q.innerIds ?? [])].some((r) => {
    const i = r?.indexOf(n) ?? -1;
    if (!r || i < 0) return false;
    const [a, b, c] = [r[(i - 1 + r.length) % r.length], n, r[(i + 1) % r.length]].map(local);
    const l = Math.hypot(c[0] - a[0], c[1] - a[1]);
    const off = l ? Math.abs((c[0] - a[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (c[1] - a[1])) / l : Infinity;
    const along = (b[0] - a[0]) * (c[0] - a[0]) + (b[1] - a[1]) * (c[1] - a[1]);
    // Вход ставят чуть мимо прямой (сантиметры) — это ещё прямая стена, не угол
    return off > 0.2 || along < 0 || along > l * l;
  })));
  const k = corner || wayEndsAt(new Set([n])) ? nextNewId-- : undefined;
  if (k !== undefined) coords.set(k, coords.get(n)!);
  let u = rids[t.edge], v = rids[(t.edge + 1) % rids.length];
  // Сторона у самого входа: после его ухода она — от соседа до соседа (или до нового узла на его месте)
  if (u === n || v === n) {
    const i = rids.indexOf(n), prev = rids[(i - 1 + rids.length) % rids.length], next = rids[(i + 1) % rids.length];
    if (k !== undefined) { if (u === n) u = k; else v = k; } else if (u === n) u = prev; else v = next;
  }
  if (u === v) return tr('Сюда вход не поставить — выберите другую стену.');
  const ins: Insert[] = [{ id: n, u, v }];
  const at = (id: number) => (id === n ? t.at : coords.get(id)!);
  const leave = (ids: number[]) => (k !== undefined ? ids.map((x) => (x === n ? k : x)) : ids.filter((x) => x !== n));
  const out: ObjectEdit[] = [];
  for (const g of live) {
    let changed = false, small = false;
    const ring = (cs: LonLat[], ids: number[] | undefined): [LonLat[], number[] | undefined] => {
      if (!ids) return [cs, ids];
      let r = ids.includes(n) ? leave(ids) : ids;
      let c = r === ids ? cs : r.map((id) => coords.get(id)!);
      const moved = insertInRing(r, c, ins, at);
      if (moved) { r = moved.ids; c = moved.coords; }
      if (r === ids) return [cs, ids];
      changed = true;
      if (r.length < 3) small = true;
      return [c, r];
    };
    const polygons = g.polygons.map((q) => {
      const [outer, outerIds] = ring(q.outer, q.outerIds);
      const inn = q.inners.map((c, j) => ring(c, q.innerIds?.[j]));
      return { ...q, outer, outerIds, inners: inn.map((x) => x[0]), innerIds: q.innerIds ? inn.map((x) => x[1]!) : undefined };
    });
    if (!changed) continue;
    if (small) return tr('{key}: в кольце останется меньше трёх вершин.', { key: g.key });
    if (!entity(g.key)) return tr('{key}: нет в данных.', { key: g.key });
    out.push({ key: g.key, polygons });
  }
  for (const [wid, w] of ways) {
    let nodes = w.nodes;
    if (nodes.includes(n)) {
      const closed = nodes.length > 1 && nodes[0] === nodes[nodes.length - 1];
      nodes = leave(nodes);
      if (closed && nodes[0] !== nodes[nodes.length - 1]) nodes = [...nodes, nodes[0]];
    }
    nodes = insertInLine(nodes, ins) ?? nodes;
    if (nodes === w.nodes) continue;
    if (nodes.length < 2) return tr('{key}: в пути останется меньше двух узлов.', { key: `way/${wid}` });
    const key = `way/${wid}`, known = session.get(key);
    if (known && !known.line) continue; // сам по себе здание или часть — уже в правке колец выше
    if (nodes.some((id) => !coords.has(id) && id !== n)) return tr('{key}: нет данных пути way/{ref} — перезагрузите видимые тайлы.', { key, ref: wid });
    if (!known) session.track({ key, version: 0, tags: { ...w.tags }, line: { ids: w.nodes, coords: w.nodes.map((id) => coords.get(id)!) } });
    out.push({ key, line: { ids: nodes, coords: nodes.map(at) } });
  }
  return out;
}

/** Какой-то из узлов ids — конец незамкнутого пути-члена мультиполигона (из данных или сессии). */
function wayEndsAt(ids: Set<number>): boolean {
  const ways = new Map<number, number[]>();
  for (const g of liveFeatures()) for (const w of g.ways ?? []) ways.set(w.id, w.nodes);
  for (const t of session.lineEntities()) ways.set(Number(t.key.split('/')[1]), t.line!.ids);
  for (const nodes of ways.values()) {
    const a = nodes[0], b = nodes[nodes.length - 1];
    if (a !== b && (ids.has(a) || ids.has(b))) return true;
  }
  return false;
}

/** Кольца всех объектов, где есть узлы ids, без этих узлов — для topologyEdits; строка — почему нельзя. */
function removalRewrites(ids: Set<number>): { f: Feature3D; rewrites: RingRewrite[] }[] | string {
  const out: { f: Feature3D; rewrites: RingRewrite[] }[] = [];
  for (const g of liveFeatures()) {
    const rewrites: RingRewrite[] = [];
    g.polygons.forEach((p, poly) => [p.outerIds, ...(p.innerIds ?? [])].forEach((rids, ring) => {
      if (!rids?.some((n) => ids.has(n))) return;
      const coords = ring ? p.inners[ring - 1] : p.outer;
      const keep = rids.map((n, k) => (ids.has(n) ? -1 : k)).filter((k) => k >= 0);
      rewrites.push({ poly, ring, ids: keep.map((k) => rids[k]), coords: keep.map((k) => coords[k]) });
    }));
    if (!rewrites.length) continue;
    if (rewrites.some((r) => r.ids.length < 3)) return tr('{key}: в кольце останется меньше трёх вершин.', { key: g.key });
    out.push({ f: g, rewrites });
  }
  return out;
}

/** Удалить вершины t: «с соседями» (или узлы только наши) — отовсюду, «отдельно» — только из своих колец. */
function removeShapeVertex(t: ShapeTarget, merged: boolean) {
  const f = entity(t.key) as Feature3D | undefined;
  const rings = f?.polygons && shapeRings(f, t);
  if (!f || !rings || (f.type === 'relation' && !relWays(f))) {
    return setStatus(tr('В кеше нет id узлов или путей этого объекта — нажмите «Перезагрузить видимые тайлы» в настройках графики.'), true);
  }
  const after = rings.map((r) => ({ poly: r.poly, ring: r.ring, ids: r.ids.filter((_, k) => !r.ks.includes(k)), coords: r.coords.filter((_, k) => !r.ks.includes(k)) }));
  // Внутреннее кольцо вырождается в линию (слили вершины треугольника) — убираем кольцо целиком
  const collapsed = after.filter((r) => r.ring > 0 && r.ids.length < 3);
  if (collapsed.length && collapsed.length === after.length && f.type === 'relation') {
    const gone = (pi: number, k: number) => collapsed.some((r) => r.poly === pi && r.ring === k + 1);
    // Кольцо в точку: dropCollapsedHoles уберёт его из полигона, путь — из членов отношения
    const edits: ObjectEdit[] = [{ key: f.key, polygons: f.polygons.map((p, pi) => ({ ...p, inners: p.inners.map((r, k) => (gone(pi, k) ? r.map(() => r[0]) : r)) })) }];
    dropCollapsedHoles(edits);
    session.editMany(edits);
    return setStatus(tr('{key}: внутреннее кольцо удалено. Отменить — Ctrl+Z.', { key: t.key }));
  }
  if (after.some((r) => r.ids.length < 3)) return setStatus(tr('{key}: в кольце останется меньше трёх вершин.', { key: t.key }), true);
  if (after.some((r, i) => selfIntersects(r.coords.map((c) => overpassLayer.focusToLocal(c)!))
    && !selfIntersects(rings[i].coords.map((c) => overpassLayer.focusToLocal(c)!)))) return setStatus(tr('Без этой вершины контур пересекает сам себя.'), true);
  const ids = new Set(rings.flatMap((r) => r.ks.map((k) => r.ids[k])));
  const outside = nodesOutside(new Set([f.key]));
  const glued = shapeTool.glue || ![...ids].some((n) => outside.has(n));
  // Узел на стыке путей-членов (у церкви из коротких путей — почти каждый) из путей не вычеркнуть: двухузловой
  // путь выродится, у длинных кольцо разорвётся. Тогда перестраиваем кольца всех объектов с этим узлом:
  // новая сторона — новым путём, старые пути остаются тем, кто их ещё держит (площадь и т. п.)
  const removal = glued && wayEndsAt(ids) ? removalRewrites(ids) : undefined;
  if (typeof removal === 'string') return setStatus(removal, true);
  const edits = removal ? topologyEdits(removal, [], new Map())
    : glued ? nodeRemoveEdits(ids) : topologyEdits([{ f, rewrites: after }], [], new Map());
  if (typeof edits === 'string') return setStatus(edits, true);
  dropCollapsedHoles(edits);
  session.editMany(edits);
  const neighbours = edits.filter((e) => e.polygons && e.key !== t.key).length;
  setStatus((merged ? tr('Вершина {key} слита с соседней', { key: t.key })
    : ids.size > 1 ? tr('Удалено вершин {key}: {n}', { key: t.key, n: ids.size }) : tr('Вершина {key} удалена', { key: t.key }))
    + (neighbours ? tr(', у соседей с общим узлом — тоже: {n}', { n: neighbours }) : '') + tr('. Отменить — Ctrl+Z.'));
}

/** Объекты, перестроенные превью «Формы» (сама часть и соседи), — вернуть их при сбросе превью. */
let shapePreviewed: string[] = [];

/** Теги для ручки крыши (высота крыши) или верха стен (высота стен — как «Вытянуть» за верх, крыша не меняется). */
function shapeHeightTags(f: Feature3D, t: ShapeTarget, dz: number): Record<string, string> {
  return t.roof ? roofHeightTags(f.tags, dz) : pushHeightTags(f.tags, 'top', dz, 'm', false, drawnHeights(f));
}

function previewShape(t: ShapeTarget, offset: THREE.Vector3 | undefined): string | undefined {
  const live = new Map(liveFeatures().map((g) => [g.key, g] as const));
  const restore = (keep: Set<string>) => {
    for (const k of shapePreviewed) { const g = live.get(k); if (!keep.has(k) && g) previewFocus(g); }
    shapePreviewed = shapePreviewed.filter((k) => keep.has(k));
  };
  shapeTool.linked = 0;
  overpassLayer.setLinked([]);
  const f = live.get(t.key);
  if (!f || !offset) { restore(new Set()); return; }
  if (t.roof || t.eave) {
    const keys = shapeHeightKeys(t);
    for (const k of keys) { const g = live.get(k); if (g) previewFocus({ ...g, tags: shapeHeightTags(g, t, offset.z) }); }
    restore(new Set(keys));
    shapePreviewed = keys;
    return;
  }
  const rings = shapeRings(f, t);
  if (!rings) { restore(new Set()); return; }
  const glue = shapeGlued(rings);
  const together = new Set(shapeSelected());
  const edits = nodeMoveEdits(glue ? shapeMoves(rings, offset) : shapeOwnMoves(rings, offset), true);
  const apart = glue ? levelApartKeys([...together, t.key]) : new Set<string>();
  if (typeof edits === 'string') { restore(new Set()); return edits; }
  const keys = new Set<string>();
  for (const x of edits) {
    const g = live.get(x.key);
    // «Отдельно» соседи остаются на месте — в превью сама часть и выделенные вместе с ней; соседи выше/ниже — всегда на месте
    if (!x.polygons || !g || (!glue && x.key !== t.key && !together.has(x.key)) || apart.has(x.key)) continue;
    keys.add(x.key);
    previewFocus({ ...g, polygons: x.polygons });
  }
  restore(keys);
  shapePreviewed = [...keys];
  const neighbours = shapePreviewed.filter((k) => k !== t.key);
  overpassLayer.setLinked(neighbours);
  shapeTool.linked = neighbours.length;
  return shapeProblem(shapeMoved(rings, offset), rings);
}

/**
 * Сдвиг вершин «с соседями»: так выбрано или среди вершин есть вход (entrance=*) — узел входа едет целиком
 * (вместе с ним стены всех объектов), иначе «отдельно» вершина стала бы новым узлом, а вход остался на старом месте.
 */
function shapeGlued(rings: ShapeRings): boolean {
  if (shapeTool.glue) return true;
  const entrances = new Set(liveFeatures().flatMap((g) => g.entrances?.map((e) => e.id) ?? []));
  return rings.some((r) => r.ks.some((k) => entrances.has(r.ids[k])));
}

function commitShape(t: ShapeTarget, offset: THREE.Vector3): boolean {
  const fail = (msg: string) => { setStatus(msg, true); return false; };
  const f = entity(t.key) as Feature3D | undefined;
  if (!f?.polygons) return false;
  if (t.roof || t.eave) {
    const tags = shapeHeightTags(f, t, offset.z), h = computeHeights(tags);
    // Выделенные части с той же ручкой (общий верх стен, общая точка крыши) — вместе, одним шагом
    const edits = shapeHeightKeys(t).flatMap((k) => {
      const g = entity(k) as Feature3D | undefined;
      return g ? [{ key: k, tags: shapeHeightTags(g, t, offset.z) }] : [];
    });
    session.editMany(edits);
    const key = edits.length > 1 ? edits.map((e) => e.key).join(', ') : t.key;
    setStatus(t.roof ? tr('Высота крыши {key}: {h} м. Отменить — Ctrl+Z.', { key, h: h.roofHeight.toFixed(2) })
      : tr('Высота стен {key}: {h} м. Отменить — Ctrl+Z.', { key, h: (h.wallTop - h.min).toFixed(2) }));
    return true;
  }
  const noIds = tr('В кеше нет id узлов или путей этого объекта — нажмите «Перезагрузить видимые тайлы» в настройках графики.');
  if (f.type === 'relation' && !relWays(f)) return fail(noIds);
  let edits: ObjectEdit[] | string;
  if (t.insert !== undefined) {
    const r = shapeRing(t);
    if (!r) return fail(noIds);
    edits = shapeInsertEdits(r, t);
  } else {
    const rings = shapeRings(f, t);
    if (!rings) return fail(noIds);
    const problem = shapeProblem(shapeMoved(rings, offset), rings);
    if (problem) return fail(problem);
    // «С соседями», но двигаем только свои узлы и отпускаем на чужой — сливаем так же, как «отдельно»
    const glued = shapeGlued(rings) && !(shapeLandings(shapeMoved(rings, offset)).size
      && !rings.some((r) => r.ks.some((k) => nodesOutside(new Set([f.key])).has(r.ids[k]))));
    const moves = glued ? shapeMoves(rings, offset) : undefined;
    const together = new Set([...shapeSelected(), f.key]);
    edits = moves ? levelSafeEdits([...together], nodeMoveEdits(moves), moves) : shapeSeparateEdits(f, rings, offset, together);
  }
  if (typeof edits === 'string') return fail(edits);
  dropCollapsedHoles(edits);
  session.editMany(edits);
  // Выделенные вместе с частью — не «соседи»: они и должны были ехать
  const selected = new Set(shapeSelected());
  const neighbours = edits.filter((e) => e.polygons && e.key !== t.key && !selected.has(e.key)).length;
  const n = 1 + (t.also?.length ?? 0), d = offset.length().toFixed(2);
  setStatus((t.insert !== undefined ? tr('Новая вершина на стороне {key}', { key: t.key })
    : n > 1 ? tr('Вершины {key} ({n}) сдвинуты на {d} м', { key: t.key, n, d }) : tr('Вершина {key} сдвинута на {d} м', { key: t.key, d }))
    + (neighbours ? tr(', соседи с общими узлами подтянуты следом: {n}', { n: neighbours }) : '') + tr('. Отменить — Ctrl+Z.'));
  return true;
}

/** Площадь кольца, м², меньше которой дыра считается схлопнутой (стену двора дотянули до противоположной). */
const COLLAPSED_HOLE_M2 = 0.05;

/**
 * Дыры, схлопнутые правкой (площадь почти ноль — осталась бы линия), — убрать из полигонов; у мультиполигона
 * уходят и пути этих колец (без тегов — удаляются). Правит edits на месте.
 */
function dropCollapsedHoles(edits: ObjectEdit[]) {
  for (const e of [...edits]) {
    if (!e.polygons || e.delete) continue;
    const dead: number[][] = [];
    e.polygons = e.polygons.map((p) => {
      const keep = p.inners.map((r) => ringArea(r.map((c) => overpassLayer.focusToLocal(c)!)) >= COLLAPSED_HOLE_M2);
      if (keep.every(Boolean)) return p;
      p.innerIds?.forEach((ids, k) => { if (!keep[k]) dead.push(ids); });
      return { ...p, inners: p.inners.filter((_, k) => keep[k]), innerIds: p.innerIds?.filter((_, k) => keep[k]) };
    });
    if (!dead.length || !e.key.startsWith('relation/')) continue;
    const f = entity(e.key) as Feature3D | undefined;
    const members = e.members ?? (f as Tagged | undefined)?.relMembers ?? session.get(e.key)?.relMembers;
    if (!members) continue;
    // Узлы путей — с учётом правок этого же шага
    const lineNodes = new Map((f?.ways ?? []).map((w) => [w.id, w.nodes] as const));
    for (const l of session.lineEntities()) lineNodes.set(Number(l.key.split('/')[1]), l.line!.ids);
    for (const x of edits) if (x.line && x.key.startsWith('way/')) lineNodes.set(Number(x.key.split('/')[1]), x.line.ids);
    const deadNodes = new Set(dead.flat());
    const gone = new Set(members.filter((m) => m.type === 'way' && m.role === 'inner'
      && lineNodes.get(m.ref)?.every((id) => deadNodes.has(id))).map((m) => m.ref));
    if (!gone.size) continue;
    e.members = members.filter((m) => m.type !== 'way' || !gone.has(m.ref));
    for (const id of gone) {
      const key = `way/${id}`;
      const at = edits.findIndex((x) => x.key === key);
      if (at >= 0) edits.splice(at, 1);
      const tags = session.get(key)?.tags ?? f?.ways?.find((w) => w.id === id)?.tags ?? {};
      if (Object.keys(tags).length) continue;
      if (!session.has(key)) {
        const nodes = lineNodes.get(id)!;
        const coords = new Map<number, LonLat>();
        for (const p of f?.polygons ?? []) p.innerIds?.forEach((ids, k) => ids.forEach((n, i) => coords.set(n, p.inners[k][i])));
        session.track({ key, version: 0, tags: {}, line: { ids: nodes, coords: nodes.map((n) => coords.get(n)!) } });
      }
      edits.push({ key, delete: true });
    }
  }
}

/** Значения для setTags: новые и удалённые (undefined) теги. */
function diffTags(before: Record<string, string>, after: Record<string, string>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) if (before[k] !== after[k]) out[k] = after[k];
  return out;
}

/** Попап посреди карты; пустой html — закрыть. */
function showPopup(html: string, close = tr('Понятно')) {
  popupEl.innerHTML = html ? `<div class="popup-card">${html}<p><button type="button" data-popup-close>${close}</button></p></div>` : '';
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
  moveSelectedByClick = false;
  const doors = indoorSelection.filter(isDoor);
  for (const door of doors) trackIndoor(indoorKey(door.key), door);
  const keys = doors.length ? doors.map(d => d.key) : selection.filter((k) => focus!.members.includes(k));
  const features = keys.map((k) => entity(k) as Feature3D | undefined).filter((f): f is Feature3D => !!f?.polygons);
  if (!doors.length && features.some((f) => !nodeIds(f) || (f.type === 'relation' && !relWays(f)))) {
    return setStatus(tr('В кеше нет id узлов или путей этих объектов — нажмите «Перезагрузить видимые тайлы» в настройках графики.'), true);
  }
  pushTool.stop(); shapeTool.stop();
  splitTool.stop(); measureTool.stop(); rotateTool.stop(); scaleTool.stop(); paintTool.stop(); offsetTool.stop();
  drawTool.stop();
  // Без выделения инструмент сначала ждёт клика по объекту (см. обработчик клика)
  moveTool.start(keys, doors.length > 0, doors.length ? [] : underlaySelection);
}

/** Применить сдвиг: x/y — координаты узлов, z — высоты (теги). */
function commitMove(keys: string[], offset: THREE.Vector3, glue: boolean) {
  const doors = keys.map(key => buildingIndoorFor(key)).filter((f): f is IndoorFeature => !!f && isDoor(f));
  if (doors.length) {
    session.editMany(doors.map(f => {
      trackIndoor(indoorKey(f.key), f);
      const [x, y] = overpassLayer.focusFromLngLat(f.point!)!;
      const at = overpassLayer.focusToLngLat(x + offset.x, y + offset.y)!;
      return { key: indoorKey(f.key), polygons: [{ outer: [at], inners: [], outerIds: [Number(indoorKey(f.key).split('/')[1])], innerIds: [] }] };
    }));
    return;
  }
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
    const edits = placeEdits(keys, features, shift, glue);
    if (typeof edits === 'string') return setStatus(edits, true);
    for (const f of features) {
      const t = tags(f);
      const e = edits.find((x) => x.key === f.key);
      if (t && e) e.tags = t;
    }
    session.editMany(edits);
  }
  setStatus(tr('Перемещено объектов: {n} на {d} м.', { n: features.length, d: offset.length().toFixed(2) }));
}

/**
 * Правки «сдвинуть все узлы объектов через fn» (перемещение, поворот). Узлы, общие с объектами вне keys,
 * остаются соседям — у нас на их месте новые (без нахлёстов).
 */
function transformEdits(keys: string[], features: Feature3D[], fn: (c: LonLat) => LonLat, shared = nodesOutside(new Set(keys))) {
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
      const coords = ring.map(fn);
      return { poly, ring: r, ids: ids.map((n, k) => id(n, coords[k])), coords };
    })),
  }));
  return topologyEdits(items, [], fresh);
}

const CARDINAL_DEG: Record<string, number> = {
  N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5,
  S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5,
};

/** Повернуть объекты keys на angle (радианы, против часовой) вокруг вертикали через pivot; roof:direction — вместе с ними. */
function commitRotate(keys: string[], pivot: THREE.Vector3, angle: number, glue: boolean) {
  const features = keys.map((k) => entity(k) as Feature3D | undefined).filter((f): f is Feature3D => !!f?.polygons);
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const turn = (c: LonLat): LonLat => {
    const [x, y] = overpassLayer.focusToLocal(c)!;
    const dx = x - pivot.x, dy = y - pivot.y;
    return overpassLayer.focusToLngLat(pivot.x + dx * cos - dy * sin, pivot.y + dx * sin + dy * cos)!;
  };
  const edits = placeEdits(keys, features, turn, glue);
  if (typeof edits === 'string') return setStatus(edits, true);
  const deg = (angle * 180) / Math.PI;
  for (const f of features) {
    // Азимут ската считается по часовой от севера — поворот против часовой его уменьшает
    const dir = f.tags['roof:direction'];
    if (dir === undefined) continue;
    const d = CARDINAL_DEG[dir.trim().toUpperCase()] ?? Number(dir);
    if (!Number.isFinite(d)) continue;
    const e = edits.find((x) => x.key === f.key);
    if (e) e.tags = { ...(e.tags ?? f.tags), 'roof:direction': String(Math.round((((d - deg) % 360) + 360) % 360 * 10) / 10) };
  }
  session.editMany(edits);
  setStatus(tr('Повёрнуто объектов: {n} на {deg}°. Отменить — Ctrl+Z.', { n: features.length, deg: deg.toFixed(1) }));
}

/**
 * Применить к объектам keys плановое преобразование m (масштаб, поворот, перенос; метры сцены, высоты не меняются).
 * glue — общие с соседями узлы едут вместе с частью (соседи тянутся следом, чужие узлы на наших сторонах остаются на
 * них); иначе общие узлы остаются соседям, у части — новые. roof:direction поворачивается вслед за контуром.
 */
function commitScale(keys: string[], m: THREE.Matrix4, glue: boolean) {
  const features = keys.map((k) => entity(k) as Feature3D | undefined).filter((f): f is Feature3D => !!f?.polygons);
  const e = m.elements;
  const map2 = (x: number, y: number): Pt => [e[0] * x + e[4] * y + e[12], e[1] * x + e[5] * y + e[13]];
  const fn = (c: LonLat): LonLat => {
    const [x, y] = overpassLayer.focusToLocal(c)!;
    return overpassLayer.focusToLngLat(...map2(x, y))!;
  };
  const edits = placeEdits(keys, features, fn, glue);
  if (typeof edits === 'string') return setStatus(edits, true);
  for (const f of features) {
    const dir = f.tags['roof:direction'];
    if (dir === undefined) continue;
    const d = CARDINAL_DEG[dir.trim().toUpperCase()] ?? Number(dir);
    if (!Number.isFinite(d)) continue;
    // Азимут — по часовой от севера (y); вектор ската через линейную часть m
    const r = (d * Math.PI) / 180, vx = Math.sin(r), vy = Math.cos(r);
    const nd = (Math.atan2(e[0] * vx + e[4] * vy, e[1] * vx + e[5] * vy) * 180) / Math.PI;
    if (Math.abs(((nd - d + 540) % 360) - 180) < 0.05) continue;
    const x = edits.find((t) => t.key === f.key);
    if (x) x.tags = { ...(x.tags ?? f.tags), 'roof:direction': String(Math.round(((nd % 360) + 360) % 360 * 10) / 10) };
  }
  session.editMany(edits);
  const k = Math.sqrt(Math.abs(e[0] * e[5] - e[1] * e[4]));
  setStatus(tr('Масштабировано объектов: {n}, ×{k}. Отменить — Ctrl+Z.', { n: features.length, k: String(Math.round(k * 1000) / 1000) }));
}

/** Соседи, перестроенные в превью «с соседями» перемещения, поворота и масштаба, — вернуть их при сбросе. */
let gluePreviewed: string[] = [];

/** Превью соседей, которых потянет плановое преобразование m объектов keys «с соседями» (LinkPreview). */
function previewGlued(keys: string[], m: THREE.Matrix4 | undefined, glue: boolean): number {
  const live = new Map(liveFeatures().map((g) => [g.key, g] as const));
  const keep = new Set<string>();
  if (m && glue) {
    const e = m.elements;
    const fn = (c: LonLat): LonLat => {
      const [x, y] = overpassLayer.focusToLocal(c)!;
      return overpassLayer.focusToLngLat(e[0] * x + e[4] * y + e[12], e[1] * x + e[5] * y + e[13])!;
    };
    const features = keys.map((k) => live.get(k)).filter((f): f is Feature3D => !!f?.polygons);
    const edits = nodeMoveEdits(glueMoves(features, [...live.values()], fn, (c) => overpassLayer.focusToLocal(c)!), true);
    const skip = new Set([...keys, ...levelApart(features, [...live.values()])]);
    if (typeof edits !== 'string') for (const x of edits) {
      const g = live.get(x.key);
      if (skip.has(x.key) || !x.polygons || !g) continue;
      keep.add(x.key);
      previewFocus({ ...g, polygons: x.polygons });
    }
  }
  for (const k of gluePreviewed) { const g = live.get(k); if (!keep.has(k) && g) previewFocus(g); }
  gluePreviewed = [...keep];
  overpassLayer.setLinked(gluePreviewed);
  return keep.size;
}

/**
 * Правки «сдвинуть все узлы объектов через fn» (перемещение, поворот, масштаб) в выбранном режиме:
 * glue — «с соседями» (glueMoves + правило уровней), иначе «отдельно» (transformEdits).
 */
function placeEdits(keys: string[], features: Feature3D[], fn: (c: LonLat) => LonLat, glue: boolean): ObjectEdit[] | string {
  if (!glue) return transformEdits(keys, features, fn);
  const moves = glueMoves(features, liveFeatures(), fn, (c) => overpassLayer.focusToLocal(c)!);
  return levelSafeEdits(keys, nodeMoveEdits(moves), moves);
}

/** Соседи выше или ниже объектов keys (правило уровней «с соседями»). */
function levelApartKeys(keys: string[]): Set<string> {
  const live = liveFeatures();
  const mine = new Set(keys);
  return levelApart(live.filter((g) => mine.has(g.key)), live);
}

/**
 * Правило уровней для правок «с соседями» (edits — сдвиг узлов moves у всех, кто их держит): соседи выше или ниже
 * объектов keys не меняются. Их узлы, которые едут у нас или у соседей того же уровня, заменяются там новыми
 * узлами (общими для всех, кто едет), старые остаются соседям выше/ниже.
 */
function levelSafeEdits(keys: string[], edits: ObjectEdit[] | string, moves: Map<number, LonLat>): ObjectEdit[] | string {
  if (typeof edits === 'string') return edits;
  const live = liveFeatures();
  const mine = new Set(keys);
  const apart = levelApart(live.filter((g) => mine.has(g.key)), live);
  if (!edits.some((e) => apart.has(e.key))) return edits;
  const fixed = new Set<number>();
  for (const g of live) if (apart.has(g.key)) for (const [, ids] of featureRings(g)) ids?.forEach((id) => fixed.add(id));
  // Узлы, которые едут, но держат и соседи выше/ниже: у тех, кто едет, — новые
  const edited = edits.filter((e) => e.polygons && !apart.has(e.key));
  const split = new Set<number>();
  for (const e of edited) for (const p of e.polygons!) for (const ids of [p.outerIds, ...(p.innerIds ?? [])]) {
    ids?.forEach((id) => { if (fixed.has(id) && moves.has(id)) split.add(id); });
  }
  const kept = edits.filter((e) => !apart.has(e.key));
  if (!split.size) return kept.filter((e) => !e.line?.ids.some((id) => fixed.has(id) && moves.has(id)));
  const fresh = new Map<number, LonLat>(), swap = new Map<number, number>();
  const id = (n: number) => {
    if (!split.has(n)) return n;
    const k = swap.get(n) ?? swap.set(n, nextNewId--).get(n)!;
    fresh.set(k, moves.get(n)!);
    return k;
  };
  const byKey = new Map(live.map((g) => [g.key, g] as const));
  const coords = new Map<number, LonLat>();
  const touched = edited.filter((e) => e.polygons!.some((p) => [p.outerIds, ...(p.innerIds ?? [])].some((ids) => ids?.some((n) => split.has(n)))));
  const items = touched.flatMap((e) => {
    const f = byKey.get(e.key);
    if (!f) return [];
    return [{ f, rewrites: e.polygons!.flatMap((p, poly) => [[p.outer, p.outerIds] as const, ...p.inners.map((c, k) => [c, p.innerIds?.[k]] as const)]
      .map(([ring, ids], r) => {
        ids?.forEach((n, k) => coords.set(n, ring[k]));
        return { poly, ring: r, ids: (ids ?? []).map(id), coords: ring };
      })) }];
  });
  const te = topologyEdits(items, [], new Map([...coords, ...fresh]));
  if (typeof te === 'string') return te;
  const done = new Set(te.map((e) => e.key));
  for (const e of te) { const was = kept.find((x) => x.key === e.key); if (was?.tags && !e.tags) e.tags = was.tags; }
  // Пути-члены переписанных отношений собраны заново (и новые куски тоже); пути с узлами соседей выше/ниже,
  // которые не переписаны разводкой, — не трогаем
  const rebuilt = items.some((i) => i.f.type === 'relation');
  return [...te, ...kept.filter((e) => !done.has(e.key) && !(rebuilt && e.create?.line)
    && !e.line?.ids.some((n) => fixed.has(n) && moves.has(n)))];
}

/** Поднять или опустить объект на dz метров, сохраняя теги этажности. */
function shiftHeights(tags: Record<string, string>, dz: number): Record<string, string> {
  const h = computeHeights(tags);
  const out = { ...tags };
  const fmt = (v: number) => String(Math.round(v * 100) / 100);
  const min = h.min + dz;
  if (min > 1e-4 || tags.min_height) out.min_height = fmt(min); else delete out.min_height;
  out.height = fmt(h.top + dz);
  return out;
}

document.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).closest('input, select, textarea')) return;
  if (e.key === 'Escape' && popupEl.childElementCount) { showPopup(''); e.stopImmediatePropagation(); return; }
  // Пробел — выключить инструмент (незавершённое действие отменяется), обратно к выделению
  if (e.code === 'Space' && toolActive() && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    e.stopImmediatePropagation();
    moveTool.stop(); shapeTool.stop();
    pushTool.stop();
    splitTool.stop(); measureTool.stop(); rotateTool.stop(); scaleTool.stop(); paintTool.stop(); offsetTool.stop();
    drawTool.stop();
    cancelCopyPick();
    cancelEntranceDrag();
    updateSnap(undefined);
    return;
  }
  if (e.key === 'Escape' && entranceDrag) { e.preventDefault(); e.stopImmediatePropagation(); cancelEntranceDrag(); setStatus(tr('Перенос входа отменён.')); return; }
  if (e.key === 'Escape' && pointPick) { e.preventDefault(); e.stopImmediatePropagation(); stopPoint(); return; }
  if (e.key === 'Escape' && copyPick) { e.preventDefault(); e.stopImmediatePropagation(); cancelCopyPick(); return; }
  if (trackKey(e)) { e.preventDefault(); e.stopImmediatePropagation(); return; }
  if (moveTool.key(e) || pushTool.key(e) || shapeTool.key(e) || splitTool.key(e) || drawTool.key(e) || measureTool.key(e) || rotateTool.key(e) || scaleTool.key(e) || paintTool.key(e) || offsetTool.key(e)) { e.preventDefault(); e.stopImmediatePropagation(); return; }
  // S — привязки вкл/выкл, в том числе посреди перемещения или вытягивания
  if ((focus || underlaySketch) && e.code === 'KeyS' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    closeCtxMenu();
    toggleSnaps();
    return;
  }
  // W — режим контуров вкл/выкл (и на карте, и в режиме здания)
  if (e.code === 'KeyW' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    toggleWireframe();
    return;
  }
  // G — сетка основания вкл/выкл
  if (focus && e.code === 'KeyG' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    closeCtxMenu();
    toggleGrid();
    return;
  }
  // D — направление ската (roof:direction) двумя точками: только у выделенных зданий и частей, иначе ничего
  if (e.code === 'KeyD' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const feats = selection.map((k) => entity(k) as Feature3D | undefined);
    if (!feats.length || !feats.every((f) => f && (f.kind === 'building' || f.kind === 'part'))) return;
    e.preventDefault();
    closeCtxMenu();
    if (measureTool.picking) measureTool.stop(); else startDirectionPick(selection);
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
  if ((e.key === 'Delete' || e.key === 'Backspace') && !toolActive() && canDeleteIndoorSelection()) {
    e.preventDefault();
    closeCtxMenu();
    deleteIndoorSelection();
    return;
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && !toolActive() && selection.length) {
    e.preventDefault();
    closeCtxMenu();
    deleteSelected();
    return;
  }
  // На карте R / L / C / N — новое здание (набросок)
  const sketchKeys: Record<string, DrawShape> = { KeyR: 'rect', KeyL: 'polygon', KeyC: 'circle', KeyN: 'ngon' };
  if (!focus && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && sketchKeys[e.code]) {
    e.preventDefault();
    closeCtxMenu();
    startSketch(sketchKeys[e.code]);
    return;
  }
  // На карте с выделенной подложкой M / Q / E — её «Переместить», «Повернуть», «Масштаб»
  const underlayKeys: Record<string, 'move' | 'rotate' | 'scale'> = { KeyM: 'move', KeyQ: 'rotate', KeyE: 'scale' };
  if (!focus && underlaySelection.length && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && underlayKeys[e.code]) {
    e.preventDefault();
    closeCtxMenu();
    startMapUnderlayTool(underlayKeys[e.code]);
    return;
  }
  // Шорткаты режима здания — по физической клавише (e.code), чтобы работали и в русской раскладке
  // Работают и посреди другого инструмента: запуск нового выключает текущий
  if (!focus || e.ctrlKey || e.metaKey || e.altKey) return;
  const action = e.code === 'KeyM' && !e.shiftKey ? 'move'
    : e.code === 'KeyP' && !e.shiftKey ? 'push'
    : e.code === 'KeyV' && !e.shiftKey ? 'shape'
    : e.code === 'KeyK' && !e.shiftKey ? 'split'
    : e.code === 'KeyT' && !e.shiftKey ? 'measure'
    : e.code === 'KeyB' && !e.shiftKey ? 'paint'
    : e.code === 'KeyO' && !e.shiftKey ? 'offset'
    : e.code === 'KeyQ' && !e.shiftKey ? 'rotate'
    : e.code === 'KeyE' && !e.shiftKey ? 'scale'
    : e.code === 'KeyA' && !e.shiftKey ? 'square'
    : e.code === 'KeyJ' && !e.shiftKey ? 'merge'
    : e.code === 'KeyX' && !e.shiftKey ? 'point'
    : e.code === 'KeyH' ? (e.shiftKey ? 'show-all' : 'hide')
    : e.code === 'KeyI' && !e.shiftKey ? 'isolate'
    : e.code === 'KeyR' && !e.shiftKey ? 'rect'
    : e.code === 'KeyL' && !e.shiftKey ? 'polygon'
    : e.code === 'KeyC' && !e.shiftKey ? 'circle'
    : e.code === 'KeyN' && !e.shiftKey ? 'ngon' : undefined;
  if (!action) return;
  e.preventDefault();
  closeCtxMenu();
  cancelCopyPick();
  if (action === 'move') { if (!startEntranceDrag('pick')) startMove(); } else if (action === 'push') startPush(); else if (action === 'shape') startShape(); else if (action === 'split') startSplit();
  else if (action === 'rotate') startRotate(); else if (action === 'scale') startScale(); else if (action === 'square') squareSelected(); else if (action === 'merge') mergeSelected(); else if (action === 'point') { if (pointPick) stopPoint(); else startPoint(); }
  else if (action === 'measure') startMeasure(); else if (action === 'paint') startPaint(); else if (action === 'offset') startOffset();
  else if (action === 'rect' || action === 'polygon' || action === 'circle' || action === 'ngon') startDraw(action); else focusAction(action);
}, { capture: true });
document.addEventListener('keyup', (e) => { offsetTool.key(e); splitTool.key(e); shapeTool.key(e); if (moveTool.key(e) || drawTool.key(e) || measureTool.key(e) || rotateTool.key(e) || scaleTool.key(e)) e.preventDefault(); });

/** Здания тайлов под точкой; до загрузки стиля слоёв ещё нет — тогда пусто (иначе MapLibre бросает ошибку). */
function queryTileLayers(point: maplibregl.PointLike): MapGeoJSONFeature[] {
  const layers = buildingsView.shown ? TILE_LAYERS.filter((id) => map.getLayer(id)) : [];
  return layers.length ? map.queryRenderedFeatures(point, { layers }) : [];
}

// Наведение на «Обновить контур» — предпросмотр нового контура
infoEl.addEventListener('mouseover', (e) => {
  if ((e.target as HTMLElement).closest('[data-outline-fix]')) previewGrownOutline(true);
});

/** Предпросмотр «Обновить контур» (новый контур поверх всего — виден и у скрытого контура); false — убрать. */
function previewGrownOutline(on: boolean) {
  const r = on && focus ? partsOutsideOutline(focus) : undefined;
  const u = r && unitedOutline(r.outline, r.parts);
  if (!r || !u || typeof u === 'string') return overpassLayer.setDrawPreview(undefined);
  // Прирост — новый контур минус прежний: его и выделяем (на фоне всего контура он бывает в пару м²)
  const loc = (ring: LonLat[]) => { const q = ring.map((c) => overpassLayer.focusToLocal(c)!); return [...q, q[0]]; };
  let gain: [number, number][][][] = [];
  try {
    gain = polygonClipping.difference([[...u.outer, u.outer[0]], ...u.holes.map((h) => [...h, h[0]])],
      ...r.outline.polygons.map((p) => [loc(p.outer), ...p.inners.map(loc)])) as [number, number][][][];
  } catch { /* без выделения прироста */ }
  overpassLayer.setDrawPreview(u.outer.map(([x, y]) => new THREE.Vector3(x, y, 0)), true, false,
    gain.map((poly) => poly.map((ring) => ring.slice(0, -1))));
}
infoEl.addEventListener('mouseout', (e) => {
  if ((e.target as HTMLElement).closest('[data-outline-fix]')) overpassLayer.setDrawPreview(undefined);
});

infoEl.addEventListener('click', (e) => {
  const link = (e.target as HTMLElement).closest<HTMLElement>('a[data-select]');
  if (link) { e.preventDefault(); select(link.dataset.select); return; }
  const btn = (e.target as HTMLElement).closest('button');
  if (!btn) return;
  if (btn.dataset.pickDirection !== undefined) {
    const form = btn.closest<HTMLFormElement>('.tag-form');
    if (measureTool.picking) measureTool.stop(); else if (form) startDirectionPick(form.dataset.keys ? form.dataset.keys.split(' ') : [form.dataset.key!]);
    return;
  }
  if (btn.dataset.merge !== undefined) return mergeIntoBuilding();
  if (btn.dataset.addSelectedParts !== undefined) return addSelectedPartsToGroup();
  if (btn.dataset.focusExit !== undefined) return closeFocus();
  if (btn.dataset.outlineFix !== undefined) return fixOutline();
  if (btn.dataset.implicitRelation !== undefined) return createImplicitRelation();
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
    infoEl.innerHTML = `<p>${tr('Скрыто вручную: {n}', { n: userHidden.size })}</p><p><button type="button" data-unhide-all>${tr('Показать все')}</button></p>`;
  }
});

function clearSelection() {
  clearTreeSelection();
  roadsLayer.select([]);
  roadSelection = [];
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
  highlightedTile = undefined;
  if (map.getLayer(HIGHLIGHT_LAYER)) map.setFilter(HIGHLIGHT_LAYER, ['==', ['id'], -1]);
  map.setFilter(MERGED_HIGHLIGHT_LAYER, ['==', ['get', 'key'], '']);
}

/** Сколько после окончания загрузки ещё видно «Данные загружены», мс. */
const READY_HOLD_MS = 2000;
let readyTimer: ReturnType<typeof setTimeout> | undefined;
/** Минимальный индикатор загрузки данных в строке состояния: точка цвета состояния + счётчик тайлов. */
function updateOverpassIndicator() {
  const { ready, total, loading, waiting } = overpass.status();
  // Сервер не отвечает (таймаут, обрыв): запросы до него не доходят — отдельное состояние, повторы идут сами
  const down = serverDown();
  const state = !overpass.enabled ? 'off' : down && (loading || waiting) ? 'down' : loading ? 'loading' : waiting ? 'waiting' : 'ready';
  // «Данные загружены» — ещё READY_HOLD_MS, затем индикатор прячется (строка состояния без него и без текста — тоже)
  const changed = state !== opIndicator.dataset.state;
  if (changed) {
    clearTimeout(readyTimer);
    if (state === 'ready') readyTimer = setTimeout(() => { opIndicator.hidden = true; }, READY_HOLD_MS);
  }
  opIndicator.dataset.state = state;
  opIndicator.hidden = state === 'off' || (state === 'ready' && !changed && opIndicator.hidden);
  const src = overpass.sourceLabel;
  opIndicator.querySelector('.label')!.textContent = {
    off: '',
    down: tr('Сервер {server} не отвечает — повторяю…', { server: server().short }),
    loading: tr('Загружаю данные зданий: {ready} из {total} участков карты…', { ready, total }),
    waiting: overpass.lastApiError?.includes('API 403') ? overpass.lastApiError : tr('Не удалось загрузить {failed} из {total} участков карты', { failed: total - ready, total }),
    ready: tr('Данные загружены ({ready} из {total})', { ready, total }),
  }[state];
  opIndicator.querySelector<HTMLButtonElement>('.retry')!.hidden = state !== 'waiting';
  const servers = overpass.pool.endpoints
    .map((e) => tr('{host}: {active} в работе, ок {ok}, ошибок {failed}', { host: e.host, active: e.active, ok: e.ok, failed: e.failed }) + (e.coolUntil > Date.now() ? tr(', остывает') : ''))
    .join('\n');
  opIndicator.title = {
    off: '',
    down: tr('{server} не отвечает (таймаут или обрыв соединения); запросы повторяются раз в 30 с', { server: server().web }),
    loading: tr('Пока данные не пришли, здания — черновик из векторных тайлов. Загружается тайлов ({src}): {n}', { src, n: loading }),
    waiting: overpass.lastApiError ?? tr('Ждут повтора: {n} (лимит или ошибка API {server}, подробности в консоли)', { n: waiting, server: server().short }),
    ready: tr('Все видимые тайлы загружены'),
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
    if (!draft || !loading) map.setPaintProperty(id, 'fill-extrusion-opacity', (draft ? 0.45 : 0.9) * tileOpacity());
  }
  if (draft && loading && draftTimer === undefined) {
    const t0 = performance.now();
    draftTimer = window.setInterval(() => {
      const o = 0.4 + 0.15 * Math.sin(((performance.now() - t0) / 1500) * 2 * Math.PI);
      for (const id of TILE_LAYERS) map.setPaintProperty(id, 'fill-extrusion-opacity', o * tileOpacity());
    }, 100);
  } else if (!(draft && loading) && draftTimer !== undefined) {
    clearInterval(draftTimer);
    draftTimer = undefined;
  }
}

/** Откуда и когда получены видимые тайлы — чтобы было видно, что на экране старые или неполные данные. */
function describeFreshness(): string {
  const f = overpass.freshness();
  const parts = [
    f.overpass && tr('из Overpass (старый кеш): {n}', { n: f.overpass }),
    f.api && tr('из API {server}: {n}', { server: server().short, n: f.api }),
    f.unknown && tr('источник неизвестен: {n}', { n: f.unknown }),
  ].filter(Boolean);
  if (!parts.length) return '';
  const age = f.oldest ? tr(' · самый старый загружен {age} назад', { age: formatAge(Date.now() - f.oldest) }) : '';
  return tr('Тайлы {list}', { list: parts.join(', ') }) + age;
}

function formatAge(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return tr('{n} мин', { n: min });
  const h = Math.round(min / 60);
  return h < 48 ? tr('{n} ч', { n: h }) : tr('{n} дн', { n: Math.round(h / 24) });
}

/** Сообщение пользователю: всплывает над картой (и дублируется в строке панели); html — ссылка и т. п. */
function setStatus(text: string, error = false, html = '') {
  panelStatus(text, error);
  if (html) statusEl.insertAdjacentHTML('beforeend', ` ${html}`);
  // Сообщение держится в строке состояния, фоновый статус загрузки его не затирает (подсказка инструмента — затирает)
  clearTimeout(messageTimer);
  messageUntil = Date.now() + (error ? MESSAGE_ERROR_MS : MESSAGE_MS);
  messageTimer = setTimeout(() => { messageUntil = 0; showOverpassStatus(); }, messageUntil - Date.now());
}

/** Только строка состояния в панели (фоновое: загрузка тайлов) — без всплывающего сообщения. */
function panelStatus(text: string, error = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', error);
}

/** Подсказка инструмента в строке состояния; undefined — инструмент закончил. */
function toolHint(hint: string | undefined, error = false) {
  if (hint) messageUntil = 0;
  if (hint) panelStatus(hint, error); else showOverpassStatus();
}

/** Выделить объект (или группу); false — выделять нечего. */
function select(key: string | undefined): boolean {
  if (freeArea) { freeArea = undefined; overpassLayer.setFreeArea(undefined); }
  if (selectedEntrance !== undefined) { cancelEntranceDrag(); selectedEntrance = undefined; overpassLayer.setEntranceSelection(undefined); }
  clearTreeSelection();
  roadsLayer.select([]);
  roadSelection = [];
  if (key && (selectedIndoor || selectedRoomWalls.length)) selectIndoor(undefined);
  addingTo = undefined;
  addPending = [];
  // Переход из списка правок или undo к объекту вне текущей группы — выходим из неё
  if (drill && key && key !== drill.key && !drill.members.includes(key)) leaveDrill();
  if (drill && key === drill.key) leaveDrill();
  // Вне группы её член выделяется вместе с ней
  if (!drill && key && !focus) key = buildingKey(key);
  else if (!drill && key) key = groupOf(key)?.key ?? key;
  if (key && !entity(key)) key = undefined; // нет в данных или отменили создание группы
  selection = key ? [key] : [];
  selectedKey = key;
  underlaySelection = [];
  if (key) clearTileHighlight();
  paintSelection();
  renderSelected();
  if (shapeTool.active) shapeTool.refresh();
  return !!key;
}

/** Выделить одну подложку (вместо всего прочего). */
function selectUnderlay(id: string) {
  select(undefined);
  underlaySelection = [id];
  paintSelection();
  renderSelected();
}

/** Добавить подложку к выделению или убрать (части здания остаются выделенными). */
function toggleUnderlay(id: string) {
  underlaySelection = underlaySelection.includes(id) ? underlaySelection.filter((x) => x !== id) : [...underlaySelection, id];
  paintSelection();
  renderSelected();
}

function toggleSelection(key: string) {
  if (!entity(key)) return;
  clearTileHighlight();
  selection = selection.includes(key) ? selection.filter((k) => k !== key) : [...selection, key];
  selectedKey = selection.at(-1);
  paintSelection();
  renderSelected();
  if (shapeTool.active) shapeTool.refresh();
}

/** Добавить к выделению несколько объектов (рамкой). */
function addToSelection(keys: string[]) {
  const add = keys.filter((k) => !selection.includes(k) && !hiddenInFocus(k) && entity(k));
  if (!add.length) return;
  clearTileHighlight();
  selection = [...selection, ...add];
  selectedKey = selection.at(-1);
  paintSelection();
  renderSelected();
  if (shapeTool.active) shapeTool.refresh();
}

// Выделение рамкой: Shift + перетаскивание. Объект попадает в рамку, если в неё попал центр его основания.
const boxEl = document.createElement('div');
boxEl.className = 'select-box';
boxEl.hidden = true;
map.getCanvasContainer().appendChild(boxEl);
let boxStart: maplibregl.Point | undefined;

map.getCanvasContainer().addEventListener('mousedown', (e) => {
  // В «Форме» рамка выбирает вершины основания выделенной части
  if (!e.shiftKey || e.button !== 0 || (toolActive() && !shapeTool.canBox)) return;
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
  if (shapeTool.active) {
    shapeTool.boxSelect(x0, y0, x1, y1);
    suppressClick = true;
    setTimeout(() => (suppressClick = false), 0);
    return;
  }
  if (focus && shownLevel && !addingTo && !e.altKey) {
    const inside = shownIndoor.filter((f) => {
      if (f.escalatorArea || indoorHidden.has(indoorKey(f.key))) return false;
      const at = f.point ?? (f.polygons[0]?.outer.length ? centroid(f.polygons[0].outer) : undefined);
      if (!at) return false;
      const p = overpassLayer.focusScreenPoint(at, shownLevel!.floor + 0.06);
      return p && p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1;
    });
    const selected = new Set(indoorSelection.map((f) => indoorKey(f.key)));
    const add = inside.filter((f) => {
      const key = indoorKey(f.key);
      if (selected.has(key)) return false;
      selected.add(key);
      return true;
    });
    if (add.length) {
      selectedRoomWalls = [];
      overpassLayer.setRoomWallSelection([]);
      clearTreeSelection();
      indoorSelection = [...indoorSelection, ...add];
      renderIndoorSelection();
    }
    suppressClick = true;
    setTimeout(() => (suppressClick = false), 0);
    return;
  }
  const keys = new Set<string>();
  // В режиме здания тайлы не пересобираются до выхода (нет новых частей, старая геометрия) — берём само здание
  const candidates = focus
    ? groupFeatures(focus).filter((f) => f.polygons?.length && !hiddenInFocus(f.key)).map((feature) => ({ feature }))
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
  syncJosmSelection();
  overpassLayer.select([...selection.flatMap(highlightKeys), ...addPending]);
  overpassLayer.underlays.select(underlaySelection);
  syncMapTools();
  syncIssueFilter();
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
  roof: [tr('Крыша'), 'roof'], 'roof section': [tr('Крыша'), 'roof'],
  steps: [tr('Ступени'), 'steps'], stairs: [tr('Лестница'), 'steps'], staircase: [tr('Лестница'), 'steps'], stairway: [tr('Лестница'), 'steps'], grandstand: [tr('Трибуна'), 'steps'],
  balcony: [tr('Балкон'), 'balcony'], loggia: [tr('Лоджия'), 'balcony'],
  deck: [tr('Настил'), 'deck'], terrace: [tr('Терраса'), 'deck'], patio: [tr('Патио'), 'deck'],
  column: [tr('Колонна'), 'column'], pillar: [tr('Столб'), 'column'], buttress: [tr('Контрфорс'), 'column'],
  tower: [tr('Башня'), 'tower'], bell_tower: [tr('Колокольня'), 'tower'],
  elevator: [tr('Лифт'), 'elevator'], verticalpassage: [tr('Лифт'), 'elevator'],
  porch: [tr('Крыльцо'), 'porch'], veranda: [tr('Веранда'), 'porch'], portico: [tr('Портик'), 'porch'], entrance: [tr('Вход'), 'porch'],
  canopy: [tr('Навес'), 'canopy'], carport: [tr('Навес для машин'), 'canopy'],
  mast: [tr('Мачта'), 'mast'], antenna: [tr('Антенна'), 'mast'],
  dome: [tr('Купол'), 'dome'], cupola: [tr('Купол'), 'dome'],
  chimney: [tr('Труба'), 'chimney'],
  base: [tr('Основание'), 'base'], stylobate: [tr('Стилобат'), 'base'], foundation: [tr('Фундамент'), 'base'], basement: [tr('Подвал'), 'base'],
  wall: [tr('Стена'), 'wall'],
  corridor: [tr('Переход'), 'bridge'], bridge: [tr('Переход'), 'bridge'], passageway: [tr('Переход'), 'bridge'],
  construction: [tr('Строится'), 'construction'],
};

/** Панель частей режима здания: все члены отношения, контур — первым. */
/** Свёрнутые группы частей одного вида (по подписи вида); запоминаются. */
const collapsedKinds = new Set<string>();
try { for (const k of JSON.parse(localStorage.getItem('outliner-collapsed') ?? '[]') as string[]) collapsedKinds.add(k); } catch { /* нет хранилища */ }
const ICON_CHEVRON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4l4 4-4 4"/></svg>';

/** Вид части для панели: подпись и иконка (контур — отдельно). */
/** order — место в списке: контур, крыши, прочие виды, обычные части (building:part=yes). */
function partKind(t: Record<string, string>, outline: boolean): { label: string; icon: string; title: string; order: number } {
  if (outline) return { label: tr('Контур'), icon: ICON_OUTLINE, title: tr('Контур (outline)'), order: 0 };
  const value = t['building:part'];
  const kind = PART_KINDS[value?.toLowerCase() ?? ''];
  const plain = !kind && !(value && value !== 'yes');
  const label = kind?.[0] ?? (plain ? tr('Часть') : tr('Часть: {value}', { value }));
  const order = kind?.[1] === 'roof' ? 1 : plain ? 3 : 2;
  return { label, icon: kind ? PART_ICONS[kind[1]] : ICON_PART, title: `${label} (building:part=${value ?? '—'})`, order };
}

/** Этажи здания режима: по этажности частей с явными высотами из indoor=level, плюс этажи из indoor-данных. */
function buildingLevels(g: BuildingGroup, indoor: IndoorFeature[]): Level[] {
  const info = indoorLevelInfo(indoor);
  return withIndoorLevels(focusLevels(g, info), indoor, info).map((l) => {
    const i = info.get(l.n);
    return i ? { ...l, ref: i.ref, name: i.name, levelKeys: i.keys, heightTag: i.heightTag } : l;
  });
}

const levelsPanel = document.getElementById('levels-panel')!;
const levelsEl = document.getElementById('levels')!;
const levelsCount = document.getElementById('levels-count')!;
/** Выбранный этаж (срез здания выше него); undefined — всё здание. */
let currentLevel: number | undefined;
/** Этаж, для которого последний раз перерисованы свойства (см. renderLevels). */
let infoLevel = '';
/** Здание, к которому относится currentLevel, и что последним отдано слою — чтобы не пересобирать план зря. */
let levelsFocusKey: string | undefined;
let levelSignature = '';


/**
 * Этажи здания по этажности частей и контура: у каждого объекта с building:levels — этажи от building:min_level
 * до верхнего (высота этажа — стены поровну на этажи) и подземные из building:levels:underground. Номер этажа
 * общий для здания; высоты берутся у объекта с наибольшей этажностью, где этот этаж есть.
 */
function focusLevels(g: BuildingGroup, info: Map<number, LevelInfo> = new Map()): Level[] {
  const byN = new Map<number, Level & { rank: number }>();
  for (const f of groupFeatures(g)) {
    const t = f.tags;
    const levels = Number(t['building:levels']);
    if (!Number.isFinite(levels) || levels <= 0) continue;
    const under = Math.max(0, Math.round(Number(t['building:levels:underground']) || 0));
    const h = computeHeights(t);
    // Без building:min_level у поднятой части (надстройка на крыше) нижний этаж — по min_height, а не нулевой
    const minLevel = t['building:min_level'] !== undefined ? Number(t['building:min_level']) || 0
      : h.min > 0 ? Math.round(h.min / LEVEL_HEIGHT) : 0;
    const step = levels > minLevel ? (h.wallTop - h.min) / (levels - minLevel) : LEVEL_HEIGHT;
    // Противоречивые теги (23 этажа в 3 м и т. п.) — такую часть в сетку этажей не берём
    if (step < MIN_LEVEL_STEP || step > MAX_LEVEL_STEP) continue;
    // Этаж, который описывают несколько объектов, берём у самого надёжного: часть точнее контура (контур
    // под частями — обычно общая этажность с высотой по умолчанию), явная высота точнее этажей × 3 м;
    // при равенстве — у объекта с большим числом этажей. Шаг у каждой части свой: первые этажи бывают выше
    const rank = (f.kind === 'part' ? 2000 : 0) + (h.source === 'height' ? 1000 : 0) + levels;
    const add = (n: number, floor: number, ceil: number, explicit: boolean, overflow?: boolean) => {
      const cur = byN.get(n);
      if (!cur || rank > cur.rank) byN.set(n, { n, floor, ceil, rank, src: f.key, explicit, overflow });
    };
    for (const l of partLevels({ min: h.min, wallTop: h.wallTop, levels, minLevel, under, step }, info)) add(l.n, l.floor, l.ceil, l.explicit, l.overflow);
  }
  return [...byN.values()].map(({ n, floor, ceil, src, explicit, overflow }) => ({ n, floor, ceil, src, explicit, ...(overflow ? { overflow } : {}) })).sort((a, b) => b.n - a.n);
}

/**
 * Indoor-данные здания режима, загруженные отдельно по его границам: помещения на стыке тайлов в данных тайла
 * бывают неполными (а обновление тайлов — долгим). Ключ здания → объекты; держим несколько последних.
 */
const focusIndoor = new Map<string, IndoorFeature[]>();
const focusIndoorLoading = new Set<string>();

function loadFocusIndoor(g: BuildingGroup) {
  // Indoor уже загружен из активного слоя JOSM и обновляется вместе с ним.
  if (josmMode) return;
  if (focusIndoor.has(g.key) || focusIndoorLoading.has(g.key)) return;
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const f of groupFeatures(g)) for (const p of f.polygons) for (const [x, y] of p.outer) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }
  if (!Number.isFinite(w)) return;
  const pad = 0.0001; // ~10 м: стены по самому периметру
  const api = server().api;
  focusIndoorLoading.add(g.key);
  void fetchMapSplit([w - pad, s - pad, e + pad, n + pad], api)
    .then((els) => completeRelations(els, (x) => incompleteIndoorRelations(x, 200), api))
    .then((els) => {
      focusIndoor.set(g.key, parseBuildings(els).indoor);
      while (focusIndoor.size > 8) focusIndoor.delete(focusIndoor.keys().next().value!);
      if (focus?.key === g.key) { renderLevels(); renderIssues(); }
    })
    .catch((err) => console.warn('[levels] indoor здания не загрузился', err))
    .finally(() => focusIndoorLoading.delete(g.key));
}

/** Indoor-объекты здания: точка на поверхности (у стены — первая точка) внутри контура какого-нибудь его объекта. */
let buildingIndoorCache: { sig: string; list: IndoorFeature[] } | undefined;

function buildingIndoor(g: BuildingGroup): IndoorFeature[] {
  // Отбор по всем тайлам — дорогой, а панель этажей перерисовывается при каждом выделении: кешируем
  const sig = `${g.key}|${overpass.revision}|${overpass.visibilityRevision}|${focusIndoor.get(g.key)?.length ?? -1}|${g.members.join(',')}|${indoorEditRev}`;
  if (buildingIndoorCache?.sig === sig) return buildingIndoorCache.list;
  const list = timed('этажи: indoor здания', () => buildingIndoorImpl(g), (r) => `${r.length} объектов`);
  buildingIndoorCache = { sig, list };
  return list;
}

function buildingIndoorImpl(g: BuildingGroup): IndoorFeature[] {
  const feats = groupFeatures(g);
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const f of feats) for (const p of f.polygons) for (const [x, y] of p.outer) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }
  if (!Number.isFinite(w)) return [];
  // Свои данные здания (без стыков тайлов) — поверх данных тайлов
  const all = new Map(overpass.indoorIn([w, s, e, n]).map((f) => [f.key, f]));
  for (const f of focusIndoor.get(g.key) ?? []) all.set(f.key, f);
  for (const [key, f] of indoorCreated) {
    const e = session.get(key);
    if (!e) continue;
    // Точка (дверь, вход, POI) — узел: место в сессии — единственная вершина
    all.set(key, f.point ? { ...f, tags: e.tags, point: e.polygons?.[0]?.outer[0] ?? f.point } : { ...f, tags: e.tags, polygons: e.polygons ?? f.polygons });
  }
  const list = [...all.values()].filter((f) => {
    const p = f.point ?? (f.line ? f.polygons[0].outer[0] : pointOnSurface(f.polygons[0]));
    // Дверь на наружной стене лежит ровно на контуре — для такой точки pointInRing случаен
    return feats.some((b) => b.polygons.some((q) => pointInRing(p, q.outer) || (!!f.point && nearRing(p, q.outer, 0.3))));
  }).filter((f) => !session.isDeleted(indoorKey(f.key)) && (!indoorCreated.has(f.key) || !!session.get(f.key))).map((f) => {
    // Правки тегов в сессии (indoor, level, room) — поверх данных: вид и этажи по новым тегам; у двери — и место
    const e = indoorEdited.has(indoorKey(f.key)) ? session.get(indoorKey(f.key)) : undefined;
    if (!e) return f;
    const g = withIndoorTags(f, e.tags);
    const at = f.point && !f.key.endsWith('#poi') ? e.polygons?.[0]?.outer[0] : undefined;
    if (!f.point && !f.line && e.polygons?.length && f.key.startsWith('way/')) return { ...g, polygons: e.polygons };
    return at ? { ...g, point: at } : g;
  });
  const visible = list.filter((f) => overpass.isVisible(f)).filter((f) => f.kind === 'poi' || !indoorEdited.has(indoorKey(f.key)) || !!f.tags.indoor || (f.escalator && f.tags.highway === 'steps' && !!f.tags.conveying && f.tags.conveying !== 'no'));
  const axes = visible.filter((f) => f.escalator && (f.tags.incline === 'up' || f.tags.incline === 'down') && f.polygons[0]?.outer.length >= 2);
  return visible.map((f) => {
    if (f.line || !f.polygons.length || !(f.tags.room === 'stairs' || f.tags.stairs === 'yes' || f.tags.conveying)) return f;
    const matched = axes.some((axis) => escalatorAreaMatches(axis, f));
    return matched ? { ...f, escalatorArea: true } : f;
  });
}

/** Точка не дальше tol метров от какой-либо стороны кольца. */
function nearRing([x, y]: LonLat, ring: LonLat[], tol: number): boolean {
  const metresPerLon = 111_320 * Math.cos(y * Math.PI / 180);
  return ring.some((a, i) => {
    const b = ring[(i + 1) % ring.length];
    const dx = (b[0] - a[0]) * metresPerLon, dy = (b[1] - a[1]) * 111_320;
    const px = (x - a[0]) * metresPerLon, py = (y - a[1]) * 111_320;
    const t = Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(px - t * dx, py - t * dy) <= tol;
  });
}

/** Узел двери внутри контура здания, достаточно далеко от наружной стены для безопасного автофикса entrance=yes. */
function isInteriorDoor(f: IndoorFeature, g: BuildingGroup): boolean {
  if (!f.point || f.kind !== 'poi' || f.tags.entrance !== 'yes') return false;
  const farFromEdge = (ring: LonLat[]) => !nearRing(f.point!, ring, 0.5);
  const features = groupFeatures(g);
  // Дверь на стене части — тоже может быть наружной: часть первого этажа под нависающими этажами уже контура
  if (features.some((b) => b.kind === 'part' && b.polygons.some((p) => !farFromEdge(p.outer) || !p.inners.every(farFromEdge)))) return false;
  return features.filter((b) => b.kind === 'building').some((b) => b.polygons.some((p) =>
    pointInRing(f.point!, p.outer) && !p.inners.some((hole) => pointInRing(f.point!, hole))
    && farFromEdge(p.outer) && p.inners.every(farFromEdge)));
}

/**
 * Дополнить этажи по этажности целыми этажами из indoor-данных (подвал без building:levels:underground и т. п.):
 * высота этажа — как у ближайшего известного, без этажности — LEVEL_HEIGHT от земли.
 */

/** Пояснение внизу панели: какие этажи посчитаны по тегам какого объекта (ссылка выделяет его), какие — из indoor. */
function levelSources(levels: Level[]): string {
  const runs: { src?: string; from: number; to: number }[] = [];
  for (const l of [...levels].sort((a, b) => a.n - b.n)) {
    const last = runs[runs.length - 1];
    if (last && last.src === l.src && l.n === last.to + 1) last.to = l.n;
    else runs.push({ src: l.src, from: l.n, to: l.n });
  }
  const range = (r: { from: number; to: number }) => (r.from === r.to ? `${r.from}` : `${r.from}…${r.to}`);
  const lines = runs.map((r) => (r.from === r.to ? tr('Этаж {range}', { range: range(r) }) : tr('Этажи {range}', { range: range(r) })) + ' — '
    + (r.src ? tr('по тегам {link}', { link: `<a href="#" data-select="${esc(r.src)}">${esc(r.src)}</a>` }) : tr('из indoor-данных')));
  return `<li class="lv-source">${lines.join('<br>')}</li>`;
}

/** Значок «есть план этажа». */
const ICON_PLAN = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M2 2h12v12H2z"/><path d="M2 8h5v6M7 2v3M10 8h4M10 8v3"/></svg>';
/** Значки «есть поэтажный план» над зданиями — с этого зума и при стольких indoor-полигонах в здании. */
const BADGE_MIN_ZOOM = 16;
const BADGE_MIN_POLYGONS = 3;
const INDOOR_PLAN_KINDS = new Set(['room', 'area', 'corridor', 'level']);

const UNDERGROUND_LAYER = 'underground-outlines';

/** Подземные здания (не рисуются объёмом) из загруженных данных с учётом фильтра даты. */
function hiddenUnderground(): Feature3D[] {
  return overpass.allFeatures().filter((f) => isHiddenUnderground(f) && overpass.isVisible(f));
}

let undergroundSig = '';
/** Пунктирные контуры подземных зданий на карте. */
function updateUndergroundOutlines(feats: Feature3D[]) {
  const src = map.getSource('underground-outlines') as maplibregl.GeoJSONSource | undefined;
  if (!src) return;
  const sig = feats.map((f) => f.key).join(',');
  if (sig === undergroundSig) return;
  undergroundSig = sig;
  src.setData({ type: 'FeatureCollection', features: feats.flatMap((f) => f.polygons.map((p) => ({
    type: 'Feature' as const, properties: { key: f.key },
    geometry: { type: 'MultiLineString' as const, coordinates: [p.outer, ...p.inners].map((r) => [...r, r[0]]) },
  }))) });
}

const indoorBadges = new IndoorBadges(map, overpassLayer, ICON_PLAN, (key) => {
  const g = groupOf(key) ?? soloGroup(key);
  if (g) enterFocus(g);
});

let badgeTimer: ReturnType<typeof setTimeout> | undefined;
/** Пересчитать значки чуть позже: тайлы приходят пачками, движение карты — частое. */
function scheduleIndoorBadges() {
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(() => timed('значки планов', updateIndoorBadges), 150);
}

/** Здания в видимой области, у которых есть indoor-полигоны (помещения, коридоры…), — значок над верхом. */
function updateIndoorBadges() {
  const underground = hiddenUnderground();
  updateUndergroundOutlines(underground);
  if (focus || !buildingsView.shown || map.getZoom() < BADGE_MIN_ZOOM) return indoorBadges.set([]);
  const b = map.getBounds();
  const bbox: Bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  const indoor = overpass.indoorIn(bbox).filter((f) => INDOOR_PLAN_KINDS.has(f.kind) && !f.line && f.polygons.length);
  if (!indoor.length) return indoorBadges.set([]);
  // Сетка рамок зданий (~50 м) — чтобы не перебирать все здания для каждого помещения
  const CELL = 0.0005;
  const grid = new Map<string, { f: Feature3D; box: Bbox }[]>();
  for (const f of [...overpass.renderedFeatures().map((r) => r.feature), ...underground]) {
    if (!f.polygons.length) continue;
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const p of f.polygons) for (const [x, y] of p.outer) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }
    if (e < bbox[0] || w > bbox[2] || n < bbox[1] || s > bbox[3]) continue;
    for (let i = Math.floor(w / CELL); i <= Math.floor(e / CELL); i++) {
      for (let j = Math.floor(s / CELL); j <= Math.floor(n / CELL); j++) {
        const k = `${i},${j}`;
        (grid.get(k) ?? grid.set(k, []).get(k)!).push({ f, box: [w, s, e, n] });
      }
    }
  }
  const count = new Map<string, number>();
  // Здание без отношения (части внутри контура) — один значок на контур; отбор объектов один на весь пересчёт
  let pool: Feature3D[] | undefined;
  const owner = new Map<string, string>();
  const ownerOf = (b: Feature3D) => {
    let k = owner.get(b.key);
    if (k === undefined) {
      k = groupOf(b.key)?.key ?? implicitBuilding(b, pool ??= loosePool())?.outline ?? b.key;
      owner.set(b.key, k);
    }
    return k;
  };
  for (const f of indoor) {
    const p = pointOnSurface(f.polygons[0]);
    const hit = grid.get(`${Math.floor(p[0] / CELL)},${Math.floor(p[1] / CELL)}`)?.find(({ f: b, box }) =>
      p[0] >= box[0] && p[0] <= box[2] && p[1] >= box[1] && p[1] <= box[3] && b.polygons.some((q) => pointInRing(p, q.outer)));
    if (!hit) continue;
    const key = ownerOf(hit.f);
    count.set(key, (count.get(key) ?? 0) + 1);
  }
  const badges: IndoorBadge[] = [];
  for (const [key, n] of count) {
    if (n < BADGE_MIN_POLYGONS) continue;
    const g = groupOf(key) ?? soloGroup(key);
    const feats = g ? groupFeatures(g) : [overpass.findFeature(key)].filter((f): f is Feature3D => !!f);
    let w = Infinity, s = Infinity, e = -Infinity, nn = -Infinity, top = 0;
    for (const f of feats) {
      for (const p of f.polygons) for (const [x, y] of p.outer) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); nn = Math.max(nn, y); }
      if (!f.hasParts && !isHiddenUnderground(f)) top = Math.max(top, computeHeights(f.tags).top);
    }
    if (!Number.isFinite(w)) continue;
    const name = (g && (g.tags.name ?? outlineTags(g)?.name)) ?? feats[0]?.tags.name;
    const title = name
      ? trn(n, '{name} — есть поэтажный план ({n} помещение). Клик — открыть здание|{name} — есть поэтажный план ({n} помещения). Клик — открыть здание|{name} — есть поэтажный план ({n} помещений). Клик — открыть здание', { name })
      : trn(n, 'есть поэтажный план ({n} помещение). Клик — открыть здание|есть поэтажный план ({n} помещения). Клик — открыть здание|есть поэтажный план ({n} помещений). Клик — открыть здание');
    badges.push({ key, at: [(w + e) / 2, (s + nn) / 2], top, title });
  }
  indoorBadges.set(badges);
}

/** Доля площади этажа, покрытая indoor-полигонами, начиная с которой у этажа есть план. */
const PLAN_COVERAGE = 0.3;

/** Площадь кольца lon/lat, м² (локально плоская проекция). */
function geoRingArea(ring: LonLat[]): number {
  if (ring.length < 3) return 0;
  const k = Math.cos((ring[0][1] * Math.PI) / 180) * 111320, m = 110540;
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] * k) * (ring[i][1] * m) - (ring[i][0] * k) * (ring[j][1] * m);
  return Math.abs(a) / 2;
}
const polyArea = (p: Polygon) => geoRingArea(p.outer) - p.inners.reduce((s, r) => s + geoRingArea(r), 0);

let plannedCache: { sig: string; set: Set<number> } | undefined;

/**
 * Этажи с поэтажным планом: помещения, коридоры и площадки покрывают не меньше PLAN_COVERAGE площади этажа
 * (объединения следов частей здания, которые есть на этом этаже); indoor=level — весь этаж.
 */
function plannedLevels(g: BuildingGroup, levels: Level[], indoor: IndoorFeature[]): Set<number> {
  const feats = groupFeatures(g);
  const sig = `${g.key}|${indoor.length}|${feats.map((f) => f.key + f.version).join(',')}|${levels.map((l) => l.n).join(',')}`;
  if (plannedCache?.sig === sig) return plannedCache.set;
  const set = new Set<number>();
  for (const l of levels) {
    const mid = (l.floor + l.ceil) / 2;
    const spans = feats.filter((f) => { const h = computeHeights(f.tags); return h.min <= mid && h.wallTop >= mid; });
    let floorArea = 0;
    try {
      const geom = spans.flatMap((f) => f.polygons.map((p) => [p.outer, ...p.inners].map((r) => [...r, r[0]])));
      if (geom.length) floorArea = polygonClipping.union(geom[0], ...geom.slice(1)).reduce((s, poly) =>
        s + polyArea({ outer: poly[0], inners: poly.slice(1) } as Polygon), 0);
    } catch { floorArea = spans.reduce((s, f) => s + f.polygons.reduce((a, p) => a + polyArea(p), 0), 0); }
    const here = indoor.filter((f) => f.levels.includes(l.n) && !f.line && (f.kind === 'room' || f.kind === 'area' || f.kind === 'corridor' || f.kind === 'level'));
    if (!here.length) continue;
    const covered = here.some((f) => f.kind === 'level') ? Infinity : here.reduce((s, f) => s + f.polygons.reduce((a, p) => a + polyArea(p), 0), 0);
    if (covered >= PLAN_COVERAGE * floorArea) set.add(l.n);
  }
  plannedCache = { sig, set };
  return set;
}

/** Показанный этаж и его indoor-объекты — для выбора кликом; выбранный indoor-объект (инфо в свойствах). */
let shownLevel: Level | undefined;
/** Номера этажей здания режима (для выбора level у indoor-объекта). */
let panelLevels: number[] = [];
/** Обозначения этажей здания режима (level:ref с indoor=level) — для подписей этажей вне панели. */
let panelLevelRefs = new Map<number, string>();
let shownIndoor: IndoorFeature[] = [];
let selectedIndoor: IndoorFeature | undefined;

const INDOOR_NAMES: Record<string, string> = { room: tr('Помещение'), corridor: tr('Коридор'), area: tr('Площадка'), level: tr('Этаж'), wall: tr('Стена'), column: tr('Колонна'), poi: tr('Объект') };

/** Помещение, коридор или площадка показанного этажа под курсором (самое маленькое из накрывающих). */
function indoorAt(point: [number, number]): IndoorFeature | undefined {
  if (!shownLevel) return;
  const ray = overpassLayer.focusRay(point);
  const hit = ray?.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -shownLevel.floor), new THREE.Vector3());
  // Дверь (маркер в проёме) — важнее всего под ней
  const door = overpassLayer.pickDoor(point);
  const doorF = door ? shownIndoor.find((x) => x.key === door) : undefined;
  if (doorF) return doorF;
  const escalator = overpassLayer.pickEscalator(point);
  const solid = overpassLayer.pickIndoorSolid(point);
  if (escalator && (!solid || escalator.t <= solid.t + 0.02)) {
    const axis = focus && buildingIndoor(focus).find((f) => f.escalator && f.key === escalator.key);
    if (axis) return axis;
  }
  if (solid && (!hit || solid.t <= hit.distanceTo(ray!.origin))) {
    const f = shownIndoor.find((x) => x.key === solid.key);
    if (f) return f;
  }
  const ll = hit && overpassLayer.focusToLngLat(hit.x, hit.y);
  if (!ll) return;
  const inside = (p: Polygon) => pointInRing(ll, p.outer) && !p.inners.some((r) => pointInRing(ll, r));
  return shownIndoor
    // indoor=level — не помещение: пол этажа вне помещений — пустая площадь (freeAreaAt), сам этаж — из панели «Этажи»
    .filter((f) => !f.line && !f.escalatorArea && f.kind !== 'poi' && f.kind !== 'wall' && f.kind !== 'column' && f.kind !== 'level' && f.polygons.some(inside))
    .sort((a, b) => a.polygons.reduce((s, p) => s + polyArea(p), 0) - b.polygons.reduce((s, p) => s + polyArea(p), 0))[0];
}

/** Выбранные indoor-объекты (Shift+клик добавляет и убирает); selectedIndoor — первый из них. */
let indoorSelection: IndoorFeature[] = [];
let selectedRoomWalls: RoomWall[] = [];
let deletingIndoorWalls = false;

function roomWallAt(point: [number, number]): RoomWall | undefined {
  if (!shownLevel || overpassLayer.pickDoor(point)) return;
  const solid = overpassLayer.pickIndoorSolid(point, true);
  if (!solid?.side) return;
  const escalator = overpassLayer.pickEscalator(point);
  if (escalator && escalator.t <= solid.t + 0.02) return;
  const ray = overpassLayer.focusRay(point);
  const floor = ray?.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -shownLevel.floor), new THREE.Vector3());
  if (floor && solid.t > floor.distanceTo(ray!.origin)) return;
  return { key: solid.key, ...solid.side };
}

function selectRoomWall(wall: RoomWall, add = false) {
  const f = shownIndoor.find((f) => f.key === wall.key);
  if (!f || !shownLevel) return;
  const old = selectedRoomWalls;
  selectIndoor(undefined);
  if (selection.length) select(undefined);
  clearTreeSelection();
  const spanKey = (w: RoomWall) => `${w.key}:${JSON.stringify(roomWallSpan(shownIndoor.find((f) => f.key === w.key)!.polygons, w))}`;
  selectedRoomWalls = add ? old.some((w) => spanKey(w) === spanKey(wall)) ? old.filter((w) => spanKey(w) !== spanKey(wall)) : [...old, wall] : [wall];
  overpassLayer.setRoomWallSelection(selectedRoomWalls.map((w) => ({ key: w.key, kind: 'wall', line: true, z: shownLevel!.floor,
    polygons: [{ outer: roomWallSpan(shownIndoor.find((f) => f.key === w.key)!.polygons, w), inners: [] }] })));
  infoEl.innerHTML = selectedRoomWalls.length ? `<h2>${tr('Стены помещения')}</h2><p class="hint">${tr('Удаление преобразует помещение в indoor=area и сохранит остальные стены. Изменение действует на всех этажах объекта.')}</p>` : '';
}

/**
 * Выбрать indoor-объект: его теги в панели свойств, контур подсвечен. undefined — снять. add — Shift: добавить
 * к выбранным или убрать из них (несколько — общая форма: одинаковые значения, у разных — «разные значения»).
 */
function selectIndoor(f: IndoorFeature | undefined, add = false) {
  if (freeArea) { freeArea = undefined; overpassLayer.setFreeArea(undefined); }
  selectedRoomWalls = [];
  overpassLayer.setRoomWallSelection([]);
  if (f) clearTreeSelection();
  // Значок помещения-магазина — показываем само помещение
  if (f?.key.endsWith('#poi')) f = shownIndoor.find((x) => x.key === f!.key.replace('#poi', '')) ?? f;
  if (add && f) {
    const k = indoorKey(f.key);
    indoorSelection = indoorSelection.some((x) => indoorKey(x.key) === k) ? indoorSelection.filter((x) => indoorKey(x.key) !== k) : [...indoorSelection, f];
  } else indoorSelection = f ? [f] : [];
  renderIndoorSelection(add);
}

/** Геометрия indoor-объекта для пресетов iD: узел-дверь — вершина, линия, остальное — площадь. */
const indoorGeometry = (f: IndoorFeature): PresetGeometry => (indoorKey(f.key).startsWith('node/')
  ? (isDoor(f) ? 'vertex' : 'point') : f.line ? 'line' : 'area');

/**
 * Название indoor-объекта: пресет iD, если он говорит больше, чем indoor=* (indoor=room + shop=clothes — «Магазин
 * одежды», + stairs=yes — «Лестница»); иначе — наши короткие названия видов. Пресеты ещё грузятся — свои, потом
 * панель перерисуется.
 */
function indoorTitle(f: IndoorFeature): string {
  const own = f.escalator ? tr('Эскалатор') : isDoor(f) ? tr('Дверь') : INDOOR_NAMES[f.kind];
  if (f.escalator) return own;
  loadPresets(() => { if (indoorSelection.length) renderIndoorSelection(); });
  const p = matchPreset(f.tags, indoorGeometry(f));
  return p && Object.keys(p.tags).some((k) => k !== 'indoor' && k !== 'door') ? p.name : own;
}

/** Обновить подсветку и общую форму после изменения набора выбранных indoor-объектов. */
function renderIndoorSelection(add = false) {
  let f: IndoorFeature;
  selectedIndoor = indoorSelection[0];
  overpassLayer.setIndoorSelection(indoorSelection.map((x) => x.key));
  indoorPois.setSelection(indoorSelection.map((x) => x.key));
  syncIssueFilter();
  if (!indoorSelection.length) { clearInfo(); return; }
  if (selection.length) select(undefined);
  if (indoorSelection.length > 1) { renderIndoorMulti(indoorSelection); return; }
  f = indoorSelection[0];
  const key = indoorKey(f.key);
  const [type, id] = key.split('/');
  const t = f.tags;
  const kind = indoorTitle(f);
  const levels = f.levels.map((n) => levelLabel(n)).join(', ');
  infoEl.innerHTML = `<h2>${esc(kind)}${t.name ? ' ' + tr('«{name}»', { name: esc(t.name) }) : t.ref ? ` ${esc(t.ref)}` : ''} — `
    + `<a href="${server().web}/${type}/${id}" target="_blank" rel="noopener">${esc(key)}</a></h2>`
    + `<p class="hint">${esc(levels)}</p>`
    + indoorForm([f])
    + `<details class="all-tags"><summary>${tr('Все теги')}</summary><table>${Object.entries(t).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table></details>`;
  bindIndoorForm([f]);
}

/** Несколько indoor-объектов: число и виды, общая форма. */
function renderIndoorMulti(fs: IndoorFeature[]) {
  const kinds = [...new Set(fs.map(indoorTitle))].join(', ');
  infoEl.innerHTML = `<h2>${trn(fs.length, 'Выбран {n} объект|Выбрано {n} объекта|Выбрано {n} объектов')}</h2><p class="hint">${esc(kinds)}</p>`
    + indoorForm(fs);
  bindIndoorForm(fs);
}

/** Поля формы: у стен и колонн нет room — среди выбранных есть такие, поля room нет; ref и name — только у помещений и зон. */
const indoorFormTags = (fs: IndoorFeature[]) => (fs.every((f) => f.kind === 'level') ? ['height', 'level:ref', 'name'] : fs.every((f) => f.escalator) ? ['highway', 'conveying', 'incline', 'level', 'width'] : fs.every(isDoor) ? ['door', 'level', ...(fs.every((f) => f.tags.door === 'revolving') ? ['diameter'] : [])]
  : fs.some((f) => f.kind === 'wall' || f.kind === 'column' || f.kind === 'poi') ? ['indoor', 'level']
  // ref и name (номер и название, подпись на плане) — у помещений и зон, у коридоров — нет
  : [...INDOOR_EDIT_TAGS].filter((k) => (k !== 'ref' && k !== 'name') || fs.every((f) => f.kind === 'room' || f.kind === 'area')));

/** Дверь плана этажа: узел с door, indoor=door или entrance (точка на линии стены в проёме). */
/** Лифт: помещение room=elevator (highway=elevator) или помещение с точкой highway=elevator внутри. */
function isElevatorRoom(f: IndoorFeature, all: IndoorFeature[]): boolean {
  if (f.kind !== 'room' || f.line) return false;
  if (f.tags.room === 'elevator' || f.tags.highway === 'elevator') return true;
  return all.some((p) => p.kind === 'poi' && p.point && p.tags.highway === 'elevator'
    && f.polygons.some((q) => pointInRing(p.point!, q.outer) && !q.inners.some((h) => pointInRing(p.point!, h))));
}

/** Туалет или кабинка: двери в его стенах уже обычных. */
/** Глубина бассейна по умолчанию, м (детский «лягушатник» мельче, но для плана не страшно). */
const POOL_DEPTH = 1.5;

/**
 * Бассейн на плане этажа: площадка (indoor=area или yes) с leisure=swimming_pool или room=swimming_pool
 * (встречается и через дефис: relation/17946689). indoor=room — зал с бассейном, а не чаша: его не трогаем.
 */
function isPool(f: IndoorFeature): boolean {
  const t = f.tags;
  return (t.leisure === 'swimming_pool' || t.room === 'swimming_pool' || t.room === 'swimming-pool')
    && (t.indoor === 'area' || t.indoor === 'yes') && !f.line && !f.point;
}

/** Глубина чаши: depth или max_depth, если правдоподобны, иначе POOL_DEPTH. */
function poolDepth(f: IndoorFeature): number {
  for (const k of ['depth', 'max_depth']) {
    const d = parseLength(f.tags[k]);
    if (d !== undefined && d >= 0.3 && d <= 6) return d;
  }
  return POOL_DEPTH;
}

function isToiletRoom(f: IndoorFeature): boolean {
  const t = f.tags;
  return ['toilets', 'toilet', 'toilet_cubicle', 'shower'].includes(t.room ?? '') || t.amenity === 'toilets' || t.toilets === 'yes';
}
const isDoor = (f: IndoorFeature) => f.kind === 'poi' && !!f.point && !f.key.endsWith('#poi')
  && !!(f.tags.door || f.tags.indoor === 'door' || f.tags.entrance);

/** Обработчики формы: правка поля — у всех выбранных одним шагом истории. */
function bindIndoorForm(fs: IndoorFeature[]) {
  for (const input of infoEl.querySelectorAll<HTMLInputElement>('[data-indoor-tag]')) {
    input.addEventListener('change', () => setIndoorTags(fs.map((f) => ({ key: indoorKey(f.key), tags: { ...f.tags, [input.dataset.indoorTag!]: input.value } })), input.dataset.indoorTag));
  }
  const levelInput = infoEl.querySelector<HTMLInputElement>('[data-indoor-tag="level"]');
  if (levelInput) { bindLevelHint(levelInput); bindLevelPicker(levelInput, fs); }
}

function changeIndoorHidden(next: Set<string>) {
  const prev = new Set(indoorHidden);
  if (prev.size === next.size && [...next].every((key) => prev.has(key))) return;
  const apply = (keys: Set<string>) => {
    indoorHidden.clear();
    for (const key of keys) indoorHidden.add(key);
    if (indoorSelection.some((f) => indoorHidden.has(indoorKey(f.key)))) {
      selectIndoor(undefined);
      clearInfo();
    }
    renderLevels();
  };
  apply(next);
  session.pushView({ undo: () => apply(prev), redo: () => apply(next) });
}

function hideSelectedIndoor() {
  if (!indoorSelection.length) return;
  changeIndoorHidden(new Set([...indoorHidden, ...indoorSelection.map((f) => indoorKey(f.key))]));
}

/** Помещение, коридор или площадка — пол, который красим по назначению. */
const isFloorKind = (f: IndoorFeature) => !f.line && (f.kind === 'room' || f.kind === 'corridor' || f.kind === 'area');

/** Назначение помещения: по его тегам и по точечным объектам (узлам) этажа внутри него. */
function categoryOf(f: IndoorFeature, onLevel: IndoorFeature[]): IndoorCategory {
  const inside = onLevel.filter((p) => p.kind === 'poi' && p.point && !p.key.endsWith('#poi')
    && f.polygons.some((q) => pointInRing(p.point!, q.outer) && !q.inners.some((h) => pointInRing(p.point!, h))));
  return indoorCategory(f, inside);
}

/** Легенда раскраски: только категории, которые есть на этаже (закрытые и технические — одним пунктом). */
function indoorLegend(onLevel: IndoorFeature[]): string {
  const present = new Set<IndoorCategory>(onLevel.filter(isFloorKind).map((f) => {
    const c = categoryOf(f, onLevel);
    return c === 'technical' ? 'private' : c;
  }));
  const items = CATEGORY_ORDER.filter((c) => present.has(c));
  if (!items.length) return '';
  const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;
  return `<li class="lv-legend">${items.map((c) => `<span class="lv-legend-item"><i style="background:${hex(CATEGORY_COLOURS[c])}"></i>${esc(CATEGORY_LABELS[c])}</span>`).join('')}</li>`;
}

/** Indoor-объект здания режима по ключу OSM (с правками сессии); недоступен — undefined. */
function buildingIndoorFor(key: string): IndoorFeature | undefined {
  return focus ? buildingIndoor(focus).find((f) => f.key === key) : undefined;
}

/** Ключи indoor-объектов, которые правились в сессии (их теги берутся из сессии). */
const indoorEdited = new Set<string>();
/** Новые стены: видимость и теги берутся из сессии для undo/redo. */
const indoorCreated = new Map<string, IndoorFeature>();
/** Меняется при правке indoor-тегов: кеш объектов здания пересчитывается. */
let indoorEditRev = 0;
/** Ключ объекта OSM у indoor-объекта (у значка помещения — #poi). */
const indoorKey = (k: string) => k.replace('#poi', '');
/** Теги indoor-объекта, которые можно править (без геометрии). */
const INDOOR_EDIT_TAGS = ['indoor', 'level', 'room', 'ref', 'name'] as const;
const INDOOR_VALUES = ['room', 'corridor', 'area', 'level', 'wall', 'column', 'door', 'yes'];
// https://wiki.openstreetmap.org/wiki/Key:door — свободный ввод сохраняется.
const DOOR_VALUES = ['yes', 'hinged', 'sliding', 'revolving', 'folding', 'trapdoor', 'overhead', 'no'];
/** Подписи значений поверх схемы iD (src/osm/presets.ts): у iD их нет или они длиннее. */
const DOOR_LABELS: Record<string, string> = {
  yes: tr('Неизвестного типа'), hinged: tr('Распашная'), sliding: tr('Раздвижная'),
  revolving: tr('Вращающаяся'), folding: tr('Складная'), trapdoor: tr('Люк'),
  overhead: tr('Подъёмная'), no: tr('Открытый проём (без двери)'),
};
const INDOOR_LABELS: Record<string, string> = {
  room: tr('Помещение'), corridor: tr('Коридор'), area: tr('Зона без стен'), level: tr('Этаж'), wall: tr('Стена'),
  column: tr('Колонна'), door: tr('Дверь'), yes: tr('Не указано'),
};
const ROOM_VALUES = ['shop', 'office', 'toilets', 'toilet', 'stairs', 'elevator', 'restaurant', 'technical', 'storage', 'class', 'conference', 'kitchen', 'waiting', 'entrance', 'auditorium', 'bedroom', 'living_room', 'bathroom', 'yes'];
const ROOM_LABELS: Record<string, string> = {
  shop: tr('Магазин'), office: tr('Офис'), toilets: tr('Туалеты'), toilet: tr('Туалет'), stairs: tr('Лестница'),
  elevator: tr('Лифт'), restaurant: tr('Ресторан'), technical: tr('Техническое помещение'), storage: tr('Кладовая'),
  class: tr('Учебный класс'), conference: tr('Переговорная'), kitchen: tr('Кухня'), waiting: tr('Зал ожидания'),
  entrance: tr('Вход'), auditorium: tr('Аудитория'), bedroom: tr('Спальня'), living_room: tr('Гостиная'),
  bathroom: tr('Ванная'), yes: tr('Не указано'),
};

/** Поля правки indoor, level и room у выбранного indoor-объекта. */
/**
 * Подпись поля indoor-формы: свои (у этажа — высота этажа, обозначение), иначе из схемы iD (src/osm/presets.ts),
 * иначе ключ. Ключ — во всплывающей подсказке. У iD нет пресета indoor=level и поля level:ref.
 */
function indoorFieldLabel(k: string, fs: IndoorFeature[]): string {
  const level = fs.every((f) => f.kind === 'level');
  const own: Record<string, string> = {
    height: level ? tr('Высота этажа, м') : tr('Высота, м'), 'level:ref': tr('Обозначение этажа'), name: tr('Название'), ref: tr('Номер'),
    // У iD и indoor, и room — «Тип»: рядом не различить
    indoor: tr('Вид'), room: tr('Назначение'), width: tr('Ширина, м'), diameter: tr('Диаметр'),
  };
  return own[k] ?? idFieldLabel(k) ?? k;
}

function indoorForm(fs: IndoorFeature[], placeholders: Record<string, string> = {}): string {
  const rows = indoorFormTags(fs).map((k) => {
    const values = new Set(fs.map((f) => f.tags[k] ?? ''));
    const mixed = values.size > 1;
    const value = mixed ? '' : [...values][0];
    const changed = fs.some((f) => session.isChanged(indoorKey(f.key), k));
    // Свой список, а не datalist: тот показывает только варианты, совпадающие с уже введённым значением
    const options = k === 'door' ? DOOR_VALUES : k === 'indoor' ? INDOOR_VALUES : k === 'room' ? ROOM_VALUES : undefined;
    const label = `<span title="${esc(k)}">${esc(indoorFieldLabel(k, fs))}</span>`;
    if (options) return `<label class="tag-row${changed ? ' changed' : ''}">${label}`
      + renderValueCombo(options, `data-indoor-tag="${k}"`, value, mixed ? tr('разные значения') : '—', k === 'door' ? DOOR_LABELS : k === 'indoor' ? INDOOR_LABELS : ROOM_LABELS, k) + '</label>';
    return `<label class="tag-row${changed ? ' changed' : ''}">${label}`
      + `<input type="text" data-indoor-tag="${k}" value="${esc(value)}" placeholder="${mixed ? tr('разные значения') : placeholders[k] ?? (k === 'diameter' ? '2.4 m' : '—')}" spellcheck="false" autocomplete="off"></label>`;
  }).join('');
  const hint = fs.every(isDoor) ? `<p class="hint">${tr('Для перемещения дверей используйте инструмент «Переместить» (M).')}</p>` : '';
  return `<div class="tag-form">${rows}</div>${hint}`;
}

/**
 * Серая подсказка после значения level — какой это этаж по-русски: «0 (1 этаж)». Только для русской
 * локали: в ней номер этажа на единицу больше level, в английской они совпадают.
 */
/** Обёртка поля level (для подсказки и списка этажей) — одна на поле. */
function levelWrap(input: HTMLInputElement): HTMLElement {
  if (input.parentElement?.classList.contains('level-hint-wrap')) return input.parentElement;
  const wrap = document.createElement('span');
  wrap.className = 'level-hint-wrap';
  input.replaceWith(wrap);
  wrap.append(input);
  return wrap;
}

/** У какого объекта открыт список этажей: после правки форма перерисовывается — открыть снова. */
let levelPickerOpen: string | undefined;
/** Сколько этажей показывать в списке: больше — ближайшие к текущему вверх и вниз. */
const LEVEL_PICKER_MAX = 9;

/**
 * Выпадающий список этажей здания у поля level: чекбоксы, выбранные пишутся через «;». Этажей больше
 * LEVEL_PICKER_MAX — показываются ближайшие к текущему этажу. Значения вне списка (дробные, дальние) сохраняются.
 */
function bindLevelPicker(input: HTMLInputElement, fs: IndoorFeature[]) {
  if (!panelLevels.length) return;
  const wrap = levelWrap(input);
  const key = fs.map((f) => indoorKey(f.key)).join(',');
  const cur = shownLevel?.n ?? 0;
  const shown = [...panelLevels].sort((a, b) => Math.abs(a - cur) - Math.abs(b - cur) || b - a).slice(0, LEVEL_PICKER_MAX).sort((a, b) => b - a);
  const box = document.createElement('div');
  box.className = 'level-picker';
  box.hidden = true;
  // Этажи каждого объекта: у одного — из поля (его можно править текстом), у нескольких — свои теги
  const levelsOf = () => (fs.length === 1 ? [parseLevels(input.value)] : fs.map((f) => parseLevels(f.tags.level)));
  const render = () => {
    const sets = levelsOf().map((l) => new Set(l));
    box.innerHTML = shown.map((n) => {
      const count = sets.filter((x) => x.has(n)).length;
      return `<label class="level-picker-row${n === cur ? ' current' : ''}"><input type="checkbox" value="${n}"${count === sets.length ? ' checked' : ''}${count && count < sets.length ? ' data-mixed' : ''}>`
        + `<span>${esc(levelLabel(n))}</span><span class="level-picker-n">level=${n}</span></label>`;
    }).join('');
    // У части выбранных этот этаж есть — промежуточное состояние
    for (const cb of box.querySelectorAll<HTMLInputElement>('input[data-mixed]')) cb.indeterminate = true;
  };
  wrap.append(box);
  const open = () => { render(); box.hidden = false; levelPickerOpen = key; };
  const close = () => {
    document.removeEventListener('pointerdown', outside, true);
    // Форма уже перерисована (правка) — список новой формы этим не закрываем
    if (!wrap.isConnected) return;
    box.hidden = true;
    levelPickerOpen = undefined;
  };
  const outside = (e: Event) => { if (!wrap.contains(e.target as Node)) close(); };
  input.addEventListener('focus', () => { open(); document.addEventListener('pointerdown', outside, true); });
  input.addEventListener('input', () => { if (!box.hidden) render(); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  box.addEventListener('pointerdown', (e) => e.preventDefault()); // фокус остаётся в поле
  box.addEventListener('change', (e) => {
    const cb = e.target as HTMLInputElement;
    const n = Number(cb.value);
    // Отметка добавляет этаж каждому выбранному, снятие — убирает у каждого (остальные этажи у каждого свои)
    const all = levelsOf();
    setIndoorTags(fs.map((f, i) => {
      const set = new Set(all[i]);
      if (cb.checked) set.add(n); else set.delete(n);
      return { key: indoorKey(f.key), tags: { ...f.tags, level: [...set].sort((a, b) => a - b).join(';') } };
    }), 'level');
  });
  if (levelPickerOpen === key) { open(); document.addEventListener('pointerdown', outside, true); }
}

function bindLevelHint(input: HTMLInputElement) {
  if (lang !== 'ru') return;
  const wrap = levelWrap(input);
  const ghost = document.createElement('span');
  ghost.className = 'level-hint';
  wrap.append(ghost);
  const update = () => {
    const above = parseLevels(input.value).filter((n) => n >= 0 && Number.isInteger(n)).map(humanFloor);
    ghost.innerHTML = above.length ? `<span class="level-hint-pad">${esc(input.value)}</span> (${esc(above.join(', '))} ${tr('этаж')})` : '';
  };
  input.addEventListener('input', update);
  update();
}

/** Начать отслеживать indoor-объект в сессии (у точки — с её узлом: дверь можно и сдвинуть). */
function trackIndoor(key: string, f: IndoorFeature | undefined) {
  if (!session.has(key)) {
    const id = Number(key.split('/')[1]);
    // У пути — его кольцо с узлами: разрез и вставка узлов правят геометрию
    const point = key.startsWith('node/') && f?.point ? [{ outer: [f.point], inners: [], outerIds: [id], innerIds: [] }]
      : key.startsWith('way/') && !f?.line && f?.polygons.length === 1 && f.polygons[0].outerIds ? f.polygons : undefined;
    session.track({ key, version: 0, tags: { ...(f?.tags ?? {}) }, ...(point ? { polygons: point } : {}) });
  }
  indoorEdited.add(key);
}

/** Точка — вершина какого-нибудь контура этажа (помещения, стены) или здания: узел нужен геометрии. */
function isVertex(at: LonLat): boolean {
  const same = (q: LonLat) => Math.abs(q[0] - at[0]) < 1e-9 && Math.abs(q[1] - at[1]) < 1e-9;
  const rings = [...shownIndoor.filter((f) => f.kind !== 'poi'), ...(focus ? groupFeatures(focus) : [])].flatMap((f) => f.polygons.flatMap((p) => [p.outer, ...p.inners]));
  return rings.some((r) => r.some(same));
}

/**
 * Удалить двери одним шагом истории. Узел в контуре стены или помещения остаётся вершиной — у него снимаются
 * все теги; отдельно стоящий узел удаляется целиком.
 */
function deleteDoors(fs: IndoorFeature[]) {
  const edits: ObjectEdit[] = [];
  for (const f of fs) {
    const key = indoorKey(f.key);
    trackIndoor(key, f);
    edits.push(f.point && isVertex(f.point) ? { key, tags: {} } : { key, delete: true });
  }
  selectIndoor(undefined);
  clearInfo();
  session.editMany(edits);
  setStatus(trn(fs.length, 'Удалена {n} дверь.|Удалено {n} двери.|Удалено {n} дверей.'));
}

/** Одинаковое действие для Del и контекстного меню. */
function canDeleteIndoorSelection(): boolean {
  return selectedRoomWalls.length > 0 || (indoorSelection.length > 0
    && (indoorSelection.every(isDoor) || indoorSelection.every(isDeletableSpace) || indoorSelection.some((f) => f.kind === 'wall')));
}

/** Помещение, коридор или зона — удаляется целиком. */
const isDeletableSpace = (f: IndoorFeature) => !f.line && !f.escalator && !f.key.endsWith('#poi')
  && (f.kind === 'room' || f.kind === 'area' || f.kind === 'corridor');

function deleteIndoorSelection() {
  if (uploading || deletingIndoorWalls || !canDeleteIndoorSelection()) return;
  if (indoorSelection.length && indoorSelection.every(isDoor)) deleteDoors(indoorSelection);
  else if (!selectedRoomWalls.length && indoorSelection.length && indoorSelection.every(isDeletableSpace)) void deleteIndoorSpaces(indoorSelection);
  else void deleteIndoorWalls();
}

/**
 * Удалить помещения одним шагом истории. Отношение удаляется (его пути без тегов при отправке — тоже, если больше
 * нигде не нужны). Путь, входящий в отношения (контур мультиполигона, здание), теряет только теги; иначе удаляется.
 */
async function deleteIndoorSpaces(fs: IndoorFeature[]) {
  if (!focus) return;
  const api = server().api, group = focus.key, stamp = JSON.stringify(session.changes());
  deletingIndoorWalls = true;
  setStatus(tr('Проверка отношений…'));
  try {
    const ways = fs.filter((f) => f.key.startsWith('way/'));
    const parents = await Promise.all(ways.map(async (f) => {
      const id = Number(f.key.split('/')[1]);
      return { key: f.key, relations: id > 0 ? await fetchWayRelations(id, api) : [] };
    }));
    if (focus?.key !== group || server().api !== api || JSON.stringify(session.changes()) !== stamp) {
      setStatus(tr('Выбор или данные изменились. Повторите удаление.'));
      return;
    }
    const edits: ObjectEdit[] = [];
    let stripped = 0;
    for (const f of fs) {
      const key = indoorKey(f.key);
      trackIndoor(key, f);
      if (key.startsWith('relation/')) { edits.push({ key, delete: true }); continue; }
      const id = Number(key.split('/')[1]);
      // Членство — по текущему составу в сессии (отношения могли уже правиться или быть созданы в ней)
      const referenced = parents.find((p) => p.key === key)!.relations.some((r) => {
        const rk = `relation/${r.id}`;
        if (session.isDeleted(rk) || fs.some((o) => indoorKey(o.key) === rk)) return false;
        const members = session.get(rk)?.relMembers ?? r.members;
        return members.some((m) => m.type === 'way' && m.ref === id);
      }) || [...editGroups.values(), ...session.createdAlive()].some((r) => r.relMembers?.some((m) => m.type === 'way' && m.ref === id));
      if (referenced) { edits.push({ key, tags: {} }); stripped++; } else edits.push({ key, delete: true });
    }
    selectIndoor(undefined);
    clearInfo();
    session.editMany(edits);
    setStatus(stripped
      ? tr('Удалено помещений: {n}; у путей в составе отношений сняты только теги: {m}. Отменить — Ctrl+Z.', { n: fs.length, m: stripped })
      : tr('Удалено помещений: {n}. Отменить — Ctrl+Z.', { n: fs.length }));
  } catch (err) {
    setStatus(tr('Не удалось удалить помещения: {error}', { error: (err as Error).message }), true);
  } finally {
    deletingIndoorWalls = false;
  }
}

/** Теги, по которым помещения должны совпадать, чтобы их объединить. */
const INDOOR_MERGE_KEYS = ['indoor', 'room', 'level', 'repeat_on'];

/**
 * «Объединить» (J) на плане этажа: выделенные помещения, коридоры или площадки одного вида (indoor, room, level)
 * с общей стороной — в одно. Историю сохраняет большее, остальные удаляются; узлы на бывшей общей стороне
 * уходят из контура (у соседей остаются), лишние вершины на прямой — тоже, если больше никому не нужны.
 * Прочие теги — у большего, недостающие добавляются от остальных. Строка — почему нельзя.
 */
async function mergeIndoor(): Promise<string | undefined> {
  if (!focus || !shownLevel) return tr('Объединять помещения можно на этаже здания.');
  const fs = indoorSelection.filter(isDeletableSpace);
  if (fs.length < 2 || fs.length !== indoorSelection.length) return tr('Выделите два или больше помещения, коридора или площадки.');
  if (fs.some((f) => !f.key.startsWith('way/') || f.polygons.length !== 1 || !f.polygons[0].outerIds)) return tr('Мультиполигоны пока не объединяются — только помещения-пути.');
  const sig = (f: IndoorFeature) => INDOOR_MERGE_KEYS.map((k) => f.tags[k] ?? '').join('|');
  if (new Set(fs.map(sig)).size > 1) return tr('У объектов разные indoor, room или level — объединяются только одинаковые.');
  const toLocal = (r: LonLat[]) => { const q = r.map((x) => overpassLayer.focusToLocal(x)!); return [...q, q[0]] as [number, number][]; };
  let union: [number, number][][][];
  try { union = polygonClipping.union(...fs.map((f) => [toLocal(f.polygons[0].outer)]) as [[[number, number][]]]); } catch (err) { console.warn('[merge-indoor]', err); return tr('Не удалось объединить контуры.'); }
  if (union.length !== 1) return tr('Объекты не соприкасаются — объединяются только помещения с общей стороной.');
  if (union[0].length > 1) return tr('Внутри объединения получилась дыра — такое пока не поддерживается.');
  const sorted = [...fs].sort((a, b) => polyArea(b.polygons[0]) - polyArea(a.polygons[0]));
  const [keep, ...rest] = sorted;
  const keepKey = indoorKey(keep.key);
  // Пути в составе отношений не удаляем молча
  const api = server().api, stamp = JSON.stringify(session.changes());
  const existing = rest.filter((f) => Number(f.key.split('/')[1]) > 0);
  let parents: { id: number }[][];
  try { parents = await Promise.all(existing.map((f) => fetchWayRelations(Number(f.key.split('/')[1]), api))); } catch (err) { return tr('Не удалось проверить отношения: {error}', { error: (err as Error).message }); }
  if (JSON.stringify(session.changes()) !== stamp || !shownLevel) return tr('Выбор или данные изменились. Повторите.');
  const inRel = existing.filter((_, i) => parents[i].some((r) => !session.isDeleted(`relation/${r.id}`)));
  if (inRel.length) return tr('{keys} входит в отношение — объединение его бы удалило.', { keys: inRel.map((f) => indoorKey(f.key)).join(', ') });
  // Узлы: вершины объединения — прежние узлы (свои и соседей)
  const merged = new Set(fs.map((f) => indoorKey(f.key)));
  const others = [...groupFeatures(focus), ...shownIndoor.filter((f) => !f.point && !f.line && !merged.has(indoorKey(f.key)))];
  const { nodeFor } = sharedNodes([...others, ...fs]);
  const ring = nodeRing(union[0][0].slice(0, -1).map((q) => overpassLayer.focusToLngLat(q[0], q[1])! as LonLat), nodeFor);
  if (!ring) return tr('Не удалось объединить контуры.');
  // Вершина на прямой, которая не нужна соседям, — лишняя (конец бывшей общей стороны)
  const used = new Set(others.flatMap((f) => f.polygons.flatMap((p) => [...(p.outerIds ?? []), ...(p.innerIds ?? []).flat()])));
  let pts = ring;
  for (let changed = true; changed && pts.length > 3;) {
    changed = false;
    for (let i = 0; i < pts.length; i++) {
      const a = overpassLayer.focusToLocal(pts[(i + pts.length - 1) % pts.length].p)!, b = overpassLayer.focusToLocal(pts[i].p)!, c = overpassLayer.focusToLocal(pts[(i + 1) % pts.length].p)!;
      const cross = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
      if (cross / (Math.hypot(c[0] - a[0], c[1] - a[1]) || 1) < 0.01 && !used.has(pts[i].id)) { pts = pts.filter((_, j) => j !== i); changed = true; break; }
    }
  }
  const tags = { ...keep.tags };
  let conflicts = 0;
  for (const f of rest) for (const [k, v] of Object.entries(f.tags)) {
    if (tags[k] === undefined) tags[k] = v;
    else if (tags[k] !== v) conflicts++;
  }
  for (const f of fs) trackIndoor(indoorKey(f.key), f);
  const edits: ObjectEdit[] = [
    { key: keepKey, tags, polygons: [{ outer: pts.map((q) => q.p), outerIds: pts.map((q) => q.id), inners: [], innerIds: [] }] },
    ...rest.map((f) => ({ key: indoorKey(f.key), delete: true })),
  ];
  selectIndoor(undefined);
  session.editMany(edits);
  for (const f of rest) indoorCreated.delete(indoorKey(f.key));
  const made = indoorCreated.get(keepKey);
  if (made) indoorCreated.set(keepKey, { ...made, tags, polygons: edits[0].polygons! });
  indoorEditRev++;
  renderLevels();
  const f = buildingIndoorFor(keepKey);
  if (f) selectIndoor(f);
  setStatus(tr('Объединено в {key}: объектов {n}.', { key: keepKey, n: fs.length })
    + (conflicts ? ' ' + tr('Разные значения тегов ({k}) — оставлены у {key}.', { k: conflicts, key: keepKey }) : ''));
  return;
}

/** Удаление стены и материализация остальных сторон помещений — один шаг истории. */
async function deleteIndoorWalls() {
  if (deletingIndoorWalls || uploading || !focus || !shownLevel) return;
  const walls = indoorSelection.filter((f) => f.kind === 'wall');
  const roomSides = [...selectedRoomWalls];
  if (!walls.length && !roomSides.length) return;
  if (indoorSelection.some((f) => f.kind !== 'wall')) return setStatus(tr('Для удаления выберите только стены.'), true);
  if ([...walls.map((f) => f.key), ...roomSides.map((w) => w.key)].some((k) => !k.startsWith('way/'))) {
    return setStatus(tr('Стены, заданные отношениями, пока удалить нельзя.'), true);
  }
  const api = server().api, group = focus.key, level = currentLevel, revision = indoorEditRev;
  const editsStamp = JSON.stringify(session.changes());
  const selectionStamp = () => JSON.stringify([indoorSelection.map((f) => f.key), selectedRoomWalls]);
  const stamp = selectionStamp();
  const indoor = buildingIndoor(focus);
  const targets: { span: WallSpan; levels: number[] }[] = [];
  for (const w of roomSides) {
    const f = indoor.find((f) => f.key === w.key)!;
    targets.push({ span: roomWallSpan(f.polygons, w), levels: f.levels });
  }
  for (const f of walls) for (const p of f.polygons) for (const r of f.line ? [p.outer] : [p.outer, ...p.inners]) {
    const n = f.line ? r.length - 1 : r.length;
    for (let i = 0; i < n; i++) targets.push({ span: [r[i], r[(i + 1) % r.length]], levels: f.levels });
  }
  const spansFor = (f: IndoorFeature) => targets.filter((t) => t.levels.some((l) => f.levels.includes(l))).map((t) => t.span);
  const rooms = indoor.filter((f) => f.kind === 'room' && floorLevels(f).some((l) => targets.some((t) => t.levels.includes(l))) && roomTouchesWall(f.polygons, spansFor(f)));
  if (rooms.some((f) => !f.key.startsWith('way/'))) return setStatus(tr('Общая стена принадлежит помещению-отношению. Такое удаление пока не поддерживается.'), true);
  deletingIndoorWalls = true;
  setStatus(tr('Проверка стен и отношений…'));
  try {
    const existing = [...new Set([...walls, ...rooms].map((f) => f.key))].filter((k) => Number(k.split('/')[1]) > 0);
    const [elements, parents] = await Promise.all([
      fetchElements(existing, api),
      Promise.all(walls.map(async (f) => ({ key: f.key, relations: Number(f.key.split('/')[1]) > 0 ? await fetchWayRelations(Number(f.key.split('/')[1]), api) : [] }))),
    ]);
    const nodeIds = [...rooms, ...walls].flatMap((f) => {
      const way = elements.get(f.key);
      return way?.type === 'way' ? way.nodes : [];
    });
    const nodes = nodeIds.length ? await fetchNodes([...new Set(nodeIds)], api) : new Map<number, OsmNode>();
    // Асинхронная проверка не должна удалять уже другой выбор или объекты другого сервера.
    if (focus?.key !== group || currentLevel !== level || server().api !== api || indoorEditRev !== revision || selectionStamp() !== stamp || JSON.stringify(session.changes()) !== editsStamp) {
      setStatus(tr('Выбор или данные изменились. Повторите удаление стен.'));
      return;
    }
    const edits: ObjectEdit[] = [];
    const nodeKeys = new Map<string, number>();
    const coordKey = (p: LonLat) => `${p[0].toFixed(9)},${p[1].toFixed(9)}`;
    for (const f of [...rooms, ...walls]) {
      if (f.polygons.length !== 1 || f.polygons[0].inners.length) throw new Error(tr('Для преобразования требуется помещение-way с одним внешним контуром.'));
      const ring = f.polygons[0].outer, way = elements.get(f.key);
      if (Number(f.key.split('/')[1]) > 0 && way?.type !== 'way') throw new Error(tr('Геометрия помещения изменилась или недоступна. Перезагрузите данные.'));
      const ids = way?.type === 'way' ? f.line ? way.nodes : way.nodes.slice(0, -1) : f.polygons[0].outerIds;
      if (!ids || ids.length !== ring.length) throw new Error(tr('Геометрия помещения изменилась или недоступна. Перезагрузите данные.'));
      ids.forEach((id, i) => {
        const node = nodes.get(id);
        if (way && (!node || Math.abs(node.lon - ring[i][0]) > 1e-8 || Math.abs(node.lat - ring[i][1]) > 1e-8)) {
          throw new Error(tr('Геометрия помещения изменилась или недоступна. Перезагрузите данные.'));
        }
        nodeKeys.set(coordKey(ring[i]), id);
      });
    }
    const nodeAt = (p: LonLat) => {
      const k = coordKey(p);
      if (!nodeKeys.has(k)) nodeKeys.set(k, nextNewId--);
      return nodeKeys.get(k)!;
    };
    const created: IndoorFeature[] = [];
    const createWall = (line: { ids: number[]; coords: LonLat[] }, tags: Record<string, string>) => {
      const key = `way/${nextNewId--}`, polygons = [{ outer: line.coords, outerIds: line.ids, inners: [] }];
      edits.push({ key, create: { key, version: 0, tags, line, polygons } });
      created.push({ key, kind: 'wall', line: true, polygons, tags, levels: [...new Set([...parseLevels(tags.level), ...parseLevels(tags.repeat_on)])] });
    };
    for (const f of walls) {
      const el = elements.get(f.key);
      if (Number(f.key.split('/')[1]) > 0 && !el) throw new Error(tr('Стена больше не доступна на сервере. Перезагрузите данные.'));
      trackIndoor(f.key, f);
      const referenced = parents.find((p) => p.key === f.key)!.relations.some((r) => {
        const key = `relation/${r.id}`;
        if (session.isDeleted(key)) return false;
        const members = session.get(key)?.relMembers ?? r.members;
        return members.some((m) => m.type === 'way' && m.ref === Number(f.key.split('/')[1]));
      }) || [...editGroups.values(), ...session.createdAlive()].some((r) => r.relMembers?.some((m) => m.type === 'way' && m.ref === Number(f.key.split('/')[1])));
      if (referenced) {
        const tags = { ...session.get(f.key)!.tags };
        delete tags.indoor;
        delete tags.level;
        edits.push({ key: f.key, tags });
      } else edits.push({ key: f.key, delete: true });
    }
    for (const f of rooms) {
      trackIndoor(f.key, f);
      edits.push({ key: f.key, tags: { ...session.get(f.key)!.tags, indoor: 'area' } });
      for (const { line, tags } of materializeRoomWalls(f.polygons, f.tags, f.levels, targets, nodeAt)) createWall(line, tags);
    }
    for (const f of created) { indoorCreated.set(f.key, f); indoorEdited.add(f.key); }
    selectIndoor(undefined);
    clearInfo();
    session.editMany(edits);
    setStatus(tr('Стены удалены. Отменить — Ctrl+Z.'));
  } catch (err) {
    setStatus(tr('Не удалось удалить стены: {error}', { error: (err as Error).message }), true);
  } finally {
    deletingIndoorWalls = false;
  }
}

/**
 * Записать теги indoor-объектов в сессию правок одним шагом истории (объект начинает отслеживаться при первой
 * правке). Пустое значение — тег удалить.
 */
function setIndoorTags(edits: { key: string; tags: Record<string, string> }[], changedTag?: string) {
  const all = focus ? buildingIndoor(focus) : shownIndoor;
  edits = syncEscalatorLevels(edits, all, changedTag === 'level');
  const out: { key: string; tags: Record<string, string> }[] = [];
  // Снят indoor у помещения и, кроме этажа, тегов нет — «Очистить»: полигон удаляется, общие узлы остаются
  const empty = edits.map((e) => all.find((x) => indoorKey(x.key) === e.key) ?? indoorSelection.find((x) => indoorKey(x.key) === e.key))
    .filter((f, i): f is IndoorFeature => !!f && isDeletableSpace(f) && changedTag === 'indoor'
      && Object.entries(edits[i].tags).every(([k, v]) => !v?.trim() || k === 'level' || k === 'repeat_on'));
  if (empty.length) {
    void deleteIndoorSpaces(empty);
    edits = edits.filter((e) => !empty.some((f) => indoorKey(f.key) === e.key));
  }
  for (const e of edits) {
    const f = all.find((x) => indoorKey(x.key) === e.key) ?? indoorSelection.find((x) => indoorKey(x.key) === e.key);
    trackIndoor(e.key, f);
    const tags: Record<string, string> = {};
    for (const [k, v] of Object.entries(e.tags)) if (v?.trim()) tags[k] = v.trim();
    out.push({ key: e.key, tags });
  }
  session.editMany(out.filter((e) => { const cur = session.get(e.key)?.tags ?? {}; return JSON.stringify(Object.entries(cur).sort()) !== JSON.stringify(Object.entries(e.tags).sort()); }));
}

/** Мост, тоннель или подход к ним: теги пути в панели свойств (только просмотр). */
/** Выделенные мосты, тоннели и подходы (Shift+клик добавляет и убирает). */
let roadSelection: RoadWay[] = [];
function clearTreeSelection() { overpassLayer.setTreeSelection(undefined); }

/** Отдельное дерево: теги доступны для просмотра, синее кольцо отмечает выбранный узел. */
function selectTree(tree: TreePoint) {
  if (!tree.key) return;
  select(undefined);
  clearTileHighlight();
  overpassLayer.setTreeSelection(tree.key);
  infoEl.innerHTML = `<h2>${tr('Дерево')} — <a href="${server().web}/${tree.key}" target="_blank" rel="noopener">${esc(tree.key)}</a></h2>`
    + `<p class="hint">${tr('только просмотр')}</p><details class="all-tags" open><summary>${tr('Все теги')}</summary>${tagTable(tree.tags ?? {})}</details>`;
}

/** Мост, тоннель или подход: теги пути в панели свойств (только просмотр). add — Shift: добавить к выделению или убрать. */
function selectRoad(w: RoadWay, add = false) {
  const keep = add ? roadSelection : [];
  select(undefined); // сбрасывает и выделение дорог
  clearTileHighlight();
  roadSelection = keep.some((r) => r.id === w.id) ? keep.filter((r) => r.id !== w.id) : [...keep, w];
  roadsLayer.select(roadSelection.map((r) => r.id));
  if (!roadSelection.length) { infoEl.innerHTML = ''; return; }
  if (roadSelection.length === 1) {
    const kind = isBridge(w.tags) ? tr('Мост') : isTunnel(w.tags) ? tr('Тоннель') : tr('Подход');
    infoEl.innerHTML = `<h2>${esc(kind)}${w.tags.name ? ' ' + tr('«{name}»', { name: esc(w.tags.name) }) : w.tags.ref ? ` ${esc(w.tags.ref)}` : ''} — `
      + `<a href="${server().web}/way/${w.id}" target="_blank" rel="noopener">way/${w.id}</a></h2>`
      + `<p class="hint">${tr('layer {layer} · только просмотр', { layer: roadLevel(w.tags) })}</p>`
      + `<details class="all-tags" open><summary>${tr('Все теги')}</summary>${tagTable(w.tags)}</details>`;
    return;
  }
  // Несколько: общие значения как есть, у остальных тегов — серое «разные значения»
  const keys = [...new Set(roadSelection.flatMap((r) => Object.keys(r.tags)))].sort((a, b) => a.localeCompare(b));
  const rows = keys.map((k) => {
    // Нет тега у части путей — тоже «разные»
    const values = new Set(roadSelection.map((r) => r.tags[k] as string | undefined));
    const only = values.size === 1 ? [...values][0] : undefined;
    const v = only !== undefined ? esc(only) : `<span class="hint">${tr('разные значения')}</span>`;
    return `<tr><td>${esc(k)}</td><td>${v}</td></tr>`;
  });
  infoEl.innerHTML = `<h2>${tr('Выбрано путей: {n}', { n: roadSelection.length })}</h2>`
    + `<p class="hint">${roadSelection.map((r) => `<a href="${server().web}/way/${r.id}" target="_blank" rel="noopener">way/${r.id}</a>`).join(', ')} · ${tr('только просмотр')}</p>`
    + `<details class="all-tags" open><summary>${tr('Все теги')}</summary><table>${rows.join('')}</table></details>`;
}

/** Номер надземного этажа для людей: в русской традиции первый этаж — level=0, в английской — этажи с нуля. */
const humanFloor = (n: number) => (lang === 'ru' ? n + 1 : n);
/** Название этажа: у подземных сохраняем номер level, надземные нумеруем по локали. */
const LEVEL_NAME = (n: number) => tr('{n} этаж', { n: n < 0 ? n : humanFloor(n) });
/** Подпись этажа: по level:ref, если он есть у indoor=level этажа здания режима («Этаж E0»), иначе по номеру. */
const levelLabel = (n: number) => (panelLevelRefs.has(n) ? tr('Этаж {ref}', { ref: panelLevelRefs.get(n)! }) : LEVEL_NAME(n));

/**
 * Свойства выбранного этажа (панель свойств, когда ничего не выделено): высота этажа — height на его indoor=level
 * (по вики — высота самого этажа; отметка пола — сумма высот ниже). Нет indoor=level — высота расчётная.
 */
function describeLevel(l: Level): string {
  const h = +(l.ceil - l.floor).toFixed(2);
  const title = `<h2>${l.ref ? esc(tr('Этаж {ref}', { ref: l.ref })) : LEVEL_NAME(l.n)}${l.name ? ' ' + tr('«{name}»', { name: esc(l.name) }) : ''}</h2>`
    + `<p class="hint">level=${l.n} · ${tr('пол {floor} м, потолок {ceil} м', { floor: +l.floor.toFixed(2), ceil: +l.ceil.toFixed(2) })}</p>`;
  const fs = levelFeatures(l);
  // Этажа отдельным объектом нет — те же поля; первая правка создаёт indoor=level по контуру (levelFromOutline)
  if (!fs.length) return title + indoorForm([newLevelStub(l.n)], { height: String(h) })
    + `<p class="hint">${tr('Высота этажа {h} м — расчётная (по этажности). Правка любого поля создаст indoor=level этажа по контуру здания (вершины на контуре — общие с ним).', { h })}</p>`;
  const ignored = l.heightTag !== undefined && !l.explicit
    ? `<p class="warn">${esc(tr('height={v} не учтена: вне {min}–{max} м', { v: l.heightTag, min: MIN_LEVEL_STEP, max: MAX_LEVEL_STEP }))}</p>`
    : l.overflow ? `<p class="warn">${esc(tr('Высоты этажей не умещаются в высоту части по этажности ({src}): этажи выходят выше её стен.', { src: l.src ?? '—' }))}</p>` : '';
  const objs = fs.map((f) => `<a href="#" data-select-indoor="${esc(indoorKey(f.key))}">${esc(indoorKey(f.key))}</a>`).join(', ');
  return title + indoorForm(fs, { height: String(h) }) + ignored
    + `<p class="hint">${tr('Теги {objs}: height — высота этажа (пусто — по этажности; пол этажей выше сдвинется).', { objs })}</p>`;
}

/** Узел контура здания ближе этого (градусы, ~1 см) к вершине сечения — общий: вершина встаёт на него. */
const OUTLINE_NODE_SNAP = 1e-7;

/** Контур здания на этаже: сечение оболочки на отметке пола; пусто (низ части выше расчётного пола) — в середине этажа. */
function levelSection(l: Level): LonLat[][][] | undefined {
  return [l.floor + 0.1, (l.floor + l.ceil) / 2].map((h) => overpassLayer.focusSection(h)).find((x) => !x || x.length);
}

/**
 * Узлы объектов (контура, частей, помещений) для новых контуров: вершина ближе OUTLINE_NODE_SNAP к узлу — этот
 * узел (общий: двигается вместе с соседом), иначе новый. used — сколько раз взят каждый общий узел.
 */
function sharedNodes(features: { polygons: Polygon[] }[]) {
  const nodes: { p: LonLat; id: number }[] = [];
  for (const f of features) for (const poly of f.polygons) {
    [poly.outer, ...poly.inners].forEach((ring, r) => {
      const ids = r === 0 ? poly.outerIds : poly.innerIds?.[r - 1];
      ring.forEach((p, i) => { if (ids?.[i] !== undefined) nodes.push({ p, id: ids[i] }); });
    });
  }
  const used = new Map<number, number>();
  const nodeFor = (p: LonLat): { p: LonLat; id: number } => {
    let best: { p: LonLat; id: number } | undefined, bd = OUTLINE_NODE_SNAP;
    for (const q of nodes) { const d = Math.max(Math.abs(q.p[0] - p[0]), Math.abs(q.p[1] - p[1])); if (d <= bd) { best = q; bd = d; } }
    if (best) { used.set(best.id, (used.get(best.id) ?? 0) + 1); return best; }
    // Новый узел — тоже кандидат: соседние кольца этого же шага (куски разреза) встают на него
    const made = { p, id: nextNewId-- };
    nodes.push(made);
    return made;
  };
  return { nodeFor, used };
}

/** Кольцо из узлов: подряд одинаковые и замыкающий — прочь; меньше трёх — нет кольца. */
function nodeRing(ring: LonLat[], nodeFor: (p: LonLat) => { p: LonLat; id: number }): { p: LonLat; id: number }[] | undefined {
  const out = ring.map(nodeFor).filter((q, i, a) => i === 0 || q.id !== a[i - 1].id);
  if (out.length > 1 && out[0].id === out.at(-1)!.id) out.pop();
  return out.length >= 3 ? out : undefined;
}

/** Выбранный кусок неразмеченной площади этажа: n — этаж, polygon — lon/lat (кольца без замыкающей точки). */
let freeArea: { n: number; polygon: Polygon } | undefined;

/**
 * Неразмеченная площадь этажа под курсором: контур здания на этаже минус помещения, коридоры и площадки этажа;
 * связный кусок, где курсор. В OSM пустота ничем не размечена — объект появится при первой правке.
 */
function freeAreaAt(point: [number, number]): { n: number; polygon: Polygon } | undefined {
  if (!shownLevel) return;
  const ray = overpassLayer.focusRay(point);
  const hit = ray?.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -shownLevel.floor), new THREE.Vector3());
  const ll = hit && overpassLayer.focusToLngLat(hit.x, hit.y);
  const section = ll && levelSection(shownLevel);
  if (!ll || !section?.length) return;
  const close = (r: LonLat[]) => [...r, r[0]] as [number, number][];
  const rooms = shownIndoor.filter((f) => isFloorKind(f) && !f.escalatorArea)
    .map((f) => f.polygons.map((p) => [close(p.outer), ...p.inners.map(close)]));
  let pieces: [number, number][][][];
  try { pieces = polygonClipping.difference(section.map((p) => p.map(close)), ...rooms); } catch (err) { console.warn('[free-area]', err); return; }
  const piece = pieces.map((p) => ({ outer: p[0].slice(0, -1) as LonLat[], inners: p.slice(1).map((r) => r.slice(0, -1) as LonLat[]) }))
    .find((p) => pointInRing(ll, p.outer) && !p.inners.some((r) => pointInRing(ll, r)));
  return piece && { n: shownLevel.n, polygon: piece };
}

function selectFreeArea(a: { n: number; polygon: Polygon }) {
  select(undefined);
  selectIndoor(undefined);
  freeArea = a;
  overpassLayer.setFreeArea({ key: 'free-area', kind: 'area', polygons: [a.polygon], z: shownLevel?.floor ?? 0 });
  renderFreeArea(a);
}

function renderFreeArea(a: { n: number; polygon: Polygon }) {
  const stub: IndoorFeature = { key: 'free-area/0', kind: 'area', tags: { level: String(a.n) }, polygons: [a.polygon], levels: [a.n] };
  infoEl.innerHTML = `<h2>${tr('Неразмеченная площадь')}</h2>`
    + `<p class="hint">${tr('{s} м² · {level}', { s: Math.round(polyArea(a.polygon)), level: levelLabel(a.n) })}</p>`
    + indoorForm([stub], { indoor: 'area' })
    + `<p class="hint">${tr('В OSM пустота ничем не размечена: правка любого поля создаст объект (по умолчанию indoor=area) с этими тегами.')}</p>`;
  for (const input of infoEl.querySelectorAll<HTMLInputElement>('[data-indoor-tag]')) {
    input.addEventListener('change', () => { if (input.value.trim()) createFromFreeArea({ [input.dataset.indoorTag!]: input.value.trim() }); });
  }
}

/** Пустая площадь → indoor-объект (по умолчанию indoor=area) этажа; вершины на соседях — их узлы. Выделяется. */
function createFromFreeArea(extra: Record<string, string>) {
  const a = freeArea;
  if (!a || !focus) return;
  const { nodeFor } = sharedNodes([...groupFeatures(focus), ...shownIndoor.filter((f) => !f.point)]);
  const edits: ObjectEdit[] = [];
  const made = indoorCreateEdits(a.polygon, { indoor: 'area', level: String(a.n), ...extra }, nodeFor, edits);
  if (!made) return;
  session.editMany(edits);
  indoorCreated.set(made.key, made);
  indoorEdited.add(made.key);
  // indoorCreated заполняется после editMany: перерисовать план с новым объектом
  indoorEditRev++;
  renderLevels();
  const f = buildingIndoorFor(made.key);
  if (f) selectIndoor(f);
}

/**
 * Новый indoor-объект по полигону (lon/lat) с тегами: путь, а с дырами — мультиполигон с безтеговыми путями-членами.
 * Узлы — через nodeFor (общие с соседями). Правки — в edits; результат — заготовка для indoorCreated.
 */
function indoorCreateEdits(poly: Polygon, tags: Record<string, string>, nodeFor: (p: LonLat) => { p: LonLat; id: number }, edits: ObjectEdit[]): IndoorFeature | undefined {
  const outer = nodeRing(poly.outer, nodeFor);
  if (!outer) return;
  const inners = poly.inners.map((r) => nodeRing(r, nodeFor)).filter((r): r is NonNullable<typeof r> => !!r);
  tags = { ...tags };
  const kind = (['room', 'corridor', 'area', 'level', 'wall', 'column'].includes(tags.indoor) ? tags.indoor : 'area') as IndoorKind;
  const polygons = [{ outer: outer.map((q) => q.p), outerIds: outer.map((q) => q.id), inners: inners.map((r) => r.map((q) => q.p)), innerIds: inners.map((r) => r.map((q) => q.id)) }];
  let key: string;
  if (!inners.length) {
    key = `way/${nextNewId--}`;
    edits.push({ key, create: { key, version: 0, tags, polygons } });
  } else {
    // Дыры (лестница, лифт, помещения внутри) — мультиполигон: внешний путь и пути дыр без тегов
    const relId = nextNewId--;
    key = `relation/${relId}`;
    const ways: MemberWay[] = [];
    for (const [r, role] of [[outer, 'outer'] as const, ...inners.map((x) => [x, 'inner'] as const)]) {
      const id = nextNewId--;
      const line = { ids: [...r.map((q) => q.id), r[0].id], coords: [...r.map((q) => q.p), r[0].p] };
      edits.push({ key: `way/${id}`, create: { key: `way/${id}`, version: 0, tags: {}, line } });
      ways.push({ id, role, nodes: line.ids });
    }
    tags.type = 'multipolygon';
    edits.push({ key, create: { key, type: 'relation', id: relId, version: 0, tags, polygons, ways,
      relMembers: ways.map((w) => ({ type: 'way' as const, ref: w.id, role: w.role })) } as unknown as Feature3D });
  }
  return { key, kind, polygons, tags, levels: parseLevels(tags.level) };
}

/** Кусок меньше этого, м², — не кусок (касание разрезом угла, погрешность). */
const CUT_MIN_AREA = 0.05;
/** Насколько глубоко нарисованная линия должна зайти в объект, чтобы его резать, м. */
const CUT_REACH = 0.5;

/**
 * «Рассечь» на плане этажа: ломаная pts (метры сцены, концы — за стенами) делит помещения, коридоры, площадки
 * и пустую площадь, которые пересекает. Помещение-путь сохраняет историю на большем куске, остальные куски —
 * новые объекты с теми же тегами; пустая площадь — новые indoor=area этажа. Новые узлы на линии разреза общие
 * у кусков и вставляются в стороны indoor-соседей (помещений, этажа); пути здания не трогаем — правка контура
 * здания без отношения собрала бы отношение и сменила здание режима. Строка — почему нельзя.
 */
function cutPlan(pts: [number, number][]): string | undefined {
  if (!focus || !shownLevel) return tr('Рассекать план можно на этаже здания.');
  const level = shownLevel;
  const unit = (a: [number, number], b: [number, number]): [number, number] => { const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; return [dx / l, dy / l]; };
  // Полуплоскость слева от продлённой ломаной: концы уходят далеко за здание, «левый» край замыкает её
  const FAR = 1e4;
  const d0 = unit(pts[1], pts[0]), d1 = unit(pts[pts.length - 2], pts[pts.length - 1]);
  const s0: [number, number] = [pts[0][0] + d0[0] * FAR, pts[0][1] + d0[1] * FAR];
  const s1: [number, number] = [pts[pts.length - 1][0] + d1[0] * FAR, pts[pts.length - 1][1] + d1[1] * FAR];
  const c = unit(s0, s1), nl: [number, number] = [-c[1] * FAR, c[0] * FAR];
  const side = [[s0, ...pts, s1, [s1[0] + nl[0], s1[1] + nl[1]], [s0[0] + nl[0], s0[1] + nl[1]], s0]] as [number, number][][];
  const toLocal = (r: LonLat[]) => { const q = r.map((x) => overpassLayer.focusToLocal(x)!); return [...q, q[0]] as [number, number][]; };
  const toPoly = (p: [number, number][][]): Polygon => ({ outer: p[0].slice(0, -1).map((q) => overpassLayer.focusToLngLat(q[0], q[1])! as LonLat),
    inners: p.slice(1).map((r) => r.slice(0, -1).map((q) => overpassLayer.focusToLngLat(q[0], q[1])! as LonLat)), });
  const localArea = (p: [number, number][][]) => ringArea(p[0].slice(0, -1)) - p.slice(1).reduce((a, r) => a + ringArea(r.slice(0, -1)), 0);
  /** Куски полигона по разрезу; меньше двух — разрез его не делит. */
  // Точки нарисованной линии через 0,1 м: продление за концами нужно лишь чтобы выйти за стену
  const samples: [number, number][] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [a, b] = [pts[i], pts[i + 1]];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.1));
    for (let k = 0; k <= n; k++) samples.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]);
  }
  /** Нарисованная линия заходит в полигон глубже CUT_REACH от его сторон (соседа на продолжении или заступ за стену не режем). */
  const entered = (local: [number, number][][]) => samples.some((q) => pointInRing(q, local[0]) && !local.slice(1).some((r) => pointInRing(q, r))
    && local.every((r) => r.every((a, i) => i === r.length - 1 || segDist2(q, a, r[i + 1]) > CUT_REACH)));
  const cut = (p: Polygon): [number, number][][][] => {
    const local = [toLocal(p.outer), ...p.inners.map(toLocal)];
    if (!entered(local)) return [];
    try {
      return [...polygonClipping.intersection(local, side), ...polygonClipping.difference(local, side)].filter((q) => localArea(q) >= CUT_MIN_AREA);
    } catch (err) { console.warn('[cut-plan]', err); return []; }
  };
  const rooms = shownIndoor.filter((f) => isFloorKind(f) && !f.escalatorArea && f.polygons.length);
  const targets: { f: IndoorFeature; pieces: [number, number][][][] }[] = [];
  const skipped: string[] = [];
  for (const f of rooms) {
    if (f.polygons.length !== 1) continue;
    const pieces = cut(f.polygons[0]);
    if (pieces.length < 2) continue;
    if (!f.key.startsWith('way/') || !f.polygons[0].outerIds) { skipped.push(indoorKey(f.key)); continue; }
    targets.push({ f, pieces });
  }
  // Пустая площадь: срез этажа минус помещения
  const free: [number, number][][][] = [];
  const section = levelSection(level);
  if (section?.length) {
    const close = (r: LonLat[]) => [...r, r[0]] as [number, number][];
    try {
      const holes = rooms.map((f) => f.polygons.map((p) => [close(p.outer), ...p.inners.map(close)]));
      for (const q of polygonClipping.difference(section.map((p) => p.map(close)), ...holes)) {
        const pieces = cut({ outer: q[0].slice(0, -1) as LonLat[], inners: q.slice(1).map((r) => r.slice(0, -1) as LonLat[]) });
        if (pieces.length >= 2) free.push(...pieces);
      }
    } catch (err) { console.warn('[cut-plan]', err); }
  }
  if (!targets.length && !free.length) {
    return skipped.length
      ? tr('Мультиполигон {keys} пока рассекать нельзя.', { keys: skipped.join(', ') })
      : tr('Разрез ничего не делит: проведите его через помещение или пустую площадь от стены до стены.');
  }
  // Узлы: существующие вершины — их id, новые на линии разреза — общие у кусков
  const neighbours = [...groupFeatures(focus), ...shownIndoor.filter((f) => !f.point && !f.line)];
  const { nodeFor } = sharedNodes(neighbours);
  const edits: ObjectEdit[] = [];
  const created: IndoorFeature[] = [];
  const rebuilt = new Map<string, Polygon>();
  for (const { f, pieces } of targets) {
    const key = indoorKey(f.key);
    const polys = pieces.map(toPoly).sort((a, b) => polyArea(b) - polyArea(a));
    const [keep, ...rest] = polys;
    const ring = nodeRing(keep.outer, nodeFor);
    if (!ring) continue;
    trackIndoor(key, f);
    const poly: Polygon = { outer: ring.map((q) => q.p), outerIds: ring.map((q) => q.id), inners: [], innerIds: [] };
    rebuilt.set(key, poly);
    edits.push({ key, polygons: [poly] });
    for (const p of rest) { const m = indoorCreateEdits(p, f.tags, nodeFor, edits); if (m) created.push(m); }
  }
  for (const p of free) { const m = indoorCreateEdits(toPoly(p), { indoor: 'area', level: String(level.n) }, nodeFor, edits); if (m) created.push(m); }
  // Новые узлы на сторонах соседей (и самих разрезанных — в куски без них): вставить в эти стороны
  const fresh = new Map<number, LonLat>();
  for (const e of edits) for (const p of e.polygons ?? (e.create as Feature3D | undefined)?.polygons ?? []) {
    [p.outer, ...p.inners].forEach((r, i) => r.forEach((q, j) => { const id = (i ? p.innerIds?.[i - 1] : p.outerIds)?.[j]; if (id !== undefined && id < 0) fresh.set(id, q); }));
  }
  const ON_EDGE = 0.02;
  const withInserts = (ids: number[], ring: LonLat[]): { ids: number[]; ring: LonLat[] } | undefined => {
    const loc = ring.map((q) => overpassLayer.focusToLocal(q)!);
    const outIds: number[] = [], outRing: LonLat[] = [];
    let changed = false;
    for (let i = 0; i < ids.length; i++) {
      outIds.push(ids[i]); outRing.push(ring[i]);
      const a = loc[i], b = loc[(i + 1) % loc.length];
      const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1;
      const on: { id: number; p: LonLat; t: number }[] = [];
      for (const [id, p] of fresh) {
        if (ids.includes(id)) continue;
        const q = overpassLayer.focusToLocal(p)!;
        const t = ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / l2;
        if (t <= 1e-6 || t >= 1 - 1e-6 || segDist2(q, a, b) > ON_EDGE) continue;
        on.push({ id, p, t });
      }
      on.sort((x, y) => x.t - y.t).forEach((x) => { outIds.push(x.id); outRing.push(x.p); changed = true; });
    }
    return changed ? { ids: outIds, ring: outRing } : undefined;
  };
  const patch = (p: Polygon): Polygon | undefined => {
    if (!p.outerIds) return;
    const o = withInserts(p.outerIds, p.outer);
    const ins = p.inners.map((r, i) => (p.innerIds?.[i] ? withInserts(p.innerIds[i], r) : undefined));
    if (!o && !ins.some(Boolean)) return;
    return { outer: o?.ring ?? p.outer, outerIds: o?.ids ?? p.outerIds, inners: p.inners.map((r, i) => ins[i]?.ring ?? r), innerIds: p.innerIds?.map((r, i) => ins[i]?.ids ?? r) };
  };
  // Собственные куски: узел разреза соседнего помещения мог лечь на их сторону
  for (const e of edits) {
    if (e.polygons) e.polygons = e.polygons.map((p) => patch(p) ?? p);
    const c = e.create as Feature3D | undefined;
    if (c?.polygons && e.key.startsWith('way/')) c.polygons = c.polygons.map((p) => patch(p) ?? p);
  }
  for (const m of created) if (m.key.startsWith('way/')) m.polygons = (edits.find((e) => e.key === m.key)?.create as Feature3D).polygons!;
  let touched = 0;
  // Соседние indoor-пути (помещения, этаж) — их кольца с новыми узлами
  for (const f of shownIndoor) {
    const key = indoorKey(f.key);
    if (f.point || f.line || rebuilt.has(key) || !key.startsWith('way/') || f.polygons.length !== 1) continue;
    const p = patch(f.polygons[0]);
    if (!p) continue;
    trackIndoor(key, f);
    edits.push({ key, polygons: [p] });
    touched++;
  }
  session.editMany(edits);
  for (const m of created) { indoorCreated.set(m.key, m); indoorEdited.add(m.key); }
  indoorEditRev++;
  renderLevels();
  const pieces = targets.reduce((n, t) => n + t.pieces.length, 0) + free.length;
  setStatus(tr('Рассечено: кусков {n}, новых объектов {created}, узлы добавлены в соседей: {touched}.', { n: pieces, created: created.length, touched })
    + (skipped.length ? ' ' + tr('Мультиполигон {keys} пока рассекать нельзя.', { keys: skipped.join(', ') }) : ''));
  const sel = [...[...rebuilt.keys()].map((k) => buildingIndoorFor(k)), ...created.map((m) => buildingIndoorFor(m.key))].filter((f): f is IndoorFeature => !!f);
  sel.forEach((f, i) => selectIndoor(f, i > 0));
  return;
}

/** Инструмент «Точка» (X) на плане этажа: включён ли. */
let pointPick = false;
const pointBtn = focusToolbar.querySelector<HTMLButtonElement>('[data-tool="point"]')!;
pointBtn.addEventListener('click', () => (pointPick ? stopPoint() : startPoint()));
/** Точка ближе стольких px к стороне — на стороне (дверь, вход). */
const POINT_SIDE_PX = 8;

function startPoint() {
  if (!focus) return;
  if (!shownLevel) { setStatus(tr('Точки ставятся на плане этажа — выберите этаж в панели «Этажи».'), true); return; }
  moveTool.stop(); shapeTool.stop(); pushTool.stop(); splitTool.stop(); drawTool.stop();
  measureTool.stop(); rotateTool.stop(); scaleTool.stop(); paintTool.stop(); offsetTool.stop();
  pointPick = true;
  pointBtn.classList.add('active');
  document.querySelector('.indoor-pois')?.classList.add('passthrough');
  syncCursor();
  toolHint(tr('Точка: щелчок на стене помещения — дверь, на наружной стене — вход, внутри — объект этажа. Esc — выйти.'));
}

function stopPoint() {
  if (!pointPick) return;
  pointPick = false;
  pointBtn.classList.remove('active');
  document.querySelector('.indoor-pois')?.classList.remove('passthrough');
  overpassLayer.setDrawPreview(undefined);
  syncCursor();
  toolHint('');
}

/** Куда встанет точка: место, вид и стороны (indoor-пути и пути здания), в которые войдёт узел. */
interface PointTarget {
  at: LonLat; local: [number, number]; kind: 'door' | 'entrance' | 'poi';
  /** Готовая вершина в этом месте (узел есть — ставим теги на него). */
  node?: number;
  indoor: { f: IndoorFeature; ring: number; edge: number }[];
  building: { u: number; v: number; cu: LonLat; cv: LonLat }[];
}

function pointTarget(screen: [number, number]): PointTarget | undefined {
  if (!focus || !shownLevel) return;
  const z = shownLevel.floor;
  const ray = overpassLayer.focusRay(screen);
  const hit = ray?.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -z), new THREE.Vector3());
  if (!hit) return;
  const p: [number, number] = [hit.x, hit.y];
  type Ring = { f: IndoorFeature | Feature3D; indoor: boolean; ring: number; ids: number[]; coords: LonLat[]; loc: [number, number][] };
  const rings: Ring[] = [];
  const add = (f: IndoorFeature | Feature3D, indoor: boolean) => f.polygons.forEach((poly, pi) => {
    if (pi > 0 && indoor) return;
    [[poly.outer, poly.outerIds] as const, ...poly.inners.map((r, j) => [r, poly.innerIds?.[j]] as const)].forEach(([coords, ids], ring) => {
      if (ids && ids.length === coords.length) rings.push({ f, indoor, ring, ids, coords, loc: coords.map((c) => overpassLayer.focusToLocal(c)!) });
    });
  });
  for (const f of shownIndoor) if (!f.point && !f.line && indoorKey(f.key).startsWith('way/') && f.polygons.length === 1) add(f, true);
  for (const f of groupFeatures(focus)) if (f.key.startsWith('way/')) add(f, false);
  // Ближайшая сторона на экране
  const px = (q: [number, number]) => overpassLayer.focusProject(new THREE.Vector3(q[0], q[1], z));
  // Стороны частей здания — только по фасаду (граница двух частей внутри — не стена этажа)
  const section = levelSection(shownLevel) ?? [];
  const sectionLoc = section.flatMap((poly) => poly.map((ring) => ring.map((c) => overpassLayer.focusToLocal(c)!)));
  const onSection = (q: [number, number]) => sectionLoc.some((loc) => loc.some((c, i) => segDist2(q, c, loc[(i + 1) % loc.length]) < 0.05));
  let best: { r: Ring; edge: number; d: number } | undefined;
  for (const r of rings) for (let i = 0; i < r.loc.length; i++) {
    if (!r.indoor && !(onSection(r.loc[i]) && onSection(r.loc[(i + 1) % r.loc.length]))) continue;
    const a = px(r.loc[i]), b = px(r.loc[(i + 1) % r.loc.length]);
    if (!a || !b) continue;
    const d = segDist2(screen, a, b);
    if (d < POINT_SIDE_PX && (!best || d < best.d)) best = { r, edge: i, d };
  }
  if (!best) return { at: overpassLayer.focusToLngLat(p[0], p[1])! as LonLat, local: p, kind: 'poi', indoor: [], building: [] };
  const a = best.r.loc[best.edge], b = best.r.loc[(best.edge + 1) % best.r.loc.length];
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1;
  let t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  // У самой вершины — сама вершина
  const len = Math.sqrt(l2);
  if (t * len < 0.15) t = 0; else if ((1 - t) * len < 0.15) t = 1;
  const q: [number, number] = [a[0] + dx * t, a[1] + dy * t];
  const node = t === 0 ? best.r.ids[best.edge] : t === 1 ? best.r.ids[(best.edge + 1) % best.r.ids.length] : undefined;
  const at = node !== undefined ? (t === 0 ? best.r.coords[best.edge] : best.r.coords[(best.edge + 1) % best.r.coords.length]) : overpassLayer.focusToLngLat(q[0], q[1])! as LonLat;
  // Все стороны через эту точку (общая стена двух помещений, контур этажа, путь здания)
  const indoor: PointTarget['indoor'] = [], building: PointTarget['building'] = [];
  if (node === undefined) for (const r of rings) for (let i = 0; i < r.loc.length; i++) {
    const j = (i + 1) % r.loc.length;
    if (segDist2(q, r.loc[i], r.loc[j]) > 0.02) continue;
    if (r.indoor) indoor.push({ f: r.f as IndoorFeature, ring: r.ring, edge: i });
    else building.push({ u: r.ids[i], v: r.ids[j], cu: r.coords[i], cv: r.coords[j] });
  }
  // Наружная стена — сторона контура этажа (indoor=level) или контура сечения здания на этаже
  const onLevel = node !== undefined ? best.r.indoor && (best.r.f as IndoorFeature).kind === 'level' : indoor.some((s) => s.f.kind === 'level');
  const outside = onLevel || onSection(q);
  // Не на стене этажа и не на фасаде — точка внутри
  if (!outside && (node !== undefined ? !best.r.indoor : !indoor.length)) return { at: overpassLayer.focusToLngLat(p[0], p[1])! as LonLat, local: p, kind: 'poi', indoor: [], building: [] };
  // Внутри здания вход не ставим в пути частей (общая стена двух частей — не фасад)
  return { at, local: q, kind: outside ? 'entrance' : 'door', node, indoor, building: outside ? building : [] };
}

function hoverPoint(screen: [number, number]) {
  const t = pointTarget(screen);
  if (!t || !shownLevel) { overpassLayer.setDrawPreview(undefined); return; }
  const s = 0.25, [x, y] = t.local, z = shownLevel.floor;
  overpassLayer.setDrawPreview([[x - s, y - s], [x + s, y - s], [x + s, y + s], [x - s, y + s]].map(([a, b]) => new THREE.Vector3(a, b, z)), true);
  toolHint(t.kind === 'entrance' ? tr('Вход в здание (entrance=yes): щелчок — поставить.')
    : t.kind === 'door' ? tr('Дверь (door=yes) — узел войдёт в стороны: {n}. Щелчок — поставить.', { n: t.node !== undefined ? 1 : t.indoor.length + t.building.length })
    : tr('Объект этажа: щелчок — поставить, вид задаётся в свойствах.'));
}

/** Поставить точку: новый узел (в стороны помещений и, у входа, в пути здания) или теги на готовую вершину. */
function placePoint(screen: [number, number]) {
  const t = pointTarget(screen);
  if (!t || !focus || !shownLevel) return;
  const n = shownLevel.n;
  const tags: Record<string, string> = t.kind === 'entrance' ? { entrance: 'yes', door: 'yes', level: String(n) }
    : t.kind === 'door' ? { indoor: 'door', door: 'yes', level: String(n) } : { level: String(n) };
  const edits: ObjectEdit[] = [];
  let id: number;
  if (t.node !== undefined && t.node > 0) {
    // Готовая вершина из данных — теги на неё
    id = t.node;
    const key = `node/${id}`;
    const existing = shownIndoor.find((f) => f.key === key);
    if (existing) { selectIndoor(existing); setStatus(tr('Здесь уже есть точка {key}.', { key })); return; }
    trackIndoor(key, { key, kind: 'poi', tags: { ...(session.get(key)?.tags ?? {}) }, polygons: [], point: t.at, levels: [n] });
    edits.push({ key, tags: { ...(session.get(key)?.tags ?? {}), ...tags } });
  } else {
    id = t.node ?? nextNewId--;
    const key = `node/${id}`;
    edits.push({ key, create: { key, version: 0, tags, polygons: [{ outer: [t.at], inners: [], outerIds: [id], innerIds: [] }] } });
    // Узел — в стороны помещений и этажа
    const byKey = new Map<string, { f: IndoorFeature; sides: { ring: number; edge: number }[] }>();
    for (const s of t.indoor) {
      const k = indoorKey(s.f.key);
      (byKey.get(k) ?? byKey.set(k, { f: s.f, sides: [] }).get(k)!).sides.push(s);
    }
    for (const [k, { f, sides }] of byKey) {
      trackIndoor(k, f);
      const cur = (session.get(k)?.polygons ?? f.polygons)[0];
      const rings = [[cur.outer, cur.outerIds!] as const, ...cur.inners.map((r, j) => [r, cur.innerIds![j]] as const)].map(([c, ids], ring) => {
        const at = sides.filter((s) => s.ring === ring).map((s) => s.edge).sort((x, y) => y - x);
        const cc = [...c], ii = [...ids];
        for (const e of at) { cc.splice(e + 1, 0, t.at); ii.splice(e + 1, 0, id); }
        return [cc, ii] as const;
      });
      edits.push({ key: k, polygons: [{ outer: rings[0][0], outerIds: rings[0][1], inners: rings.slice(1).map((r) => r[0]), innerIds: rings.slice(1).map((r) => r[1]) }] });
    }
    // Вход — и в пути здания (контур, части по фасаду)
    if (t.building.length) {
      const coord = new Map<number, LonLat>([[id, t.at]]);
      for (const b of t.building) { coord.set(b.u, b.cu); coord.set(b.v, b.cv); }
      const out = insertIntoNeighbours(`node/${id}`, t.building.map((b) => ({ id, p: t.local, u: b.u, v: b.v })), coord);
      if (typeof out === 'string') { setStatus(out, true); return; }
      edits.push(...out);
    }
  }
  session.editMany(edits);
  const key = `node/${id}`;
  // И готовая вершина из данных: без тегов её не было среди точек этажа
  indoorCreated.set(key, { key, kind: 'poi', tags: session.get(key)?.tags ?? tags, polygons: [], point: t.at, levels: [n] });
  indoorEdited.add(key);
  indoorEditRev++;
  renderLevels();
  const f = buildingIndoorFor(key);
  if (f) selectIndoor(f);
  setStatus(t.kind === 'entrance' ? tr('Поставлен вход {key}.', { key }) : t.kind === 'door' ? tr('Поставлена дверь {key}.', { key }) : tr('Поставлена точка {key}: вид задайте в свойствах.', { key }));
}

/** Теги без этажа: копии на других этажах совпадают по ним. */
const tagsNoLevel = (t: Record<string, string>) => JSON.stringify(Object.entries(t).filter(([k]) => k !== 'level' && k !== 'repeat_on').sort());
/** Вершины совпадают с точностью ~5 см (в градусах). */
const NEAR_DEG = 5e-7;
const nearLL = (a: LonLat, b: LonLat) => Math.abs(a[0] - b[0]) < NEAR_DEG && Math.abs(a[1] - b[1]) < NEAR_DEG;

/** Копии объекта f на других этажах: тот же вид, теги (кроме level) и форма — этаж → копия. */
function levelCopies(f: IndoorFeature, all: IndoorFeature[]): Map<number, IndoorFeature> {
  const out = new Map<number, IndoorFeature>();
  const sig = tagsNoLevel(f.tags);
  const same = (g: IndoorFeature) => {
    if (f.point || g.point) return !!f.point && !!g.point && nearLL(f.point, g.point);
    const a = f.polygons[0], b = g.polygons[0];
    return !!a && !!b && f.polygons.length === g.polygons.length && a.outer.length === b.outer.length && a.outer.every((p) => b.outer.some((q) => nearLL(p, q)));
  };
  for (const g of all) {
    if (g.key === f.key || g.key.endsWith('#poi') || g.kind !== f.kind || g.levels.length !== 1 || f.levels.includes(g.levels[0])) continue;
    if (tagsNoLevel(g.tags) === sig && same(g)) out.set(g.levels[0], g);
  }
  return out;
}

type RepeatMode = 'copies' | 'repeat_on' | 'level';

/** «Повторять на этажах…»: галки по этажам здания, способ — отдельные копии, repeat_on или один объект на нескольких этажах. */
function openRepeatDialog() {
  if (!focus || !shownLevel) return;
  const fs = indoorSelection.filter((f) => !f.key.endsWith('#poi'));
  if (!fs.length) return;
  const all = buildingIndoor(focus);
  const copies = fs.map((f) => levelCopies(f, all));
  const own = new Set(fs.flatMap((f) => parseLevels(f.tags.level)));
  const repeatOn = fs.map((f) => parseLevels(f.tags.repeat_on));
  const mode: RepeatMode = repeatOn.some((r) => r.length) ? 'repeat_on' : fs.every((f) => parseLevels(f.tags.level).length > 1) ? 'level' : 'copies';
  const levels = [...panelLevels].sort((a, b) => b - a);
  const rows = levels.map((n) => {
    const isOwn = fs.every((f) => parseLevels(f.tags.level).includes(n));
    const has = fs.map((f, i) => isOwn || copies[i].has(n) || repeatOn[i].includes(n) || parseLevels(f.tags.level).includes(n));
    const all = has.every(Boolean), some = has.some(Boolean);
    return `<li><label><input type="checkbox" data-repeat-level="${n}"${all ? ' checked' : ''}${isOwn && n === shownLevel!.n ? ' disabled' : ''}${!all && some ? ' data-mixed' : ''}> ${esc(levelLabel(n))}</label></li>`;
  }).join('');
  const radio = (m: RepeatMode, label: string, hint: string) => `<label class="repeat-mode"><input type="radio" name="repeat-mode" value="${m}"${m === mode ? ' checked' : ''}> ${label}<span class="hint">${hint}</span></label>`;
  showPopup(`<h3>${tr('Повторять на этажах')}</h3>
    <p class="hint">${tr('Объектов: {n}. Отмеченные этажи — где объект есть; снятая галка убирает копию.', { n: fs.length })}</p>
    <ul class="repeat-levels">${rows}</ul>
    ${radio('copies', tr('Отдельные копии'), tr('по объекту на этаж, правятся по отдельности'))}
    ${radio('repeat_on', tr('repeat_on'), tr('один объект, повторяется на этажах (вики советует скупо)'))}
    ${radio('level', tr('Один объект на нескольких этажах'), tr('level=0;1;2 — лестница, лифт, шахта'))}
    <p><button type="button" data-repeat-apply>${tr('Применить')}</button></p>`, tr('Отмена'));
  for (const el of popupEl.querySelectorAll<HTMLInputElement>('[data-mixed]')) el.indeterminate = true;
  const touched = new Set<number>();
  for (const el of popupEl.querySelectorAll<HTMLInputElement>('[data-repeat-level]')) el.addEventListener('change', () => touched.add(Number(el.dataset.repeatLevel)));
  popupEl.querySelector('[data-repeat-apply]')!.addEventListener('click', () => {
    const checked = new Map<number, boolean>();
    for (const el of popupEl.querySelectorAll<HTMLInputElement>('[data-repeat-level]')) {
      const n = Number(el.dataset.repeatLevel);
      // Смешанное и нетронутое — не трогаем
      if (el.indeterminate && !touched.has(n)) continue;
      checked.set(n, el.checked);
    }
    const m = (popupEl.querySelector<HTMLInputElement>('input[name="repeat-mode"]:checked')?.value ?? 'copies') as RepeatMode;
    showPopup('');
    const err = applyRepeat(fs, copies, checked, m);
    if (err) setStatus(err, true);
  });
}

/** Применить «Повторять на этажах»: копии создаются и удаляются, repeat_on или level пишутся одним шагом истории. */
function applyRepeat(fs: IndoorFeature[], copies: Map<number, IndoorFeature>[], checked: Map<number, boolean>, mode: RepeatMode): string | undefined {
  if (!focus || !shownLevel) return;
  const all = buildingIndoor(focus);
  const edits: ObjectEdit[] = [];
  const made: IndoorFeature[] = [];
  const removed = new Set<string>();
  const used = new Set(all.flatMap((g) => g.polygons.flatMap((p) => [...(p.outerIds ?? []), ...(p.innerIds ?? []).flat()])));
  const drop = (g: IndoorFeature) => {
    const key = indoorKey(g.key);
    if (removed.has(key)) return;
    removed.add(key);
    trackIndoor(key, g);
    // Узел — вершина контура: снимаем теги, иначе удаляем
    const id = Number(key.split('/')[1]);
    edits.push(g.point && key.startsWith('node/') && used.has(id) ? { key, tags: {} } : { key, delete: true });
  };
  let skipped = 0;
  if (mode === 'copies') {
    // Узлы целевого этажа: вершины его помещений и здания; новые — общие у копий этого шага (дверь встаёт в стену)
    const byLevel = new Map<number, ReturnType<typeof sharedNodes> & { known: Set<number> }>();
    const nodesOn = (n: number) => {
      let r = byLevel.get(n);
      if (!r) {
        const feats = [...groupFeatures(focus!), ...all.filter((g) => !g.point && !g.line && g.levels.includes(n))];
        const known = new Set(feats.flatMap((g) => g.polygons.flatMap((p) => [...(p.outerIds ?? []), ...(p.innerIds ?? []).flat()])));
        r = { ...sharedNodes(feats), known };
        byLevel.set(n, r);
      }
      return r;
    };
    // Сначала контуры, потом точки: двери встают на вершины скопированных помещений
    const order = fs.map((f, i) => i).sort((a, b) => Number(!!fs[a].point) - Number(!!fs[b].point));
    for (const i of order) {
      const f = fs[i];
      for (const [n, want] of checked) {
        if (f.levels.includes(n)) continue;
        const copy = copies[i].get(n);
        if (!want) { if (copy) drop(copy); continue; }
        if (copy) continue;
        const tags: Record<string, string> = { ...f.tags, level: String(n) };
        delete tags.repeat_on;
        delete tags.type;
        const { nodeFor, known } = nodesOn(n);
        if (f.point) {
          const q = nodeFor(f.point);
          const key = `node/${q.id}`;
          if (session.get(key) || all.some((g) => g.key === key)) { skipped++; continue; }
          if (q.id > 0 && known.has(q.id)) {
            trackIndoor(key, { key, kind: 'poi', tags: {}, polygons: [], point: q.p, levels: [n] });
            edits.push({ key, tags });
          } else edits.push({ key, create: { key, version: 0, tags, polygons: [{ outer: [q.p], inners: [], outerIds: [q.id], innerIds: [] }] } });
          made.push({ key, kind: f.kind, tags, polygons: [], point: q.p, levels: [n] });
          continue;
        }
        if (f.line || f.polygons.length !== 1) { skipped++; continue; }
        const m = indoorCreateEdits(f.polygons[0], tags, nodeFor, edits);
        if (m) made.push(m); else skipped++;
      }
    }
    // Копии вместо repeat_on
    for (const f of fs) if (f.tags.repeat_on !== undefined) { const key = indoorKey(f.key); trackIndoor(key, f); const t = { ...f.tags }; delete t.repeat_on; edits.push({ key, tags: t }); }
  } else {
    // Один объект: этажи — в repeat_on или в level; отдельные копии на этих этажах больше не нужны
    fs.forEach((f, i) => {
      const own = parseLevels(f.tags.level);
      const cur = new Set(mode === 'repeat_on' ? parseLevels(f.tags.repeat_on) : own.filter((n) => n !== shownLevel!.n));
      for (const [n, want] of checked) if (n !== shownLevel!.n) { if (want) cur.add(n); else cur.delete(n); }
      for (const [n, copy] of copies[i]) if (cur.has(n) || checked.get(n) === false) drop(copy);
      const list = (xs: number[]) => [...new Set(xs)].sort((a, b) => a - b).join(';');
      const tags = { ...f.tags };
      if (mode === 'repeat_on') {
        if (cur.size) tags.repeat_on = list([...cur].filter((n) => !own.includes(n))); else delete tags.repeat_on;
        if (tags.repeat_on === '') delete tags.repeat_on;
      } else {
        tags.level = list([shownLevel!.n, ...cur]);
        delete tags.repeat_on;
      }
      const key = indoorKey(f.key);
      trackIndoor(key, f);
      edits.push({ key, tags });
    });
  }
  if (!edits.length) return skipped ? tr('Скопировать нельзя: стены-линии и мультиполигоны из нескольких частей пока не копируются.') : undefined;
  session.editMany(edits);
  for (const m of made) { indoorCreated.set(m.key, m); indoorEdited.add(m.key); }
  for (const f of fs) indoorEdited.add(indoorKey(f.key));
  indoorEditRev++;
  renderLevels();
  // Выделение — прежнее
  fs.map((f) => buildingIndoorFor(indoorKey(f.key))).filter((f): f is IndoorFeature => !!f).forEach((f, i) => selectIndoor(f, i > 0));
  setStatus(tr('Этажи: копий создано {made}, убрано {removed}.', { made: made.length, removed: removed.size })
    + (skipped ? ' ' + tr('Пропущено: {n}.', { n: skipped }) : ''));
  return;
}

/**
 * «Прямоугольник» и «Полигон» на плане этажа: помещение indoor=area этого этажа по нарисованному контуру
 * (в пределах среза этажа). Вершины на соседях — их узлы.
 */
function createIndoorDrawn(ring: [number, number][]): string | undefined {
  if (!focus || !shownLevel) return tr('Нет этажа.');
  let polys: Polygon[] = [{ outer: ring.map((q) => overpassLayer.focusToLngLat(q[0], q[1])! as LonLat), inners: [] }];
  const section = levelSection(shownLevel);
  if (section?.length) {
    const close = (r: LonLat[]) => [...r, r[0]] as [number, number][];
    try {
      polys = polygonClipping.intersection([close(polys[0].outer)], section.map((p) => p.map(close)))
        .map((p) => ({ outer: p[0].slice(0, -1) as LonLat[], inners: p.slice(1).map((r) => r.slice(0, -1) as LonLat[]) }));
    } catch (err) { console.warn('[indoor-draw]', err); }
  }
  if (!polys.length) return tr('Контур вне этажа здания.');
  const { nodeFor } = sharedNodes([...groupFeatures(focus), ...shownIndoor.filter((f) => !f.point && !f.line)]);
  const edits: ObjectEdit[] = [];
  const made = polys.map((p) => indoorCreateEdits(p, { indoor: 'area', level: String(shownLevel!.n) }, nodeFor, edits)).filter((m): m is IndoorFeature => !!m);
  if (!made.length) return tr('Контур вырожден: у него нет площади.');
  session.editMany(edits);
  for (const m of made) { indoorCreated.set(m.key, m); indoorEdited.add(m.key); }
  indoorEditRev++;
  renderLevels();
  made.map((m) => buildingIndoorFor(m.key)).filter((f): f is IndoorFeature => !!f).forEach((f, i) => selectIndoor(f, i > 0));
  setStatus(tr('Создано: {keys} (indoor=area, этаж {n}).', { keys: made.map((m) => m.key).join(', '), n: levelLabel(shownLevel.n) }));
  return;
}

/**
 * Этаж из контура: indoor=level этажа n по сечению оболочки здания на отметке пола (под скатом — уже следа).
 * Вершины, совпадающие с узлами контура или частей, — эти же узлы (attached: двигаются вместе с фасадом),
 * остальные — новые. Сечение с дырами (двор-колодец) — мультиполигон пока не создаём: только внешние кольца.
 */
function levelFromOutline(n: number, extra: Record<string, string> = {}) {
  if (!focus) return;
  const l = buildingLevels(focus, buildingIndoor(focus)).find((x) => x.n === n);
  // На полу пусто (низ части выше расчётного пола: подвал по этажности глубже самой части) — середина этажа
  const section = l && levelSection(l);
  if (!l || !section?.length) { setStatus(tr('Контур этажа ещё не посчитан — повторите через пару секунд.'), true); return; }
  const { nodeFor, used } = sharedNodes(groupFeatures(focus));
  const edits: ObjectEdit[] = [];
  let holes = 0;
  for (const poly of section) {
    holes += poly.length - 1;
    const ring = nodeRing(poly[0], nodeFor);
    if (!ring) continue;
    const key = `way/${nextNewId--}`;
    const tags = { indoor: 'level', level: String(n), ...extra };
    const polygons = [{ outer: ring.map((q) => q.p), outerIds: ring.map((q) => q.id), inners: [] }];
    edits.push({ key, create: { key, version: 0, tags, polygons } });
    indoorCreated.set(key, { key, kind: 'level', polygons, tags, levels: [n] });
    indoorEdited.add(key);
  }
  if (!edits.length) return;
  session.editMany(edits);
  // Новый этаж — выделен: контур подсвечен, дальше правится как любой indoor-объект
  const made = edits.map((e) => buildingIndoorFor(e.key)).filter((f): f is IndoorFeature => !!f);
  made.forEach((f, i) => selectIndoor(f, i > 0));
  setStatus(tr('Создан indoor=level этажа {n}: общих узлов с контуром — {shared}.', { n, shared: used.size })
    + (holes ? ' ' + tr('Дворы внутри контура ({k}) не вырезаны.', { k: holes }) : ''));
}

/** Заготовка indoor=level для формы этажа, у которого его ещё нет. */
const newLevelStub = (n: number): IndoorFeature => ({ key: `level-new/${n}`, kind: 'level', tags: {}, polygons: [], levels: [n] });

/** Объекты indoor=level этажа (их теги правятся в свойствах этажа). */
function levelFeatures(l: Level): IndoorFeature[] {
  return focus ? (l.levelKeys ?? []).map((k) => buildingIndoorFor(k)).filter((f): f is IndoorFeature => !!f) : [];
}

/** Панель этажей режима здания: список по этажности и indoor-данным, клик — срез здания выше этажа. */
/**
 * Почему этаж выбивается из ожидаемых высот (для «!» в панели): высота этажа вне MIN/MAX_LEVEL_STEP
 * или пол не там, где этаж с таким номером может быть при правдоподобных этажах (1 м допуска).
 */
function levelIssue(l: Level): string | undefined {
  const h = l.ceil - l.floor;
  if (h < MIN_LEVEL_STEP || h > MAX_LEVEL_STEP) return tr('высота этажа {h} м — вне {min}–{max} м', { h: h.toFixed(1), min: MIN_LEVEL_STEP, max: MAX_LEVEL_STEP });
  const [lo, hi] = l.n >= 0 ? [l.n * MIN_LEVEL_STEP, l.n * MAX_LEVEL_STEP] : [l.n * MAX_LEVEL_STEP, l.n * MIN_LEVEL_STEP];
  if (l.floor < lo - 1 || l.floor > hi + 1) return tr('пол на {z} м — для этого этажа ожидается {lo}–{hi} м', { z: l.floor.toFixed(1), lo, hi });
  return undefined;
}

/**
 * Подземная часть здания для пунктира в общем виде: глубина — пол нижнего подземного этажа; контур — части
 * с building:levels:underground, а если подвал известен только из indoor-данных — контур здания (или все части).
 */
function undergroundOutline(g: BuildingGroup, levels: Level[]): { rings: LonLat[][]; depth: number } | undefined {
  const depth = Math.min(0, ...levels.filter((l) => l.n < 0).map((l) => l.floor));
  if (depth > -0.5) return undefined;
  const feats = groupFeatures(g);
  let src = feats.filter((f) => Number(f.tags['building:levels:underground']) > 0);
  if (!src.length) src = feats.filter((f) => f.kind === 'building');
  if (!src.length) src = feats;
  return { rings: src.flatMap((f) => f.polygons.flatMap((p) => [p.outer, ...p.inners])), depth };
}

function renderLevels() {
  scheduleIndoorBadges(); timed('этажи: панель', renderLevelsImpl); }

function renderLevelsImpl() {
  levelsPanel.hidden = !focus;
  if (!focus) {
    levelsEl.innerHTML = '';
    overpassLayer.setUnderground(undefined);
    indoorPois.set([], 0);
    shownLevel = undefined;
    shownIndoor = [];
    selectedIndoor = undefined;
    indoorSelection = [];
    selectedRoomWalls = [];
    overpassLayer.setRoomWallSelection([]);
    indoorPois.setSelection([]);
    if (levelsFocusKey !== undefined) { linkLevel = undefined; setLevelParam(undefined); } // вышли из режима здания
    currentLevel = levelsFocusKey = undefined;
    levelSignature = '';
    underlayLevels = [];
    underlayLevelsSig = '';
    return;
  }
  if (levelsFocusKey !== focus.key) {
    if (levelsFocusKey !== undefined) linkLevel = undefined; // этаж из ссылки — только для первого здания
    // Здание без отношения получило отношение (правка контура или части собрала его тем же шагом) — то же здание:
    // этаж остаётся
    const prev = levelsFocusKey?.startsWith(SOLO) ? levelsFocusKey.slice(SOLO.length) : levelsFocusKey;
    const same = prev !== undefined && focus.members.includes(prev);
    levelsFocusKey = focus.key;
    if (!same) currentLevel = undefined;
  }
  loadFocusIndoor(focus);
  const indoor = buildingIndoor(focus);
  const levels = buildingLevels(focus, indoor);
  panelLevels = levels.map((l) => l.n);
  panelLevelRefs = new Map(levels.filter((l) => l.ref).map((l) => [l.n, l.ref!]));
  if (linkLevel !== undefined && levels.some((l) => l.n === linkLevel)) { currentLevel = linkLevel; linkLevel = undefined; }
  if (currentLevel !== undefined && !levels.some((l) => l.n === currentLevel)) currentLevel = undefined;
  // Сменился этаж (щелчок, ссылка, этаж пропал) или его данные (догрузились indoor, правка) — свойства этажа в панели, если ничего не выделено
  const infoSig = (() => { const l = levels.find((x) => x.n === currentLevel); return l ? JSON.stringify([l.n, l.floor, l.ceil, l.ref, l.name, l.heightTag, l.levelKeys, l.overflow]) : ''; })();
  if (infoSig !== infoLevel) {
    infoLevel = infoSig;
    if (freeArea && freeArea.n !== currentLevel) { freeArea = undefined; overpassLayer.setFreeArea(undefined); }
    if (!selection.length && !indoorSelection.length) queueMicrotask(() => { if (!selection.length && !indoorSelection.length) renderSelected(); });
  }
  // Пока этаж из ссылки не появился в панели — он остаётся в адресе
  setLevelParam(currentLevel ?? linkLevel);
  syncUnderlayLevels(levels);
  levelsCount.textContent = levels.length ? `(${levels.length})` : '';
  const planned = plannedLevels(focus, levels, indoor);
  levelsEl.innerHTML = levels.length
    ? `<li class="${currentLevel === undefined ? 'selected' : ''}" data-level=""><span class="lv-name"><span class="lv-plan"></span>${tr('Всё здание')}</span></li>` + levels.map((l, i) =>
      // Заголовки групп: перед первым надземным и первым подземным этажом (список — сверху вниз)
      (i === 0 || (levels[i - 1].n >= 0) !== (l.n >= 0) ? `<li class="lv-group">${l.n >= 0 ? tr('Надземные этажи') : tr('Подземные этажи')}</li>` : '')
      + `<li class="${l.n === currentLevel ? 'selected' : ''}" data-level="${l.n}" title="level=${l.n}${l.ref ? ` · level:ref=${esc(l.ref)}` : ''}${l.name ? ` · ${esc(l.name)}` : ''} · ${l.src ? tr('по тегам {link}', { link: l.src }) : tr('из indoor-данных')}${planned.has(l.n) ? ' · ' + tr('есть поэтажный план') : ''}">`
      + `<span class="lv-name"><span class="lv-plan">${planned.has(l.n) ? ICON_PLAN : ''}</span>${l.ref ? esc(tr('Этаж {ref}', { ref: l.ref })) : LEVEL_NAME(l.n)}${l.name ? ` <span class="lv-sub">${esc(l.name)}</span>` : ''}</span>`
      + `<span class="lv-meta">${levelIssue(l) ? `<span class="lv-warn" title="${esc(levelIssue(l)!)}">!</span>` : ''}<span${l.explicit ? ` class="lv-explicit" title="${esc(tr('Высота этажа задана: height={h} на indoor=level', { h: +(l.ceil - l.floor).toFixed(2) }))}"` : ''}>${tr('{floor}–{ceil} м', { floor: l.floor.toFixed(1), ceil: l.ceil.toFixed(1) })}</span></span></li>`).join('') + levelSources(levels)
    : `<li class="lv-empty">${tr('Нет этажности (building:levels) и indoor-данных')}</li>`;
  overpassLayer.setUnderground(currentLevel === undefined ? undergroundOutline(focus, levels) : undefined);
  const level = levels.find((l) => l.n === currentLevel);
  const onLevel = level ? indoor.filter((f) => f.levels.includes(level.n) && !indoorHidden.has(indoorKey(f.key))) : [];
  const visibleIndoor = indoor.filter((f) => !indoorHidden.has(indoorKey(f.key)));
  if (selectedRoomWalls.length && (shownLevel?.n !== level?.n || shownLevel?.floor !== level?.floor)) {
    selectIndoor(undefined);
    clearInfo();
  }
  shownLevel = level;
  shownIndoor = onLevel;
  if (selectedRoomWalls.length && (!level || selectedRoomWalls.some((w) => !onLevel.some((f) => f.key === w.key && f.kind === 'room')))) {
    selectIndoor(undefined);
    clearInfo();
  }
  // Лифты: пол только на нижней остановке; выше, до верхней (и на этажах без остановки), — шахта: вырез в полу
  const elevators = visibleIndoor.filter((f) => isElevatorRoom(f, visibleIndoor) && f.levels.length);
  const planOf = (l: Level) => {
    const fs = visibleIndoor.filter((f) => f.levels.includes(l.n));
    const shaft = (f: IndoorFeature) => elevators.includes(f) && l.n > Math.min(...f.levels) && l.n <= Math.max(...f.levels);
    const passing = elevators.filter((f) => shaft(f) && !f.levels.includes(l.n))
      .map((f): IndoorItem => ({ key: f.key, kind: f.kind, polygons: f.polygons, z: l.floor, shaft: true, cutOnly: true }));
    return {
      cut: l.ceil,
      // Площадь эскалатора задаёт его след и проём, но не сплошной пол под ступенями.
      // Многоэтажные помещения имеют пол только внизу; стены и колонны есть на всех указанных уровнях.
      items: fs.filter((f) => f.kind !== 'poi' && !f.escalator && !f.escalatorArea
        && !(f.kind === 'area' && f.tags.stairs === 'yes' && !!f.tags.conveying && f.tags.conveying !== 'no')
        && (f.line || f.kind === 'wall' || f.kind === 'column' || floorLevels(f).includes(l.n)))
        .map((f): IndoorItem => ({ key: f.key, kind: f.kind, polygons: f.polygons, line: f.line, z: l.floor, areaLedge: f.tags.indoor === 'area',
          ...(isFloorKind(f) ? { colour: CATEGORY_COLOURS[categoryOf(f, fs)] } : {}),
          ...(isToiletRoom(f) ? { doorWidth: TOILET_DOOR_WIDTH } : {}),
          ...(isPool(f) ? { pool: poolDepth(f) } : {}),
          ...(shaft(f) ? { shaft: true } : {}) })).concat(passing),
      // Помещение в несколько этажей выше своего пола: только для подсветки выбора — по основанию на нижнем этаже
      highlights: fs.filter((f) => isFloorKind(f) && !f.line && !f.escalator && !f.escalatorArea && !floorLevels(f).includes(l.n))
        .flatMap((f): IndoorItem[] => {
          const base = levels.find((x) => x.n === Math.min(...floorLevels(f)));
          return base ? [{ key: f.key, kind: f.kind, polygons: f.polygons, z: base.floor }] : [];
        }),
      // Модели нижних этажей видны сквозь второй свет; маркеры остаются на активном этаже.
      doorModels: fs.filter((f) => isDoor(f) && f.tags.door === 'revolving')
        .map((f) => ({ key: f.key, at: f.point!, z: l.floor, tags: f.tags })),
      // Двери этажа — проёмы в стенах
      doors: fs.filter((f) => f.kind === 'poi' && f.point && (f.tags.door || f.tags.indoor === 'door' || f.tags.entrance)).map((f) => f.point!),
    };
  };
  const plan = level && planOf(level);
  // Видимые сквозь второй свет эскалаторы нижних этажей тоже нужны в сцене.
  const voids = level ? levelVoids(focus, levels, visibleIndoor, level.n) : [];
  const allEscalators = visibleIndoor.filter((f) => f.escalator && f.polygons[0]?.outer.length >= 2 && f.levels.length >= 2
      && (f.tags.incline === 'up' || f.tags.incline === 'down'))
    .map((f) => {
      const low = levels.find((l) => l.n === Math.min(...f.levels));
      const high = levels.find((l) => l.n === Math.max(...f.levels));
      if (!level || !low || !high) return;
      const line = f.polygons[0].outer;
      const visibleBelow = voids.some((v) => v.through.includes(high.n) && line.slice(1).some((b, i) => {
        const a = line[i], mid: LonLat = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        return [a, mid, b].some((p) => v.polygon.some(([outer, ...holes]) =>
          pointInRing(p, outer) && !holes.some((hole) => pointInRing(p, hole))));
      }));
      return { key: f.key, line, bottom: low.floor, top: high.floor,
        width: Math.max(0.7, Math.min(5, parseLength(f.tags.width) ?? 1.2)), incline: f.tags.incline,
        pale: !f.levels.includes(level.n), visible: f.levels.includes(level.n) || visibleBelow };
    }).filter((f): f is NonNullable<typeof f> => !!f);
  // Все эскалаторы здания режут проёмы в планах нижних этажей (те не зависят от выбранного этажа и кешируются)
  const cutEscalators = allEscalators.map(({ visible: _, ...e }) => e);
  const escalators = cutEscalators.filter((_, i) => allEscalators[i].visible);
  const selectable = new Set([...onLevel.map((f) => f.key), ...escalators.map((e) => e.key)]);
  // Выбранные, которых на этаже больше нет (сменили level или этаж) — из выбора вон
  if (indoorSelection.some((s) => !selectable.has(s.key))) {
    const keep = indoorSelection.filter((s) => selectable.has(s.key));
    indoorSelection = [];
    if (!keep.length) selectIndoor(undefined);
    for (const f of keep) selectIndoor(f, keep.length > 1);
  }
  const escalatorIconPositions = new Map<string, { at: LonLat; z: number }>();
  for (const area of onLevel.filter((f) => f.escalatorArea)) {
    const axis = escalators.find((e) => e.line.slice(1).some((b, i) => {
      const a = e.line[i], mid: LonLat = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      return area.polygons.some((p) => pointInRing(mid, p.outer) && !p.inners.some((hole) => pointInRing(mid, hole)));
    }));
    if (!axis) continue;
    const a = axis.line[0], b = axis.line.at(-1)!;
    escalatorIconPositions.set(`${area.key}#poi`, {
      at: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], z: (axis.bottom + axis.top) / 2 + 0.35,
    });
  }
  indoorPois.set(onLevel.filter((f) => f.kind === 'poi'), level?.floor ?? 0, escalatorIconPositions,
    onLevel.filter((f) => f.kind === 'room' || f.kind === 'area'));
  if (level) levelsEl.insertAdjacentHTML('beforeend', indoorLegend(onLevel));
  overpassLayer.setDoors(level ? onLevel.filter(isDoor).map((f) => ({ key: f.key, at: f.point!, z: level.floor, tags: f.tags })) : []);
  // Второй свет: пустоты в перекрытии и этажи под ними
  // Пустоты здания посчитались или поменялись (пришли indoor-данные) — перекрытия стеклянных частей пересобрать
  const allVoids = buildingVoids(focus, levels, visibleIndoor);
  const vsig = `${focus.key}|${visibleIndoor.map((f) => f.key).join(',')}|${[...allVoids].map(([n, l]) => `${n}:${l.length}`).join(',')}`;
  if (vsig !== glassVoidsSig) {
    glassVoidsSig = vsig;
    const members = new Set(focus.members);
    // Стекло бывает унаследованным от контура — пересобираем все части здания (редко: только когда пустоты меняются)
    void overpassLayer.rebuildWhere((f) => members.has(f.key));
  }
  const through = [...new Set(voids.flatMap((v) => v.through))];
  const sig = plan ? `${level!.n}|${level!.ceil}|${plan.items.map((i) => i.key).join(',')}|${plan.doors.map((d) => d.join(',')).join(';')}|${voids.length}|${escalators.map((e) => `${e.key}:${e.bottom}:${e.top}`).join(',')}|${indoorEditRev}|${[...indoorHidden].sort().join(',')}` : '';
  if (sig === levelSignature) return;
  levelSignature = sig;
  overpassLayer.setLevel(plan && {
    ...plan, floor: level!.floor,
    escalators, cutEscalators,
    voids: voids.map((v) => v.polygon).flat(),
    // Пустота прорезает пол этажа и полы промежуточных этажей (у самого нижнего — пол атриума)
    voidCuts: voids.map((v) => ({
      polygon: v.polygon,
      zs: [level!.floor, ...v.through.slice(0, -1).map((n) => levels.find((l) => l.n === n)?.floor).filter((z): z is number => z !== undefined)],
    })),
    below: through.map((n) => levels.find((l) => l.n === n)).filter((l): l is Level => !!l)
      .map((l) => ({ ...planOf(l), voids: (allVoids.get(l.n) ?? []).flatMap((v) => v.polygon) })),
  });
}

/** Пустоты (второй свет) этажа n здания: lon/lat; кеш — по зданию, данным и этажу. */
/** Чем последний раз пересобраны перекрытия стеклянных частей здания режима. */
let glassVoidsSig = '';
type LevelVoids = Map<number, { polygon: LonLat[][][]; through: number[] }[]>;
/** Пустоты (второй свет) всех этажей здания, lon/lat; кеш — по зданию и данным. */
const voidsCache = new Map<string, { sig: string; map: LevelVoids }>();
function buildingVoids(g: BuildingGroup, levels: Level[], indoor: IndoorFeature[]): LevelVoids {
  const feats = groupFeatures(g);
  let w = Infinity, s = Infinity, e = -Infinity, nn = -Infinity;
  for (const f of feats) for (const p of f.polygons) for (const [x, y] of p.outer) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); nn = Math.max(nn, y); }
  const hasParts = feats.some((f) => f.kind === 'part');
  // Части внутри здания, забытые в отношении (relation/17852191 вне relation/17852202), — тоже контур этажа
  const members = new Set(g.members);
  const outlines = feats.filter((f) => f.kind === 'building');
  const strays = hasParts && Number.isFinite(w) ? overpass.allFeatures().filter((f) => f.kind === 'part' && !members.has(f.key) && f.polygons.length
    && f.polygons[0].outer.every(([x, y]) => x >= w && x <= e && y >= s && y <= nn)
    && outlines.some((o) => o.polygons.some((q) => pointInRing(pointOnSurface(f.polygons[0]), q.outer)))) : [];
  const partFeats = [...feats.filter((f) => !hasParts || f.kind === 'part'), ...strays];
  // По содержимому, а не по ревизии тайлов: тайлы приходят порциями, а здание в них то же — пересчёт (~1 с) зря
  const sig = JSON.stringify([levels.map((l) => [l.n, l.floor, l.ceil]),
    partFeats.map((f) => [f.key, f.tags, f.polygons]),
    indoor.map((f) => [f.key, f.kind, f.tags, f.levels, f.line, f.escalator, f.escalatorArea, f.polygons])]);
  const hit = voidsCache.get(g.key);
  if (hit?.sig === sig) return hit.map;
  const map: LevelVoids = timed('этажи: второй свет', () => {
    const out: LevelVoids = new Map();
    if (!Number.isFinite(w) || !indoor.length) return out;
    // Плоская система в метрах вокруг здания
    const cx = (w + e) / 2, cy = (s + nn) / 2, kx = Math.cos(cy * Math.PI / 180) * 111320, ky = 111320;
    const loc = ([x, y]: LonLat): [number, number] => [(x - cx) * kx, (y - cy) * ky];
    const geo = ([x, y]: [number, number]): LonLat => [x / kx + cx, y / ky + cy];
    const poly = (p: Polygon) => [p.outer.map(loc), ...p.inners.map((r) => r.map(loc))];
    const parts = partFeats
      .map((f) => { const h = computeHeights(f.tags); return { polygons: f.polygons.map(poly), min: h.min, wallTop: h.wallTop }; });
    const plans = buildPlans(levels, parts, indoor.filter((f) => f.kind !== 'poi').map((f) => ({ kind: f.kind, levels: f.levels, floors: floorLevels(f), line: f.line, polygons: f.polygons.map(poly) })));
    for (const l of levels) {
      const list = findVoids(l.n, plans).map((v) => ({ polygon: v.polygon.map((p) => p.map((r) => r.slice(0, -1).map((q) => geo(q as [number, number])))), through: v.through }));
      // Лифтовая шахта — сквозной проём до нижней остановки (через этажи без остановок тоже)
      for (const f of indoor.filter((f) => f.levels.length && l.n > Math.min(...f.levels) && l.n <= Math.max(...f.levels) && isElevatorRoom(f, indoor))) {
        const through = levels.filter((x) => x.n < l.n && x.n >= Math.min(...f.levels)).map((x) => x.n);
        if (through.length) list.push({ polygon: f.polygons.map((p) => [p.outer, ...p.inners]), through });
      }
      // Узкие проёмы эскалаторов не проходят порог площади для общего поиска второго света.
      for (const f of indoor.filter((f) => f.escalatorArea && f.levels.includes(l.n) && l.n > Math.min(...f.levels))) {
        const through = levels.filter((x) => x.n < l.n && x.n >= Math.min(...f.levels)).map((x) => x.n);
        if (through.length) list.push({ polygon: f.polygons.map((p) => [p.outer, ...p.inners]), through });
      }
      for (const f of indoor.filter((f) => f.escalator && (f.tags.incline === 'up' || f.tags.incline === 'down')
        && f.levels.includes(l.n) && l.n > Math.min(...f.levels))) {
        const line = f.polygons[0]?.outer;
        if (!line || line.length < 2 || indoor.some((area) => area.escalatorArea && area.levels.includes(l.n)
          && line.slice(1).some((p, i) => {
            const a = line[i], mid: LonLat = [(a[0] + p[0]) / 2, (a[1] + p[1]) / 2];
            return area.polygons.some((q) => pointInRing(mid, q.outer));
          }))) continue;
        const through = levels.filter((x) => x.n < l.n && x.n >= Math.min(...f.levels)).map((x) => x.n);
        const width = Math.max(0.7, Math.min(5, parseLength(f.tags.width) ?? 1.2));
        for (let i = 1; i < line.length; i++) {
          const a = loc(line[i - 1]), b = loc(line[i]);
          const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
          if (len < 0.1) continue;
          const nx = -(b[1] - a[1]) / len * width * 0.55, ny = (b[0] - a[0]) / len * width * 0.55;
          const ring: [number, number][] = [[a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny], [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny]];
          list.push({ polygon: [[ring.map(geo)]], through });
        }
      }
      if (list.length) out.set(l.n, list);
    }
    return out;
  }, (r) => `${[...r.values()].flat().length} пустот`);
  voidsCache.set(g.key, { sig, map });
  while (voidsCache.size > 20) voidsCache.delete(voidsCache.keys().next().value!);
  return map;
}

/** Пустоты этажа n здания. */
function levelVoids(g: BuildingGroup, levels: Level[], indoor: IndoorFeature[], n: number) {
  return buildingVoids(g, levels, indoor).get(n) ?? [];
}

levelsEl.addEventListener('click', (e) => {
  const link = (e.target as HTMLElement).closest<HTMLElement>('[data-select]');
  if (link) { e.preventDefault(); select(link.dataset.select); return; }
  const li = (e.target as HTMLElement).closest<HTMLElement>('li[data-level]');
  if (!li) return;
  const n = li.dataset.level === '' ? undefined : Number(li.dataset.level);
  currentLevel = n;
  linkLevel = undefined;
  renderLevels();
  // Этаж размечен indoor=level — щелчок выделяет его (контур подсвечен, свойства — его форма); Esc — свойства этажа
  const l = n !== undefined && focus ? buildingLevels(focus, buildingIndoor(focus)).find((x) => x.n === n) : undefined;
  const fs = l ? levelFeatures(l) : [];
  if (fs.length) { select(undefined); fs.forEach((f, i) => selectIndoor(f, i > 0)); }
});
infoEl.addEventListener('click', (e) => {
  const ilink = (e.target as HTMLElement).closest<HTMLElement>('[data-select-indoor]');
  if (!ilink) return;
  e.preventDefault();
  const f = buildingIndoorFor(ilink.dataset.selectIndoor!);
  if (f) selectIndoor(f);
});

/** Члены группы панели по data-group (для клика по группе). */
let outlinerGroups = new Map<string, string[]>();

/**
 * Панель частей режима здания: контур — первым, затем части; две и больше частей одного вида собираются
 * в группу (сворачивается стрелкой, клик выделяет все её части, глазик скрывает или показывает их все).
 */
/** Проблемы здания режима здания — пересчитываются вместе со списком частей. */
let focusIssues: Issue[] = [];
let mapIssues: Issue[] = [];
let mapIssuesDirty = true;
let mapIssuesTimer: ReturnType<typeof setTimeout> | undefined;
/** Проблемы в порядке списка панели (кнопки «Исправить» ссылаются по номеру). */
let shownIssues: Issue[] = [];
/** Проблема, исправление которой показано каркасом (наведение на строку «Проверки»). */
let fixPreviewed: Issue | undefined;
/** Временная подсветка частей ошибки под курсором, независимо от «Подсветить все». */
let hoveredIssue: Issue | undefined;
/** Выделенные строки валидатора переживают его перерисовку, пока сама ошибка существует. */
const selectedIssueIds = new Set<string>();
const issueId = (i: Issue) => `${i.key}\0${i.other ?? ''}\0${i.code}\0${i.text}`;

/** Последние проверки по зданиям: пересчёт, только когда сменились объекты (правка даёт новый объект). */
const issueCache = new Map<string, { feats: Feature3D[]; roles: string; issues: Issue[] }>();
// Устаревшие теги iD — отдельным файлом; пришли — перепроверить уже показанное
loadDeprecated(() => { setDeprecatedTags(deprecations()); issueCache.clear(); featureIssueCache = new WeakMap(); renderIssues(); });

/** Проверить здание: члены с правками сессии, без удалённых. */
function buildingIssues(g: BuildingGroup): Issue[] {
  const feats = groupFeatures(g).filter((f) => !session.isDeleted(f.key));
  const roles = g.roles.join();
  const hit = issueCache.get(g.key);
  if (hit && hit.roles === roles && hit.feats.length === feats.length && hit.feats.every((f, i) => f === feats[i])) return hit.issues;
  const issues = timed('проверка здания', () => validateBuilding(g, feats), () => `${g.key}, ${feats.length}`);
  if (issueCache.size > 2000) issueCache.clear();
  issueCache.set(g.key, { feats, roles, issues });
  return issues;
}

/** Проверка тегов и контура одного объекта; кеш по объекту фичи (правка создаёт новый объект). */
let featureIssueCache = new WeakMap<Feature3D, Issue[]>();
function featureIssues(f: Feature3D): Issue[] {
  let issues = featureIssueCache.get(f);
  if (!issues) featureIssueCache.set(f, issues = [...validateTags(f.key, f.tags, f.hasParts), ...validateGeometry(f)]);
  return issues;
}

/** Проверки объектов, реально показанных в режиме карты; неполные отношения проверяем по загруженным членам. */
function visibleMapIssues(): Issue[] {
  const rendered = overpass.renderedFeatures().map((r) => r.feature);
  const seen = new Set<string>();
  const groups = new Map<string, BuildingGroup>();
  const singles: Feature3D[] = [];
  for (const f of rendered) {
    if (seen.has(f.key) || session.isDeleted(f.key)) continue;
    seen.add(f.key);
    const group = groupOf(f.key);
    if (group) groups.set(group.key, group);
    else singles.push(f);
  }
  const issues = singles.flatMap(featureIssues);
  for (const group of groups.values()) {
    const available = groupFeatures(group).filter((f) => !session.isDeleted(f.key));
    if (available.length === group.members.length) issues.push(...buildingIssues(group));
    else for (const f of available) issues.push(...featureIssues(f));
  }
  const byKey = new Map(rendered.map((f) => [f.key, f]));
  issues.push(...duplicateIssues([...seen].map((k) => byKey.get(k)!), rendered));
  issues.push(...orphanPartIssues(singles));
  issues.push(...timed('проверка зданий без отношения', () => implicitIssues(singles), (r) => `${r.length}`));
  issues.push(...timed('проверка частей вне отношения', () => strayPartIssues(singles), (r) => `${r.length}`));
  return issues;
}

/**
 * Части вне отношений внутри контура (роль outline) отношения type=building: забыли добавить в отношение.
 * Если ближе (меньше) объемлющий контур без отношения — это здание без отношения, его ловит implicitIssues.
 */
function strayPartIssues(scope: Feature3D[]): Issue[] {
  const parts = scope.filter((f) => f.kind === 'part' && f.polygons.length && !f.tags.building && !groupOf(f.key) && !session.isDeleted(f.key));
  if (!parts.length) return [];
  const isOutline = (b: Feature3D) => !!b.tags.building && b.tags.building !== 'no' && !b.tags['building:part'];
  // Рамки контуров считаем один раз: точку части сначала проверяем по рамке, полигон — только у попавших
  const all = [...overpass.allFeatures(), ...createdShapes()]
    .filter((f) => f.polygons?.length && !session.isDeleted(f.key) && isOutline(f))
    .map((f) => (session.has(f.key) ? (session.get(f.key) as Feature3D | undefined) ?? f : f))
    .filter((f) => f.polygons?.length)
    .map((b) => { const r = bboxOf(b); return { b, r, area: (r.e - r.w) * (r.n - r.s) }; });
  const out: Issue[] = [];
  for (const p of parts) {
    const c = pointOnSurface(p.polygons[0]);
    let host: Feature3D | undefined, best = Infinity;
    for (const { b, r, area } of all) {
      if (area >= best || b.key === p.key || c[0] < r.w || c[0] > r.e || c[1] < r.s || c[1] > r.n) continue;
      if (insideFeature(c, b)) { host = b; best = area; }
    }
    if (!host) continue;
    const hostKey = host.key, g = groupOf(hostKey);
    if (!g || isSolo(g) || !g.members.some((k, i) => k === hostKey && g.roles[i] === 'outline')) continue;
    out.push({ key: p.key, level: 'warning', code: 'stray-part',
      text: tr('Часть здания внутри контура отношения {relation}, но не входит в него — добавьте её в отношение с ролью part.', { relation: g.key }),
      fix: { label: tr('добавить в {relation} (part)', { relation: g.key }), tags: {}, addToGroup: g.key } });
  }
  return out;
}

/** Части вне отношений внутри контура отношения g (для режима здания). */
function strayPartsOf(g: BuildingGroup): Issue[] {
  if (isSolo(g)) return [];
  const outline = groupFeatures(g).find((f) => g.members.some((k, i) => k === f.key && g.roles[i] === 'outline'));
  if (!outline?.polygons.length) return [];
  return strayPartIssues(looseFeatures(bboxOf(outline)));
}

/** Здания без отношения (контур и части внутри) среди объектов scope — предложение собрать отношение. */
function implicitIssues(scope: Feature3D[]): Issue[] {
  const seen = new Set<string>();
  const out: Issue[] = [];
  let pool: Feature3D[] | undefined;
  for (const f of scope) {
    if (f.kind !== 'part' && !f.hasParts) continue;
    if (seen.has(f.key)) continue;
    const b = implicitBuilding(f, pool ??= loosePool());
    b?.parts.forEach((k) => seen.add(k));
    if (!b || seen.has(b.outline)) continue;
    seen.add(b.outline);
    out.push({ key: b.outline, level: 'warning', code: 'implicit-building',
      text: tr('Контур здания и части внутри него (частей: {n}) без отношения type=building — соберите отношение, чтобы состав здания был явным.', { n: b.parts.length }),
      fix: { label: tr('собрать отношение type=building'), tags: {}, createRelation: b } });
  }
  return out;
}

/** Части без здания вокруг: контуры — загруженные и созданные в сессии, с правками сессии. */
function orphanPartIssues(scope: Feature3D[]): Issue[] {
  const parts = scope.filter((f) => f.kind === 'part');
  if (!parts.length) return [];
  const buildings = [...overpass.allFeatures(), ...createdShapes()]
    .filter((f) => !session.isDeleted(f.key))
    .map((f) => (session.has(f.key) ? (session.get(f.key) as Feature3D | undefined) ?? f : f));
  return timed('проверка частей без здания', () => validateOrphanParts(parts, buildings, (key) => !!groupOf(key)), (r) => `${r.length}`);
}

/** Копии объектов других зданий (совпадающие контуры): scope — что проверяем, all — с чем сравниваем. */
function duplicateIssues(scope: Feature3D[], all: Feature3D[]): Issue[] {
  const live = (fs: Feature3D[]) => fs.filter((f) => !session.isDeleted(f.key));
  return timed('проверка копий', () => validateDuplicates(live(scope), live(all), (key) => groupOf(key)?.key ?? key), (r) => `${r.length}`);
}

/** Принадлежность проблемы зданию для группировки в режиме карты. */
function issueBuildingKey(issue: Issue): string {
  return groupOf(issue.key)?.key ?? issue.fix?.removeFromGroup ?? issue.fix?.addToGroup ?? issue.key;
}

/** Пауза без новых зданий и сдвигов карты, после которой считается проверка карты, мс. */
const MAP_ISSUES_QUIET_MS = 400;
/** Дольше этого от первого запроса проверку не откладываем (тайлы идут непрерывно), мс. */
const MAP_ISSUES_MAX_WAIT_MS = 3000;
let mapIssuesSince = 0;

/**
 * Проверка карты (сотни мс на плотном районе) — когда всё улеглось: пока приходят тайлы и строятся здания,
 * каждый приход сдвигает её, а запуск — в простое браузера. Раньше она шла через 150 мс после каждого
 * тайла и отнимала у загрузки секунды основного потока.
 */
function scheduleMapIssues() {
  if (focus) return;
  mapIssuesDirty = true;
  const now = performance.now();
  if (!mapIssuesTimer) mapIssuesSince = now;
  clearTimeout(mapIssuesTimer);
  const wait = Math.max(0, Math.min(MAP_ISSUES_QUIET_MS, mapIssuesSince + MAP_ISSUES_MAX_WAIT_MS - now));
  mapIssuesTimer = setTimeout(() => {
    const run = () => {
      mapIssuesTimer = undefined;
      if (!focus) renderIssues();
    };
    if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 1000 });
    else run();
  }, wait);
}
map.on('moveend', scheduleMapIssues);

/** Значок проблем в строке списка: ошибка — красный, предупреждение — жёлтый; текст — во всплывающей подсказке. */
function issueMark(list: Issue[] | undefined): string {
  if (!list?.length) return '';
  const error = list.some((i) => i.level === 'error');
  return `<span class="issue-mark ${error ? 'error' : 'warning'}" title="${esc(list.map((i) => i.text).join('\n'))}">${error ? '✖' : '⚠'}</span>`;
}

/** Панель «Проверка»: проблемы здания режима здания, клик — выделить объект (Shift — оба пересекающихся). */
function renderIssues() {
  const simpleIssues = focus ? [...buildingIssues(focus), ...(isSolo(focus) ? [...orphanPartIssues(groupFeatures(focus)), ...implicitIssues(groupFeatures(focus).filter((f) => f.kind === 'part').slice(0, 1))] : strayPartsOf(focus))] : [];
  const focusedBuilding = focus;
  const indoorAll = focusedBuilding ? buildingIndoor(focusedBuilding) : [];
  const indoorIssues = focusedBuilding ? [...indoorAll.flatMap((f) => validateIndoor(f, isInteriorDoor(f, focusedBuilding))), ...validateRepeatedRooms(indoorAll), ...validateStackedEscalators(indoorAll)] : [];
  const duplicates = focusedBuilding ? duplicateIssues(groupFeatures(focusedBuilding), overpass.renderedFeatures().map((r) => r.feature)) : [];
  focusIssues = [...simpleIssues, ...duplicates, ...indoorIssues];
  // Слой зданий выключен — проверку карты не считаем (пересчитаем, когда включат)
  if (!focus && !buildingsView.shown) mapIssues = [];
  else if (!focus && mapIssuesDirty) { mapIssues = timed('проверка карты', visibleMapIssues, (r) => `${r.length}`); mapIssuesDirty = false; }
  // Есть выбор — только проблемы выбранных объектов (в режиме здания само здание целиком не фильтрует)
  const picked = issueFilterKeys();
  if (focus) picked.delete(focus.key);
  issueFilterSig = [...issueFilterKeys()].sort().join(',');
  const mine = (i: Issue) => !picked.size || picked.has(i.key) || (!!i.other && picked.has(i.other))
    || (!focus && picked.has(issueBuildingKey(i)));
  const simpleShown = simpleIssues.filter(mine), indoorShown = indoorIssues.filter(mine);
  const currentIssues = (focus ? focusIssues : mapIssues).filter(mine);
  // Список пересобирается — строки под курсором уже нет, превью исправления снимаем
  if (fixPreviewed) { fixPreviewed = undefined; overpassLayer.setFixPreview(undefined); }
  hoveredIssue = undefined;
  issuesPanel.hidden = !currentIssues.length;
  if (issuesPanel.hidden) { issuesEl.innerHTML = ''; shownIssues = []; selectedIssueIds.clear(); highlightIssues(); return; }
  const errors = currentIssues.filter((i) => i.level === 'error').length;
  const warnings = currentIssues.length - errors;
  issuesCount.textContent = `(${[errors ? tr('ошибок {n}', { n: errors }) : '', warnings || !errors ? tr('предупреждений {n}', { n: warnings }) : ''].filter(Boolean).join(', ')})`;
  const sorted = (list: Issue[]) => [...list].sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1));
  const mapGroups = new Map<string, Issue[]>();
  if (!focus) for (const issue of currentIssues) {
    const key = issueBuildingKey(issue);
    (mapGroups.get(key) ?? mapGroups.set(key, []).get(key)!).push(issue);
  }
  shownIssues = focus ? [...sorted(simpleShown), ...sorted(indoorShown)] : [...mapGroups.values()].flatMap(sorted);
  const currentIds = new Set(shownIssues.map(issueId));
  for (const id of selectedIssueIds) if (!currentIds.has(id)) selectedIssueIds.delete(id);
  const group = (title: string, list: Issue[], start: number, buildingKey?: string) => list.length ? `<section class="issue-group${buildingKey ? ' issue-building' : ''}${buildingKey && selection.includes(buildingKey) ? ' selected' : ''}"${buildingKey ? ` data-building-key="${esc(buildingKey)}"` : ''}>
    <h2>${esc(title)} <span class="hint">(${list.length})</span></h2>
    <ul class="issue-list">${list.map((i, offset) => {
      const n = start + offset;
      return `<li class="${i.level}${selection.includes(i.key) || (i.other && selection.includes(i.other)) ? ' selected' : ''}${selectedIssueIds.has(issueId(i)) ? ' issue-picked' : ''}" data-i="${n}" data-key="${esc(i.key)}"${i.other ? ` data-other="${esc(i.other)}"` : ''}>
        <span class="issue-icon">${i.level === 'error' ? '✖' : '⚠'}</span>
        <span class="issue-text">${esc(i.text)}<span class="ol-key">${esc(i.key)}</span></span>
        ${i.fix ? `<button type="button" class="issue-fix" data-i="${n}" title="${tr('Исправить: {fix}', { fix: esc(i.fix.label) })}">${tr('Исправить')}</button>` : ''}</li>`;
    }).join('')}</ul></section>` : '';
  issuesEl.innerHTML = focus ? group('Simple 3D', shownIssues.slice(0, simpleShown.length), 0)
    + group('Indoor', shownIssues.slice(simpleShown.length), simpleShown.length)
    : [...mapGroups].map(([key, list], i, all) => group(key, sorted(list), all.slice(0, i).reduce((n, [, prev]) => n + prev.length, 0), key)).join('');
  const fixable = shownIssues.filter((i) => i.fix && selectedIssueIds.has(issueId(i))).length;
  issuesFixAll.hidden = !fixable;
  issuesFixAll.textContent = tr('Исправить выделенное ({n})', { n: fixable });
  highlightIssues();
}

/** Выбранные объекты (части, здания, indoor): панель проверки показывает только их проблемы. */
function issueFilterKeys(): Set<string> {
  return new Set([...selection, ...indoorSelection.map((f) => indoorKey(f.key))]);
}
let issueFilterSig = '';
/** Выбор сменился — пересобрать список проблем под него. */
function syncIssueFilter() {
  const sig = [...issueFilterKeys()].sort().join(',');
  if (sig === issueFilterSig) return;
  issueFilterSig = sig;
  renderIssues();
}

/**
 * Точки проблем (где контур пересекает сам себя) — кружками поверх сцены: на рёбрах их не разглядеть.
 * В режиме здания — на высоте низа объекта.
 */
const issuePointsEl = document.createElement('div');
issuePointsEl.className = 'issue-points';
map.getContainer().appendChild(issuePointsEl);
let issuePoints: { p: [number, number]; key: string; level: 'error' | 'warning' }[] = [];
function setIssuePoints(active: Issue[]) {
  issuePoints = active.flatMap((i) => (i.points ?? []).map((p) => ({ p, key: i.key, level: i.level })));
  issuePointsEl.innerHTML = issuePoints.map((x) => `<div class="issue-point ${x.level}"></div>`).join('');
  placeIssuePoints();
}
function placeIssuePoints() {
  issuePoints.forEach((x, i) => {
    const el = issuePointsEl.children[i] as HTMLElement | undefined;
    if (!el) return;
    const local = focus ? overpassLayer.focusToLocal(x.p) : undefined;
    const at = local ? overpassLayer.focusProject(new THREE.Vector3(local[0], local[1], shapeWalls(x.key)?.min ?? 0))
      : (({ x: px, y: py }) => [px, py] as [number, number])(map.project(x.p));
    el.hidden = !at;
    if (at) { el.style.left = `${at[0]}px`; el.style.top = `${at[1]}px`; }
  });
}
map.on('render', () => { if (issuePoints.length) placeIssuePoints(); });

/** «Подсветить все»: рёбра объёмов с проблемами (ошибка важнее предупреждения). */
let highlightedIssueLevels = new Map<string, 'error' | 'warning'>();
let highlightedIssueAreas = new Set<Issue>();
function highlightIssues() {
  const levels = new Map<string, 'error' | 'warning'>();
  const selected = shownIssues.filter((issue) => selectedIssueIds.has(issueId(issue)));
  const active = [...(issuesAll.checked ? focus ? focusIssues : mapIssues : []), ...selected, ...(hoveredIssue ? [hoveredIssue] : [])];
  for (const issue of active) {
    for (const key of [issue.key, issue.other]) if (key && levels.get(key) !== 'error') levels.set(key, issue.level);
  }
  const indoorKeys = focus ? [...levels.keys()].filter((key) => !!buildingIndoorFor(key)) : [];
  overpassLayer.setIndoorIssueHighlight(indoorKeys);
  indoorPois.setIssueHighlight(indoorKeys);
  if (levels.size === highlightedIssueLevels.size && [...levels].every(([key, level]) => highlightedIssueLevels.get(key) === level)
    && active.filter((i) => i.area).every((i) => highlightedIssueAreas.has(i)) && highlightedIssueAreas.size === active.filter((i) => i.area).length) { setIssuePoints(active); return; }
  highlightedIssueAreas = new Set(active.filter((i) => i.area));
  highlightedIssueLevels = levels;
  setIssuePoints(active);
  overpassLayer.setIssueHighlight(levels, active.filter((i) => i.area).map((i) => ({ key: i.key, level: i.level, polygons: i.area! })));
}

function syncSelectedIssues() {
  for (const li of issuesEl.querySelectorAll<HTMLElement>('li[data-i]')) {
    const issue = shownIssues[Number(li.dataset.i)];
    li.classList.toggle('issue-picked', !!issue && selectedIssueIds.has(issueId(issue)));
    li.classList.toggle('selected', !!issue && (selection.includes(issue.key) || (!!issue.other && selection.includes(issue.other))));
  }
  const count = shownIssues.filter((issue) => issue.fix && selectedIssueIds.has(issueId(issue))).length;
  issuesFixAll.hidden = !count;
  issuesFixAll.textContent = tr('Исправить выделенное ({n})', { n: count });
  highlightIssues();
}

issuesAll.addEventListener('change', () => {
  try { localStorage.setItem(focus ? issuesAllBuildingKey : issuesAllMapKey, issuesAll.checked ? '1' : '0'); } catch { /* не запомним */ }
  highlightIssues();
});

/** Применить исправления одним шагом истории; исправления одного объекта накладываются по очереди. */
function applyFixes(list: Issue[]) {
  const splits = list.filter((i) => i.fix?.splitLevels);
  if (splits.length) void splitRoomsByLevel(splits);
  list = list.filter((i) => !i.fix?.splitLevels);
  if (list.some((i) => i.fix?.growOutline)) {
    // Одно расширение на здание, сколько бы частей ни выходило; только в режиме этого здания
    const grow = list.find((i) => i.fix?.growOutline)!;
    if (focus && groupOf(grow.key)?.key === focus.key) fixOutline();
    else setStatus(tr('Откройте здание, чтобы расширить его контур.'), true);
    list = list.filter((i) => !i.fix?.growOutline);
  }
  const tags = new Map<string, Record<string, string>>();
  const removals = new Map<string, Set<string>>();
  const additions = new Map<string, Set<string>>();
  for (const i of list) {
    let f = entity(i.key);
    if (!f && focus) {
      const indoor = buildingIndoorFor(i.key);
      if (indoor) { trackIndoor(i.key, indoor); f = session.get(i.key); }
    }
    if (!i.fix || !f) continue;
    const t = tags.get(i.key) ?? tags.set(i.key, { ...f.tags }).get(i.key)!;
    for (const [k, v] of Object.entries(i.fix.tags)) if (v === undefined) delete t[k]; else t[k] = v;
    if (i.fix.removeFromGroup) {
      const keys = removals.get(i.fix.removeFromGroup) ?? new Set<string>();
      keys.add(i.key);
      removals.set(i.fix.removeFromGroup, keys);
    }
    if (i.fix.addToGroup) (additions.get(i.fix.addToGroup) ?? additions.set(i.fix.addToGroup, new Set()).get(i.fix.addToGroup)!).add(i.key);
  }
  if (!tags.size) return;
  const edits: ObjectEdit[] = [...tags].map(([key, t]) => ({ key, tags: t }));
  for (const i of list) {
    const b = i.fix?.createRelation;
    if (b && !groupOf(b.outline)) { const g = implicitRelation(b.outline, b.parts); edits.push({ key: g.key, create: g }); }
  }
  for (const key of new Set([...removals.keys(), ...additions.keys()])) {
    const group = entity(key) as EditGroup | undefined;
    if (!group) continue;
    const gone = removals.get(key) ?? new Set<string>();
    const have = new Set(group.relMembers.map((m) => `${m.type}/${m.ref}`));
    const added = [...additions.get(key) ?? []].filter((k) => !have.has(k)).map((k) => {
      const [type, ref] = k.split('/');
      return { type: type as 'way' | 'relation', ref: Number(ref), role: 'part' };
    });
    edits.push({ key, tags: { ...group.tags }, members: [...group.relMembers.filter((m) => !gone.has(`${m.type}/${m.ref}`)), ...added] });
  }
  session.editMany(edits);
  setStatus(list.length > 1 ? tr('Применено исправлений: {n} (объектов: {objects}).', { n: list.length, objects: tags.size }) : tr('Исправлено: {fix}.', { fix: list[0].fix!.label }));
}

/**
 * Помещения, записанные одним объектом на несколько этажей, — копия на каждый этаж одним шагом истории.
 * Путь копируется с теми же узлами, мультиполигон — новым отношением с теми же членами; копии встают
 * в те же отношения здания, что и исходный объект. Сам объект остаётся на нижнем этаже.
 */
async function splitRoomsByLevel(list: Issue[]) {
  const api = server().api, stamp = JSON.stringify(session.changes());
  const rels = list.filter((i) => i.key.startsWith('relation/') && Number(i.key.split('/')[1]) > 0).map((i) => i.key);
  let fetched: Awaited<ReturnType<typeof fetchElements>>;
  try { fetched = rels.length ? await fetchElements(rels, api) : new Map(); } catch (e) { setStatus(String(e), true); return; }
  if (server().api !== api || JSON.stringify(session.changes()) !== stamp) return setStatus(tr('Данные изменились. Повторите исправление.'), true);
  const edits: ObjectEdit[] = [];
  const created: IndoorFeature[] = [];
  const groupMembers = new Map<string, OsmMember[]>();
  for (const i of list) {
    const f = buildingIndoorFor(i.key);
    if (!f) continue;
    const [type, id] = [i.key.split('/')[0], Number(i.key.split('/')[1])];
    let members: OsmMember[] | undefined;
    if (type === 'relation') {
      const r = id > 0 ? fetched.get(i.key) : session.get(i.key);
      members = r && 'members' in r ? r.members : (r as { relMembers?: OsmMember[] } | undefined)?.relMembers;
      if (!members) { setStatus(tr('Не удалось получить члены {key}.', { key: i.key }), true); return; }
    } else if (f.polygons.length !== 1 || (!f.polygons[0].outerIds && !i.fix!.splitNewNodes)) {
      setStatus(tr('Геометрия {key} недоступна. Перезагрузите данные.', { key: i.key }), true); return;
    }
    trackIndoor(i.key, f);
    const tags = { ...(session.get(i.key)?.tags ?? f.tags), ...i.fix!.tags } as Record<string, string>;
    edits.push({ key: i.key, tags });
    for (const l of i.fix!.splitLevels!) {
      const copyTags = { ...tags, level: l };
      const newId = nextNewId--, key = `${type}/${newId}`;
      if (type === 'way') {
        const p = f.polygons[0];
        // Ось (незамкнутая линия) — на новых узлах; контур — на тех же узлах, замкнутый
        const line = i.fix!.splitNewNodes ? { ids: p.outer.map(() => nextNewId--), coords: p.outer.slice() }
          : { ids: [...p.outerIds!, p.outerIds![0]], coords: [...p.outer, p.outer[0]] };
        edits.push({ key, create: { key, version: 0, tags: copyTags, line, polygons: f.polygons } });
      } else edits.push({ key, create: { key, version: 0, tags: copyTags, relMembers: members!.map((m) => ({ ...m })), polygons: f.polygons } });
      created.push({ ...f, key, tags: copyTags, levels: parseLevels(l) });
      for (const g of editGroups.values()) {
        const cur = groupMembers.get(g.key) ?? g.relMembers;
        const at = cur.findIndex((m) => `${m.type}/${m.ref}` === i.key);
        if (at < 0) continue;
        groupMembers.set(g.key, [...cur.slice(0, at + 1), { type: type as 'way' | 'relation', ref: newId, role: cur[at].role }, ...cur.slice(at + 1)]);
      }
    }
  }
  if (!created.length) return;
  for (const [key, members] of groupMembers) edits.push({ key, tags: { ...editGroups.get(key)!.tags }, members });
  for (const f of created) { indoorCreated.set(f.key, f); indoorEdited.add(f.key); }
  session.editMany(edits);
  setStatus(tr('Разделено по этажам: {n} копий. Отменить — Ctrl+Z.', { n: created.length }));
}

issuesFixAll.addEventListener('click', () => applyFixes(shownIssues.filter((i) => i.fix && selectedIssueIds.has(issueId(i)))));

/** Пролёт к зданию проблемы без перехода в режим отдельного здания. */
function flyToIssueBuilding(issue: Issue) {
  const key = issueBuildingKey(issue);
  const group = groupOf(key);
  const features = group ? groupFeatures(group) : [entity(key) as Feature3D | undefined];
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const f of features) for (const poly of f?.polygons ?? []) for (const [lon, lat] of poly.outer) {
    w = Math.min(w, lon); s = Math.min(s, lat); e = Math.max(e, lon); n = Math.max(n, lat);
  }
  if (!Number.isFinite(w)) return;
  const camera = map.cameraForBounds([[w, s], [e, n]], { padding: 90, maxZoom: 19 });
  if (camera) map.flyTo({ center: camera.center, zoom: camera.zoom, duration: 900, essential: true });
}

issuesEl.addEventListener('click', (e) => {
  const fix = (e.target as HTMLElement).closest<HTMLElement>('.issue-fix');
  if (fix) { applyFixes([shownIssues[Number(fix.dataset.i)]]); return; }
  const li = (e.target as HTMLElement).closest<HTMLElement>('li[data-key]');
  if (!li) return;
  const issue = shownIssues[Number(li.dataset.i)];
  if (!issue) return;
  const id = issueId(issue);
  if (e.shiftKey) {
    if (selectedIssueIds.has(id)) selectedIssueIds.delete(id); else selectedIssueIds.add(id);
    syncSelectedIssues();
    return;
  }
  selectedIssueIds.clear();
  selectedIssueIds.add(id);
  syncSelectedIssues();
  const indoor = buildingIndoorFor(li.dataset.key!);
  if (indoor) {
    if (!shownIndoor.some((f) => f.key === indoor.key)) { currentLevel = indoor.levels[0]; renderLevels(); }
    selectIndoor(indoor, false);
    return;
  }
  if (!entity(li.dataset.key!)) return;
  if (!focus && issue) {
    select(issueBuildingKey(issue));
    flyToIssueBuilding(issue);
    return;
  }
  select(li.dataset.key);
  if (li.dataset.other && entity(li.dataset.other)) toggleSelection(li.dataset.other);
});
issuesEl.addEventListener('mouseover', (e) => {
  const li = (e.target as HTMLElement).closest<HTMLElement>('li[data-key]');
  overpassLayer.setHover(li?.dataset.key);
  // С автоисправлением — ещё и каркас объёма после него (если геометрия изменится)
  const issue = li ? shownIssues[Number(li.dataset.i)] : undefined;
  if (hoveredIssue !== issue) { hoveredIssue = issue; highlightIssues(); }
  if (issue === fixPreviewed) return;
  if (fixPreviewed?.fix?.growOutline || issue?.fix?.growOutline) previewGrownOutline(!!issue?.fix?.growOutline);
  fixPreviewed = issue;
  if (issue?.fix?.growOutline) return overpassLayer.setFixPreview(undefined);
  const f = issue?.fix ? liveFeatures().find((x) => x.key === issue.key) : undefined;
  if (!f || !issue?.fix) return overpassLayer.setFixPreview(undefined);
  const tags = { ...f.tags };
  for (const [k, v] of Object.entries(issue.fix.tags)) if (v === undefined) delete tags[k]; else tags[k] = v;
  overpassLayer.setFixPreview({ ...f, tags });
});
issuesEl.addEventListener('mouseout', (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('li[data-key]');
  if (!row || (e.relatedTarget instanceof Node && row.contains(e.relatedTarget))) return;
  hoveredIssue = undefined;
  highlightIssues();
  overpassLayer.setHover(undefined);
});
issuesEl.addEventListener('mouseleave', () => {
  overpassLayer.setHover(undefined);
  hoveredIssue = undefined;
  highlightIssues();
  if (fixPreviewed?.fix?.growOutline) previewGrownOutline(false);
  fixPreviewed = undefined;
  overpassLayer.setFixPreview(undefined);
});

/** Проблемы изменённых объектов (для «Правок» перед отправкой): по зданиям, куда они входят. */
function changeIssues(keys: string[]): Issue[] {
  const changed = new Set(keys), seen = new Set<string>(), out: Issue[] = [];
  for (const k of keys) {
    if (indoorEdited.has(k)) {
      const f = session.get(k);
      if (f) {
        const indoor = buildingIndoorFor(k);
        out.push(...validateIndoor({ key: k, tags: f.tags }, !!indoor && !!focus && isInteriorDoor(indoor, focus)));
      }
      continue;
    }
    const g = groupOf(k) ?? soloGroup(k);
    if (!g || seen.has(g.key)) continue;
    seen.add(g.key);
    for (const i of buildingIssues(g)) if (changed.has(i.key) || (i.other && changed.has(i.other))) out.push(i);
  }
  return out;
}

/** Ключ свёрнутой группы «Двери» (рядом с подписями видов частей). */
const DOORS_GROUP = '\u0000doors';
const ICON_DOOR = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M3.5 14.5V2.5h9v12M1.5 14.5h13"/><circle cx="10" cy="8.5" r="0.6" fill="currentColor"/></svg>';

function renderOutliner() {
  renderLevels();
  queueMicrotask(() => renderMobileCard()); // вход в режим здания и выход — карточка мобильного режима
  outlinerPanel.hidden = !focus;
  renderIssues();
  if (!focus) { outlinerEl.innerHTML = ''; return; }
  const g = focus;
  const issueOf = new Map<string, Issue[]>();
  for (const i of focusIssues) (issueOf.get(i.key) ?? issueOf.set(i.key, []).get(i.key)!).push(i);
  const rows = g.members.map((key, i) => {
    const f = entity(key);
    const outline = g.roles[i] === 'outline';
    return { key, f, outline, kind: partKind(f?.tags ?? {}, outline) };
  });
  // Порядок: контур, крыши, прочие виды (как встретились), обычные части (building:part=yes) — в конце
  const rank = (r: (typeof rows)[number]) => r.kind.order;
  rows.sort((a, b) => rank(a) - rank(b));
  outlinerCount.textContent = `(${rows.length})`;
  const row = (r: (typeof rows)[number], child: boolean) => {
    const off = focusHidden.has(r.key), dated = focusDated.has(r.key);
    const cls = [child && 'ol-child', selection.includes(r.key) && 'selected', off && 'off', dated && 'dated', !r.f && 'missing'].filter(Boolean).join(' ');
    const title = !r.f ? tr('{key} — не загружен', { key: r.key })
      : dated ? tr('{key} — нет на дату {date} (слайдер времени)', { key: r.key, date: ohm.date }) : r.key;
    return `<li class="${cls}" data-key="${esc(r.key)}" title="${esc(title)}">
      <span class="ol-icon" title="${esc(r.kind.title)}">${r.kind.icon}</span>
      <span class="ol-label">${child && !r.f?.tags.name ? `<span class="ol-key bare">${esc(r.key)}</span>` : `${esc(r.f?.tags.name ?? r.kind.label)}<span class="ol-key">${esc(r.key)}</span>`}</span>
      ${issueMark(issueOf.get(r.key))}
      <button type="button" class="ol-eye" data-eye title="${off ? tr('Показать') : tr('Скрыть')}">${off ? ICON_EYE_OFF : ICON_EYE}</button></li>`;
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
    const live = keys.filter((k) => entity(k) && !hiddenInFocus(k));
    const sel = live.length > 0 && live.every((k) => selection.includes(k));
    const cls = ['ol-group', collapsed && 'collapsed', sel && 'selected', allOff && 'off'].filter(Boolean).join(' ');
    html.push(`<li class="${cls}" data-group="${esc(r.kind.label)}" title="${tr('Выделить все: {kind}', { kind: esc(r.kind.label) })}">
      <button type="button" class="ol-toggle" data-toggle title="${collapsed ? tr('Развернуть') : tr('Свернуть')}">${ICON_CHEVRON}</button>
      <span class="ol-icon" title="${esc(r.kind.title)}">${r.kind.icon}</span>
      <span class="ol-label">${esc(r.kind.label)}<span class="ol-key">${keys.length}</span></span>
      <button type="button" class="ol-eye" data-eye title="${allOff ? tr('Показать все') : tr('Скрыть все')}">${allOff ? ICON_EYE_OFF : ICON_EYE}</button></li>`);
    if (!collapsed) for (const x of list) html.push(row(x, true));
  }
  // Двери — входы на фасаде (узлы контура с entrance=*): клик выбирает вход
  const doors = new Map<number, Record<string, string>>();
  for (const f of liveFeatures()) if (g.members.includes(f.key)) for (const e of f.entrances ?? []) doors.set(e.id, e.tags);
  if (doors.size) {
    const label = tr('Двери'), collapsed = collapsedKinds.has(DOORS_GROUP);
    html.push(`<li class="ol-group${collapsed ? ' collapsed' : ''}" data-doors title="${esc(label)}">
      <button type="button" class="ol-toggle" data-toggle title="${collapsed ? tr('Развернуть') : tr('Свернуть')}">${ICON_CHEVRON}</button>
      <span class="ol-icon">${ICON_DOOR}</span>
      <span class="ol-label">${esc(label)}<span class="ol-key">${doors.size}</span></span></li>`);
    if (!collapsed) for (const [id, t] of doors) {
      const name = t.ref ?? t.name ?? (t.entrance === 'yes' ? tr('Вход') : t.entrance);
      html.push(`<li class="ol-child${selectedEntrance === id ? ' selected' : ''}" data-entrance="${id}" title="node/${id}">
        <span class="ol-icon">${ICON_DOOR}</span><span class="ol-label">${esc(name)}<span class="ol-key">node/${id}</span></span></li>`);
    }
  }
  outlinerEl.innerHTML = html.join('');
}

// Двери: стрелка — свернуть, клик по двери — выбрать вход
outlinerEl.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  if (t.closest('li[data-doors]')) {
    e.stopImmediatePropagation();
    if (collapsedKinds.has(DOORS_GROUP)) collapsedKinds.delete(DOORS_GROUP); else collapsedKinds.add(DOORS_GROUP);
    try { localStorage.setItem('outliner-collapsed', JSON.stringify([...collapsedKinds])); } catch { /* только до перезагрузки */ }
    renderOutliner();
    return;
  }
  const li = t.closest<HTMLElement>('li[data-entrance]');
  if (!li) return;
  e.stopImmediatePropagation();
  selectEntrance(Number(li.dataset.entrance));
}, { capture: true });

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
  const live = keys.filter((k) => entity(k) && !hiddenInFocus(k));
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
map.getContainer().addEventListener('contextmenu', (e) => e.preventDefault(), { capture: true });
window.addEventListener('pointerup', (e) => {
  if (e.button !== 2 || !rightDown) return;
  const moved = Math.hypot(e.clientX - rightDown[0], e.clientY - rightDown[1]) > 4;
  rightDown = undefined;
  if (moved || moveTool.state === 'move' || pushTool.state === 'push') return;
  const rect = map.getCanvas().getBoundingClientRect();
  if (!rect.width || e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) return;
  ctxLngLat = map.unproject([e.clientX - rect.left, e.clientY - rect.top]);
  if (!focus) return openCtxMenu(e.clientX, e.clientY, 'map');
  const key = overpassLayer.pickHit([e.clientX - rect.left, e.clientY - rect.top])?.key;
  if (shownLevel) {
    const point: [number, number] = [e.clientX - rect.left, e.clientY - rect.top];
    const wall = roomWallAt(point);
    if (wall) {
      const span = JSON.stringify(roomWallSpan(shownIndoor.find((f) => f.key === wall.key)!.polygons, wall));
      if (!selectedRoomWalls.some((w) => w.key === wall.key
        && JSON.stringify(roomWallSpan(shownIndoor.find((f) => f.key === w.key)!.polygons, w)) === span)) selectRoomWall(wall);
      return openCtxMenu(e.clientX, e.clientY, 'indoor');
    }
    const room = indoorAt(point);
    if (room) {
      if (!indoorSelection.some((f) => indoorKey(f.key) === indoorKey(room.key))) selectIndoor(room);
      return openCtxMenu(e.clientX, e.clientY, 'indoor');
    }
  }
  // Мимо здания — меню режима: показать всё и выход
  if (!key || !focus.members.includes(key)) return openCtxMenu(e.clientX, e.clientY, 'empty');
  if (!selection.includes(key)) select(key);
  openCtxMenu(e.clientX, e.clientY, 'scene');
}, { capture: true });

/**
 * Меню частей. В сцене скрытые не выбрать — вместо «Показать» там «Показать всё скрытое»;
 * 'empty' — клик мимо здания: только «Показать всё» и выход.
 */
function openCtxMenu(x: number, y: number, where: 'list' | 'scene' | 'empty' | 'indoor' | 'map') {
  const yandex = `<li class="ctx-sep"></li><li><button type="button" data-ctx="yandex-pano">${tr('Открыть Яндекс Панорамы здесь')}</button></li>`;
  if (where === 'map') {
    ctxMenu.innerHTML = yandex.replace('<li class="ctx-sep"></li>', '');
    return placeCtxMenu(x, y);
  }
  if (!focus) return;
  const hiddenCount = focusHidden.size + indoorHidden.size;
  const showAll = `<li><button type="button" data-ctx="show-all"${hiddenCount ? '' : ' disabled'}>${tr('Показать всё')}${hiddenCount ? ` (${hiddenCount})` : ''}<kbd>⇧H</kbd></button></li>`;
  if (where === 'indoor') {
    const count = indoorSelection.length + selectedRoomWalls.length;
    const n = count > 1 ? ` (${count})` : '';
    ctxMenu.innerHTML = `<li><button type="button" data-ctx="indoor-hide"${indoorSelection.length ? '' : ' disabled'}>${tr('Скрыть объекты')}${n}<kbd>H</kbd></button></li>`
      + showAll
      + (indoorSelection.length > 1 && indoorSelection.every(isDeletableSpace)
        ? `<li><button type="button" data-ctx="indoor-merge">${tr('Объединить')}${n}<kbd>J</kbd></button></li>` : '')
      + (indoorSelection.length && shownLevel ? `<li><button type="button" data-ctx="indoor-repeat">${tr('Повторять на этажах…')}${n}</button></li>` : '')
      + `<li><button type="button" data-ctx="indoor-delete"${canDeleteIndoorSelection() && !uploading && !deletingIndoorWalls ? '' : ' disabled'}>${
        indoorSelection.length && !selectedRoomWalls.length && indoorSelection.every(isDeletableSpace) ? tr('Очистить (сделать пустым)') : tr('Удалить')}${n}<kbd>Del</kbd></button></li>`;
    return placeCtxMenu(x, y);
  }
  const inScene = where !== 'list';
  const kbd = (k: string) => `<kbd>${k}</kbd>`;
  const snaps = `<li class="ctx-sep"></li><li><button type="button" data-ctx="snaps">${overpassLayer.snapsEnabled ? tr('Выключить привязки') : tr('Включить привязки')}${kbd('S')}</button></li>`;
  const exit = inScene ? `<li class="ctx-sep"></li><li><button type="button" data-ctx="exit">${tr('Выйти из режима редактирования')}${kbd('Esc')}</button></li>` : '';
  const keys = selection.filter((k) => focus!.members.includes(k));
  const anyShown = keys.some((k) => !focusHidden.has(k)), anyHidden = keys.some((k) => focusHidden.has(k));
  const n = keys.length > 1 ? ` (${keys.length})` : '';
  ctxMenu.innerHTML = where === 'empty' ? `
    ${showAll}${snaps}${yandex}${exit}` : `
    <li><button type="button" data-ctx="hide"${anyShown ? '' : ' disabled'}>${tr('Скрыть объекты')}${n}${kbd('H')}</button></li>
    <li><button type="button" data-ctx="isolate"${keys.length && focus.members.some((k) => !keys.includes(k) && !focusHidden.has(k)) ? '' : ' disabled'}>${tr('Изолировать')}${n}${kbd('I')}</button></li>
    ${inScene
      ? showAll
      : `<li><button type="button" data-ctx="show"${anyHidden ? '' : ' disabled'}>${tr('Показать объекты')}${n}</button></li>`}
    <li><button type="button" data-ctx="exclude"${keys.length ? '' : ' disabled'}>${tr('Исключить из модели')}${n}</button></li>
    <li><button type="button" data-ctx="delete"${keys.length ? '' : ' disabled'}>${tr('Удалить')}${n}${kbd('Del')}</button></li>${inScene ? '' : showAll}${snaps}${exit}`;
  placeCtxMenu(x, y);
}

function placeCtxMenu(x: number, y: number) {
  ctxMenu.hidden = false;
  // Не выходим за край окна
  const { width, height } = ctxMenu.getBoundingClientRect();
  ctxMenu.style.left = `${Math.min(x, innerWidth - width - 4)}px`;
  ctxMenu.style.top = `${Math.min(y, innerHeight - height - 4)}px`;
}

/** Точка последнего правого клика по карте — для перехода на панорамы. */
let ctxLngLat: maplibregl.LngLat | undefined;

/**
 * Яндекс Панорамы — только переходом на сайт Яндекс Карт: условия API не разрешают показывать их панорамы
 * поверх чужих карт (п. 6.1.1), а для OSM разрешено лишь обрисовывать увиденное на снимках. Направление взгляда —
 * как у камеры карты; Яндекс сам откроет ближайшую к точке панораму.
 */
function openYandexPanorama(at: maplibregl.LngLat) {
  const ll = `${at.lng.toFixed(6)},${at.lat.toFixed(6)}`;
  const dir = ((map.getBearing() % 360) + 360) % 360;
  const q = `ll=${ll}&z=18&l=stv%2Csta&panorama%5Bpoint%5D=${ll}&panorama%5Bdirection%5D=${dir.toFixed(1)}%2C0&panorama%5Bspan%5D=120%2C60`;
  window.open(`https://yandex.ru/maps/?${q}`, '_blank', 'noopener');
}

ctxMenu.addEventListener('click', (e) => {
  const button = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-ctx]:not(:disabled)');
  const action = button?.dataset.ctx;
  if (action === 'yandex-pano') {
    closeCtxMenu();
    if (ctxLngLat) openYandexPanorama(ctxLngLat);
    return;
  }
  if (!action || !focus) return;
  closeCtxMenu();
  if (action === 'indoor-hide') return hideSelectedIndoor();
  if (action === 'indoor-delete') return deleteIndoorSelection();
  if (action === 'indoor-merge') return mergeSelected();
  if (action === 'indoor-repeat') return openRepeatDialog();
  focusAction(action);
});

// Панель «Помощь»: краткая подсказка по включённому инструменту; кнопка «?» показывает и скрывает её
const helpPanel = document.getElementById('help-panel')!;
const helpEl = document.getElementById('help')!;
const helpTool = document.getElementById('help-tool')!;
const helpBtns = document.querySelectorAll<HTMLButtonElement>('[data-help]');
type HelpTopic = { title: string; desc: string; items: string[] };
const HELP: Record<string, HelpTopic> = {
  map: { title: tr('Карта'), desc: tr('Просмотр зданий из OSM в 3D. Выделенное здание можно править в панели «Свойства» или открыть в режиме здания.'), items: [
    tr('Клик — выделить здание, Shift+клик — добавить к выделению, Alt+клик — следующий объект под курсором.'),
    tr('Двойной клик по зданию — режим здания (правка частей).'),
    tr('R — новое здание прямоугольником, L — полигоном, C — кругом, N — правильным многоугольником. Delete — удалить, Ctrl+Z — отменить.'),
    tr('Перетаскивание правой кнопкой — поворот и наклон карты.'),
  ] },
  focus: { title: tr('Режим здания'), desc: tr('Одно здание отдельно от карты: его части, контур и правка геометрии инструментами слева.'), items: [
    tr('Клик — выделить часть, Shift+клик — добавить к выделению, Alt+клик — следующая под курсором.'),
    tr('Перетаскивание правой или средней кнопкой (или Ctrl+левой) — облёт вокруг точки под курсором.'),
    tr('M — переместить, Q — повернуть, A — выровнять углы (90°), P — вытянуть, K — рассечь, J — объединить, R / L / C / N — новая часть (прямоугольник, полигон, круг, многоугольник), O — отступ, T — рулетка, B — заливка.'),
    tr('Пробел — выключить инструмент. G — сетка, S — привязки, D — направление ската, H — скрыть часть, I — изолировать выделенные, Shift+H — показать все.'),
    tr('Ctrl+C / Ctrl+V — копировать и вставить части, Delete — удалить, Ctrl+Z — отменить.'),
    tr('Двойной клик по части — изолировать её (остальные скрыты); двойной клик мимо здания — показать все части, а если скрытых нет — назад к карте.'),
    tr('Esc — снять выделение, ещё раз — назад к карте.'),
  ] },
  move: { title: tr('Переместить (M)'), desc: tr('Сдвигает выделенные части по горизонтали или вертикали, как Move в SketchUp. D — общие с соседями узлы: «с соседями» — соседи того же уровня тянутся следом, «отдельно» — часть отделяется от них.'), items: [
    tr('Клик по точке выделенной части — точка захвата, второй клик — применить; выделенные части едут вместе.'),
    tr('Если ничего не выделено, первый клик выбирает часть, следующий — точка захвата на ней.'),
    tr('Вдоль оси здания движение прилипает к ней; Shift держит ось, стрелки фиксируют ось (→ x, ← y, ↑ z, ↓ — снять).'),
    tr('Число + Enter — сдвиг в метрах. Привязка к точкам других объектов.'),
    tr('Esc — отмена.'),
  ] },
  rotate: { title: tr('Повернуть (Q)'), desc: tr('Поворачивает выделенные части вокруг вертикальной оси; направление ската (roof:direction) поворачивается вместе с частью. D — общие с соседями узлы: «с соседями» — соседи того же уровня тянутся следом, «отдельно» — часть отделяется от них.'), items: [
    tr('Клик — ось поворота (с привязкой к вершине, центру, сетке), второй клик — опорное направление.'),
    tr('Ведите курсор: у кратных 15° угол прилипает, Shift — только шагом 15°, привязка к точке — направление точно на неё.'),
    tr('Клик — применить; число + Enter — угол в градусах (против часовой, минус — по часовой). Esc — отмена.'),
  ] },
  scale: { title: tr('Масштаб (E)'), desc: tr('Масштабирует выделенные части в плане, как Scale в SketchUp; высоты не меняются. Направление ската (roof:direction) следует за контуром.'), items: [
    tr('Множитель: клик — базовая точка, второй клик — опорная (отрезок ×1), ведите курсор — множитель; Shift — только вдоль оси здания.'),
    tr('Клик — применить; число или процент (1.5, 150%) + Enter — множитель.'),
    tr('По двум точкам: точка на объекте и куда её поставить, затем так же вторая — перенос, поворот и масштаб сразу; Shift — без поворота.'),
    tr('Tab — способ; D — общие узлы с соседями или отдельно. Esc — отмена.'),
  ] },
  push: { title: tr('Вытянуть (P)'), desc: tr('Меняет высоту верха (height) или низа (min_height) части либо сдвигает одну стену, как Push/Pull в SketchUp.'), items: [
    tr('Клик по крыше — тянуть верх, по низу — низ, по стене — эту стену наружу или внутрь; второй клик — применить.'),
    tr('Shift — задняя грань под курсором: дно или дальняя стена.'),
    tr('Число + Enter — сдвиг (минус — внутрь или вниз); Tab — метры или этажи.'),
    tr('Привязка к точке другого объекта выравнивает грань по ней. Esc — отмена.'),
  ] },
  shape: { title: tr('Форма (V)'), desc: tr('Правит контур выделенной части по вершинам: вершина едет только в плане, объём и крыша перестраиваются.'), items: [
    tr('Клик по вершине выделенной части (на любой высоте ребра стены) — захват, второй клик — применить.'),
    tr('Клик по стороне у основания — новая вершина ровно на стороне; дальше её можно отвести (Esc — оставить на стороне).'),
    tr('Движение прилипает к осям здания и продолжениям сторон у вершины; Shift держит направление.'),
    tr('Число + Enter — сдвиг в метрах; D — общие узлы с соседями или отдельно.'),
    tr('Del — удалить вершину под курсором; вершина, подведённая к соседней, сливается с ней.'),
    tr('Shift+клик по вершине или Shift+рамка — выбрать несколько вершин основания: захват любой двигает все, Del удаляет все.'),
    tr('Бирюзовые ручки крыши (конёк, вершина) — только вверх или вниз: верх стен стоит, меняется высота крыши.'),
    tr('Фиолетовые ручки верха стен — только вверх или вниз: меняется высота стен, крыша едет целиком.'),
    tr('Клик не по вершине — выбрать другой объект. Esc — отмена.'),
  ] },
  split: { title: tr('Рассечь (K)'), desc: tr('Делит верхнюю грань части на две части с теми же тегами или вырезает в ней кольцо — дыру с новой частью внутри.'), items: [
    tr('Клик по ребру верхней грани — начало разреза, клики внутри грани — изгибы, клик по другому ребру той же грани — конец.'),
    tr('Первый клик внутри грани (не у ребра) — замкнутое кольцо: клик в первую точку его замыкает. Внутреннюю часть удалите (Del) — двор, или вытяните (P) — башня, атриум.'),
    tr('Backspace — убрать последнюю точку кольца, Shift — держать ось. Esc — отмена.'),
  ] },
  rect: { title: tr('Прямоугольник (R)'), desc: tr('Рисует новую часть — плоский прямоугольный контур; потом её можно вытянуть (P). На карте — новое отдельное здание.'), items: [
    tr('Клики — точки прямоугольника на земле или на плоской крыше (по первому клику).'),
    tr('Способ построения — во всплывашке у кнопки или Tab (первая точка сохраняется).'),
    tr('Число + Enter — длина стороны или «ширина;глубина». Shift — держать ось здания.'),
    tr('Esc — отмена.'),
  ] },
  polygon: { title: tr('Полигон (L)'), desc: tr('Рисует новую часть произвольной формы — плоский контур; потом её можно вытянуть (P). На карте — новое отдельное здание.'), items: [
    tr('Клики — вершины на земле или на плоской крыше; клик в первую вершину или Enter — замкнуть.'),
    tr('Число + Enter — длина текущей стороны, Backspace — убрать последнюю точку.'),
    tr('Shift — держать ось здания (на привязке «продолжение» — линию ребра). Esc — отмена.'),
  ] },
  circle: { title: tr('Круг (C)'), desc: tr('Рисует новую часть — плоский круглый контур; на карте — новое отдельное здание. Пока рисуете, круг гладкий, в данные он попадает многоугольником (вершин — по размеру: стороны отходят от окружности не больше чем на 10 см).'), items: [
    tr('Способ построения — во всплывашке у кнопки или Tab: по центру и радиусу; по двум касательным под 90° (клик — вершина прямого угла, касательные по осям здания, размер — курсором); по трём точкам (три клика — точки, через которые проходит окружность).'),
    tr('По центру: клик — центр на земле или на плоской крыше, второй клик — точка на окружности.'),
    tr('Число + Enter — радиус в метрах. Работают привязки к вершинам и рёбрам.'),
    tr('Esc — отмена.'),
  ] },
  ngon: { title: tr('Правильный многоугольник (N)'), desc: tr('Рисует новую часть — плоский правильный многоугольник; на карте — новое отдельное здание.'), items: [
    tr('Число углов — в поле «Углов» внизу (3–64), запоминается.'),
    tr('Клик — центр, второй клик — вершина (задаёт радиус и поворот).'),
    tr('Число + Enter — радиус в метрах. Esc — отмена.'),
  ] },
  offset: { title: tr('Отступ (O)'), desc: tr('Строит новый плоский контур, параллельный контуру плоской крыши или низа части, — например, для парапета, надстройки или козырька.'), items: [
    tr('Наведите на плоскую крышу (Shift — на низ части): контур отступает наружу или внутрь по стороне курсора.'),
    tr('Клик — новый плоский контур на высоте грани; число + Enter — отступ в метрах (минус — внутрь).'),
    tr('Новая часть берёт этажи или метры, как у исходной. Esc — отмена, повторный Esc — выйти.'),
  ] },
  measure: { title: tr('Рулетка (T)'), desc: tr('Измеряет расстояние между двумя точками; данные не меняет.'), items: [
    tr('Клик — первая точка, второй клик — вторая: расстояние, по горизонтали и по высоте.'),
    tr('Работают привязки; Shift — держать ось здания (x, y или вертикаль).'),
    tr('Esc — сбросить замер, повторный Esc — выйти.'),
  ] },
  pick: { title: tr('Заливка (B): взять образец'), desc: tr('Переносит цвет и материал с одной поверхности на другие. Сначала возьмите образец.'), items: [
    tr('Ctrl/Cmd/Alt+клик по крыше или стене — взять цвет и материал.'),
    tr('Крыша — roof:colour и roof:material, стена — building:colour и building:material.'),
  ] },
  paint: { title: tr('Заливка (B)'), desc: tr('Переносит цвет и материал с одной поверхности на другие. Образец взят — назначайте его поверхностям.'), items: [
    tr('Клик по крыше или стене — назначить взятые цвет и материал этой поверхности.'),
    tr('Ctrl/Cmd/Alt+клик — взять новый образец. Esc — выключить.'),
  ] },
};
let helpShown = false;
try { helpShown = localStorage.getItem('help-panel') === 'on'; } catch { /* по умолчанию скрыта */ }
let helpTopic = '';
function renderHelp() {
  helpPanel.hidden = !helpShown;
  for (const b of helpBtns) b.classList.toggle('active', helpShown);
  if (!helpShown) return;
  const key = moveTool.active ? 'move' : rotateTool.active ? 'rotate' : scaleTool.active ? 'scale' : pushTool.active ? 'push' : shapeTool.active ? 'shape' : splitTool.active ? 'split'
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
  ['vertex', tr('Вершины')], ['midpoint', tr('Середины рёбер')], ['center', tr('Центры')], ['edge', tr('На ребре')],
  ['perpendicular', tr('Перпендикуляр')], ['extension', tr('Продолжение ребра')], ['grid', tr('Узлы сетки')], ['shape', tr('Центр фигуры')],
  ['tracking', tr('Откладывание от вершины')],
];
try { for (const k of JSON.parse(localStorage.getItem('snaps-off') ?? '[]') as SnapKind[]) overpassLayer.snapKindsOff.add(k); } catch { /* нет хранилища */ }
snapsBtn.insertAdjacentHTML('beforeend', `<span class="flyout-arrow" data-flyout title="${tr('Типы привязок')}"></span>`);
let snapsFlyout: HTMLElement | undefined;
function closeSnapsFlyout() { snapsFlyout?.remove(); snapsFlyout = undefined; }
function renderSnapsFlyout() {
  if (!snapsFlyout) return;
  const off = overpassLayer.snapKindsOff;
  // «Все привязки» — включить все типы; доступен, только если какой-то выключен
  snapsFlyout.innerHTML = `<button type="button" class="flyout-all" data-snap-all${off.size ? '' : ' disabled'}>${tr('Включить все привязки')}</button>
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
  renderSnapsFlyout();
  placeFlyout(snapsFlyout, snapsBtn);
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
  setStatus(on ? tr('Сетка 10 м включена (G).') : tr('Сетка выключена (G) — привязки к ней тоже.'));
  if (lastPointer) updateSnap(lastPointer);
}
try { if (localStorage.getItem('grid') === '0') overpassLayer.setGridVisible(false); } catch { /* нет хранилища */ }

function toggleSnaps() {
  overpassLayer.snapsEnabled = !overpassLayer.snapsEnabled;
  snapsBtn.classList.toggle('active', overpassLayer.snapsEnabled);
  snapsBtn.title = overpassLayer.snapsEnabled ? tr('Привязки включены (S)') : tr('Привязки выключены (S)');
  renderSnapsFlyout();
  setStatus(overpassLayer.snapsEnabled ? tr('Привязки включены (S).') : tr('Привязки выключены (S) — инструменты двигают свободно.'));
  // Обновить маркер и текущее движение инструмента под курсором
  if (lastPointer) updateSnap(lastPointer);
}

/** Действие над выделенными частями (меню и шорткаты): hide, show, show-all, isolate, exclude, exit. */
function focusAction(action: string) {
  if (!focus) return;
  if (indoorSelection.length && action === 'hide') { hideSelectedIndoor(); return; }
  if (action === 'show-all') {
    changeFocusHidden(new Set());
    changeIndoorHidden(new Set());
    return;
  }
  const keys = selection.filter(inFocus);
  if (action === 'exclude') { if (keys.length) excludeFromGroup(); return; }
  if (action === 'delete') { if (keys.length) deleteSelected(); return; }
  if (action === 'exit') return closeFocus();
  if (action === 'snaps') return toggleSnaps();
  // Изолировать — скрыть все части, кроме выделенных (выделенные при этом показать)
  if (action === 'isolate') {
    if (!keys.length) return setStatus(tr('Выделите части (Shift+клик — несколько), затем I — изолировать их.'));
    changeFocusHidden(new Set(focus.members.filter((k) => !keys.includes(k))));
    setStatus(tr('Изолировано частей: {n}. Двойной клик по пустому месту или Shift+H — показать все, Ctrl+Z — отменить.', { n: keys.length }));
    return;
  }
  const next = new Set(focusHidden);
  for (const k of keys) if (action === 'hide') next.add(k); else next.delete(k);
  changeFocusHidden(next);
}

/** Скрытие/показ частей шагом общей истории: Cmd+Z / Cmd+Shift+Z отменяют и повторяют его вместе с правками. */
function changeFocusHidden(next: Set<string>) {
  const prev = new Set(focusHidden);
  if (prev.size === next.size && [...next].every((k) => prev.has(k))) return;
  applyFocusHidden(next);
  session.pushView({ undo: () => applyFocusHidden(prev), redo: () => applyFocusHidden(next) });
}

/**
 * Передать сцене скрытые части: глазиком и по дате слайдера времени. changed — только если набор частей,
 * которых нет в году слайдера, поменялся (правка start_date / end_date): пересборка геометрии не бесплатна.
 */
function syncFocusHidden(changed = false): boolean {
  if (!focus) return false;
  const dated = new Set(focus.members.filter((k) => { const f = entity(k); return !!f && !overpass.isVisible(f as Feature3D); }));
  if (changed && dated.size === focusDated.size && [...dated].every((k) => focusDated.has(k))) return false;
  focusDated = dated;
  overpassLayer.setFocusHidden([...focusHidden, ...dated]);
  return true;
}

function applyFocusHidden(keys: Set<string>) {
  if (!focus) return;
  const hiding = [...keys].some((k) => !focusHidden.has(k));
  focusHidden.clear();
  for (const k of keys) focusHidden.add(k);
  if (hiding) outlinerUnhover();
  syncFocusHidden();
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
  if (key && !hiddenInFocus(key)) {
    overpassLayer.setHover(key);
  } else outlinerUnhover();
});
outlinerEl.addEventListener('mouseleave', outlinerUnhover);
function outlinerUnhover() {
  overpassLayer.setHover(undefined);
}

/** Почему объект нельзя добавить в группу (undefined — можно). */
function addReason(key: string, target = addingTo): string | undefined {
  const f = entity(key);
  if (!f || !('polygons' in f)) return tr('это не здание и не часть');
  if (!f.tags['building:part'] || f.tags['building:part'] === 'no') return tr('нет тега building:part');
  const g = groupOf(key);
  if (g) return g.key === target?.key ? tr('уже в этом здании') : tr('уже входит в {key}', { key: g.key });
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

/** Отношение и отдельные части выбраны вместе в режиме карты. */
function selectedPartsForGroup(): { group: EditGroup; parts: string[] } | { reason: string } | undefined {
  const groups = selection.filter((k) => editGroups.has(k));
  if (!groups.length) return undefined;
  if (groups.length !== 1) return { reason: tr('Выберите одно отношение type=building и части для добавления.') };
  const group = editGroups.get(groups[0])!;
  const parts = selection.filter((k) => k !== group.key);
  if (!parts.length) return undefined;
  for (const key of parts) {
    const reason = addReason(key, group);
    if (reason) return { reason: tr('{key}: {reason}.', { key, reason }) };
  }
  return { group, parts };
}

function addSelectedPartsToGroup() {
  const plan = selectedPartsForGroup();
  if (!plan || 'reason' in plan) return;
  const extra = plan.parts.map((key) => {
    const [type, ref] = key.split('/');
    return { type: type as 'way' | 'relation', ref: Number(ref), role: 'part' };
  });
  session.setMembers(plan.group.key, [...plan.group.relMembers, ...extra]);
  select(plan.group.key);
}

function renderAdding() {
  const g = addingTo!;
  const list = addPending.map((k) => `<li>${esc(k)}</li>`).join('');
  infoEl.innerHTML = `
    <h2>${tr('Добавить части в {link}', { link: `<a href="${server().web}/${g.key}" target="_blank" rel="noopener">${g.key}</a>` })}</h2>
    <p class="hint">${tr('Shift+клик по частям — отметить или снять. Обычный клик — отмена.')}</p>
    ${list ? `<ul class="change-list">${list}</ul>` : `<p class="hint">${tr('Пока ничего не отмечено.')}</p>`}
    ${addMessage ? `<p class="warn">⚠ ${esc(addMessage)}</p>` : ''}
    <p><button type="button" data-add-confirm ${addPending.length ? '' : 'disabled'}>${tr('Добавить ({n})', { n: addPending.length })}</button>
       <button type="button" data-add-cancel>${tr('Отмена')}</button></p>`;
}

/** candidates — кандидаты в контур, если их несколько (для выбора в панели). */
type MergePlan = { members: { key: string; role: 'outline' | 'part' }[]; candidates?: Feature3D[];
  convert?: Feature3D[]; address?: Record<string, string>; syntheticOutline?: boolean } | { reason: string; candidates?: Feature3D[] };

/** Контур, выбранный вручную, когда кандидатов несколько. */
let chosenOutline: string | undefined;

/** Можно ли объединить выделенное в здание type=building: один контур (выделенный или скрытый под частями) и части. */
function mergePlan(keys: string[]): MergePlan {
  if (keys.some((k) => editGroups.has(k))) return { reason: tr('В выделении есть здание type=building — объединять можно только отдельные объекты.') };
  if (keys.some((k) => groupOf(k))) return { reason: tr('Часть объектов уже входит в здание type=building.') };
  const feats = keys.map(entity).filter((f): f is Feature3D => !!f && 'polygons' in f);
  if (feats.length !== keys.length) return { reason: tr('В выделении есть объект без контура здания.') };
  // Контур — всё с тегом building, даже если на нём же стоит building:part (так часто размечают)
  const isBuilding = (f: Feature3D) => !!f.tags.building && f.tags.building !== 'no';
  const outlines = new Set(feats.filter(isBuilding));
  const parts = feats.filter((f) => f.kind === 'part' && !(outlines.has(f) && f.kind !== 'part'));
  const selectedBuildings = feats.filter(isBuilding);
  if (!parts.length && selectedBuildings.length < 2) return { reason: tr('Выделите части здания (building:part).') };
  if (selectedBuildings.length > 1) {
    const address = selectedBuildings.map((f) => Object.fromEntries(Object.entries(f.tags).filter(([k]) => k.startsWith('addr:'))));
    const filled = address.filter((a) => Object.keys(a).length);
    if (filled.some((a) => JSON.stringify(Object.entries(a).sort()) !== JSON.stringify(Object.entries(filled[0]).sort())))
      return { reason: tr('У выбранных зданий разные адресные теги. Проверьте адреса перед объединением.') };
    const members = [...new Set([...selectedBuildings, ...parts].map((f) => f.key))].map((key) => ({ key, role: 'part' as const }));
    return { members, convert: selectedBuildings, address: filled[0] ?? {}, syntheticOutline: true };
  }
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
  if (!outlines.size) return { reason: tr('Не найден контур здания (building) вокруг частей — выделите его тоже.') };
  const candidates = [...outlines];
  // Выбор контура: вручную → единственный «чистый» building (без building:part) → единственный кандидат
  const pure = candidates.filter((f) => f.kind !== 'part');
  const outline = candidates.find((f) => f.key === chosenOutline) ?? (pure.length === 1 ? pure[0] : candidates.length === 1 ? candidates[0] : undefined);
  if (!outline) return { reason: tr('Найдено контуров: {n} — выберите, какой из них контур здания.', { n: candidates.length }), candidates };
  // Прочие «чистые» здания частями быть не могут
  const extra = pure.filter((f) => f !== outline);
  if (extra.length) return { reason: tr('{keys} — здание без building:part: уберите из выделения или выберите контуром.', { keys: extra.map((f) => f.key).join(', ') }), candidates };
  if (groupOf(outline.key)) return { reason: tr('Контур {key} уже входит в здание type=building.', { key: outline.key }) };
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
  const edits: ObjectEdit[] = [];
  if (plan.syntheticOutline) {
    const features = plan.members.map((m) => entity(m.key) as Feature3D);
    const shapes = features.flatMap((f) => f.polygons.map((poly) => [poly.outer, ...poly.inners].map((ring) => [...ring, ring[0]])));
    if (!shapes.length) return setStatus(tr('Не удалось построить контур здания.'), true);
    let union: ReturnType<typeof polygonClipping.union>;
    try { union = polygonClipping.union(shapes[0], ...shapes.slice(1)); }
    catch { return setStatus(tr('Не удалось построить контур здания.'), true); }
    if (!union.length) return setStatus(tr('Не удалось построить контур здания.'), true);
    const outlineId = nextNewId--;
    const outlineKey = `relation/${outlineId}`;
    const ways: MemberWay[] = [];
    const polygons: Polygon[] = [];
    for (const [outer, ...inners] of union) {
      const rings = [outer, ...inners].map((ring) => {
        const coords = ring.slice(0, -1) as LonLat[];
        const ids = coords.map(() => nextNewId--);
        const id = nextNewId--;
        const role = ring === outer ? 'outer' : 'inner';
        edits.push({ key: `way/${id}`, create: { key: `way/${id}`, version: 0, tags: {}, line: { ids: [...ids, ids[0]], coords: [...coords, coords[0]] } } });
        ways.push({ id, role, nodes: [...ids, ids[0]] });
        return { coords, ids };
      });
      polygons.push({ outer: rings[0].coords, inners: rings.slice(1).map((r) => r.coords),
        outerIds: rings[0].ids, innerIds: rings.slice(1).map((r) => r.ids) });
    }
    const values = new Set(plan.convert?.map((f) => f.tags.building));
    const building = values.size === 1 ? [...values][0] : 'yes';
    const outline: Feature3D = { key: outlineKey, type: 'relation', id: outlineId, version: 0, kind: 'building',
      tags: { type: 'multipolygon', building, ...plan.address }, polygons, hasParts: true, ways };
    edits.push({ key: outlineKey, create: { ...outline, relMembers: ways.map((w) => ({ type: 'way' as const, ref: w.id, role: w.role })) } });
    for (const f of plan.convert ?? []) {
      const tags: Record<string, string> = { ...f.tags, 'building:part': f.tags['building:part'] ?? f.tags.building };
      delete tags.building;
      for (const k of Object.keys(plan.address ?? {})) delete tags[k];
      edits.push({ key: f.key, tags });
    }
    plan.members.unshift({ key: outlineKey, role: 'outline' });
  }
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
  session.editMany([...edits, { key, create: group }]);
  leaveDrill();
  select(key);
}

/** Кнопка исключения выделенных частей из группы, в которую «провалились». */
function excludeButton(): string {
  if (!drill || !selection.length || !selection.every((k) => drill!.members.includes(k))) return '';
  return `<p><button type="button" data-exclude>${tr('Исключить из этого здания')}${selection.length > 1 ? ` (${selection.length})` : ''}</button></p>`;
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
    f.tags['building:part'] ? `, building:part=${esc(f.tags['building:part'])}` : ''}${f.tags.name ? ' ' + tr('«{name}»', { name: esc(f.tags.name) }) : ''}</span></label>`).join('');
  return `<fieldset class="outline-choice"><legend>${tr('Контур здания')}</legend>${list}</fieldset>`;
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

/** Оси картинки подложки (единичные): вдоль ширины, вдоль высоты, нормаль — по её ориентации. */
function underlayAxes(u: Underlay): [THREE.Vector3, THREE.Vector3, THREE.Vector3] {
  const q = underlayQuaternion(u);
  return [new THREE.Vector3(1, 0, 0).applyQuaternion(q), new THREE.Vector3(0, 1, 0).applyQuaternion(q), new THREE.Vector3(0, 0, 1).applyQuaternion(q)];
}

/**
 * Числа подложки для свойств: азимут (лежащей — куда смотрит верх картинки, стоящей — куда обращена лицевая сторона;
 * по часовой от севера, °), наклон (0 — лежит, 90 — стоит, °), ширина на местности (м), низ — высота нижней точки
 * над основанием (землёй или полом этажа), м.
 */
function underlayNumbers(u: Underlay) {
  const [a, b, n] = underlayAxes(u);
  const flat = Math.abs(n.z) > Math.SQRT1_2;
  const d = flat ? b : n;
  const azimuth = ((Math.atan2(d.x, d.y) * 180) / Math.PI + 360) % 360;
  const w = u.width * u.scale, h = u.height * u.scale;
  return { azimuth, tilt: (u.tilt * 180) / Math.PI, width: w, bottom: u.elevation - (Math.abs(a.z) * w + Math.abs(b.z) * h) / 2 };
}

/** Свойства выделенных подложек (без объектов OSM); у одной — точные значения положения. */
function renderUnderlaySelection() {
  const list = underlaySelection.map((id) => currentUnderlays().find((u) => u.id === id)).filter((u): u is Underlay => !!u);
  const u = list.length === 1 ? list[0] : undefined;
  const num = (prop: string, label: string, value: number, unit: string, step: string, title = '') =>
    `<label class="field" title="${esc(title)}"><span>${label}</span><input type="number" data-uprop="${prop}" step="${step}" value="${fmtNum(value)}"> ${unit}</label>`;
  const n = u && underlayNumbers(u);
  infoEl.innerHTML = `
    <h2>${u ? tr('Своя подложка') : tr('Подложки: {n}', { n: list.length })}</h2>
    <ul class="change-list">${list.map((x) => `<li><span class="ch-icon"></span><span class="ch-title" title="${esc(x.name)}">${esc(x.name)}</span>${x.building === undefined ? `<span class="ch-key">${tr('(общая)')}</span>` : ''}</li>`).join('')}</ul>
    ${u && n ? `<div class="underlay-props" data-underlay="${esc(u.id)}">
      ${num('azimuth', tr('Азимут'), n.azimuth, '°', '0.1', tr('Лежащей — куда смотрит верх картинки, стоящей — куда обращена лицевая сторона; по часовой от севера'))}
      ${num('tilt', tr('Наклон'), n.tilt, '°', '0.1', tr('0 — лежит (план), 90 — стоит (фасад, разрез)'))}
      ${num('width', tr('Ширина'), n.width, tr('м'), '0.01', tr('Ширина картинки на местности'))}
      ${num('bottom', tr('Низ'), n.bottom, tr('м'), '0.01', tr('Высота нижней точки картинки над землёй (у подложки этажа — над его полом)'))}
      <label class="field"><span>${tr('Прозрачность')}</span><input type="range" data-uprop="opacity" min="0" max="95" value="${Math.round((1 - u.opacity) * 100)}"></label>
      <label class="field-check"><input type="checkbox" data-uprop="mirror"${u.mirror ? ' checked' : ''}> ${tr('Зеркально')}</label>
      <p class="hint">${tr('Двигать, поворачивать и масштабировать — инструментами «Переместить», «Повернуть», «Масштаб» (M, Q, E).')}</p>
    </div>` : ''}`;
}

const fmtNum = (v: number) => String(Math.round(v * 1000) / 1000);

// Поле свойства подложки изменено — шаг истории (прозрачность — сразу, без истории: её крутят ползунком)
infoEl.addEventListener('change', (e) => {
  const input = (e.target as HTMLElement).closest<HTMLInputElement>('[data-uprop]');
  const id = input?.closest<HTMLElement>('[data-underlay]')?.dataset.underlay;
  const u = id && currentUnderlays().find((x) => x.id === id);
  if (!input || !u) return;
  const prop = input.dataset.uprop!, v = Number(input.value), n = underlayNumbers(u);
  let next: Underlay | undefined;
  if (prop === 'mirror') next = { ...u, mirror: input.checked };
  else if (prop === 'opacity') { const o = { ...u, opacity: Math.max(0.05, Math.min(1, 1 - v / 100)) }; replaceUnderlay(o, true); scheduleUnderlaySave(o); return; }
  else if (!Number.isFinite(v)) return renderSelected();
  // Азимут — поворот вокруг вертикали через центр: у любой ориентации это добавка к rotation (против часовой)
  else if (prop === 'azimuth') { const r = u.rotation - ((v - n.azimuth) * Math.PI) / 180; next = { ...u, rotation: Math.atan2(Math.sin(r), Math.cos(r)) }; }
  else if (prop === 'tilt') next = { ...u, tilt: (Math.max(0, Math.min(180, v)) * Math.PI) / 180 };
  else if (prop === 'width' && v > 0) next = { ...u, scale: v / u.width };
  else if (prop === 'bottom') next = { ...u, elevation: u.elevation + v - n.bottom };
  if (!next) return renderSelected();
  editUnderlays([u], [next], undefined, tr('подложка'));
});

function renderMulti() {
  const plan = mergePlan(selection);
  const addPlan = selectedPartsForGroup();
  const list = selection.map((k) => `<li data-hover-key="${esc(k)}"><a href="#" data-select="${esc(k)}">${esc(k)}</a>${
    editGroups.has(k) ? ' (type=building)' : ''}</li>`).join('');
  infoEl.innerHTML = `
    <h2>${tr('Выделено: {n}', { n: selection.length })}</h2>
    <ul class="change-list">${list}</ul>
    ${renderMultiTagForm(selection.filter((k) => session.get(k)?.tags.type !== 'building'), session, dateSources)}
    ${drill ? excludeButton() : addPlan ? `<p><button type="button" data-add-selected-parts ${'reason' in addPlan ? 'disabled' : ''}>${tr('Добавить выбранные части в отношение')}</button></p>` : `<p><button type="button" data-merge ${'reason' in plan ? 'disabled' : ''}>${tr('Объединить в здание')}</button></p>`}
    ${drill ? '' : addPlan ? 'reason' in addPlan ? `<p class="hint">${esc(addPlan.reason)}</p>` : `<p class="hint">${tr('В {key} будут добавлены части: {n}.', { key: esc(addPlan.group.key), n: addPlan.parts.length })}</p>` : 'reason' in plan ? `<p class="hint">${esc(plan.reason)}</p>` : plan.syntheticOutline ? `<p class="hint">${tr('Будет создан общий контур по выбранным зданиям; объёмы станут частями: {n}.', { n: plan.members.length })}</p>` : `<p class="hint">${tr('Будет создано отношение type=building: контур {outline} и частей {n}.', {
      outline: esc(plan.members[0].key), n: plan.members.filter((m) => m.role === 'part').length })}</p>`}
    ${drill || addPlan ? '' : outlineChooser(plan)}
    <p class="hint">${tr('Shift+клик — добавить или убрать объект.')}</p>`;
}

/** Снято выделение: в режиме здания — его свойства (на выбранном этаже — свойства этажа), иначе пусто. */
function clearInfo() {
  if (focus) renderSelected();
  else infoEl.innerHTML = '';
}

function renderSelected() {
  outlineOverlay = undefined;
  try {
    renderSelectedImpl();
    // Смешанное выделение: подложки едут вместе с частями
    if (selection.length && underlaySelection.length) infoEl.insertAdjacentHTML('afterbegin', `<p class="hint">${tr('И подложек: {n}', { n: underlaySelection.length })}</p>`);
  } finally { overpassLayer.setOverlay(outlineOverlay); updateTagsClip(); }
}

// Копировать и вставить теги (кнопки в шапке «Свойств»): все теги одного объекта — на выбранные другие
/** Не переносятся: type задаёт устройство отношения (мультиполигон, здание), а не свойства объекта. */
const UNCOPIED_TAGS = new Set(['type']);

/** Выбранные объекты, теги которых можно копировать и менять (в сессии). */
const tagClipKeys = () => selection.filter((k) => session.get(k));

function updateTagsClip() {
  const keys = tagClipKeys();
  tagsClip.hidden = !keys.length && !copiedTags;
  copyTagsBtn.disabled = keys.length !== 1;
  pasteTagsBtn.disabled = !copiedTags || !keys.length || (keys.length === 1 && keys[0] === copiedTags.from);
  pasteTagsBtn.title = copiedTags ? tr('Вставить теги {key} ({n})', { key: copiedTags.from, n: Object.keys(copiedTags.tags).length }) : tr('Вставить теги');
}

tagsClip.addEventListener('click', (e) => {
  e.stopPropagation(); // не сворачивать панель
  const t = e.target as HTMLElement;
  const keys = tagClipKeys();
  if (t.closest('[data-copy-tags]') && keys.length === 1) {
    const tags = Object.fromEntries(Object.entries(session.get(keys[0])!.tags).filter(([k]) => !UNCOPIED_TAGS.has(k)));
    copiedTags = { from: keys[0], tags };
    setStatus(trn(Object.keys(tags).length, 'Скопирован {n} тег {key}.|Скопировано {n} тега {key}.|Скопировано {n} тегов {key}.', { key: keys[0] }));
  } else if (t.closest('[data-paste-tags]') && copiedTags) {
    const from = copiedTags;
    const edits = keys.filter((k) => k !== from.from).flatMap((key) => {
      const cur = session.get(key)!.tags, tags = { ...cur, ...from.tags };
      return Object.keys(from.tags).some((k) => cur[k] !== tags[k]) ? [{ key, tags }] : [];
    });
    if (!edits.length) setStatus(tr('Теги уже такие же.'));
    else { session.editMany(edits); setStatus(trn(edits.length, 'Теги {from} вставлены в {n} объект. Отменить — Ctrl+Z.|Теги {from} вставлены в {n} объекта. Отменить — Ctrl+Z.|Теги {from} вставлены в {n} объектов. Отменить — Ctrl+Z.', { from: from.from })); }
  }
  updateTagsClip();
});

function renderSelectedImpl() {
  if (freeArea && !selection.length && !indoorSelection.length) return renderFreeArea(freeArea);
  if (selectedEntrance !== undefined) return renderEntrance(selectedEntrance);
  if (addingTo) return renderAdding();
  if (!selection.length && underlaySelection.length) return renderUnderlaySelection();
  if (selection.length > 1) return renderMulti();
  const og = selectedKey ? groupOf(selectedKey) : undefined;
  const sf = selectedKey ? session.get(selectedKey) : undefined;
  // Контур — и в отношении type=building (роль outline), и без отношения (здание с частями внутри)
  const outline = og ? og.members.some((k, i) => k === selectedKey && og.roles[i] === 'outline')
    : !!(sf as Feature3D | undefined)?.polygons?.length && implicitBuilding(sf as Feature3D)?.outline === sf!.key;
  const form = selectedKey ? renderTagForm(selectedKey, session, inheritSources(selectedKey), { suggest: dateSources(selectedKey), outline }) : undefined;
  const g = selectedKey ? editGroups.get(selectedKey) : undefined;
  // Отношение type=building — только контейнер: высоты, крыша и прочее живут на контуре и частях
  if (g) { infoEl.innerHTML = describeGroup(g); return; }
  // Новые объекты (нарисованные, отрезанные) в режиме здания ещё не нарисованы в тайлах карты — берём из сессии
  const own = selectedKey && !overpass.get(selectedKey) ? session.get(selectedKey) as Feature3D | undefined : undefined;
  const r = selectedKey ? overpass.get(selectedKey) ?? (own?.polygons ? { feature: own, roofApproximated: false } : undefined) : undefined;
  if (!r && focus && !selection.length) {
    infoEl.innerHTML = describeFocus(focus);
    const l = currentLevel !== undefined ? buildingLevels(focus, buildingIndoor(focus)).find((x) => x.n === currentLevel) : undefined;
    const fs = l ? levelFeatures(l) : [];
    if (fs.length) bindIndoorForm(fs);
    else if (l) for (const input of infoEl.querySelectorAll<HTMLInputElement>('[data-indoor-tag]')) {
      input.addEventListener('change', () => { if (input.value.trim()) levelFromOutline(l.n, { [input.dataset.indoorTag!]: input.value.trim() }); });
    }
    return;
  }
  // В режиме здания подсказка о группе не нужна (выход — Esc и панель частей); «Исключить» — под свойствами
  // Здание без отношения (контур с частями внутри) — та же шапка, что у отношения
  const header = r && !focus && highlightKeys(r.feature.key).length > 1 ? buildingHeader((session.get(r.feature.key)?.tags ?? r.feature.tags).name, session.get(r.feature.key)?.tags ?? r.feature.tags) : '';
  infoEl.innerHTML = r ? header + (focus ? '' : drillHint(r.feature.key)) + describeOsm(r, form) + excludeButton() : '';
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

// Перекрытия стеклянных частей — на высотах полов из той же раскладки, что у панели «Этажи»; с пустотами второго света
setLevelGrid((f) => {
  const g = groupOf(f.key);
  if (!g || g.key === f.key) return;
  const indoor = buildingIndoor(g);
  const levels = buildingLevels(g, indoor);
  if (!levels.length) return;
  const voids = buildingVoids(g, levels, indoor);
  const zs = [...new Set([...levels.map((l) => l.floor), ...levels.map((l) => l.ceil)])];
  return zs.map((z) => {
    // Плита — весь след части на отметке пола (часть на этой высоте существует — это и есть сечение оболочки),
    // минус пустоты второго света; где этаж не размечен — плита тоже есть
    const at = levels.filter((l) => Math.abs(l.floor - z) < 0.01);
    return { z, holes: at.flatMap((l) => voids.get(l.n) ?? []).flatMap((v) => v.polygon) };
  });
});

/** Откуда часть наследует теги в форме: контур здания, затем само отношение. Контур сам ни от кого не наследует. */
function inheritSources(key: string): InheritSource[] {
  const g = groupOf(key);
  if (!g || g.key === key) return [];
  const outline = g.members.find((_, i) => g.roles[i] === 'outline');
  if (outline === key) return [];
  const out: InheritSource[] = [];
  const t = outlineTags(g);
  if (t) out.push({ label: tr('контура {key}', { key: outline! }), tags: t });
  out.push({ label: tr('отношения {key}', { key: g.key }), tags: g.tags });
  return out;
}

/**
 * Откуда подсказывать даты (start_date / end_date, OHM): части — контур, затем отношение;
 * контуру — отношение, отношению — контур. Не наследование: значение лишь предлагается в поле.
 */
function dateSources(key: string): InheritSource[] {
  const g = groupOf(key);
  if (!g) return [];
  const outline = g.members.find((_, i) => g.roles[i] === 'outline');
  const t = outline && outline !== key ? outlineTags(g) : undefined;
  const out: InheritSource[] = t ? [{ label: tr('контура {key}', { key: outline! }), tags: t }] : [];
  if (g.key !== key && !isSolo(g)) out.push({ label: tr('отношения {key}', { key: g.key }), tags: g.tags });
  return out;
}

/** Панель режима одного здания, пока ничего не выделено. */
function describeFocus(g: BuildingGroup): string {
  const level = currentLevel !== undefined ? buildingLevels(g, buildingIndoor(g)).find((l) => l.n === currentLevel) : undefined;
  if (level) return describeLevel(level) + focusExitButton('Esc');
  const name = g.tags.name ?? outlineTags(g)?.name;
  return `
    <h2>${tr('Режим здания')}</h2>
    ${name ? `<h2 class="group-name">${esc(name)}</h2>` : ''}
    <p class="hint">${tr('{link}, членов: {n}.', { link: `<a href="${server().web}/${isSolo(g) ? g.members[0] : g.key}" target="_blank" rel="noopener">${isSolo(g) ? g.members[0] : g.key}</a>`, n: g.members.length })}
      ${tr('Клик по части — выделить её, Shift — несколько. Двойной клик по части — изолировать её, мимо здания — показать все части или выйти.')}</p>
    ${outlineWarning(g)}
    ${implicitWarning(g)}
    ${focusExitButton('Esc')}`;
}

function focusExitButton(keys = 'Esc ×2'): string {
  return `<p><button type="button" data-focus-exit>${tr('Выйти из режима здания')}</button> <span class="hint">(${keys})</span></p>`;
}

/** Подсказка над частью, выделенной внутри группы. */
function drillHint(key: string): string {
  if (!drill || !drill.members.includes(key)) return '';
  const name = drill.tags.name ?? outlineTags(drill)?.name;
  const group = `<a href="${server().web}/${drill.key}" target="_blank" rel="noopener">${drill.key}</a>${name ? ' ' + tr('«{name}»', { name: esc(name) }) : ''}`;
  return `<p class="hint drill">${focus
    ? tr('Внутри группы {group} — Esc снимет выделение, повторный Esc — выход из режима здания.', { group })
    : tr('Внутри группы {group} — клик вне группы вернёт к ней.', { group })}</p>${focus ? outlineWarning(drill) : ''}`;
}

/** Теги контура группы (роль outline) — название и адрес здания обычно на нём. */
function outlineTags(g: BuildingGroup): Record<string, string> | undefined {
  const key = g.members.find((_, i) => g.roles[i] === 'outline');
  if (!key) return;
  return (session.get(key) ?? overpass.findFeature(key))?.tags;
}

/** Шапка здания: название и адрес (у отношения — с контура). */
function buildingHeader(name: string | undefined, t: Record<string, string> | undefined): string {
  const addr = t && [t['addr:street'], t['addr:housenumber']].filter(Boolean).join(', ');
  return `${name ? `<h2 class="group-name">${esc(name)}</h2>` : ''}${addr ? `<p class="hint">${esc(addr)}</p>` : ''}`;
}

function describeGroup(g: BuildingGroup): string {
  const t = outlineTags(g);
  return `
    ${buildingHeader(g.tags.name ?? t?.name, t)}
    <h2>type=building — <a href="${server().web}/${g.key}" target="_blank" rel="noopener">${g.key}</a>${g.version ? ` v${g.version}` : ''}</h2>
    <p class="hint">${tr('Членов: {n}. Двойной клик по зданию — режим одного здания.', { n: g.members.length })}
      ${tr('Отношение — контейнер: теги здания (высота, крыша, адрес) ставятся на контур и части.')}</p>
    <p><button type="button" data-add-parts>${tr('Добавить части')}</button></p>
    ${groupDateForm(g)}
    ${tagTable(g.tags)}`;
}

/** Даты отношения (OHM): только поля дат, с подсказкой от контура. */
function groupDateForm(g: BuildingGroup): string {
  if (isSolo(g) || !entity(g.key)) return '';
  return renderTagForm(g.key, session, [], { suggest: dateSources(g.key), only: (tag) => /^(start|end)_date/.test(tag) });
}

/** После правки тегов: пересобрать меши, обновить панель и список изменений. */
function onSessionChange(keys: string[]) {
  if (josmApi() && !uploading) scheduleJosmSync();
  scheduleAutosave();
  mapIssuesDirty = true;
  // Правка тегов помещения (и её отмена) — план этажа и панель свойств по новым тегам
  if (keys.some((k) => indoorEdited.has(k))) {
    if (selectedRoomWalls.length) { selectIndoor(undefined); clearInfo(); }
    indoorEditRev++;
    const sel = indoorSelection.map((f) => indoorKey(f.key));
    renderLevels();
    const again = sel.map((k) => buildingIndoorFor(k)).filter((f): f is IndoorFeature => !!f);
    indoorSelection = [];
    for (const f of again) selectIndoor(f, again.length > 1);
    renderChanges();
    if (keys.every((k) => indoorEdited.has(k))) { renderIssues(); return; }
  }
  // Правка могла поменять объект на месте — проверки пересчитать (до перерисовки свойств, где они показаны)
  issueCache.clear();
  focusIssues = focus ? buildingIssues(focus) : [];
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
    // Контур получил building:part — объёмом (и виден), потерял — плоским следом
    const bare = bareOutlines(focus);
    for (const k of overpassLayer.setFocusFlat(bare)) {
      affected.add(k);
      if (!bare.includes(k)) focusHidden.delete(k);
    }
    for (const k of affected) {
      const f = focus.members.includes(k) ? session.get(k) as Feature3D | undefined : undefined;
      if (f?.polygons) previewFocus(f);
    }
    // Правка start_date / end_date могла убрать часть из года слайдера времени или вернуть
    syncFocusHidden(true);
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
    if (g || back) { drill = focus = (g ?? back)!; overpassLayer.setFocus(groupFeatures(focus), bareOutlines(focus)); syncFocusHidden(); setEditParam(isSolo(focus) ? focus.members[0] : focus.key); } else closeFocus();
  } else if (isSolo(focus)) {
    // Повтор рассечения: отдельное здание снова в отношении
    const g = groupOf(focus!.members[0]);
    // Здание без отношения получило отношение (правка или кнопка) — та же сцена, выделение сохраняется
    if (g && focus!.members.every((k, i) => focus!.roles[i] === '' || g.members.includes(k))) {
      drill = focus = g;
      overpassLayer.setFocus(groupFeatures(g), bareOutlines(g));
      syncFocusHidden();
      setEditParam(g.key);
      paintSelection();
      renderSelected();
    } else if (g) enterFocus(g);
    else {
      // Отменили вставку копий рядом с отдельным зданием — убрать их из сцены
      const gone = focus!.members.slice(1).filter((k) => keys.includes(k) && !session.get(k));
      if (gone.length) {
        drill = focus = { ...focus!, members: focus!.members.filter((k) => !gone.includes(k)), roles: focus!.roles.filter((_, i) => !gone.includes(focus!.members[i])) };
        overpassLayer.setFocus(groupFeatures(focus), bareOutlines(focus));
        syncFocusHidden();
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
  // Высоты или контур поменялись (правка в свойствах, undo) — маркеры вершин «Формы» на новые места
  if (shapeTool.active) shapeTool.refresh();
}

const editsHistory = document.getElementById('edits-history')!;
const EDITS_FORMAT = 'osm-simple3d-edits';
const editsClip = document.getElementById('edits-clip')!;
const copyEditsBtn = editsClip.querySelector<HTMLButtonElement>('[data-copy-edits]')!;
editsClip.hidden = !!josmMode;
const undoBtn = editsHistory.querySelector<HTMLButtonElement>('[data-undo]')!;
const redoBtn = editsHistory.querySelector<HTMLButtonElement>('[data-redo]')!;
/** Отношение type=building — несколько кубиков. */
const ICON_GROUP = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M5 1.8l3.5 2v4L5 9.8l-3.5-2v-4z"/><path d="M11 6.2l3.5 2v4L11 14.2l-3.5-2v-4z"/></svg>';
const ICON_REVERT = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16.5 14.5C15.5 9.5 12.5 7 8.5 7.5c-1.6.2-3 .9-4.2 2"/><path d="M3.5 5.5v4.5H8"/></svg>';

function renderChanges() {
  renderAccount();
  if (josmPlugin()) return renderJosmChanges();
  // Пути-члены мультиполигонов (разрезание при правке контуров) — служебные: отправляются, но в списке не видны
  const changes = session.changes().filter((c) => !c.feature.line || isIndoorChange(c));
  // Раздел появляется после первой правки; остаётся, пока есть что отменить или повторить.
  // Шаги скрытия частей — тоже в истории, но панель ради них не раскрываем
  const show = changes.length > 0 || session.hasDataHistory();
  changesEl.hidden = !show;
  editsHistory.hidden = !session.canUndo() && !session.canRedo();
  updateEditsClip();
  undoBtn.disabled = !session.canUndo();
  redoBtn.disabled = !session.canRedo();
  editsCount.textContent = changes.length ? `(${changes.length})` : osmUser ? '' : tr('· не выполнен вход');
  // Список правок нужен редко — сама панель не раскрывается; правок не осталось — сворачиваем, в остальное время решает пользователь
  if (show !== editsHadContent && !show) setCollapsed(editsPanel, true);
  editsHadContent = show;
  if (!show) { changesEl.innerHTML = ''; return; }
  const list = changes.map((c) => {
    const group = editGroups.has(c.key);
    const icon = group ? ICON_GROUP : indoorEdited.has(c.key) ? ICON_PLAN : (c.feature as Feature3D).kind === 'part' ? ICON_PART : ICON_OUTLINE;
    const name = c.after.name ?? c.before.name;
    const diff = c.diff.map((d) => d.tag === '(члены)' ? membersDiff(c)
      : d.tag.startsWith('(')
      ? `<div>${esc(d.tag.slice(1, -1))}: ${esc(d.to ?? '')}</div>`
      : `<div><span class="ch-tag">${esc(d.tag)}</span> ${d.from === undefined ? '' : `<del>${esc(d.from)}</del> → `}${d.to === undefined ? `<del>${tr('удалён')}</del>` : `<ins>${esc(d.to)}</ins>`}</div>`).join('');
    // Создание и удаление отменяются через undo (там же — состав отношения)
    const revert = c.created || c.deleted ? '' : `<button type="button" class="icon-btn ch-revert" data-revert-key="${esc(c.key)}" title="${tr('Вернуть как было')}">${ICON_REVERT}</button>`;
    return `<li data-key="${esc(c.key)}" class="${selection.includes(c.key) ? 'selected' : ''}" title="${esc(c.key)}">
      <span class="ch-icon">${icon}</span>
      <span class="ch-title">${name ? esc(name) : ''}<span class="ch-key">${esc(c.key)}</span>${c.created ? `<span class="ch-new">${tr('новый')}</span>` : ''}</span>
      ${revert}
      <div class="ch-diff">${diff}</div></li>`;
  }).join('');
  const issues = changes.length ? changeIssues(changes.filter((c) => !c.deleted).map((c) => c.key)) : [];
  const issuesHtml = issues.length ? `<p class="warn">⚠ ${tr('Проблемы в изменённых объектах ({n}) — отправить можно, но лучше поправить:', { n: issues.length })}</p>
    <ul class="issue-list">${issues.map((i) => `<li class="${i.level}" data-key="${esc(i.key)}">
      <span class="issue-icon">${i.level === 'error' ? '✖' : '⚠'}</span><span class="issue-text">${esc(i.text)}<span class="ol-key">${esc(i.key)}</span></span></li>`).join('')}</ul>` : '';
  changesEl.innerHTML = `
    ${changes.length ? `<ul class="change-list">${list}</ul>` : `<p class="hint">${tr('Изменений нет — можно повторить отменённое.')}</p>`}
    ${issuesHtml}
    ${renderUpload(changes.length)}`;
}

/**
 * С плагином JOSM: история и правки — общие с JOSM. Кнопки отмены и повтора работают с командами JOSM
 * (в них и правки из 3D), список — неотправленные объекты слоя JOSM, то, что JOSM отправит в OSM.
 */
let josmChanges: JosmChange[] = [];
function renderJosmChanges() {
  const st = josmStatus();
  // Свой шаг ещё не передан в JOSM (доли секунды) — отмена своя
  const local = session.hasDataHistory();
  editsHistory.hidden = !local && !st?.undo && !st?.redo;
  undoBtn.disabled = local ? !session.canUndo() : !st?.undo;
  redoBtn.disabled = local ? !session.canRedo() : !st?.redo;
  undoBtn.title = !local && st?.undoName ? tr('Отменить в JOSM: {name} (Ctrl+Z)', { name: st.undoName }) : tr('Отменить (Ctrl+Z)');
  redoBtn.title = !local && st?.redoName ? tr('Повторить в JOSM: {name} (Ctrl+Shift+Z)', { name: st.redoName }) : tr('Повторить (Ctrl+Shift+Z)');
  const show = josmChanges.length > 0 || !editsHistory.hidden;
  changesEl.hidden = !show;
  editsCount.textContent = josmChanges.length ? `(${josmChanges.length})` : '';
  if (show !== editsHadContent && !show) setCollapsed(editsPanel, true);
  editsHadContent = show;
  if (!show) { changesEl.innerHTML = ''; return; }
  const label = { new: tr('новый'), modify: '', delete: tr('удалён') };
  const list = josmChanges.map((c) => {
    const icon = c.tags.type === 'building' ? ICON_GROUP : c.tags['building:part'] ? ICON_PART : c.tags.indoor ? ICON_PLAN : ICON_OUTLINE;
    return `<li data-key="${esc(c.key)}" class="${selection.includes(c.key) ? 'selected' : ''}" title="${esc(c.key)}">
      <span class="ch-icon">${icon}</span>
      <span class="ch-title">${c.tags.name ? esc(c.tags.name) : ''}<span class="ch-key">${esc(c.key)}</span>${label[c.kind] ? `<span class="ch-new">${label[c.kind]}</span>` : ''}</span></li>`;
  }).join('');
  changesEl.innerHTML = `
    ${josmChanges.length ? `<ul class="change-list">${list}</ul>` : `<p class="hint">${tr('В слое JOSM нет неотправленных правок.')}</p>`}
    ${renderUpload(1)}`;
}

/** Состав отношения: было → стало и сколько членов добавлено/убрано. */
function membersDiff(c: TagChange): string {
  const before = c.membersBefore ?? [], after = c.members ?? [];
  const id = (m: { type: string; ref: number }) => `${m.type}/${m.ref}`;
  const was = new Set(before.map(id)), now = new Set(after.map(id));
  const added = after.filter((m) => !was.has(id(m))).length, removed = before.filter((m) => !now.has(id(m))).length;
  const delta = [added && `+${added}`, removed && `−${removed}`].filter(Boolean).join(', ');
  return `<div><span class="ch-tag">${tr('члены')}</span> <del>${before.length}</del> → <ins>${after.length}</ins>${delta ? ` (${delta})` : ''}</div>`;
}

function renderAccount() {
  const s = server();
  // С JOSM вход не нужен: в OSM отправляет JOSM — показываем, под кем
  if (josmPlugin()) {
    const user = josmStatus()?.user;
    accountEl.innerHTML = user ? esc(tr('JOSM: {name}', { name: user })) : esc(tr('JOSM: вход не выполнен'));
    return;
  }
  accountEl.innerHTML = osmUser
    ? `<a href="${s.web}/user/${encodeURIComponent(osmUser.name)}" target="_blank" rel="noopener">${esc(osmUser.name)}</a> ·
       <button type="button" class="link-btn" data-logout ${uploading ? 'disabled' : ''}>${tr('Выйти')}</button>`
    : `<button type="button" class="login-btn" data-login ${uploading ? 'disabled' : ''}>${tr('Войти в {server}', { server: server().short })}</button>`;
}

/** Предложенный комментарий: показывается серым в пустом поле, Tab вставляет его для правки. */
let suggestedComment = '';
/** Предложение, вставленное по Tab и ещё не правленное, — устаревает вместе с правками. */
let insertedSuggestion: string | undefined;

function commentSuggestion(): string {
  const groupKey = (key: string) => editGroups.get(key)?.key ?? groupOf(key)?.key;
  return suggestComment(session.changes().filter((c) => !c.feature.line || isIndoorChange(c)), {
    groupOf: (key) => { const g = groupKey(key); return g && g !== key ? g : undefined; },
    isGroup: (key) => editGroups.has(key),
    buildingName: (key) => {
      const g = editGroups.get(key) ?? groupOf(key);
      return g ? g.tags.name ?? outlineTags(g)?.name : undefined;
    },
    fixedIssues: (key) => {
      const before = session.originalTags(key), f = entity(key);
      if (!before || !f) return false;
      // Проблема — вид проверки и тег, о котором она (значение может меняться: 4m → 4)
      const sig = (i: Issue) => `${i.code} ${i.text.split(/[=\s]/)[0]}`;
      const now = new Set(validateTags(key, f.tags, 'hasParts' in f && !!f.hasParts).map(sig));
      return validateTags(key, before, 'hasParts' in f && !!f.hasParts).some((i) => !now.has(sig(i)));
    },
  });
}

function renderUpload(count: number): string {
  if (!count) {
    if (insertedSuggestion !== undefined && uploadComment === insertedSuggestion) uploadComment = '';
    insertedSuggestion = undefined;
    return '';
  }
  if (josmMode && josmPlugin()) {
    return `<div class="upload"><p class="hint">${esc(uploading ? tr('Передаю правки в JOSM…')
      : tr('Правки из 3D сразу попадают в слой JOSM, история отмены общая. Отправка в OSM — из JOSM.'))}</p></div>`;
  }
  if (josmMode) {
    return `<div class="upload"><p class="hint">${esc(tr('Источник — JOSM без модуля simple3d: только чтение, правки из 3D не возвращаются в JOSM и отправка отсюда отключена. Установите модуль — правки будут сразу попадать в JOSM.'))} ${josmPluginLink()}</p></div>`;
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
      <label class="upload-label" for="upload-comment">${tr('Комментарий к пакету правок')}</label>
      <textarea id="upload-comment" data-comment rows="${rows}" placeholder="${esc(suggestedComment)}" ${uploading ? 'disabled' : ''}>${esc(uploadComment)}</textarea>
      <button type="button" class="upload-btn" data-upload ${canUpload ? '' : 'disabled'}>${uploading ? tr('Отправка…') : tr('Сохранить в {server} ({n})', { server: s.short, n: count })}</button>
      <div class="upload-meta"><span>${osmUser ? commentHint() : tr('для отправки войдите в {server}', { server: s.short })}</span>
        <span class="server-tag${s.id === 'dev' ? '' : ' prod'}" title="${esc(s.label)}">${esc(s.label)}</span></div>
    </div>`;
}

async function doLogin() {
  try {
    await login();
    osmUser = await fetchUser();
    setStatus(osmUser ? tr('Вход выполнен: {name}.', { name: osmUser.name }) : tr('Не удалось получить данные пользователя.'), !osmUser);
    void syncSettings();
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
  void syncSettings();
}

async function doUpload() {
  if (uploading || deletingIndoorWalls) return;
  const changes = session.changes();
  const s = server();
  uploading = true;
  renderChanges();
  try {
    const edits = changes.map((c) => {
      const g = editGroups.get(c.key);
      const created = !c.created ? undefined
        : g ? { type: 'relation' as const, id: g.id, version: 0, tags: c.after, members: g.relMembers }
        : c.key.startsWith('node/') ? { type: 'node' as const, id: Number(c.key.split('/')[1]), version: 0, tags: c.after,
          lon: c.feature.polygons?.[0]?.outer[0]?.[0] ?? 0, lat: c.feature.polygons?.[0]?.outer[0]?.[1] ?? 0 }
        : c.key.startsWith('relation/') ? { type: 'relation' as const, id: Number(c.key.split('/')[1]), version: 0, tags: c.after, members: c.feature.relMembers ?? [] }
        : { type: 'way' as const, id: Number(c.key.split('/')[1]), version: 0, tags: c.after, nodes: c.wayNodes?.after ?? [] };
      return { key: c.key, before: c.before, after: c.after, created, members: c.members, membersBefore: c.membersBefore,
        nodeMoves: c.nodeMoves, wayNodes: c.wayNodes, newNodes: c.newNodes, deleted: c.deleted, version: c.feature.version, polygons: c.feature.polygons,
        splitFrom: c.feature.splitFrom };
    });
    const toJosm = josmApi();
    // В JOSM комментарий — имя команды в его истории: предложенный по правкам
    // Шаги подложек, сделанные вместе с этими правками (и не отменённые), — в ту же команду JOSM
    const underlaySteps = toJosm ? pendingJosmUnderlays.filter((p) => p.applied).map((p) => p.id) : [];
    const res = await uploadEdits(edits, toJosm ? commentSuggestion() : uploadComment.trim(), (t) => panelStatus(t), toJosm,
      { ...sourceTags(), ...(underlaySteps.length ? { 'simple3d:underlays': underlaySteps.join(',') } : {}) });
    if (toJosm) pendingJosmUnderlays = [];
    // Отправлено — источники считаем заново, с того, что включено сейчас
    usedImagery.clear();
    usedStreet.clear();
    usedUnderlay = currentUnderlays().some((u) => u.visible);
    noteSources();
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
        if (g) { editGroups.delete(e.key); g.id = Number(newKey.split('/')[1]); g.key = newKey; editGroups.set(newKey, g); }
        selection = selection.map((k) => (k === e.key ? newKey : k));
        if (selectedKey === e.key) selectedKey = newKey;
        if (indoorEdited.delete(e.key)) indoorEdited.add(newKey);
        const indoor = indoorCreated.get(e.key);
        if (indoor) {
          indoorCreated.delete(e.key);
          indoorCreated.set(newKey, { ...indoor, key: newKey, tags, polygons: e.polygons ?? indoor.polygons });
        }
      }
      saved.set(e.key, { version, tags, newKey, polygons: e.polygons });
    }
    session.markSaved(saved, [...res.deleted, ...res.dropped]);
    // Созданные пути получили настоящие id — им место в данных тайлов
    const createdWays: Feature3D[] = [];
    for (const [k, v] of saved) {
      if (!v.newKey?.startsWith('way/')) continue;
      if (indoorEdited.has(v.newKey)) continue;
      const f = session.get(v.newKey) as Feature3D | undefined;
      if (f?.polygons) { f.id = Number(v.newKey.split('/')[1]); createdWays.push(f); }
      void k;
    }
    rebuildGroupIndex();
    // Здание режима получило настоящие id (новое здание с карты, новые части): сцена и группа — по новым ключам,
    // иначе «Вытянуть» и выбор ищут уже несуществующий объект
    if (focus && [...saved.values()].some((v) => v.newKey)) {
      const renamed = (k: string) => saved.get(k)?.newKey ?? k;
      const fresh = isSolo(focus) ? soloGroup(renamed(focus.members[0])) : groupOf(renamed(focus.key));
      if (fresh) {
        drill = focus = fresh;
        overpassLayer.setFocus(groupFeatures(fresh), bareOutlines(fresh));
        syncFocusHidden();
        paintSelection();
        renderSelected();
      }
    }
    // Сразу в кеш тайлов текущего источника — не ждать фонового обновления тайла
    const savedGroups = [...saved].map(([k, v]) => editGroups.get(v.newKey ?? k)).filter((g): g is EditGroup => !!g)
      .map((g) => ({ key: g.key, type: g.type, id: g.id, version: g.version, tags: { ...g.tags }, members: [...g.members], roles: [...g.roles] }));
    // В JOSM: кеш тайлов обновит сам слой (плагин сообщает об изменении сразу)
    if (toJosm) {
      uploading = false;
      setStatus(trn(saved.size + res.deleted.size, 'В JOSM: {n} объект.|В JOSM: {n} объекта.|В JOSM: {n} объектов.'));
      return;
    }
    overpass.noteUploaded(res.versions, [...res.deleted, ...res.dropped]);
    void overpass.applySaved(withMemberWays(new Map([...saved].map(([k, v]) => [v.newKey ?? k, v]))), savedGroups, createdWays, [...res.deleted]);
    uploadComment = '';
    const link = `<a href="${s.web}/changeset/${res.changeset}" target="_blank" rel="noopener">changeset ${res.changeset}</a>`;
    uploading = false;
    setStatus(trn(saved.size + res.deleted.size, 'Сохранено: {n} объект.|Сохранено: {n} объекта.|Сохранено: {n} объектов.')
      + (res.rebased.size ? ' ' + tr('Поверх чужих правок других тегов перенесено: {n}.', { n: res.rebased.size }) : ''), false, link);
  } catch (err) {
    uploading = false;
    if (err instanceof ConflictError) {
      setStatus(tr('{error}. Эти теги уже изменил кто-то другой — перезагрузите тайлы, отмените свои правки этих объектов и повторите.', { error: err.message }), true);
    } else {
      setStatus(tr('Ошибка отправки: {error}', { error: (err as Error).message }), true);
    }
  } finally {
    uploading = false;
    renderChanges();
    // Пока шла передача в JOSM, появились новые правки — передать и их
    if (josmApi() && session.changes().length) scheduleJosmSync();
  }
}

/** Ссылка на описание модуля JOSM и его установку. */
const josmPluginLink = () => `<a href="https://github.com/FelisPimeja/osm-simple3d-editor/tree/main/josm-plugin${lang === 'ru' ? '/README.ru.md' : '#readme'}" target="_blank" rel="noopener">${esc(tr('Как установить модуль'))}</a>`;

/**
 * Плагин JOSM: каждая правка (шаг истории) уходит в слой JOSM вскоре после неё — пачкой, если правок несколько подряд.
 * Во время работы инструмента (перетаскивание) ждём: промежуточные состояния в JOSM не нужны.
 */
let josmSyncTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleJosmSync() {
  clearTimeout(josmSyncTimer);
  josmSyncTimer = setTimeout(() => {
    if (uploading || toolBusy()) return scheduleJosmSync();
    if (session.changes().length) void doUpload();
  }, 300);
}

editsHistory.addEventListener('click', (e) => {
  e.stopPropagation(); // не сворачивать панель
  const t = e.target as HTMLElement;
  const redo = !!t.closest('[data-redo]');
  if (!redo && !t.closest('[data-undo]')) return;
  if (josmPlugin() && !session.hasDataHistory()) return void josmUndo(redo).catch((err) => setStatus((err as Error).message, true));
  if (redo) return void selectAfterHistory(session.redo() ?? selectedKey);
  selectAfterHistory(session.undo() ?? selectedKey);
});

changesEl.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  if (t.closest('[data-upload]')) return void doUpload();
  const revert = t.closest<HTMLElement>('[data-revert-key]');
  if (revert) return void session.revert(revert.dataset.revertKey!);
  const row = t.closest<HTMLElement>('li[data-key]');
  const indoorRow = row && indoorEdited.has(row.dataset.key!) ? buildingIndoorFor(row.dataset.key!) : undefined;
  if (indoorRow) selectIndoor(indoorRow);
  else if (row) select(row.dataset.key);
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
  return suggestedComment ? tr('Tab в поле — вставить предложенный') : tr('нужен комментарий');
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
// С JOSM: выбор между слоем JOSM и данными того же сервера из API (сервер задаёт JOSM — ?server= из плагина);
// другие проекты здесь ни к чему — их данные не из этого слоя
serverSelect.innerHTML = josmMode
  ? `<option value="josm">${esc(tr('JOSM · {server}', { server: server().label }))}</option>`
    + `<option value="${server().id}">${esc(tr('{server} — данные API', { server: server().label }))}</option>`
  : SERVER_LIST.map((s) => `<option value="${s.id}">${esc(s.label)}</option>`).join('')
    + `<option value="josm" title="${esc(tr('Активный слой запущенного JOSM (Remote Control, localhost:8111)'))}">${esc(tr('JOSM (локально)'))}</option>`;
serverSelect.value = josmMode ? 'josm' : server().id;
// Настройки пользователя — отдельное окно; хранятся в браузере и в профиле на сервере (см. src/settings.ts)
const settingsDialog = document.getElementById('settings-dialog') as HTMLDialogElement;
const settingsSyncEl = document.getElementById('settings-sync')!;
const langSelect = document.getElementById('lang-select') as HTMLSelectElement;
const keepGfxToggle = document.getElementById('keep-gfx') as HTMLInputElement;
keepGfxToggle.addEventListener('change', () => {
  setKeepGraphics(keepGfxToggle.checked);
  void saveSetting('graphics'); // включили — записать текущие, выключили — убрать из профиля
});
langSelect.innerHTML = LANGS.map((l) => `<option value="${l.id}">${esc(l.label)}</option>`).join('');
langSelect.value = lang;

function renderSettingsSync() {
  const s = server();
  const st = syncStatus(s);
  settingsSyncEl.classList.toggle('warn', st === 'readonly');
  settingsSyncEl.innerHTML = st === 'local'
    ? esc(tr('Настройки хранятся в этом браузере. Войдите в {server}, чтобы сохранять их в профиле и получать на других устройствах.', { server: s.short }))
      + ` <button type="button" class="link-btn" data-settings-login>${esc(tr('Войти'))}</button>`
    : st === 'synced'
      ? esc(tr('Сохраняются в профиле {name} на {server}.', { name: osmUser?.name ?? '…', server: s.short }))
      : esc(tr('Настройки берутся из профиля на {server}, но записать их туда нельзя: при входе не было разрешения изменять настройки.', { server: s.short }))
        + ` <button type="button" class="link-btn" data-settings-relogin>${esc(tr('Войти заново'))}</button>`;
}

document.getElementById('settings-open')!.addEventListener('click', () => {
  langSelect.value = lang;
  keepGfxToggle.checked = keepGraphics();
  renderSettingsSync();
  settingsDialog.showModal();
});
// Клик по затемнению вокруг окна — закрыть
settingsDialog.addEventListener('click', (e) => { if (e.target === settingsDialog) settingsDialog.close(); });
// Пока окно открыто, горячие клавиши редактора молчат (Esc закрывает само окно)
window.addEventListener('keydown', (e) => { if (settingsDialog.open) e.stopImmediatePropagation(); }, true);
settingsSyncEl.addEventListener('click', async (e) => {
  const t = e.target as HTMLElement;
  if (t.closest('[data-settings-relogin]')) { allowPrefsScope(); logout(); osmUser = undefined; }
  else if (!t.closest('[data-settings-login]')) return;
  await doLogin();
  renderSettingsSync();
});

// Язык применяется перезагрузкой страницы
langSelect.addEventListener('change', async () => {
  langSelect.disabled = true;
  await saveLang(langSelect.value as Lang);
  location.reload();
});

/** Сверить настройки с профилем; пришло то, что требует перезагрузки (язык, сглаживание), — перезагрузить. */
async function syncSettings() {
  if (!osmUser) return;
  try {
    const reload = await syncPrefs();
    if (settingsDialog.open) keepGfxToggle.checked = keepGraphics();
    // Правки переживут перезагрузку: их сохраняет и восстанавливает автосохранение
    if (reload) location.reload();
  } catch (err) {
    console.warn('OSM preferences:', err);
  }
}

serverSelect.addEventListener('change', () => {
  const n = session.changes().length;
  if (n && !confirm(trn(n, 'Есть несохранённые изменения ({n} объект) — при смене сервера они пропадут. Продолжить?|Есть несохранённые изменения ({n} объекта) — при смене сервера они пропадут. Продолжить?|Есть несохранённые изменения ({n} объектов) — при смене сервера они пропадут. Продолжить?'))) {
    serverSelect.value = josmMode ? 'josm' : server().id;
    return;
  }
  // В JOSM и обратно — с перезагрузкой: от источника зависят данные, отправка и временные id
  if (serverSelect.value === 'josm' || josmMode) {
    if (serverSelect.value !== 'josm') setServer(serverSelect.value as ServerId);
    writeJosmParam(serverSelect.value === 'josm');
    return void location.reload();
  }
  const style = server().style;
  setServer(serverSelect.value as ServerId);
  // Другая подложка (и наличие тайловых зданий) — проще начать заново: стиль задаётся при создании карты
  if (server().style !== style) return void location.reload();
  // Данные — с выбранного сервера: правки прежнего к нему не относятся
  resetSession();
  clearSelection();
  if (map.getLayer(overpassLayer.id)) overpass.setSource(tileSource()); // до загрузки стиля — в обработчике load
  applyDate();
  renderChanges();
  void refreshUser();
});

/**
 * Фильтр по дате для OpenHistoricalMap (панель внизу, по образцу openhistoricalmap.org, компактнее):
 * границы шкалы (с … по, годы), текущая дата ползунком (до дня) или полем (год, ГГГГ-ММ, ГГГГ-ММ-ДД)
 * и воспроизведение — дата шагает на «шаг» раз в «скорость». Показываются объекты, существовавшие
 * в этот год/месяц/день. В адресе — &date=1850 или &date=1850-03-12 (как на сайте OHM); границы шкалы,
 * шаг и скорость — в localStorage. Фильтруются и подложка (start_decdate/end_decdate тайлов),
 * и здания из API (start_date/end_date).
 */
const DATE_KEY = 'osm3d.ohm-time';
const thisYear = new Date().getFullYear();
/** step: число лет, 'd' — день, 'm' — месяц. */
interface OhmTime { date: string; from: number; to: number; step: string; speed: number }
const ohm: OhmTime = (() => {
  const d: OhmTime = { date: String(thisYear), from: thisYear - 200, to: thisYear, step: '10', speed: 1000 };
  try {
    const saved = JSON.parse(localStorage.getItem(DATE_KEY) ?? '{}');
    Object.assign(d, saved);
    if (typeof saved.year === 'number' && typeof saved.date !== 'string') d.date = String(saved.year); // прежний формат
    d.step = String(d.step);
  } catch { /* по умолчанию */ }
  const q = new URLSearchParams(location.search).get('date');
  if (q !== null && parseDate(q)) d.date = q.trim();
  if (!parseDate(d.date)) d.date = String(thisYear);
  const y = parseDate(d.date)!.y;
  if (y < d.from) d.from = y;
  if (y > d.to) d.to = y;
  return d;
})();
const ohmYear = () => parseDate(ohm.date)!.y;

const datePanel = document.getElementById('date-panel')!;
const dateYear = document.getElementById('date-year') as HTMLInputElement;
const dateSlider = document.getElementById('date-slider') as HTMLInputElement;
const dateFrom = document.getElementById('date-from') as HTMLInputElement;
const dateTo = document.getElementById('date-to') as HTMLInputElement;
const dateStep = document.getElementById('date-step') as HTMLSelectElement;
const dateSpeed = document.getElementById('date-speed') as HTMLSelectElement;
const datePlay = datePanel.querySelector<HTMLButtonElement>('[data-play]')!;
let playTimer: ReturnType<typeof setInterval> | undefined;

function saveOhm() { try { localStorage.setItem(DATE_KEY, JSON.stringify(ohm)); } catch { /* не критично */ } }

/** Поля панели по состоянию (без перерисовки карты). Ползунок — десятичный год, конец шкалы — последний день года «по». */
function showDateControls() {
  dateYear.value = ohm.date;
  dateFrom.value = String(ohm.from);
  dateTo.value = String(ohm.to);
  dateSlider.min = String(ohm.from);
  dateSlider.max = String(dateSpan(String(ohm.to))!.to - 1e-6);
  dateSlider.value = String(decimalDate(ohm.date));
  dateStep.value = ohm.step;
  dateSpeed.value = String(ohm.speed);
  datePlay.classList.toggle('playing', !!playTimer);
  datePlay.title = playTimer ? tr('Пауза') : tr('Воспроизвести');
}

function applyDate() {
  const on = server().id === 'ohm';
  datePanel.hidden = !on;
  setDateFields(on);
  if (!on) stopPlay();
  showDateControls();
  const url = new URL(location.href);
  if (on) url.searchParams.set('date', ohm.date); else url.searchParams.delete('date');
  if (url.href !== location.href) history.replaceState(history.state, '', url);
  const span = on ? dateSpan(ohm.date) : undefined;
  if (map.getSource('ohm')) applyBasemapDate(map, 'ohm', span);
  overpass.setFeatureFilter(span === undefined ? () => true : (f) => existsIn(f.tags, span));
  if (on) void syncWayback(span!.to);
  overpass.setTreeFilter(span ? ohm.date : '', span === undefined ? () => true : (d) => existsIn(d as Record<string, string>, span));
  // В режиме здания сцена — своя, не из тайлов: части не той даты скрываем в ней
  if (focus && syncFocusHidden(true)) {
    outlinerUnhover();
    if (selection.some((k) => focusDated.has(k))) select(undefined);
    renderOutliner();
  }
  // Indoor может смениться даже при неизменном наборе частей здания.
  if (focus) { renderLevels(); renderIssues(); }
  if (roadSelection.some((r) => !overpass.isVisible(r))) {
    roadSelection = [];
    roadsLayer.select([]);
    infoEl.innerHTML = '';
  }
  scheduleRoads();
}

/** Новая дата (год, ГГГГ-ММ или ГГГГ-ММ-ДД). Год 0 допустим: даты OSM — ISO 8601, там 0 = 1 г. до н. э. */
/** Выпуск Esri Wayback по дате слайдера: последний до конца периода (to — десятичный год). */
async function syncWayback(to: number) {
  const r = pickRelease(await waybackReleases(), to);
  if (!r || !setWaybackRelease(r)) return;
  basemapCtrl?.setLabel(WAYBACK.id, `Esri Wayback · ${r.date}`);
  const shown = basemap === WAYBACK.id;
  // Слой ещё не добавлен (выпусков не было) — добавить; есть — сменить тайлы и подпись атрибуции
  if (shown && mapLoaded) syncBasemapLayers();
}

function setDate(v: string) {
  v = v.trim();
  const p = parseDate(v);
  if (!p) return showDateControls();
  // Дата за границами шкалы — шкала расширяется до неё
  ohm.from = Math.min(ohm.from, p.y);
  ohm.to = Math.max(ohm.to, p.y);
  if (v === ohm.date) return showDateControls();
  ohm.date = v;
  saveOhm();
  applyDate();
}

/** Дата, сдвинутая на шаг воспроизведения (dir = ±1). */
function stepDate(dir: number): string {
  const unit = ohm.step === 'd' || ohm.step === 'm' ? ohm.step : 'y';
  return shiftDate(ohm.date, unit, unit === 'y' ? dir * Number(ohm.step) : dir) ?? ohm.date;
}

function setBounds(from: number, to: number) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) return showDateControls();
  ohm.from = Math.round(from);
  ohm.to = Math.round(to);
  saveOhm();
  const y = ohmYear();
  if (y < ohm.from || y > ohm.to) setDate(String(Math.min(ohm.to, Math.max(ohm.from, y))));
  showDateControls();
}

function stopPlay() {
  if (playTimer) clearInterval(playTimer);
  playTimer = undefined;
  showDateControls();
}

/** Воспроизведение: с конца шкалы — с начала; дальше конца — стоп. */
function startPlay() {
  if (parseDate(stepDate(1))!.y > ohm.to) setDate(String(ohm.from));
  playTimer = setInterval(() => {
    const next = stepDate(1);
    if (parseDate(next)!.y > ohm.to) return stopPlay();
    setDate(next);
    if (parseDate(stepDate(1))!.y > ohm.to) stopPlay();
  }, ohm.speed);
  showDateControls();
}

datePanel.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
  if (!b) return;
  if (b.dataset.play !== undefined) return playTimer ? stopPlay() : startPlay();
  if (b.dataset.back !== undefined) { const v = stepDate(-1); setDate(parseDate(v)!.y < ohm.from ? String(ohm.from) : v); }
  if (b.dataset.fwd !== undefined) { const v = stepDate(1); setDate(parseDate(v)!.y > ohm.to ? String(ohm.to) : v); }
});
// Ползунок — с точностью до дня: при движении — только подпись, перерисовка по отпусканию (тайлы перестраиваются не мгновенно)
dateSlider.addEventListener('input', () => { dateYear.value = isoDay(Number(dateSlider.value)); });
dateSlider.addEventListener('change', () => setDate(isoDay(Number(dateSlider.value))));
dateYear.addEventListener('change', () => setDate(dateYear.value));
dateFrom.addEventListener('change', () => setBounds(Number(dateFrom.value), ohm.to));
dateTo.addEventListener('change', () => setBounds(ohm.from, Number(dateTo.value)));
dateStep.addEventListener('change', () => { ohm.step = dateStep.value; saveOhm(); });
dateSpeed.addEventListener('change', () => {
  ohm.speed = Number(dateSpeed.value);
  saveOhm();
  if (playTimer) { stopPlay(); startPlay(); }
});

/**
 * Слой JOSM: первая загрузка; карта переходит к его данным. Не вышло (JOSM не запущен) — опрос повторяет
 * загрузку (retry): ошибка тогда только в строке панели, а тайлы с ошибкой перечитываются.
 */
let josmReady = false;
async function loadJosm(retry = false) {
  if (!retry) panelStatus(tr('Читаю данные из JOSM…'));
  try {
    const { elements, bbox } = await josmLayer().then(josmApplied);
    josmReady = true;
    if (retry) await overpass.refreshJosm();
    // Без модуля simple3d — только чтение через Remote Control: подсказать, что модуль даёт полный режим
    if (josmPlugin()) setStatus(trn(elements.length, 'Из JOSM: {n} объект.|Из JOSM: {n} объекта.|Из JOSM: {n} объектов.'));
    else setStatus(trn(elements.length, 'Из JOSM: {n} объект.|Из JOSM: {n} объекта.|Из JOSM: {n} объектов.') + ' '
      + tr('Это режим только для чтения: правки из 3D не вернутся в JOSM. Для полной работы (правки, общая отмена и выделение) установите в JOSM модуль simple3d.'),
      false, josmPluginLink());
    if (!bbox) return;
    // Ракурс из адреса (перезагрузка, ссылка) сохраняем, если он над данными слоя; иначе — к данным
    const c = map.getCenter();
    if (startHashValid && c.lng >= bbox[0] && c.lng <= bbox[2] && c.lat >= bbox[1] && c.lat <= bbox[3]) return;
    // Не мельче зума, с которого грузятся данные: иначе слой JOSM не покажется
    const cam = map.cameraForBounds(bbox, { padding: 40, maxZoom: 18 });
    map.jumpTo({ center: cam?.center, zoom: Math.max(cam?.zoom ?? 0, OVERPASS_MIN_ZOOM) });
  } catch (err) {
    if (retry) panelStatus((err as Error).message, true); else setStatus((err as Error).message, true);
  }
}

/** Временные id редактора — ниже новых объектов JOSM (у тех тоже отрицательные). */
function josmApplied(l: JosmLayer): JosmLayer {
  // Выделенные объекты хранятся копиями в сессии и перекрывают данные тайлов.
  // Обновляем и эти копии; refresh сохраняет объекты с местными правками и историей.
  const parsed = parseBuildings(l.elements);
  for (const f of parsed.features) if (session.has(f.key)) {
    session.refresh({ ...f, tags: { ...f.tags },
      ...(f.ways ? { relMembers: f.ways.map((w) => ({ type: 'way' as const, ref: w.id, role: w.role })) } : {}) });
  }
  for (const g of parsed.groups) if (session.has(g.key)) {
    const copy: EditGroup = { ...g, tags: { ...g.tags }, members: [...g.members], roles: [...g.roles],
      relMembers: g.members.map((key, i) => {
        const [type, ref] = key.split('/');
        return { type: type as 'way' | 'relation', ref: Number(ref), role: g.roles[i] ?? '' };
      }) };
    if (session.refresh(copy) && editGroups.has(g.key)) editGroups.set(g.key, copy);
  }
  rebuildGroupIndex();
  nextNewId = Math.min(nextNewId, minElementId(l.elements) - 1);
  josmAreas = l.areas;
  josmChanges = l.changed;
  void refreshJosmStatus().then(() => renderChanges());
  lastFilterSig = '';
  updateTileFilter();
  return l;
}

// Изменения в JOSM: через 2 с после прошлой проверки (большой слой JOSM отдаёт секунду-две), пока вкладка видна
// и не включён инструмент (пересборка под курсором сбила бы правку); перерисовка — только если слой изменился
async function pollJosm() {
  try {
    if (document.hidden || toolBusy()) return;
    if (!josmReady) { await loadJosm(true); return; }
    const next = await pollJosmLayer();
    if (next) {
      josmApplied(next);
      await overpass.refreshJosm();
      issueCache.clear();
      if (focus) {
        const fresh = isSolo(focus) ? focus : groupOf(focus.key);
        if (fresh) {
          drill = focus = fresh;
          overpassLayer.setFocus(groupFeatures(fresh), bareOutlines(fresh));
          syncFocusHidden();
          levelSignature = '';
          renderLevels();
          renderIssues();
        }
      }
      paintSelection();
      renderSelected();
    }
  } finally { setTimeout(pollJosm, josmPlugin() ? (document.hidden || toolBusy() ? 500 : 50) : 2000); }
}
if (josmMode) setTimeout(pollJosm, 2000);
// Панели ввода инструментов (VCB) стоят над строкой состояния: её высоту пишем в --statusbar-h (style.css)
const statusbar = document.getElementById('statusbar')!;
// В одной системе координат со строкой состояния (контейнер карты бывает выше окна)
statusbar.after(...map.getContainer().querySelectorAll<HTMLElement>(':scope > .vcb'));
new ResizeObserver(() => document.body.style.setProperty('--statusbar-h', `${statusbar.offsetHeight}px`)).observe(statusbar);

/** Источник тайлов для текущего сервера: его /map API (свой кеш; у боевого — прежняя база кеша). */
function tileSource(): TileSource {
  if (josmMode) return { api: JOSM_URL, db: 'osm-simple3d-josm', josm: true };
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
  if (selectedRoomWalls.length || indoorSelection.length) { selectIndoor(undefined); clearInfo(); }
  else if (selection.length || underlaySelection.length) select(undefined);
  else closeFocus();
});

document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return;
  // В поле с несохранённым вводом — родной undo браузера; поле без правок (фокус вернулся после применения) — undo редактора
  const field = (e.target as HTMLElement).closest<HTMLInputElement | HTMLTextAreaElement>('input, textarea');
  if (field && field.type !== 'color' && field.value !== field.defaultValue) return;
  e.preventDefault();
  // Правки уже в JOSM (история редактора после передачи пуста) — отмена и повтор там
  if (josmPlugin() && !session.hasDataHistory()) return void josmUndo(e.shiftKey).catch((err) => setStatus((err as Error).message, true));
  const key = e.shiftKey ? session.redo() : session.undo();
  if (key) selectAfterHistory(key);
});

/**
 * Выделить объект, затронутый undo/redo. В режиме здания — только если это его часть: отменённое создание
 * (нарисованная или отрезанная часть) или само отношение не должны выводить на карту.
 */
function selectAfterHistory(key: string | undefined) {
  // Правка помещения — оно и остаётся выбранным (onSessionChange уже показал его с новыми тегами)
  if (key && indoorEdited.has(key)) {
    // Объект среди выбранных (правка нескольких) — выбор не трогаем
    if (indoorSelection.some((f) => indoorKey(f.key) === key)) return;
    const f = buildingIndoorFor(key);
    if (f) selectIndoor(f);
    return;
  }
  // Правка нескольких выделенных объектов — выделение не трогаем
  if (key && selection.length > 1 && selection.includes(key)) { renderSelected(); return; }
  if (focus && (!key || !focus.members.includes(key))) { select(undefined); return; }
  select(key);
}

/** Предупреждение об этажности части выше контура (для части) или частей выше него (для контура). */
function levelsAboveOutline(f: Feature3D): string | false {
  const g = groupOf(f.key);
  if (!g || g.key === f.key) return false;
  const above = partsAboveOutline(g);
  if (!above) return false;
  const outlineKey = g.members.find((_, i) => g.roles[i] === 'outline');
  if (f.key === outlineKey) return aboveOutlineText(above);
  if (!above.keys.includes(f.key)) return false;
  return tr('building:levels ({levels}) больше, чем у контура здания ({outline}):', { levels: esc(f.tags['building:levels']), outline: above.outline })
    + ' ' + tr('на контуре принято указывать максимальную этажность — поправьте контур или часть.');
}

function describeOsm({ feature: f, roofApproximated }: RenderedFeature, form?: string): string {
  const h = computeHeights(f.tags);
  const warn = [
    roofApproximated && tr('Форма крыши «{shape}» пока не поддерживается для этой геометрии — показаны стены до верха и плоская крыша.', { shape: h.roofShape }),
    h.source === 'default' && tr('Нет height и building:levels — высота взята по умолчанию.'),
    levelsAboveOutline(f),
  ].filter(Boolean);
  // Проверка: в режиме здания — вся (с пересечениями частей), иначе — теги и геометрия объекта
  const issues = (focus ? focusIssues.filter((i) => i.key === f.key || i.other === f.key) : [...validateTags(f.key, f.tags, f.hasParts), ...validateGeometry(f)])
    .filter((i) => i.code !== 'above');
  return `
    <h2>${f.kind === 'part' ? 'building:part' : 'building'} — <a href="${server().web}/${f.key}" target="_blank" rel="noopener">${f.key}</a>${f.version ? ` v${f.version}` : ''}</h2>
    <pre>${tr('высота: {min} → {wall} → {top} м ({source})', { min: fmt(h.min), wall: fmt(roofApproximated ? h.top : h.wallTop), top: fmt(h.top), source: h.source })}\n${tr('крыша: {shape}, {height} м', { shape: h.roofShape, height: fmt(h.roofHeight) })}</pre>
    ${warn.map((w) => `<p class="warn">⚠ ${w}</p>`).join('')}
    ${issues.map((i) => `<p class="warn ${i.level}">${i.level === 'error' ? '✖' : '⚠'} ${esc(i.text)}</p>`).join('')}
    ${form ? `${form}<details class="all-tags"><summary>${tr('Все теги')}</summary>${tagTable(f.tags)}</details>` : tagTable(f.tags)}`;
}

/** Planetiler: id = osmId * 10 + (1 — node, 2 — way, 3 — relation); 0 — фича, склеенная из нескольких зданий. */
function decodeTileId(id: unknown): string {
  if (typeof id !== 'number') return '—';
  const type = (OFM_IDS ? { 1: 'node', 2: 'way', 3: 'relation' } : { 0: 'way', 1: 'relation' } as Record<number, string>)[id % 10];
  return type ? osmLink(type, Math.floor(id / 10)) : tr('склеенная фича (несколько зданий) — уточняем через API…');
}

function describeTile(f: MapGeoJSONFeature): string {
  const merged = f.layer.id === MERGED_LAYER;
  const id = merged ? f.properties.src : f.id;
  const hideKey = merged ? f.properties.key : f.id;
  const hideBtns = hideKey !== undefined
    ? `<p><button type="button" data-hide="${esc(hideKey)}">${merged ? tr('Скрыть полигон') : tr('Скрыть')}</button>
       ${userHidden.size ? `<button type="button" data-unhide-all>${tr('Показать все ({n})', { n: userHidden.size })}</button>` : ''}</p>`
    : '';
  return `<h2>${tr('Здание из тайла')}</h2><p>feature.id: ${id ?? '—'}${merged ? ' ' + tr('(полигон склеенной фичи)') : ''}<br>${server().short}: ${decodeTileId(id)}</p>${hideBtns}
    <p id="resolved" class="hint">${tr('Ищем объекты OSM внутри фичи…')}</p>${tagTable(f.properties)}`;
}

let resolveSeq = 0;
/** Находит через API все здания/части, из которых состоит тайловая фича (с учётом склеенных). */
async function resolveTileFeature(f: MapGeoJSONFeature) {
  const seq = ++resolveSeq;
  const polys = polygonsOf(f.geometry);
  const xs = polys.flatMap((p) => p[0].map((c) => c[0])), ys = polys.flatMap((p) => p[0].map((c) => c[1]));
  const bbox: Bbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  const out = (html: string) => { if (seq === resolveSeq) document.getElementById('resolved')!.innerHTML = html; };
  if ((bbox[2] - bbox[0]) * (bbox[3] - bbox[1]) > MAX_API_AREA) return out(tr('Фича слишком большая для запроса к API.'));
  try {
    const { features } = parseBuildings(await fetchMap(bbox, server().id === 'dev' ? SERVERS.prod.api : server().api)); // у тестового сервера тайлы боевые
    const h = f.properties.render_height ?? Infinity, min = f.properties.render_min_height ?? 0;
    const matches = features.filter((o) => {
      if (o.hasParts) return false;
      const hh = computeHeights(o.tags);
      const pt = interiorPoint([o.polygons[0].outer, ...o.polygons[0].inners]);
      // Высоты в тайле округлены — сравниваем с запасом
      return pt && polys.some((p) => inPolygon(pt, p)) && hh.min < h + 1 && hh.top > min - 1;
    });
    out(matches.length
      ? tr('По данным API ({n}): {list}', { n: matches.length, list: matches.slice(0, 15).map((o) => osmLink(o.type, o.id)).join(', ') + (matches.length > 15 ? ' …' : '') })
      : tr('В текущих данных OSM совпадений не найдено (тайлы могут отставать).'));
  } catch (err) {
    out(tr('Не удалось запросить API: {error}', { error: (err as Error).message }));
  }
}

const osmLink = (type: string, id: number) => `<a href="${server().web}/${type}/${id}" target="_blank" rel="noopener">${type}/${id}</a>`;
const fmt = (n: number) => String(Math.round(n * 10) / 10);
function esc(s: unknown): string { return String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`); }
const tagTable = (tags: Record<string, unknown>) =>
  `<table>${Object.entries(tags).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>`;

if (import.meta.env.DEV) Object.assign(window, { map, overpassLayer, overpass, orbit, select, enterFocus, getSession: () => session, pointTarget });

void openEditLink();
renderHelp();

// ——— Мобильный режим: только просмотр ———
// Узкий экран: инструменты, свойства и правки скрыты; панель приложения и (в режиме здания) панель этажей — свёрнуты.
// Двойного клика нет (двойной тап приближает карту): здание открывается кнопкой в карточке, которая появляется
// по тапу на здание; в режиме здания карточка — с кнопкой «К карте».
const mobileQuery = matchMedia('(max-width: 768px)');
const mobileCard = document.getElementById('mobile-card')!;
let mobile = false;
/** Здание карточки (в режиме карты). */
let cardGroup: BuildingGroup | undefined;

function applyMobile() {
  mobile = mobileQuery.matches;
  document.body.classList.toggle('mobile', mobile);
  if (mobile) {
    setCollapsed(document.getElementById('panel')!, true);
    setCollapsed(levelsPanel, true);
  }
  renderMobileCard();
}
mobileQuery.addEventListener('change', applyMobile);

function groupName(g: BuildingGroup): string {
  return g.tags.name ?? outlineTags(g)?.name ?? (session.get(g.members[0]) ?? overpass.findFeature(g.members[0]))?.tags.name ?? g.key;
}

// Мобильная версия: строка состояния — над всем, что прижато к низу (карточка здания, панели правой колонки);
// отступ снизу пишем в --mobile-bottom (style.css)
const rightCol = document.getElementById('right-col')!;
const placeStatusbar = () => {
  document.body.style.setProperty('--mobile-card-h', `${mobileCard.offsetHeight}px`);
  const tops = [mobileCard, ...rightCol.children].filter((e) => e instanceof HTMLElement && e.offsetParent)
    .map((e) => e.getBoundingClientRect().top);
  document.body.style.setProperty('--mobile-bottom', `${Math.max(44, tops.length ? innerHeight - Math.min(...tops) : 0)}px`);
};
const statusbarObserver = new ResizeObserver(placeStatusbar);
statusbarObserver.observe(mobileCard);
statusbarObserver.observe(rightCol);
for (const c of rightCol.children) statusbarObserver.observe(c);
addEventListener('resize', placeStatusbar);

function renderMobileCard() {
  if (!mobile) { mobileCard.hidden = true; return; }
  if (focus) {
    mobileCard.innerHTML = `<div class="mc-text"><div class="mc-name">${esc(groupName(focus))}</div><div class="mc-hint">${tr('Режим здания · этажи — в панели «Этажи»')}</div></div>`
      + `<button type="button" class="secondary" data-mc-exit>${tr('К карте')}</button>`;
    mobileCard.hidden = false;
    return;
  }
  if (!cardGroup) { mobileCard.hidden = true; return; }
  mobileCard.innerHTML = `<div class="mc-text"><div class="mc-name">${esc(groupName(cardGroup))}</div><div class="mc-hint">${tr('Здание в 3D, этажи')}</div></div>`
    + `<button type="button" data-mc-open>${tr('Открыть здание')}</button>`;
  mobileCard.hidden = false;
}

mobileCard.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  if (t.closest('[data-mc-exit]')) { closeFocus(); cardGroup = undefined; renderMobileCard(); }
  else if (t.closest('[data-mc-open]') && cardGroup) { const g = cardGroup; cardGroup = undefined; enterFocus(g); renderMobileCard(); }
});

// Тап по зданию — карточка; мимо — убрать
map.on('click', (e) => {
  if (!mobile || focus) return;
  const key = overpassLayer.pick(e.point);
  cardGroup = key ? groupOf(key) ?? soloGroup(key) : undefined;
  renderMobileCard();
});

// Долгое нажатие — без контекстного меню и выделения текста
map.getCanvasContainer().addEventListener('contextmenu', (e) => { if (mobile) e.preventDefault(); });
applyMobile();

// CSS imports and the initial panel setup are complete; reveal the UI together.
requestAnimationFrame(() => document.documentElement.removeAttribute('data-ui-loading'));

/**
 * Выделение, общее с JOSM (плагин): выбрали здесь — выделяется в JOSM, выбрали в JOSM — здесь. Объект JOSM,
 * которого нет в 3D (дорога, точка), здесь просто снимает выделение — в JOSM его выбор не трогаем.
 * josmSelSig — последнее согласованное выделение: совпадает — ничего не отправляем (нет эха туда-обратно).
 */
let josmSelSig = '';
const selSig = (keys: string[]) => [...keys].sort().join(',');
function currentSelectionKeys(): string[] {
  if (indoorSelection.length) return indoorSelection.map((f) => indoorKey(f.key));
  return selection;
}
function syncJosmSelection() {
  if (!josmPlugin()) return;
  // После отрисовки: indoor-выделение и selection к этому моменту уже обновлены
  queueMicrotask(() => {
    const keys = currentSelectionKeys(), sig = selSig(keys);
    if (sig === josmSelSig) return;
    josmSelSig = sig;
    void sendJosmSelection(keys).catch(() => {});
  });
}
if (josmMode) watchJosmSelection((keys) => {
  if (!josmPlugin() || toolBusy()) return;
  const sig = selSig(keys);
  if (sig === josmSelSig || sig === selSig(currentSelectionKeys())) { josmSelSig = sig; return; }
  josmSelSig = sig;
  const shown = keys.filter((k) => entity(k));
  const rooms = shown.length ? [] : keys.map((k) => buildingIndoorFor(k)).filter((f): f is IndoorFeature => !!f);
  if (rooms.length) {
    rooms.forEach((f, i) => selectIndoor(f, i > 0));
  } else if (shown.length) {
    select(shown[0]);
    if (shown.length > 1) addToSelection(shown.slice(1));
  } else {
    if (indoorSelection.length || selectedRoomWalls.length) selectIndoor(undefined);
    if (selection.length) select(undefined);
  }
  // Здесь выделено по-своему (часть → всё здание, дорога → ничего) — не повод менять выделение в JOSM:
  // согласованным считаем то, что получилось здесь, и отрисовка (paintSelection) его не отправит
  josmSelSig = selSig(currentSelectionKeys());
}, (v) => {
  // Повторный «Open in 3D editor» в JOSM: этот редактор открыт — показать вид JOSM здесь (второе окно не открывается)
  map.jumpTo({ center: [v.lon, v.lat], zoom: v.zoom });
  window.focus();
});

/** Автосохранение правок (IndexedDB): что нужно, чтобы после перезагрузки продолжить с того же места. */
interface AutosaveData {
  session: SessionSnapshot; nextNewId: number;
  editGroups: [string, EditGroup][]; indoorEdited: string[]; indoorCreated: [string, IndoorFeature][];
}
/** В JOSM правки живут в его слое — сохранять нечего. */
const autosave = josmMode ? undefined : new Autosave<AutosaveData>(() => server().id);
/** Всё о правках для записи; undefined — правок и истории нет. */
function editsSnapshot(): { count: number; data: AutosaveData } | undefined {
  const count = session.changes().length;
  if (!count && !session.hasDataHistory()) return undefined;
  return { count, data: { session: session.snapshot(), nextNewId, editGroups: [...editGroups],
    indoorEdited: [...indoorEdited], indoorCreated: [...indoorCreated] } };
}
function scheduleAutosave() {
  autosave?.schedule(editsSnapshot);
}

// Копировать / вставить правки целиком (JSON) — разбирать правки, которые не уходят на сервер
function updateEditsClip() {
  copyEditsBtn.disabled = !session.changes().length && !session.hasDataHistory();
}
editsClip.addEventListener('click', (e) => {
  e.stopPropagation(); // не сворачивать панель
  const t = e.target as HTMLElement;
  if (t.closest('[data-copy-edits]')) {
    const s = editsSnapshot();
    if (!s) return;
    const json = JSON.stringify({ format: EDITS_FORMAT, version: 1, server: server().id, savedAt: new Date().toISOString(), count: s.count, data: s.data });
    navigator.clipboard.writeText(json).then(
      () => setStatus(trn(s.count, 'Правки скопированы: {n} объект, {kb} КБ JSON.|Правки скопированы: {n} объекта, {kb} КБ JSON.|Правки скопированы: {n} объектов, {kb} КБ JSON.', { kb: Math.ceil(json.length / 1024) })),
      (err) => setStatus(tr('Не удалось скопировать: {err}', { err: (err as Error).message }), true));
  } else if (t.closest('[data-paste-edits]')) {
    void pasteEdits();
  }
});

async function pasteEdits() {
  let text: string;
  try {
    text = await navigator.clipboard.readText();
  } catch {
    // Чтение буфера запрещено (встроенные браузеры, без разрешения) — вставка в поле работает всегда
    return askEditsText();
  }
  applyEditsText(text);
}

/** Поле для вставки JSON правок вручную (Cmd+V): вставка сразу применяется. */
function askEditsText() {
  showPopup(`<h3>${tr('Вставить правки')}</h3><p>${tr('Браузер не дал прочитать буфер обмена — вставьте скопированные правки сюда (Cmd+V / Ctrl+V).')}</p>
    <textarea data-edits-text rows="6" style="width:100%;box-sizing:border-box;font:12px monospace"></textarea>`);
  const area = popupEl.querySelector<HTMLTextAreaElement>('[data-edits-text]')!;
  area.focus();
  area.addEventListener('paste', (e) => {
    const text = e.clipboardData?.getData('text/plain');
    if (!text) return;
    e.preventDefault();
    showPopup('');
    applyEditsText(text);
  });
}

function applyEditsText(text: string) {
  let rec: { format?: string; server?: string; count?: number; data?: AutosaveData };
  try {
    rec = JSON.parse(text);
  } catch (err) {
    return setStatus(tr('В буфере обмена нет правок: {err}', { err: (err as Error).message }), true);
  }
  if (rec?.format !== EDITS_FORMAT || !rec.data?.session) return setStatus(tr('В буфере обмена нет правок редактора.'), true);
  if (rec.server !== server().id && !confirm(tr('Правки скопированы для сервера «{from}», а открыт «{to}». Вставить всё равно?', { from: rec.server ?? '?', to: server().id }))) return;
  const n = session.changes().length;
  if (n && !confirm(trn(n, 'Текущие правки ({n} объект) будут заменены вставленными. Продолжить?|Текущие правки ({n} объекта) будут заменены вставленными. Продолжить?|Текущие правки ({n} объектов) будут заменены вставленными. Продолжить?'))) return;
  const old = session.snapshot().features.map((f) => f.key);
  clearSelection();
  resetSession();
  onSessionChange(old); // прежние правки — с карты долой
  restoreEdits({ count: rec.count ?? 0, data: rec.data });
}

/** Пустая сессия: правки, созданные здания и помещения — забыты. */
function resetSession() {
  session = new EditSession([], onSessionChange);
  session.beforeStep = autoRelation;
  indoorEdited.clear();
  indoorCreated.clear();
  editGroups = new Map();
  editMemberGroup = new Map();
  scheduleAutosave();
}

/** Вернуть сохранённые правки в пустую сессию. */
function restoreEdits(rec: Pick<SavedEdits<AutosaveData>, 'count' | 'data'>) {
  const d = rec.data;
  const keys = session.restore(d.session);
  nextNewId = Math.min(nextNewId, d.nextNewId);
  // Группа — тот же объект, что в сессии (из IndexedDB связь приходит сама, из JSON — нет)
  for (const [k, g] of d.editGroups) editGroups.set(k, (session.tracked(k) as EditGroup | undefined) ?? g);
  for (const k of d.indoorEdited) indoorEdited.add(k);
  for (const [k, f] of d.indoorCreated) indoorCreated.set(k, f);
  rebuildGroupIndex();
  onSessionChange(keys);
  renderChanges();
  setStatus(trn(rec.count, 'Восстановлены несохранённые правки: {n} объект. Отменить их — Ctrl+Z, как обычно.|Восстановлены несохранённые правки: {n} объекта. Отменить их — Ctrl+Z, как обычно.|Восстановлены несохранённые правки: {n} объектов. Отменить их — Ctrl+Z, как обычно.'));
}

if (autosave) void (async () => {
  try {
    // Своя запись — вкладку перезагрузили: молча продолжаем. Иначе — правки закрытой вкладки: спросить
    const own = await autosave.own();
    if (session.changes().length || session.hasDataHistory()) return; // уже начали править — не мешаем
    if (own) return restoreEdits(own);
    const [orphan] = await autosave.orphans();
    if (!orphan || session.changes().length || session.hasDataHistory()) return;
    const when = new Date(orphan.savedAt).toLocaleString();
    if (confirm(trn(orphan.count, 'Остались несохранённые правки из закрытой вкладки ({n} объект, {when}). Восстановить?|Остались несохранённые правки из закрытой вкладки ({n} объекта, {when}). Восстановить?|Остались несохранённые правки из закрытой вкладки ({n} объектов, {when}). Восстановить?', { when }))) {
      await autosave.adopt(orphan);
      restoreEdits(orphan);
    } else await autosave.discard(orphan.id);
  } catch (err) {
    console.warn('Не удалось восстановить правки:', err);
  }
})();

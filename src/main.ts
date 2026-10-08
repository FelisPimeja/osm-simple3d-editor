import * as maplibregl from 'maplibre-gl';
import type { ExpressionSpecification, FillExtrusionLayerSpecification, MapGeoJSONFeature } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { fetchMap, type Bbox, type OsmMember } from './osm/api';
import { fetchUser, getToken, login, logout, type OsmUser } from './osm/auth';
import { SERVERS, server, setServer, type ServerId } from './osm/servers';
import { ConflictError, uploadEdits } from './osm/upload';
import { computeHeights } from './osm/heights';
import { centroid, isBareOutlineTags, parseBuildings, pointInRing, pointOnSurface, type BuildingGroup, type Feature3D, type LonLat, type Polygon } from './osm/model';
import { MoveTool } from './edit/move-tool';
import * as THREE from 'three';
import { inheritedTags } from './osm/inherit';
import { BuildingsLayer, setInheritance, type GraphicsOptions, type RenderedFeature, type SnapHit } from './render/buildings-layer';
import { gridKeyOfPoint, queryTileBuildings, tileFeatureIdsByTile, type TileBuildingFeature } from './tiles/tile-features';
import { OverpassTiles, type TileSource } from './view/overpass-tiles';
import { CursorOrbit } from './view/orbit';
import { PushTool, type PushTarget } from './edit/push-tool';
import { SplitTool, type CutPoint } from './edit/split-tool';
import { suggestComment } from './edit/changeset-comment';
import { EditSession, type Tagged, type TagChange } from './edit/session';
import { onSkeletons } from './render/skeleton';
import { timed } from './perf';
import { bindTagForms, renderTagForm, type InheritSource } from './edit/tag-form';
import { computeOutlineRemainders, inPolygon, interiorPoint, polygonsOf } from './tiles/outlines';

const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
const BUILDINGS_LAYER = 'simple3d-buildings';
const REMAINDERS_LAYER = 'simple3d-outline-remainders';
const MERGED_LAYER = 'simple3d-merged-exploded';
const MERGED_HIGHLIGHT_LAYER = 'simple3d-merged-highlight';
const TILE_LAYERS = [BUILDINGS_LAYER, REMAINDERS_LAYER, MERGED_LAYER];
const HIGHLIGHT_LAYER = 'simple3d-highlight';
// Начиная с этого зума здания тайлов z14 подменяются данными Overpass
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

// Здания из тайлов — условные (без крыш и частей), рисуем белыми, чтобы отличать от данных Overpass/API.
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
const gfx: GraphicsSettings = { antialias: false, monochrome: false, orbitAtCursor: false, hemisphere: false, groundAO: false, edges: false, noGlass: false, ...loadGraphics() };

function loadGraphics(): Partial<GraphicsSettings> {
  try { return JSON.parse(localStorage.getItem(GFX_KEY) ?? '{}'); } catch { return {}; }
}
function saveGraphics() {
  try { localStorage.setItem(GFX_KEY, JSON.stringify(gfx)); } catch { /* приватный режим и т.п. */ }
}

// В сборке воркер MapLibre лежит в maplibre/ рядом со страницей (см. vite.config.ts); в dev — штатно из node_modules
if (import.meta.env.PROD) maplibregl.setWorkerUrl(new URL('maplibre/maplibre-gl-worker.mjs', document.baseURI).href);

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
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }));

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
}, (f) => (session.get(f.key) as Feature3D | undefined) ?? f);
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

// Постоянный кеш тайлов Overpass (IndexedDB)
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
  // Тайлы, здания которых уже нарисованы из Overpass
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
  const f = overpass.get(key)?.feature;
  return f ? session.track({ ...f, tags: { ...f.tags } }) : undefined;
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
  if (splitTool.active) {
    const p: [number, number] = [e.point.x, e.point.y];
    if (!splitTool.click(p) && splitTool.state === 'pick') { splitTool.stop(); select(undefined); }
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
  const key = overpassLayer.pick(e.point);
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

/** Префикс ключа «группы» отдельного здания (без отношения type=building) в режиме здания. */
const SOLO = 'solo:';
const isSolo = (g: BuildingGroup | undefined) => !!g?.key.startsWith(SOLO);

/** Отдельное здание (путь или мультиполигон с building=*) — как группа из одного объекта; отношения нет. */
function soloGroup(key: string): BuildingGroup | undefined {
  const f = entity(key) as Feature3D | undefined;
  if (!f?.polygons?.length || 'relMembers' in f) return;
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
    // Контур нового отношения целиком покрыт частями (рассекли отдельное здание) — плоским следом
    return !!t && (isBareOutlineTags(t) || (g.id < 0 && g.roles.includes('part')));
  });
}

function enterFocus(g: BuildingGroup) {
  if (!focus) {
    focusHiddenLayers = [];
    for (const l of map.getStyle().layers) {
      if (l.id === overpassLayer.id || l.type === 'background') continue;
      const pending = pendingTileLayers.find((p) => p.id === l.id);
      focusHiddenLayers.push(pending ?? { id: l.id, visibility: (map.getLayoutProperty(l.id, 'visibility') as string | undefined) ?? 'visible' });
      map.setLayoutProperty(l.id, 'visibility', 'none');
    }
  }
  const fly = !focus;
  if (focus?.key !== g.key) {
    // Голые контуры (без высоты, всё здание — части) по умолчанию выключены, включаются глазиком
    session.dropViewActions(); // шаги скрытия — о прежнем здании
    focusHidden.clear();
    for (const k of bareOutlines(g)) focusHidden.add(k);
  }
  drill = focus = g;
  focusToolbar.hidden = false;
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

function exitFocus() {
  if (!focus) return;
  focus = undefined;
  focusHidden.clear();
  session.dropViewActions();
  overpassLayer.setHover(undefined);
  moveTool.stop();
  pushTool.stop();
  splitTool.stop();
  focusToolbar.hidden = true;
  renderOutliner();
  updateSnap(undefined);
  orbit.setUnderground(false);
  orbit.setEnabled(gfx.orbitAtCursor);
  overpassLayer.setFocus(undefined);
  const restore = (ls: typeof focusHiddenLayers) => {
    for (const { id, visibility } of ls) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visibility as 'visible' | 'none');
  };
  // Здания из векторных тайлов — только после того, как тайлы догрузятся и фильтр скроет то, что уже есть
  // из Overpass; иначе на миг мелькает их грубая геометрия
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
const SNAP_LABELS = { vertex: 'Вершина', midpoint: 'Середина', center: 'Центр' } as const;
/** Текущая привязка под курсором — для будущих инструментов геометрии. */
let currentSnap: SnapHit | undefined;

function updateSnap(point: [number, number] | undefined) {
  if (point && moveTool.state === 'move') moveTool.move(point);
  if (point && pushTool.state === 'push') pushTool.move(point);
  if (point && splitTool.state === 'cut') splitTool.move(point);
  if (pushTool.active || splitTool.active) {
    // Рассечение: подсвечиваем вершины и середины рёбер объектов (концы разреза)
    currentSnap = pushTool.active ? (pushTool.state === 'push' ? pushTool.snap : undefined)
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
    if (hint) setStatus(hint); else showOverpassStatus();
  });
pushBtn.addEventListener('click', () => (pushTool.active ? pushTool.stop() : startPush()));

function startPush() {
  if (!focus) return;
  moveTool.stop();
  splitTool.stop();
  pushTool.start();
}

// Инструмент «Рассечь»: прямой разрез верхней грани делит путь на два (больший сохраняет историю)
const splitBtn = focusToolbar.querySelector<HTMLButtonElement>('[data-tool="split"]')!;
const splitTool = new SplitTool(overpassLayer, splitReason, splitFeature, (hint, error) => {
  splitBtn.classList.toggle('active', splitTool.active);
  if (hint) setStatus(hint, error); else showOverpassStatus();
});
splitBtn.addEventListener('click', () => (splitTool.active ? splitTool.stop() : startSplit()));

function startSplit() {
  if (!focus) return;
  moveTool.stop();
  pushTool.stop();
  splitTool.begin();
}

/** Какой-нибудь инструмент режима здания включён. */
function toolActive(): boolean {
  return moveTool.active || pushTool.active || splitTool.active;
}

/** Почему объект нельзя рассечь (undefined — можно). */
function splitReason(key: string): string | undefined {
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
    for (const o of overpass.allFeatures()) {
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

/** Стену можно тянуть, если её узлы не принадлежат другим объектам; иначе попап со связанными, как у перемещения. */
function allowPushSide(t: PushTarget): boolean {
  const f = entity(t.key) as Feature3D | undefined;
  const nodes = f && t.edge ? sideNodes(f, t.edge) : undefined;
  if (!nodes) { setStatus('В кеше нет id узлов этого объекта — нажмите «Перезагрузить видимые тайлы» в настройках графики.', true); return false; }
  const linked = new Map<string, number>();
  for (const o of overpass.allFeatures()) {
    if (o.key === t.key) continue;
    const shared = (nodeIds(o) ?? []).filter((id) => nodes.includes(id)).length;
    if (shared) linked.set(o.key, shared);
  }
  if (!linked.size) return true;
  const list = [...linked].map(([k, n]) => `<li><a href="${server().web}/${k}" target="_blank" rel="noopener">${k}</a> — общих узлов: ${n}</li>`).join('');
  showPopup(`<h3>Нельзя вытянуть стену</h3>
    <p>Узлы этой стены принадлежат и другим объектам — при сдвиге они бы деформировались:</p><ul>${list}</ul>
    <p class="hint">Верх и низ при этом тянуть можно.</p>`);
  overpassLayer.setOverlay([...linked.keys()]);
  return false;
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
  if (t.face === 'side') session.editMany([{ key: t.key, polygons: pushSidePolygons(f, t.edge!, dz) }]);
  else session.setTags(t.key, diffTags(f.tags, pushTags(f.tags, t.face, dz)));
  setStatus(`${{ top: 'Верх', bottom: 'Низ', side: 'Стена' }[t.face]} ${t.key} сдвинут${t.face === 'side' ? 'а' : ''} на ${dz >= 0 ? '+' : ''}${dz.toFixed(2)} м.`);
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
  if (face === 'top') {
    if (!tags.height && tags['building:levels'] && whole) out['building:levels'] = String(Number(tags['building:levels']) + Math.round(k));
    else out.height = fmt(h.top + dz);
    return out;
  }
  if (!tags.min_height && (tags['building:min_level'] || (!tags.height && tags['building:levels'])) && whole) {
    const minLevel = Number(tags['building:min_level'] ?? 0) + Math.round(k);
    if (minLevel) out['building:min_level'] = String(minLevel); else delete out['building:min_level'];
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

/** Проверить выделение и включить перемещение: объекты не должны делить узлы ни с кем, кроме друг друга. */
function startMove() {
  if (!focus) return;
  const keys = selection.filter((k) => focus!.members.includes(k));
  if (!keys.length) return setStatus('Сначала выберите в здании объект (или несколько с Shift), затем инструмент «Переместить».', true);
  const features = keys.map((k) => entity(k) as Feature3D | undefined).filter((f): f is Feature3D => !!f?.polygons);
  const own = new Set<number>();
  for (const f of features) {
    const ids = nodeIds(f);
    if (!ids) return setStatus('В кеше нет id узлов этих объектов — нажмите «Перезагрузить видимые тайлы» в настройках графики.', true);
    ids.forEach((id) => own.add(id));
  }
  const chosen = new Set(keys);
  const linked = new Map<string, number>();
  for (const f of overpass.allFeatures()) {
    if (chosen.has(f.key)) continue;
    const shared = (nodeIds(f) ?? []).filter((id) => own.has(id)).length;
    if (shared) linked.set(f.key, shared);
  }
  if (linked.size) {
    const list = [...linked].map(([k, n]) => `<li><a href="${server().web}/${k}" target="_blank" rel="noopener">${k}</a> — общих узлов: ${n}${
      focus!.members.includes(k) ? '' : ' (вне этого здания)'}</li>`).join('');
    showPopup(`<h3>Нельзя переместить</h3>
      <p>${keys.length > 1 ? 'Выбранные объекты делят' : 'Объект делит'} узлы с другими объектами — при сдвиге они бы деформировались:</p>
      <ul>${list}</ul>
      <p class="hint">Перемещать можно объекты без общих узлов или связанные только между собой — выберите их вместе (Shift).</p>`);
    overpassLayer.setOverlay([...linked.keys()]);
    return;
  }
  pushTool.stop();
  splitTool.stop();
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
  session.editMany(features.map((f) => ({
    key: f.key,
    polygons: moved ? f.polygons.map((p) => ({ ...p, outer: p.outer.map(shift), inners: p.inners.map((r) => r.map(shift)) })) : undefined,
    tags: Math.abs(dz) > 1e-4 ? shiftHeights(f.tags, dz) : undefined,
  })));
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
  if (moveTool.key(e) || pushTool.key(e) || splitTool.key(e)) { e.preventDefault(); e.stopImmediatePropagation(); return; }
  // S — привязки вкл/выкл, в том числе посреди перемещения или вытягивания
  if (focus && e.code === 'KeyS' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    closeCtxMenu();
    toggleSnaps();
    return;
  }
  // Шорткаты режима здания — по физической клавише (e.code), чтобы работали и в русской раскладке
  if (!focus || toolActive() || e.ctrlKey || e.metaKey || e.altKey) return;
  const action = e.code === 'KeyM' && !e.shiftKey ? 'move'
    : e.code === 'KeyP' && !e.shiftKey ? 'push'
    : e.code === 'KeyK' && !e.shiftKey ? 'split'
    : e.code === 'KeyH' ? (e.shiftKey ? 'show-all' : 'hide')
    : e.code === 'KeyR' && !e.shiftKey ? 'exclude' : undefined;
  if (!action) return;
  e.preventDefault();
  closeCtxMenu();
  if (action === 'move') startMove(); else if (action === 'push') startPush(); else if (action === 'split') startSplit(); else focusAction(action);
}, { capture: true });
document.addEventListener('keyup', (e) => { if (moveTool.key(e)) e.preventDefault(); });

/** Здания тайлов под точкой; до загрузки стиля слоёв ещё нет — тогда пусто (иначе MapLibre бросает ошибку). */
function queryTileLayers(point: maplibregl.PointLike): MapGeoJSONFeature[] {
  const layers = TILE_LAYERS.filter((id) => map.getLayer(id));
  return layers.length ? map.queryRenderedFeatures(point, { layers }) : [];
}

map.on('mousemove', (e) => {
  const hit = !!overpassLayer.pick(e.point) || queryTileLayers(e.point).length > 0;
  map.getCanvas().style.cursor = hit ? 'pointer' : '';
});

infoEl.addEventListener('click', (e) => {
  const link = (e.target as HTMLElement).closest<HTMLElement>('a[data-select]');
  if (link) { e.preventDefault(); select(link.dataset.select); return; }
  const btn = (e.target as HTMLElement).closest('button');
  if (!btn) return;
  if (btn.dataset.merge !== undefined) return mergeIntoBuilding();
  if (btn.dataset.focusExit !== undefined) return closeFocus();
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

/** Минимальный индикатор Overpass в углу карты: точка цвета состояния + счётчик тайлов. */
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
    loading: `Загружается тайлов: ${loading}${overpass.viaApi.size ? ` (из OSM API вместо Overpass: ${overpass.viaApi.size})` : ''}`,
    waiting: `Ждут повтора: ${waiting} (лимит или ошибка Overpass, подробности в консоли)`,
    ready: 'Все видимые тайлы загружены',
  }[state] + (state === 'off' ? '' : `\n${describeFreshness()}\n\n${servers}`);
}

/**
 * Черновик: пока для тайла нет данных Overpass/API, здание из векторных тайлов — лишь набросок.
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
  const parts = [f.overpass && `из Overpass: ${f.overpass}`, f.api && `из OSM API: ${f.api}`, f.unknown && `источник неизвестен: ${f.unknown}`].filter(Boolean);
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
  const inBox = overpass.renderedFeatures().filter(({ feature: f }) => {
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

/** Панель частей режима здания: все члены отношения, контур — первым. */
function renderOutliner() {
  outlinerPanel.hidden = !focus;
  if (!focus) { outlinerEl.innerHTML = ''; return; }
  const g = focus;
  const rows = g.members.map((key, i) => ({ key, role: g.roles[i] }))
    .sort((a, b) => Number(b.role === 'outline') - Number(a.role === 'outline'));
  outlinerCount.textContent = `(${rows.length})`;
  outlinerEl.innerHTML = rows.map(({ key, role }) => {
    const f = entity(key);
    const outline = role === 'outline';
    const t = f?.tags ?? {};
    const name = t.name ?? (outline ? 'Контур' : t['building:part'] && t['building:part'] !== 'yes' ? t['building:part'] : 'Часть');
    const off = focusHidden.has(key);
    const cls = [selection.includes(key) && 'selected', off && 'off', !f && 'missing'].filter(Boolean).join(' ');
    const title = f ? key : `${key} — не загружен`;
    return `<li class="${cls}" data-key="${esc(key)}" title="${esc(title)}">
      <span class="ol-icon" title="${outline ? 'Контур (outline)' : 'Часть (part)'}">${outline ? ICON_OUTLINE : ICON_PART}</span>
      <span class="ol-label">${esc(name)}<span class="ol-key">${esc(key)}</span></span>
      <button type="button" class="ol-eye" data-eye title="${off ? 'Показать' : 'Скрыть'}">${off ? ICON_EYE_OFF : ICON_EYE}</button></li>`;
  }).join('');
}

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
    <li><button type="button" data-ctx="exclude"${keys.length ? '' : ' disabled'}>Исключить из модели${n}${kbd('R')}</button></li>${snaps}${exit}`;
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

function toggleSnaps() {
  overpassLayer.snapsEnabled = !overpassLayer.snapsEnabled;
  setStatus(overpassLayer.snapsEnabled ? 'Привязки включены (S).' : 'Привязки выключены (S) — инструменты двигают свободно.');
  // Обновить маркер и текущее движение инструмента под курсором
  if (lastPointer) updateSnap(lastPointer);
}

/** Действие над выделенными частями (меню и шорткаты): hide, show, show-all, isolate, exclude, exit. */
function focusAction(action: string) {
  if (!focus) return;
  const keys = selection.filter((k) => focus!.members.includes(k));
  if (action === 'exclude') { if (keys.length) excludeFromGroup(); return; }
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
    for (const f of overpass.allFeatures()) {
      if (partKeys.has(f.key) || !isBuilding(f)) continue;
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
  const r = selectedKey ? overpass.get(selectedKey) : undefined;
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
    name ? ` «${esc(name)}»` : ''} — ${focus ? 'Esc снимет выделение, повторный Esc — выход из режима здания' : 'клик вне группы вернёт к ней'}.</p>`;
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
  overpass.refreshFeatures([...affected]);
  // Сцену режима здания обновляем напрямую: refreshFeatures доходит до неё только через тайлы, где объект
  // нарисован, а части здания могут лежать в тайле, который сейчас не показан (тогда правка «не применялась»)
  if (focus && !keys.includes(focus.key)) {
    for (const k of affected) {
      const f = focus.members.includes(k) ? session.get(k) as Feature3D | undefined : undefined;
      if (f?.polygons) overpassLayer.previewFocusFeature(f);
    }
  }
  // Созданный путь (рассечение) появился или исчез (отмена) — тайлы перерисовать
  if (keys.some((k) => k.startsWith('way/-'))) overpass.rerender();
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
  }
  if (selectedKey && keys.includes(selectedKey)) {
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
  const changes = session.changes();
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
    const revert = c.created ? '' : `<button type="button" class="icon-btn ch-revert" data-revert-key="${esc(c.key)}" title="Вернуть как было">${ICON_REVERT}</button>`;
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
  return suggestComment(session.changes(), {
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
        nodeMoves: c.nodeMoves, wayNodes: c.wayNodes, newNodes: c.newNodes, version: c.feature.version, polygons: c.feature.polygons };
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
    session.markSaved(saved);
    // Созданные пути получили настоящие id — им место в данных тайлов
    const createdWays: Feature3D[] = [];
    for (const [k, v] of saved) {
      if (!v.newKey?.startsWith('way/')) continue;
      const f = session.get(v.newKey) as Feature3D | undefined;
      if (f) { f.id = Number(v.newKey.split('/')[1]); createdWays.push(f); }
      void k;
    }
    rebuildGroupIndex();
    // Сразу в кеш тайлов текущего источника — не ждать, пока Overpass догонит
    const savedGroups = [...saved].map(([k, v]) => editGroups.get(v.newKey ?? k)).filter((g): g is EditGroup => !!g)
      .map((g) => ({ key: g.key, type: g.type, id: g.id, version: g.version, tags: { ...g.tags }, members: [...g.members], roles: [...g.roles] }));
    void overpass.applySaved(new Map([...saved].map(([k, v]) => [v.newKey ?? k, v])), savedGroups, createdWays);
    uploadComment = '';
    const link = `<a href="${s.web}/changeset/${res.changeset}" target="_blank" rel="noopener">changeset ${res.changeset}</a>`;
    uploading = false;
    setStatus(`Сохранено: ${saved.size} объектов.` + (res.rebased.size ? ` Поверх чужих правок других тегов перенесено: ${res.rebased.size}.` : ''));
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
  if (t.closest('[data-undo]')) return void select(session.undo() ?? selectedKey);
  if (t.closest('[data-redo]')) return void select(session.redo() ?? selectedKey);
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

/** Источник тайлов для текущего сервера: боевой — Overpass, тестовый — его /map API (свой кеш). */
function tileSource(): TileSource {
  const s = server();
  return s.id === 'prod' ? { kind: 'overpass', fallbackApi: s.api } : { kind: 'api', api: s.api, db: `osm-simple3d-${s.id}` };
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
  // В полях ввода оставляем родной undo браузера
  if ((e.target as HTMLElement).closest('input, select, textarea')) return;
  e.preventDefault();
  const key = e.shiftKey ? session.redo() : session.undo();
  if (key) select(key);
});

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

if (import.meta.env.DEV) Object.assign(window, { map, overpassLayer, overpass, orbit, select, getSession: () => session });

import * as maplibregl from 'maplibre-gl';
import type { ExpressionSpecification, FillExtrusionLayerSpecification, MapGeoJSONFeature } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { fetchArea, fetchMap, type Bbox, type OsmRelation, type OsmWay } from './osm/api';
import { fetchUser, getToken, login, logout, type OsmUser } from './osm/auth';
import { SERVERS, server, setServer, type ServerId } from './osm/servers';
import { ConflictError, uploadEdits } from './osm/upload';
import { computeHeights } from './osm/heights';
import { centroid, incompleteBuildingRelations, parseBuildings, pointInRing, type BuildingGroup, type Feature3D } from './osm/model';
import { BuildingsLayer, type GraphicsOptions, type RenderedFeature } from './render/buildings-layer';
import { gridKeyOfPoint, queryTileBuildings, tileFeatureIdsByTile, type TileBuildingFeature } from './tiles/tile-features';
import { OverpassTiles } from './view/overpass-tiles';
import { CursorOrbit } from './view/orbit';
import { EditSession, type Tagged } from './edit/session';
import { onSkeletons } from './render/skeleton';
import { timed } from './perf';
import { bindTagForms, renderTagForm } from './edit/tag-form';
import { computeOutlineRemainders, inPolygon, interiorPoint, polygonsOf } from './tiles/outlines';

const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
const BUILDINGS_LAYER = 'simple3d-buildings';
const REMAINDERS_LAYER = 'simple3d-outline-remainders';
const MERGED_LAYER = 'simple3d-merged-exploded';
const MERGED_HIGHLIGHT_LAYER = 'simple3d-merged-highlight';
const TILE_LAYERS = [BUILDINGS_LAYER, REMAINDERS_LAYER, MERGED_LAYER];
const HIGHLIGHT_LAYER = 'simple3d-highlight';
const MIN_EDIT_ZOOM = 16;
// Начиная с этого зума здания тайлов z14 подменяются данными Overpass
const OVERPASS_MIN_ZOOM = 15;
/** Ниже OVERPASS_MIN_ZOOM — только тайлы, уже лежащие в кеше (без запросов к Overpass). */
const CACHED_MIN_ZOOM = 10;
// Замена контуров с частями на «контур минус части» (src/tiles/outlines.ts). Временно выключено:
// по тайлам контур не отличить от части, эвристика даёт артефакты — см. PLAN.md.
const OUTLINE_REMAINDERS = false;
// Ограничение самого API — 0.25 deg², но берём заметно меньше, чтобы не упираться в 50k узлов
const MAX_EDIT_AREA = 0.0004;

// Склеенные фичи (id с суффиксом 0) рисуем отдельным слоем, разрезанными на полигоны
const BASE_FILTER: ExpressionSpecification = ['all', ['!=', ['get', 'hide_3d'], true], ['!=', ['%', ['id'], 10], 0]];

// Здания из тайлов — условные (без крыш и частей), рисуем белыми, чтобы отличать от данных Overpass/API.
// Цвет из тайла (colour, с разбором 'a;b') — см. тег openfreemap-tiles.
const TILE_FILL = '#ffffff';

/** id тайловых фич-контуров, заменённых остатком «контур минус части». */
let replacedIds: number[] = [];
/** id тайловых фич, перекрытых областью редактирования. */
let editAreaIds: number[] = [];
/**
 * Временно: скрытые вручную кнопкой «Скрыть» (для изучения наложений).
 * Ключ — id тайловой фичи или `key` полигона склеенной фичи.
 */
const userHidden = new Set<string>();

interface GraphicsSettings extends GraphicsOptions { antialias: boolean; monochrome: boolean; orbitAtCursor: boolean }
const GFX_KEY = 'osm3d.graphics';
const gfx: GraphicsSettings = { antialias: false, monochrome: false, orbitAtCursor: false, hemisphere: false, groundAO: false, edges: false, ...loadGraphics() };

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
for (const panel of document.querySelectorAll<HTMLElement>('.panel')) {
  const storeKey = `osm3d.collapsed.${panel.id}`;
  const btn = panel.querySelector<HTMLButtonElement>('.collapse-btn')!;
  const apply = (collapsed: boolean) => {
    panel.classList.toggle('collapsed', collapsed);
    btn.setAttribute('aria-expanded', String(!collapsed));
    btn.title = collapsed ? 'Развернуть' : 'Свернуть';
  };
  try { apply(localStorage.getItem(storeKey) === '1'); } catch { /* нет хранилища */ }
  panel.querySelector('.panel-head')!.addEventListener('click', () => {
    const collapsed = !panel.classList.contains('collapsed');
    apply(collapsed);
    try { localStorage.setItem(storeKey, collapsed ? '1' : '0'); } catch { /* нет хранилища */ }
  });
}
const statusEl = document.getElementById('status')!;
const opIndicator = document.getElementById('op-indicator')!;
const monoToggle = document.getElementById('mono-toggle') as HTMLInputElement;
const editBtn = document.getElementById('edit-btn') as HTMLButtonElement;

const editLayer = new BuildingsLayer('osm-edit-buildings');
const overpassLayer = new BuildingsLayer('osm-overpass-buildings');
const overpass = new OverpassTiles(map, overpassLayer, () => {
  updateTileFilter();
  showOverpassStatus();
});
let editing: Map<string, RenderedFeature> | undefined;
/** Правки тегов в текущей области редактирования. */
let session: EditSession | undefined;
let selectedKey: string | undefined;
/** Все выделенные объекты (Shift+клик добавляет); selectedKey — последний из них. */
let selection: string[] = [];
/** Здания и части области редактирования — для поиска скрытого контура при объединении. */
let editFeatures: Feature3D[] = [];
/** Режим «добавить части»: группа, в которую добавляем, и отмеченные Shift+кликом кандидаты. */
let addingTo: BuildingGroup | undefined;
let addPending: string[] = [];
/** Временные отрицательные id для создаваемых отношений. */
let nextNewId = -1;
/** Отношения type=building области редактирования и индекс «член → группа». */
let editGroups = new Map<string, BuildingGroup>();
let editMemberGroup = new Map<string, string>();
/** Группа, в которую «провалились» двойным кликом: внутри неё выделяются отдельные части. */
let drill: BuildingGroup | undefined;
/** Исходные элементы API области редактирования (геометрия и члены нужны для osmChange). */
let rawElements = new Map<string, OsmWay | OsmRelation>();
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

  // До загрузки стиля добавленные слои и фильтры потерялись бы
  editBtn.disabled = false;
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
  const hit = (editing ? editLayer : overpassLayer).pickHit([x, y]);
  // Не попали в 3D-слой (тайловое здание или пусто) — точка на земле
  return hit ?? { lngLat: map.unproject([x, y]), altitude: 0 };
});
const orbitToggle = document.getElementById('orbit-toggle') as HTMLInputElement;
orbitToggle.checked = gfx.orbitAtCursor;
orbit.setEnabled(gfx.orbitAtCursor);
orbitToggle.addEventListener('change', () => {
  gfx.orbitAtCursor = orbitToggle.checked;
  saveGraphics();
  orbit.setEnabled(gfx.orbitAtCursor);
});

function applyMonochrome() {
  for (const layer of [overpassLayer, editLayer]) layer.setMonochrome(gfx.monochrome);
}
applyMonochrome();

// Настройки графики: отдельные галки, чтобы сравнивать влияние на производительность
for (const input of document.querySelectorAll<HTMLInputElement>('[data-gfx]')) {
  const key = input.dataset.gfx as keyof GraphicsSettings;
  input.checked = gfx[key];
  input.addEventListener('change', () => {
    gfx[key] = input.checked;
    saveGraphics();
    if (key === 'antialias') return location.reload();
    applyGraphics();
  });
}

function applyGraphics() {
  for (const layer of [overpassLayer, editLayer]) layer.setGraphics(gfx);
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
  if (!overpass.enabled) return setStatus(`Тайлы Overpass загружаются с z ≥ ${OVERPASS_MIN_ZOOM} вне режима редактирования.`, true);
  setStatus(`Перезапрашиваем из Overpass тайлов: ${overpass.reloadVisible()}.`);
});
document.getElementById('gfx')!.addEventListener('toggle', () => void showCacheInfo());
void showCacheInfo();

// FPS считаем по кадрам MapLibre (рисует по требованию — смотреть при движении карты)
const perfEl = document.getElementById('perf')!;
let frames = 0;
map.on('render', () => frames++);
setInterval(() => {
  const triangles = overpassLayer.lastTriangles + editLayer.lastTriangles;
  perfEl.textContent = `FPS: ${frames} · треугольников: ${triangles.toLocaleString('ru')}`;
  frames = 0;
}, 1000);

function refreshOverpass() {
  if (!map.getLayer(overpassLayer.id)) return;
  timed('refreshOverpass', refreshOverpassImpl);
}

function refreshOverpassImpl() {
  const z = map.getZoom();
  overpass.mode = editing ? 'off' : z >= OVERPASS_MIN_ZOOM ? 'full' : z >= CACHED_MIN_ZOOM ? 'cached' : 'off';
  overpass.update();
}

function showOverpassStatus() {
  updateOverpassIndicator();
  if (editing) return;
  if (!overpass.enabled) return setStatus(`Здания из тайлов. С z ≥ ${OVERPASS_MIN_ZOOM} — из Overpass.`);
  const { ready, total, loading, waiting } = overpass.status();
  if (overpass.mode === 'cached') {
    return setStatus(`Здания из тайлов${ready ? `, рядом с центром — из кеша Overpass (${ready} тайлов)` : ''}. С z ≥ ${OVERPASS_MIN_ZOOM} — из Overpass.`);
  }
  setStatus(`Overpass: ${ready}/${total} тайлов${loading ? `, загружается ${loading}` : ''}${waiting ? `, ждут повтора ${waiting} (лимит/ошибка, см. консоль)` : ''}.`);
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
  const sig = [replacedIds.length, editAreaIds.join(), hiddenIds.join(), overpassTiles.sort().join(), overpassIds.length].join('|');
  if (sig === lastFilterSig) return;
  lastFilterSig = sig;
  console.debug(`[perf] setFilter: скрыто ${overpassIds.length} фич тайлов под Overpass`);
  map.setFilter(BUILDINGS_LAYER, ['all', BASE_FILTER, notIn([...replacedIds, ...editAreaIds, ...hiddenIds, ...overpassIds])]);
  map.setFilter(REMAINDERS_LAYER, notIn([...editAreaIds, ...hiddenIds]));
  map.setFilter(MERGED_LAYER, ['all',
    ['!', ['in', ['get', 'src'], ['literal', editAreaIds]]],
    ['!', ['in', ['get', 'tile'], ['literal', overpassTiles]]],
    ['!', ['in', ['get', 'key'], ['literal', [...userHidden]]]]]);
}

editBtn.addEventListener('click', () => (editing ? exitEditMode() : enterEditMode()));

async function enterEditMode() {
  if (map.getZoom() < MIN_EDIT_ZOOM) return setStatus(`Приблизьте карту до z ≥ ${MIN_EDIT_ZOOM}.`, true);
  const b = map.getBounds();
  const bbox: Bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((v) => +v.toFixed(6)) as Bbox;
  const area = (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]);
  if (area > MAX_EDIT_AREA) return setStatus('Область слишком большая — приблизьте карту или уменьшите наклон.', true);

  editBtn.disabled = true;
  setStatus('Загрузка данных из OSM API…');
  try {
    const elements = await fetchArea(bbox, incompleteBuildingRelations);
    rawElements = new Map(
      elements.filter((e): e is OsmWay | OsmRelation => e.type !== 'node').map((e) => [`${e.type}/${e.id}`, e]),
    );
    const { features, groups, skipped } = parseBuildings(elements);
    editGroups = new Map(groups.map((g) => [g.key, g]));
    for (const g of groups) {
      const rel = rawElements.get(g.key);
      if (rel?.type === 'relation') (g as BuildingGroup & Tagged).relMembers = rel.members.map((m) => ({ ...m }));
    }
    editFeatures = features;
    const rendered = editLayer.setGroup('edit', features, [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2]);
    if (!map.getLayer(editLayer.id)) map.addLayer(editLayer);
    editing = new Map(rendered.map((r) => [r.feature.key, r]));
    session = new EditSession([...features, ...groups], onSessionChange);
    rebuildGroupIndex();
    renderChanges();
    overpassLayer.select(undefined);
    refreshOverpass(); // в режиме редактирования Overpass-слой выключен
    hideTileBuildingsIn(bbox);
    clearSelection();

    const outlines = features.filter((f) => f.hasParts).length;
    setStatus(`Загружено: ${rendered.length} объектов (контуров с частями: ${outlines}, пропущено: ${skipped.length}). Кликните по зданию.`);
    if (skipped.length) console.info('Пропущены:', skipped);
    editBtn.textContent = 'Выйти из редактирования';
    serverSelect.disabled = true;
    editBtn.classList.add('active');
  } catch (err) {
    setStatus(`Ошибка загрузки: ${(err as Error).message}`, true);
  } finally {
    editBtn.disabled = false;
  }
}

function exitEditMode() {
  const n = session?.changes().length ?? 0;
  if (n && !confirm(`Есть несохранённые изменения (${n} объектов). Выйти и потерять их?`)) return;
  session = undefined;
  selectedKey = undefined;
  selection = [];
  editFeatures = [];
  editGroups = new Map();
  editMemberGroup = new Map();
  rawElements = new Map();
  renderChanges();
  editing = undefined;
  editLayer.clear();
  if (map.getLayer(editLayer.id)) map.removeLayer(editLayer.id);
  refreshOverpass();
  editAreaIds = [];
  updateTileFilter();
  clearSelection();
  editBtn.textContent = 'Редактировать область';
  serverSelect.disabled = false;
  editBtn.classList.remove('active');
  showOverpassStatus();
}

/**
 * Скрывает тайловые здания, задевающие область редактирования: их перерисовывает наш слой.
 * Сопоставлять по OSM id ненадёжно — склеенные фичи (суффикс 0) объединяют несколько зданий.
 */
function hideTileBuildingsIn([w, s, e, n]: Bbox) {
  const inside = ([x, y]: number[]) => x >= w && x <= e && y >= s && y <= n;
  editAreaIds = [...new Set(
    map.querySourceFeatures('openmaptiles', { sourceLayer: 'building' })
      .filter((f) => typeof f.id === 'number' && polygonsOf(f.geometry).some((p) => p[0].some(inside)))
      .map((f) => f.id as number),
  )];
  updateTileFilter();
}

/** Группа type=building объекта (или сама группа по своему ключу) в текущем режиме. */
function groupOf(key: string): BuildingGroup | undefined {
  if (editing) return editGroups.get(editMemberGroup.get(key) ?? key);
  return overpass.groupOf(key);
}

/** Индекс «член → группа» по существующим сейчас группам (созданные можно отменить). */
function rebuildGroupIndex() {
  editMemberGroup = new Map();
  for (const g of [...editGroups.values()]) {
    if (!session?.get(g.key)) continue;
    for (const m of g.members) if (!editMemberGroup.has(m)) editMemberGroup.set(m, g.key);
  }
}

/** Что выделить по клику: вне группы — группу целиком; внутри группы — часть; клик мимо группы — выход к ней. */
function resolveClick(key: string | undefined): string | undefined {
  if (drill) {
    if (key && drill.members.includes(key)) return key;
    const g = drill;
    drill = undefined;
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

/** Выделение в режиме просмотра (Overpass). false — под курсором нет нашего объекта. */
function selectOverpass(key: string | undefined): boolean {
  selection = key ? [key] : [];
  overpassLayer.select(highlightKeys(key));
  const g = key ? groupOf(key) : undefined;
  if (key && g?.key === key) {
    clearTileHighlight();
    infoEl.innerHTML = `<p class="hint">Данные Overpass</p>${describeGroup(g)}`;
    return true;
  }
  const r = key ? overpass.get(key) : undefined;
  if (!r) return false;
  clearTileHighlight();
  infoEl.innerHTML = `<p class="hint">Данные Overpass</p>${drillHint(key!)}${describeOsm(r)}`;
  return true;
}

map.on('click', (e) => {
  const key = (editing ? editLayer : overpassLayer).pick(e.point);
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
  if (editing) {
    selectEdited(resolveClick(key));
    return;
  }
  if (selectOverpass(resolveClick(key))) return;
  const f = queryTileLayers(e.point)[0];
  infoEl.innerHTML = f ? describeTile(f) : '';
  map.setFilter(HIGHLIGHT_LAYER, ['==', ['id'], f?.layer.id === MERGED_LAYER ? -1 : f?.id ?? -1]);
  map.setFilter(MERGED_HIGHLIGHT_LAYER, ['==', ['get', 'key'], f?.layer.id === MERGED_LAYER ? f.properties.key : '']);
  if (f) resolveTileFeature(f);
});

// Двойной клик по группе — «провалиться» в неё и выделить часть под курсором (вместо приближения карты)
map.on('dblclick', (e) => {
  const key = (editing ? editLayer : overpassLayer).pick(e.point);
  const g = key ? groupOf(key) : undefined;
  if (!key || !g || drill?.key === g.key) return;
  e.preventDefault();
  drill = g;
  if (editing) selectEdited(key);
  else selectOverpass(key);
});

/** Здания тайлов под точкой; до загрузки стиля слоёв ещё нет — тогда пусто (иначе MapLibre бросает ошибку). */
function queryTileLayers(point: maplibregl.PointLike): MapGeoJSONFeature[] {
  const layers = TILE_LAYERS.filter((id) => map.getLayer(id));
  return layers.length ? map.queryRenderedFeatures(point, { layers }) : [];
}

map.on('mousemove', (e) => {
  const hit = editing
    ? !!editLayer.pick(e.point)
    : !!overpassLayer.pick(e.point) || queryTileLayers(e.point).length > 0;
  map.getCanvas().style.cursor = hit ? 'pointer' : '';
});

infoEl.addEventListener('click', (e) => {
  const link = (e.target as HTMLElement).closest<HTMLElement>('a[data-select]');
  if (link) { e.preventDefault(); if (editing) selectEdited(link.dataset.select); else selectOverpass(link.dataset.select); return; }
  const btn = (e.target as HTMLElement).closest('button');
  if (!btn) return;
  if (btn.dataset.merge !== undefined) return mergeIntoBuilding();
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
  drill = undefined;
  addingTo = undefined;
  addPending = [];
  selection = [];
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
  opIndicator.querySelector('.label')!.textContent = `Overpass ${ready}/${total}`;
  const servers = overpass.pool.endpoints
    .map((e) => `${e.host}: ${e.active} в работе, ок ${e.ok}, ошибок ${e.failed}${e.coolUntil > Date.now() ? ', остывает' : ''}`)
    .join('\n');
  opIndicator.title = {
    off: '',
    loading: `Загружается тайлов: ${loading}`,
    waiting: `Ждут повтора: ${waiting} (лимит или ошибка Overpass, подробности в консоли)`,
    ready: 'Все видимые тайлы загружены',
  }[state] + (state === 'off' ? '' : `\n\n${servers}`);
}

function setStatus(text: string, error = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', error);
}

function selectEdited(key: string | undefined) {
  addingTo = undefined;
  addPending = [];
  // Переход из списка правок или undo к объекту вне текущей группы — выходим из неё
  if (drill && key && key !== drill.key && !drill.members.includes(key)) drill = undefined;
  if (drill && key === drill.key) drill = undefined;
  // Вне группы её член выделяется вместе с ней
  if (!drill && key) key = groupOf(key)?.key ?? key;
  if (key && !session?.get(key)) key = undefined; // например, отменили создание группы
  selection = key ? [key] : [];
  selectedKey = key;
  paintSelection();
  renderSelected();
}

function toggleSelection(key: string) {
  selection = selection.includes(key) ? selection.filter((k) => k !== key) : [...selection, key];
  if (!editing) {
    clearTileHighlight();
    const one = selection.length === 1 ? selection[0] : undefined;
    if (selection.length > 1) { overpassLayer.select(selection.flatMap(highlightKeys)); renderMulti(); }
    else if (!one || !selectOverpass(one)) clearSelection();
    return;
  }
  selectedKey = selection.at(-1);
  paintSelection();
  renderSelected();
}

function paintSelection() {
  editLayer.select([...selection.flatMap(highlightKeys), ...addPending]);
}

/** Почему объект нельзя добавить в группу (undefined — можно). */
function addReason(key: string): string | undefined {
  const f = session?.get(key);
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
  const g = addingTo as (BuildingGroup & Tagged) | undefined;
  if (!g?.relMembers || !session || !addPending.length) return;
  const extra = addPending.map((k) => {
    const [type, ref] = k.split('/');
    return { type: type as 'way' | 'relation', ref: Number(ref), role: 'part' };
  });
  addingTo = undefined;
  addPending = [];
  session.setMembers(g.key, [...g.relMembers, ...extra]);
  selectEdited(g.key);
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

type MergePlan = { members: { key: string; role: 'outline' | 'part' }[] } | { reason: string };

/** Можно ли объединить выделенное в здание type=building: один контур (выделенный или скрытый под частями) и части. */
function mergePlan(keys: string[]): MergePlan {
  if (keys.some((k) => editGroups.has(k))) return { reason: 'В выделении есть здание type=building — объединять можно только отдельные объекты.' };
  if (keys.some((k) => groupOf(k))) return { reason: 'Часть объектов уже входит в здание type=building.' };
  const feats = keys.map((k) => session?.get(k)).filter((f): f is Feature3D => !!f && 'polygons' in f);
  // Контур — всё с тегом building, даже если на нём же стоит building:part (так часто размечают)
  const isBuilding = (f: Feature3D) => !!f.tags.building && f.tags.building !== 'no';
  const outlines = new Set(feats.filter(isBuilding));
  const parts = feats.filter((f) => f.kind === 'part' && !outlines.has(f));
  if (!parts.length) return { reason: 'Выделите части здания (building:part).' };
  // Контур, целиком закрытый частями, не рисуется и не выделяется — ищем его под частями
  const centres = parts.flatMap((p) => p.polygons.map((poly) => centroid(poly.outer)));
  for (const f of editFeatures) {
    if (f.kind === 'building' && f.hasParts && centres.some((c) => f.polygons.some((p) => pointInRing(c, p.outer)))) outlines.add(f);
  }
  if (!outlines.size) return { reason: 'Не найден контур здания (building) вокруг частей — выделите его тоже.' };
  if (outlines.size > 1) return { reason: `Найдено контуров: ${outlines.size} — в здании должен быть один.` };
  const [outline] = outlines;
  if (groupOf(outline.key)) return { reason: `Контур ${outline.key} уже входит в здание type=building.` };
  // Контур с building:part одновременно и часть — входит в отношение в обеих ролях
  const outlineAsPart = outline.kind === 'part' ? [{ key: outline.key, role: 'part' as const }] : [];
  return { members: [{ key: outline.key, role: 'outline' }, ...outlineAsPart, ...parts.map((p) => ({ key: p.key, role: 'part' as const }))] };
}

function mergeIntoBuilding() {
  const plan = mergePlan(selection);
  if (!session || 'reason' in plan) return;
  const id = nextNewId--;
  const key = `relation/${id}`;
  const tags = { type: 'building' };
  rawElements.set(key, {
    type: 'relation', id, version: 0, tags: { ...tags },
    members: plan.members.map((m) => {
      const [type, ref] = m.key.split('/');
      return { type: type as 'way' | 'relation', ref: Number(ref), role: m.role };
    }),
  });
  const rel = rawElements.get(key) as OsmRelation;
  const group: BuildingGroup & Tagged = { key, type: 'relation', id, version: 0, tags, members: plan.members.map((m) => m.key), relMembers: rel.members };
  editGroups.set(key, group);
  session.create(editGroups.get(key)!);
  drill = undefined;
  selectEdited(key);
}

/** Кнопка исключения выделенных частей из группы, в которую «провалились». */
function excludeButton(): string {
  if (!editing || !drill || !selection.length || !selection.every((k) => drill!.members.includes(k))) return '';
  return `<p><button type="button" data-exclude>Исключить из этого здания${selection.length > 1 ? ` (${selection.length})` : ''}</button></p>`;
}

function excludeFromGroup() {
  const g = drill as (BuildingGroup & Tagged) | undefined;
  if (!g?.relMembers || !session) return;
  const drop = new Set(selection);
  const members = g.relMembers.filter((m) => !drop.has(`${m.type}/${m.ref}`));
  session.setMembers(g.key, members);
  selectEdited(g.key); // выходим на уровень группы
}

function renderMulti() {
  const plan: MergePlan = editing ? mergePlan(selection) : { reason: 'Объединять в здание можно в режиме редактирования.' };
  const list = selection.map((k) => `<li><a href="#" data-select="${esc(k)}">${esc(k)}</a>${
    editGroups.has(k) ? ' (type=building)' : ''}</li>`).join('');
  infoEl.innerHTML = `
    <h2>Выделено: ${selection.length}</h2>
    <ul class="change-list">${list}</ul>
    ${drill ? excludeButton() : `<p><button type="button" data-merge ${'reason' in plan ? 'disabled' : ''}>Объединить в здание</button></p>`}
    ${drill ? '' : 'reason' in plan ? `<p class="hint">${esc(plan.reason)}</p>` : `<p class="hint">Будет создано отношение type=building: контур ${
      esc(plan.members[0].key)} и частей ${plan.members.filter((m) => m.role === 'part').length}.</p>`}
    <p class="hint">Shift+клик — добавить или убрать объект.</p>`;
}

function renderSelected() {
  if (addingTo) return renderAdding();
  if (selection.length > 1) return renderMulti();
  const form = selectedKey && session ? renderTagForm(selectedKey, session) : undefined;
  const g = selectedKey ? editGroups.get(selectedKey) : undefined;
  // Отношение type=building — только контейнер: высоты, крыша и прочее живут на контуре и частях
  if (g) { infoEl.innerHTML = describeGroup(g, true); return; }
  const r = selectedKey ? editing?.get(selectedKey) : undefined;
  infoEl.innerHTML = r ? drillHint(r.feature.key) + excludeButton() + describeOsm(r, form) : '';
}

/** Подсказка над частью, выделенной внутри группы. */
function drillHint(key: string): string {
  if (!drill || !drill.members.includes(key)) return '';
  return `<p class="hint drill">Внутри группы <a href="${server().web}/${drill.key}" target="_blank" rel="noopener">${drill.key}</a>${
    drill.tags.name ? ` «${esc(drill.tags.name)}»` : ''} — клик вне группы вернёт к ней.</p>`;
}

function describeGroup(g: BuildingGroup, editable = false): string {
  return `
    <h2>type=building — <a href="${server().web}/${g.key}" target="_blank" rel="noopener">${g.key}</a> v${g.version}</h2>
    <p class="hint">Членов: ${g.members.length}. Двойной клик по зданию — выделение отдельных частей.
      Отношение — контейнер: теги здания (высота, крыша, адрес) ставятся на контур и части.</p>
    ${editable ? '<p><button type="button" data-add-parts>Добавить части</button></p>' : ''}
    ${tagTable(g.tags)}`;
}

/** После правки тегов: пересобрать меши, обновить панель и список изменений. */
function onSessionChange(keys: string[]) {
  // Созданные группы могли появиться или исчезнуть, у групп — смениться состав (undo/redo)
  if (keys.some((k) => editGroups.has(k))) {
    for (const k of keys) {
      const g = editGroups.get(k) as (BuildingGroup & Tagged) | undefined;
      if (g?.relMembers) g.members = g.relMembers.filter((m) => m.type !== 'node').map((m) => `${m.type}/${m.ref}`);
    }
    rebuildGroupIndex();
    paintSelection();
  }
  for (const key of keys) {
    const f = session?.get(key);
    const r = f && 'polygons' in f && editLayer.updateFeature('edit', f as Feature3D);
    if (r) editing?.set(key, r);
  }
  if (selectedKey && keys.includes(selectedKey)) {
    const active = document.activeElement as HTMLElement | null;
    const focusTag = active?.closest('.tag-form') ? active.dataset.tag : undefined;
    renderSelected();
    // Возвращаем фокус в то же поле (Tab уже мог увести его дальше — тогда в следующее)
    if (focusTag) infoEl.querySelector<HTMLElement>(`[data-tag="${CSS.escape(focusTag)}"]`)?.focus();
  }
  renderChanges();
}

function renderChanges() {
  renderAccount();
  const changes = session?.changes() ?? [];
  // Раздел появляется после первой правки; остаётся, пока есть что отменить или повторить.
  const show = !!session && (changes.length > 0 || session.canUndo() || session.canRedo());
  changesEl.hidden = !show;
  if (!show || !session) { changesEl.innerHTML = ''; return; }
  const list = changes.map((c) => `
    <li><a href="#" data-select="${esc(c.key)}">${esc(c.key)}</a>${c.created ? ' (новое)' : ''}
      <ul>${c.diff.map((d) => `<li><code>${esc(d.tag)}</code>: <del>${esc(d.from ?? '—')}</del> → <ins>${esc(d.to ?? '—')}</ins></li>`).join('')}</ul>
    </li>`).join('');
  changesEl.innerHTML = `
    <h2>Изменения (${changes.length})</h2>
    <p class="history">
      <button type="button" data-undo ${session.canUndo() ? '' : 'disabled'} title="Ctrl+Z">↶ Отменить</button>
      <button type="button" data-redo ${session.canRedo() ? '' : 'disabled'} title="Ctrl+Shift+Z">↷ Повторить</button>
    </p>
    ${changes.length ? `<ul class="change-list">${list}</ul>` : '<p class="hint">Пока нет изменений.</p>'}
    ${renderUpload(changes.length)}`;
}

function renderAccount() {
  const s = server();
  accountEl.innerHTML = osmUser
    ? `Вы вошли как <a href="${s.web}/user/${encodeURIComponent(osmUser.name)}" target="_blank" rel="noopener">${esc(osmUser.name)}</a>
       <button type="button" data-logout ${uploading ? 'disabled' : ''}>Выйти</button>`
    : `<button type="button" data-login ${uploading ? 'disabled' : ''}>Войти в OSM</button>`;
}

function renderUpload(count: number): string {
  const s = server();
  const canUpload = osmUser && count > 0 && uploadComment.trim() && !uploading;
  return `
    <div class="upload${s.id === 'prod' ? ' prod' : ''}">
      <h3>Отправка: ${esc(s.label)}</h3>
      ${osmUser ? '' : '<p class="hint">Для отправки войдите в OSM.</p>'}
      <textarea data-comment rows="2" placeholder="Комментарий к пакету правок (обязательно)" ${uploading ? 'disabled' : ''}>${esc(uploadComment)}</textarea>
      <button type="button" data-upload ${canUpload ? '' : 'disabled'}>${uploading ? 'Отправка…' : `Сохранить в OSM (${count})`}</button>
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
  if (!session || uploading) return;
  const changes = session.changes();
  const s = server();
  if (s.id === 'prod' && !confirm(`Отправить ${changes.length} изменений в боевую базу OpenStreetMap?`)) return;
  uploading = true;
  renderChanges();
  try {
    const edits = changes.map((c) => {
      const element = rawElements.get(c.key);
      if (!element) throw new Error(`Нет исходных данных для ${c.key}`);
      const withMembers = c.members && element.type === 'relation' ? { ...element, members: c.members } : element;
      return { key: c.key, element: withMembers, before: c.before, after: c.after, created: c.created, membersChanged: !!c.members };
    });
    const res = await uploadEdits(edits, uploadComment.trim(), (t) => setStatus(t));
    const saved = new Map<string, { version: number; tags: Record<string, string>; newKey?: string }>();
    for (const e of edits) {
      const version = res.versions.get(e.key);
      if (version === undefined) continue;
      const rebased = res.rebased.get(e.key);
      const tags = rebased?.tags ?? e.after;
      const newKey = res.newKeys.get(e.key);
      const element = { ...(rebased?.element ?? e.element), version, tags };
      if (newKey) {
        // Созданное отношение получило настоящий id
        element.id = Number(newKey.split('/')[1]);
        rawElements.delete(e.key);
        const g = editGroups.get(e.key);
        if (g) { editGroups.delete(e.key); g.id = element.id; editGroups.set(newKey, g); }
        selection = selection.map((k) => (k === e.key ? newKey : k));
        if (selectedKey === e.key) selectedKey = newKey;
      }
      rawElements.set(newKey ?? e.key, element);
      saved.set(e.key, { version, tags, newKey });
    }
    session.markSaved(saved);
    // Overpass отдаёт только боевую базу — правки с тестового сервера в его кеш не кладём
    if (s.id === 'prod') {
      const savedGroups = [...saved].map(([k, v]) => editGroups.get(v.newKey ?? k)).filter((g): g is BuildingGroup => !!g)
        .map((g) => ({ key: g.key, type: g.type, id: g.id, version: g.version, tags: { ...g.tags }, members: [...g.members] }));
      void overpass.applySaved(saved, savedGroups);
    }
    uploadComment = '';
    const link = `<a href="${s.web}/changeset/${res.changeset}" target="_blank" rel="noopener">changeset ${res.changeset}</a>`;
    setStatus(`Сохранено: ${saved.size} объектов.` + (res.rebased.size ? ` Поверх чужих правок перенесено: ${res.rebased.size} (геометрия в 3D может быть устаревшей — перезагрузите область).` : ''));
    statusEl.insertAdjacentHTML('beforeend', ` ${link}`);
  } catch (err) {
    if (err instanceof ConflictError) {
      setStatus(`${err.message}. Эти теги уже изменил кто-то другой — выйдите из редактирования, загрузите область заново и повторите правки.`, true);
    } else {
      setStatus(`Ошибка отправки: ${(err as Error).message}`, true);
    }
  } finally {
    uploading = false;
    renderChanges();
  }
}

changesEl.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  if (t.closest('[data-undo]')) return selectEdited(session?.undo() ?? selectedKey);
  if (t.closest('[data-redo]')) return selectEdited(session?.redo() ?? selectedKey);
  if (t.closest('[data-upload]')) return void doUpload();
  const link = t.closest<HTMLElement>('[data-select]');
  if (link) { e.preventDefault(); selectEdited(link.dataset.select); }
});

changesEl.addEventListener('input', (e) => {
  const t = e.target as HTMLTextAreaElement;
  if (!t.matches('[data-comment]')) return;
  uploadComment = t.value;
  const btn = changesEl.querySelector<HTMLButtonElement>('[data-upload]');
  if (btn) btn.disabled = !(osmUser && session?.changes().length && uploadComment.trim() && !uploading);
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
  setServer(serverSelect.value as ServerId);
  void refreshUser();
});
void refreshUser();

bindTagForms(infoEl, () => session);

// Скелеты для сложных крыш считаются в воркере; досчитанные — пересобираем ждавшие здания
onSkeletons(() => {
  timed('пересборка зданий со скелетами', () => {
    overpassLayer.rebuildPending();
    editLayer.rebuildPending((r) => {
      editing?.set(r.feature.key, r);
      if (r.feature.key === selectedKey) renderSelected();
    });
  });
});

document.addEventListener('keydown', (e) => {
  if (!session || !(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return;
  // В полях ввода оставляем родной undo браузера
  if ((e.target as HTMLElement).closest('input, select, textarea')) return;
  e.preventDefault();
  const key = e.shiftKey ? session.redo() : session.undo();
  if (key) selectEdited(key);
});

window.addEventListener('beforeunload', (e) => {
  if (session?.changes().length) e.preventDefault();
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
    <h2>${f.kind === 'part' ? 'building:part' : 'building'} —
      <a href="${server().web}/${f.key}" target="_blank" rel="noopener">${f.key}</a> v${f.version}</h2>
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
  if ((bbox[2] - bbox[0]) * (bbox[3] - bbox[1]) > MAX_EDIT_AREA) return out('Фича слишком большая для запроса к API.');
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

if (import.meta.env.DEV) Object.assign(window, { map, editLayer, overpassLayer, overpass, orbit, selectEdited, getSession: () => session });

import * as maplibregl from 'maplibre-gl';
import type { ExpressionSpecification, FillExtrusionLayerSpecification, MapGeoJSONFeature } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { fetchArea, fetchMap, type Bbox, type OsmRelation, type OsmWay } from './osm/api';
import { fetchUser, getToken, login, logout, type OsmUser } from './osm/auth';
import { SERVERS, server, setServer, type ServerId } from './osm/servers';
import { ConflictError, uploadEdits } from './osm/upload';
import { computeHeights } from './osm/heights';
import { incompleteBuildingRelations, parseBuildings, type Feature3D } from './osm/model';
import { BuildingsLayer, type GraphicsOptions, type RenderedFeature } from './render/buildings-layer';
import { queryTileBuildings, tileFeatureIdsByTile, type TileBuildingFeature } from './tiles/tile-features';
import { OverpassTiles } from './view/overpass-tiles';
import { CursorOrbit } from './view/orbit';
import { EditSession } from './edit/session';
import { skeletonReady } from './render/skeleton';
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

const map = new maplibregl.Map({
  container: 'map',
  // MSAA задаётся только при создании контекста — переключение требует перезагрузки
  canvasContextAttributes: { antialias: gfx.antialias },
  style: STYLE_URL,
  center: [37.6205, 55.7535],
  zoom: 16,
  pitch: 60,
  bearing: -20,
  hash: true,
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }));

const infoEl = document.getElementById('info')!;
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
/** Исходные элементы API области редактирования (геометрия и члены нужны для osmChange). */
let rawElements = new Map<string, OsmWay | OsmRelation>();
let osmUser: OsmUser | undefined;
let uploadComment = '';
let uploading = false;
const changesEl = document.getElementById('changes')!;

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
  overpass.enabled = !editing && map.getZoom() >= OVERPASS_MIN_ZOOM;
  overpass.update();
}

function showOverpassStatus() {
  updateOverpassIndicator();
  if (editing) return;
  if (!overpass.enabled) return setStatus(`Здания из тайлов. С z ≥ ${OVERPASS_MIN_ZOOM} — из Overpass.`);
  const { ready, total, loading, waiting } = overpass.status();
  setStatus(`Overpass: ${ready}/${total} тайлов${loading ? `, загружается ${loading}` : ''}${waiting ? `, ждут повтора ${waiting} (лимит/ошибка, см. консоль)` : ''}.`);
}

// Пересчитываем контуры с частями, когда догрузились новые тайлы
let tilesChanged = false;
map.on('sourcedata', (e) => {
  if (e.sourceId === 'openmaptiles' && e.isSourceLoaded) tilesChanged = true;
});
map.on('idle', () => {
  if (!tilesChanged || !map.getLayer(BUILDINGS_LAYER)) return;
  tilesChanged = false;
  (map.getSource('merged-exploded') as maplibregl.GeoJSONSource).setData({
    type: 'FeatureCollection',
    features: explodeMerged(queryTileBuildings(map, 'openmaptiles', 'building')),
  });
  const tileFeatures = map.querySourceFeatures('openmaptiles', { sourceLayer: 'building' });
  if (OUTLINE_REMAINDERS) {
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
});

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
        properties: { ...f.properties, src: f.id, key, tile: f.tile ?? '' },
      });
    }
  }
  return [...out.values()];
}

function updateTileFilter() {
  const notIn = (ids: number[]): ExpressionSpecification => ['!', ['in', ['id'], ['literal', ids]]];
  const hiddenIds = [...userHidden].map(Number).filter(Number.isFinite);
  // Тайлы, здания которых уже нарисованы из Overpass
  const overpassTiles = overpass.displayed();
  const byTile = overpassTiles.length ? tileFeatureIdsByTile(map, 'openmaptiles', 'building') : new Map<string, number[]>();
  const overpassIds = overpassTiles.flatMap((k) => byTile.get(k) ?? []);
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
    const { features, skipped } = parseBuildings(elements);
    const rendered = editLayer.setGroup('edit', features, [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2]);
    if (!map.getLayer(editLayer.id)) map.addLayer(editLayer);
    editing = new Map(rendered.map((r) => [r.feature.key, r]));
    session = new EditSession(features, onSessionChange);
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

map.on('click', (e) => {
  if (editing) {
    selectEdited(editLayer.pick(e.point));
    return;
  }
  const key = overpassLayer.pick(e.point);
  overpassLayer.select(key);
  const r = key ? overpass.get(key) : undefined;
  if (r) {
    clearTileHighlight();
    infoEl.innerHTML = `<p class="hint">Данные Overpass</p>${describeOsm(r)}`;
    return;
  }
  const f = map.queryRenderedFeatures(e.point, { layers: TILE_LAYERS })[0];
  infoEl.innerHTML = f ? describeTile(f) : '';
  map.setFilter(HIGHLIGHT_LAYER, ['==', ['id'], f?.layer.id === MERGED_LAYER ? -1 : f?.id ?? -1]);
  map.setFilter(MERGED_HIGHLIGHT_LAYER, ['==', ['get', 'key'], f?.layer.id === MERGED_LAYER ? f.properties.key : '']);
  if (f) resolveTileFeature(f);
});

map.on('mousemove', (e) => {
  const hit = editing
    ? !!editLayer.pick(e.point)
    : !!overpassLayer.pick(e.point) || map.queryRenderedFeatures(e.point, { layers: TILE_LAYERS }).length > 0;
  map.getCanvas().style.cursor = hit ? 'pointer' : '';
});

infoEl.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('button');
  if (!btn) return;
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
  selectedKey = key;
  editLayer.select(key);
  renderSelected();
}

function renderSelected() {
  const r = selectedKey ? editing?.get(selectedKey) : undefined;
  infoEl.innerHTML = r ? describeOsm(r, session ? renderTagForm(r.feature.key, session) : undefined) : '';
}

/** После правки тегов: пересобрать меши, обновить панель и список изменений. */
function onSessionChange(keys: string[]) {
  for (const key of keys) {
    const f = session?.get(key);
    const r = f && editLayer.updateFeature('edit', f);
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
  const changes = session?.changes() ?? [];
  changesEl.hidden = !session;
  if (!session) { changesEl.innerHTML = ''; return; }
  const list = changes.map((c) => `
    <li><a href="#" data-select="${esc(c.key)}">${esc(c.key)}</a>
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

function renderUpload(count: number): string {
  const s = server();
  const account = osmUser
    ? `Вы вошли как <a href="${s.web}/user/${encodeURIComponent(osmUser.name)}" target="_blank" rel="noopener">${esc(osmUser.name)}</a>
       <button type="button" data-logout>Выйти</button>`
    : `<button type="button" data-login ${uploading ? 'disabled' : ''}>Войти в OSM</button>`;
  const canUpload = osmUser && count > 0 && uploadComment.trim() && !uploading;
  return `
    <div class="upload${s.id === 'prod' ? ' prod' : ''}">
      <h3>Отправка: ${esc(s.label)}</h3>
      <p class="account">${account}</p>
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
      return { key: c.key, element, before: c.before, after: c.after };
    });
    const res = await uploadEdits(edits, uploadComment.trim(), (t) => setStatus(t));
    const saved = new Map<string, { version: number; tags: Record<string, string> }>();
    for (const e of edits) {
      const version = res.versions.get(e.key);
      if (version === undefined) continue;
      const rebased = res.rebased.get(e.key);
      const tags = rebased?.tags ?? e.after;
      rawElements.set(e.key, { ...(rebased?.element ?? e.element), version, tags });
      saved.set(e.key, { version, tags });
    }
    session.markSaved(saved);
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
  if (t.closest('[data-login]')) return void doLogin();
  if (t.closest('[data-logout]')) { logout(); osmUser = undefined; return renderChanges(); }
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

const serverSelect = document.getElementById('server-select') as HTMLSelectElement;
serverSelect.innerHTML = Object.values(SERVERS).map((s) => `<option value="${s.id}">${esc(s.label)}</option>`).join('');
serverSelect.value = server().id;
serverSelect.addEventListener('change', () => {
  setServer(serverSelect.value as ServerId);
  void refreshUser();
});
void refreshUser();

bindTagForms(infoEl, () => session);

// Скатные крыши сложной формы появляются, когда догрузится straight skeleton.
// Пересобираем только здания, которые до этого были упрощены до плоской крыши.
void skeletonReady.then((ok) => {
  if (!ok) return;
  const needsSkeleton = (f: Feature3D) => {
    const shape = f.tags['roof:shape'];
    return shape === 'round' || shape === 'gambrel' || shape === 'mansard' || shape === 'half-hipped' || ((shape === 'gabled' || shape === 'hipped') && !(f.polygons.length === 1 && !f.polygons[0].inners.length && f.polygons[0].outer.length === 4));
  };
  void overpassLayer.rebuildWhere(needsSkeleton);
  void editLayer.rebuildWhere(needsSkeleton, (r) => {
    editing?.set(r.feature.key, r);
    if (r.feature.key === selectedKey) renderSelected();
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

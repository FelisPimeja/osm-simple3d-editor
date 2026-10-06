import * as maplibregl from 'maplibre-gl';
import type { ExpressionSpecification, FillExtrusionLayerSpecification, MapGeoJSONFeature } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { fetchArea, fetchMap, type Bbox } from './osm/api';
import { computeHeights } from './osm/heights';
import { incompleteBuildingRelations, parseBuildings } from './osm/model';
import { BuildingsLayer, type RenderedFeature } from './render/buildings-layer';
import { queryTileBuildings, type TileBuildingFeature } from './tiles/tile-features';
import { computeOutlineRemainders, overlapShares, inPolygon, interiorPoint, polygonsOf, type Ring } from './tiles/outlines';

const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
const BUILDINGS_LAYER = 'simple3d-buildings';
const REMAINDERS_LAYER = 'simple3d-outline-remainders';
const MERGED_LAYER = 'simple3d-merged-exploded';
const MERGED_HIGHLIGHT_LAYER = 'simple3d-merged-highlight';
const TILE_LAYERS = [BUILDINGS_LAYER, REMAINDERS_LAYER, MERGED_LAYER];
const HIGHLIGHT_LAYER = 'simple3d-highlight';
const MIN_EDIT_ZOOM = 16;
// Замена контуров с частями на «контур минус части» (src/tiles/outlines.ts). Временно выключено:
// по тайлам контур не отличить от части, эвристика даёт артефакты — см. PLAN.md.
const OUTLINE_REMAINDERS = false;
// Доля площади полигона склеенной фичи, перекрытая другими зданиями, начиная с которой он считается лишним
const OVERLAP_THRESHOLD = 0.5;
// Ограничение самого API — 0.25 deg², но берём заметно меньше, чтобы не упираться в 50k узлов
const MAX_EDIT_AREA = 0.0004;

// Склеенные фичи (id с суффиксом 0) рисуем отдельным слоем, разрезанными на полигоны
const BASE_FILTER: ExpressionSpecification = ['all', ['!=', ['get', 'hide_3d'], true], ['!=', ['%', ['id'], 10], 0]];

// В тайлах colour — сырое значение тега: CSS-имя, hex или несколько цветов через ';'.
// Берём первый, невалидный заменяем цветом по умолчанию (иначе здание становится чёрным).
const TILE_COLOUR: ExpressionSpecification = [
  'let', 'c', ['coalesce', ['get', 'colour'], ''],
  ['let', 'i', ['index-of', ';', ['var', 'c']],
    ['to-color', ['case', ['>=', ['var', 'i'], 0], ['slice', ['var', 'c'], 0, ['var', 'i']], ['var', 'c']], '#d9d0c9']],
];

/** id тайловых фич-контуров, заменённых остатком «контур минус части». */
let replacedIds: number[] = [];
/** id тайловых фич, перекрытых областью редактирования. */
let editAreaIds: number[] = [];
/**
 * Временно: скрытые вручную кнопкой «Скрыть» (для изучения наложений).
 * Ключ — id тайловой фичи или `key` полигона склеенной фичи.
 */
const userHidden = new Set<string>();

const map = new maplibregl.Map({
  container: 'map',
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
const editBtn = document.getElementById('edit-btn') as HTMLButtonElement;
const mergedBtn = document.getElementById('merged-btn') as HTMLButtonElement;

const editLayer = new BuildingsLayer();
let editing: Map<string, RenderedFeature> | undefined;

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
      'fill-extrusion-color': TILE_COLOUR,
    },
  });

  map.addSource('outline-remainders', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({
    id: REMAINDERS_LAYER,
    type: 'fill-extrusion',
    source: 'outline-remainders',
    minzoom: 14,
    paint: { ...extrusion, 'fill-extrusion-color': TILE_COLOUR },
  });

  map.addSource('merged-exploded', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({
    id: MERGED_LAYER,
    type: 'fill-extrusion',
    source: 'merged-exploded',
    minzoom: 14,
    paint: { ...extrusion, 'fill-extrusion-color': TILE_COLOUR },
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

  // До загрузки стиля добавленные слои и фильтры потерялись бы
  editBtn.disabled = false;
  mergedBtn.disabled = false;
});

// Временно: скрыть полигоны склеенных фич, на >50% перекрытые другими зданиями
let hideOverlapped = false;
mergedBtn.addEventListener('click', () => {
  hideOverlapped = !hideOverlapped;
  mergedBtn.textContent = hideOverlapped ? 'Показать перекрытые склеенные' : 'Скрыть перекрытые склеенные';
  updateTileFilter();
});

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
        properties: { ...f.properties, src: f.id, key },
      });
    }
  }
  // Полигоны, на >50% перекрытые другими зданиями, — кандидаты в контуры поверх частей
  const shares = overlapShares(
    [...out.values()].map((f) => ({ key: f.properties!.key, src: f.properties!.src, poly: f.geometry.coordinates as Ring[] })),
    visible.map((f) => ({ id: f.id, polys: f.polys })),
  );
  for (const f of out.values()) {
    const share = shares.get(f.properties!.key) ?? 0;
    f.properties!.overlap = Math.round(share * 100) / 100;
    f.properties!.overlapped = share > OVERLAP_THRESHOLD;
  }
  return [...out.values()];
}

function updateTileFilter() {
  const notIn = (ids: number[]): ExpressionSpecification => ['!', ['in', ['id'], ['literal', ids]]];
  const hiddenIds = [...userHidden].map(Number).filter(Number.isFinite);
  map.setFilter(BUILDINGS_LAYER, ['all', BASE_FILTER, notIn([...replacedIds, ...editAreaIds, ...hiddenIds])]);
  map.setFilter(REMAINDERS_LAYER, notIn([...editAreaIds, ...hiddenIds]));
  map.setFilter(MERGED_LAYER, ['all',
    hideOverlapped ? ['!=', ['get', 'overlapped'], true] : true,
    ['!', ['in', ['get', 'src'], ['literal', editAreaIds]]],
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
    const { features, skipped } = parseBuildings(await fetchArea(bbox, incompleteBuildingRelations));
    const rendered = editLayer.setFeatures(features, [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2]);
    if (!map.getLayer(editLayer.id)) map.addLayer(editLayer);
    editing = new Map(rendered.map((r) => [r.feature.key, r]));
    hideTileBuildingsIn(bbox);
    clearSelection();

    const outlines = features.filter((f) => f.hasParts).length;
    setStatus(`Загружено: ${rendered.length} объектов (контуров с частями: ${outlines}, пропущено: ${skipped.length}). Кликните по зданию.`);
    if (skipped.length) console.info('Пропущены:', skipped);
    editBtn.textContent = 'Выйти из редактирования';
    editBtn.classList.add('active');
  } catch (err) {
    setStatus(`Ошибка загрузки: ${(err as Error).message}`, true);
  } finally {
    editBtn.disabled = false;
  }
}

function exitEditMode() {
  editing = undefined;
  if (map.getLayer(editLayer.id)) map.removeLayer(editLayer.id);
  editAreaIds = [];
  updateTileFilter();
  clearSelection();
  editBtn.textContent = 'Редактировать область';
  editBtn.classList.remove('active');
  setStatus('Режим просмотра.');
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
    const key = editLayer.pick(e.point);
    editLayer.select(key);
    const r = key ? editing.get(key) : undefined;
    infoEl.innerHTML = r ? describeOsm(r) : '';
    return;
  }
  const f = map.queryRenderedFeatures(e.point, { layers: TILE_LAYERS })[0];
  infoEl.innerHTML = f ? describeTile(f) : '';
  map.setFilter(HIGHLIGHT_LAYER, ['==', ['id'], f?.layer.id === MERGED_LAYER ? -1 : f?.id ?? -1]);
  map.setFilter(MERGED_HIGHLIGHT_LAYER, ['==', ['get', 'key'], f?.layer.id === MERGED_LAYER ? f.properties.key : '']);
  if (f) resolveTileFeature(f);
});

map.on('mousemove', (e) => {
  const hit = editing ? !!editLayer.pick(e.point) : map.queryRenderedFeatures(e.point, { layers: TILE_LAYERS }).length > 0;
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
  map.setFilter(HIGHLIGHT_LAYER, ['==', ['id'], -1]);
  map.setFilter(MERGED_HIGHLIGHT_LAYER, ['==', ['get', 'key'], '']);
}

function setStatus(text: string, error = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', error);
}

function describeOsm({ feature: f, roofApproximated }: RenderedFeature): string {
  const h = computeHeights(f.tags);
  const warn = [
    roofApproximated && `Форма крыши «${h.roofShape}» пока не поддерживается для этой геометрии — показаны стены до верха и плоская крыша.`,
    h.source === 'default' && 'Нет height и building:levels — высота взята по умолчанию.',
    f.tags.height && f.tags['building:levels'] && Math.abs(h.top - Number(f.tags['building:levels']) * 3) > h.top * 0.5 &&
      'height и building:levels заметно расходятся.',
  ].filter(Boolean);
  return `
    <h2>${f.kind === 'part' ? 'building:part' : 'building'} —
      <a href="https://www.openstreetmap.org/${f.key}" target="_blank" rel="noopener">${f.key}</a> v${f.version}</h2>
    <pre>высота: ${fmt(h.min)} → ${fmt(roofApproximated ? h.top : h.wallTop)} → ${fmt(h.top)} м (${h.source})\nкрыша: ${h.roofShape}, ${fmt(h.roofHeight)} м</pre>
    ${warn.map((w) => `<p class="warn">⚠ ${w}</p>`).join('')}
    ${tagTable(f.tags)}`;
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
    const { features } = parseBuildings(await fetchMap(bbox));
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
const esc = (s: unknown) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const tagTable = (tags: Record<string, unknown>) =>
  `<table>${Object.entries(tags).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>`;

if (import.meta.env.DEV) Object.assign(window, { map, editLayer });

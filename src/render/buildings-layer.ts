import { wireframeEdges } from './wireframe-edges';
import { openRoofOutline } from './open-roof';
import { outlineRemainders } from './outline-remainder';
import { closedWallCap } from './indoor-wall-cap';
import { cutEscalatorOpenings, escalatorFloorHoles, escalatorOpeningMasks, escalatorOpeningOutline } from './escalator-openings';
import { partitionFloors } from './floor-overlap';
import { occludedByTriangles } from './ray-occlusion';
import { trimIndoorBuildingEdges } from './indoor-building-edges';
import { revolvingDoorDiameter, revolvingDoorModel } from './revolving-door';
import { cutDoorOpenings, doorOpeningHalfWidth, wallDoorwaySpan } from './door-openings';
import * as THREE from 'three';
import polygonClipping, { type MultiPolygon as ClipMulti } from 'polygon-clipping';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LngLat, MercatorCoordinate, type CustomLayerInterface, type CustomRenderMethodInput, type Map as MlMap, type PointLike } from 'maplibre-gl';
import { computeHeights, type Heights } from '../osm/heights';
import { clipAbove, prepareSolid, sectionOf, trimCoplanarWalls, trimTriangles, type PreparedSolid } from './shell-trim';
import { nextFrameSlot } from './frame-budget';
import { trimInWorker, trimSync, trimWorkersAvailable, type TrimJob, type TrimResult } from './shell-trim-pool';
import { areaLedgeTriangles } from './area-ledge';
import { floatingParts } from '../osm/floating';
import type { Feature3D, IndoorKind, LonLat, Polygon } from '../osm/model';
import { dropPartSeams } from './part-seams';
import { edgePass } from './edge-pass';
import { bottomTriangles, buildTriangles, shapeOf, type LocalPolygon, type Pt } from './building-geometry';
import { recordMs, timed } from '../perf';
import { orientedFrame, type LocalFrame } from './oriented-box';
import { setTreesMonochrome, setTreesSeasonal, type TreeGroup } from './trees';
import { UnderlayMeshes } from './underlay-meshes';

const DEFAULT_WALL = '#ffffff';
const DEFAULT_ROOF = '#ffffff';
/** Подсветка поверх всего (выбор контура) — яркий оранжевый, чтобы отличалась от выделения. */
const OVERLAY_COLOUR = new THREE.Color('#ff6a00');
const HIGHLIGHT = new THREE.Color('#97beff'); // #2f7cff, смешанный с белым пополам
const MONOCHROME = new THREE.Color('#ffffff');

/** Indoor-объект выбранного этажа: контуры (lon/lat) и высота пола, м. */
export interface IndoorItem { key: string; kind: IndoorKind; polygons: Polygon[]; line?: boolean; z: number; /** Только явные indoor=area могут иметь объёмный свободный край. */ areaLedge?: boolean; /** Заливка по назначению (иначе — по виду). */ colour?: number; /** Ширина дверей в стенах этого помещения, м (туалеты — уже обычных). */ doorWidth?: number;
  /** Шахта лифта выше нижней остановки: без своего пола, и пол других объектов этажа по её контуру вырезан. */ shaft?: boolean;
  /** Стены многоуровневой комнаты на верхнем этаже, без своего пола. */ noFloor?: boolean;
  /** Только вырез (этаж, где лифт проходит без остановки): ни пола, ни стен. */ cutOnly?: boolean;
  /** Бассейн: чаша этой глубины (м) под полом этажа, вода чуть ниже пола. */ pool?: number }
export interface EscalatorItem { key: string; line: LonLat[]; bottom: number; top: number; width: number; incline?: string; pale?: boolean }

/** Заливка пола по виду indoor-объекта. */
const INDOOR_COLOURS: Record<IndoorKind, number> = { level: 0xe7e5e4, area: 0xffffff, corridor: 0xffffff, room: 0xf6ead2, wall: 0xffffff, column: 0xffffff, poi: 0xffffff };
/** Части здания меньше этой площади (м²) на срезе этажа закрываются крышкой — колонны, столбы. */
const SOLID_PART_AREA = 6;
/** Толщина контура внешнего периметра этажа на срезе, px. */
const PERIMETER_WIDTH_PX = 2;
/** Дверной проём в стенах плана: ширина и высота, м; дверь дальше DOOR_SNAP от стены её не режет. */
const DOOR_WIDTH = 1;
const DOOR_HEIGHT = 2.2;
const DOOR_SNAP = 0.15;
/** Дверь туалета (и кабинок) — уже обычной. */
export const TOILET_DOOR_WIDTH = 0.8;
/** Ширина из тега width двери (м), если правдоподобна. */
const tagWidth = (tags?: Record<string, string>) => {
  const w = parseFloat(tags?.width ?? '');
  return w >= 0.5 && w <= 4 ? w : undefined;
};
/** Перемычка во всю толщину — только в просвете размером с дверь (до двустворчатой) в стене толщиной до 0,5 м:
 * шире или глубже — это проход или узкое место коридора, над ним ничего нет. */
const LINTEL_MAX_GAP = DOOR_WIDTH * 2 + 0.2;
const LINTEL_MAX_DEPTH = 0.5;
/** Плита под полом этажа — по сечению оболочки чуть выше пола, м. */
const SLAB_PROBE = 0.1;
/** Толщина перекрытия: потолок нижнего этажа — на столько ниже пола верхнего, м. */
const SLAB_THICKNESS = 0.3;
/** Насколько ниже потолка этажа проходит срез, м. */
const CUT_BELOW_CEIL = 0.1;
/** Части, начинающиеся не ниже этого под потолком этажа, считаются потолком (срез — под их днищем), м. */
const CEIL_SNAP = 0.5;
/** Стены, перегородки и колонны — белые, как здание; в полную высоту этажа (до среза). */
/** Стены помещений: каждая стена — две грани (по одной на сторону) с цветом помещения со своей стороны. */
const INDOOR_WALL_MATERIAL = new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true, side: THREE.FrontSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
/** Насколько в сторону от стены смотреть, в каком она помещении, м. */
const WALL_SIDE_PROBE = 0.05;
/** Выделенное помещение: заливка цветом выделения частей и контур. */
const INDOOR_SELECT_MATERIAL = new THREE.MeshBasicMaterial({ color: HIGHLIGHT, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 });
/** Маркер двери на полу проёма: плоский кружок (вид сверху и сбоку) — на любом ракурсе виден. */
const DOOR_GEO = new THREE.SphereGeometry(0.08, 16, 8).scale(1, 1, 0.35);
const DOOR_MATERIAL = new THREE.MeshBasicMaterial({ color: 0x000000 });
const DOOR_AXIS_MATERIAL = new THREE.LineDashedMaterial({ color: 0x2563eb, dashSize: 0.12, gapSize: 0.08, depthTest: false, depthWrite: false });
const DOOR_SELECTED_MATERIAL = new THREE.MeshBasicMaterial({ color: 0x2563eb });
/** Вход на фасаде (entrance=*): белый прямоугольник 1×2 м чуть перед стеной, с тёмной обводкой. */
const ENTRANCE_MATERIAL = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
const ENTRANCE_SELECTED_MATERIAL = new THREE.MeshBasicMaterial({ color: 0x97beff, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
const ENTRANCE_LINE_MATERIAL = new THREE.LineBasicMaterial({ color: 0x57534e });
// Lines have no polygonOffset; bias their depth like the entrance fill, keeping wall occlusion.
ENTRANCE_LINE_MATERIAL.onBeforeCompile = shader => {
  shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\n  gl_Position.z -= 2e-5 * gl_Position.w;');
};
/** Вход на фасаде — того же размера, что проём двери на плане этажа: ширина по тегу width, иначе DOOR_WIDTH. */
export const ENTRANCE_WIDTH = DOOR_WIDTH;
export const ENTRANCE_HEIGHT = DOOR_HEIGHT;
/** Прямоугольник входа лежит в плоскости стены (как проём на плане этажа); от мерцания — сдвиг глубины материала. */
const ENTRANCE_OFFSET = 0;
/** Вход со скрытого объекта режима здания виден, если стоит не дальше этого от стены видимого, м. */
const ENTRANCE_ON_WALL = 0.3;
/** Расстояние от точки до отрезка ab. */
function distToSegment([px, py]: Pt, [ax, ay]: Pt, [bx, by]: Pt): number {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}
/** Насколько близко к маркеру двери выбирает клик, px. */
const DOOR_PICK_PX = 10;
/** Полы помещений, коридоров и площадок — цвет вершин по виду. */
/** Пол лежит на отметке этажа; сдвиг глубины — чтобы линии на полу (швы, низ стен) не тонули в нём. */
const INDOOR_FLOOR_MATERIAL = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
/** Крышка сечения замкнутых стен и колонн — освещается как верх здания. */
const INDOOR_CAP_MATERIAL = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide });
/** Стена помещения совпадает с уже нарисованной (периметр, indoor=wall, соседнее помещение): ближе этого, м. */
const WALL_MERGE_DIST = 0.03;
/** Сколько бледных планов нижних этажей держать готовыми (см. palePlans). */
const PALE_PLAN_CACHE = 24;
/** То же для граней колонн и стен-полигонов: тоньше любой стены. */
const SOLID_MERGE_DIST = 0.03;
/** Внутренний контур помещения тоньше этого, м, — стена (объём с крышкой), а не проём. */
const THIN_HOLE_WIDTH = 0.6;
/** Отступ внутрь цветной грани помещения на фасаде от плоскости оболочки здания. */
const FACADE_TINT_INSET = 0.02;
const WALL_MERGE_COS = Math.cos(THREE.MathUtils.degToRad(10));
const INDOOR_LINE_MATERIAL = new THREE.LineBasicMaterial({ color: 0x57534e });
/** Floor contacts remain depth-tested, with a small bias against coplanar floor faces. */
const FLOOR_CONTACT_MATERIAL = new THREE.LineBasicMaterial({ color: 0x57534e });
FLOOR_CONTACT_MATERIAL.onBeforeCompile = shader => {
  shader.vertexShader=shader.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\n gl_Position.z -= 2e-6 * gl_Position.w;');
};
/** Этаж под вторым светом — бледнее: стены и крышки высветлены, полы смешаны с белым, линии светлее. */
const INDOOR_PALE_WALL = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x777777, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
const INDOOR_PALE_LINE = new THREE.LineBasicMaterial({ color: 0xc4c0bb });
const PALE_MIX = 0.5;
/** Чаша бассейна: стенки и дно — светлый кафель; вода — полупрозрачная, на POOL_WATER_DROP ниже пола. */
const POOL_TILE_MATERIAL = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide });
const POOL_WATER_MATERIAL = new THREE.MeshLambertMaterial({ color: 0x2f9bd6, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false });
const POOL_WATER_DROP = 0.2;
/** Грани частей здания ближе этого к полу этажа со вторым светом — вырезаются в пустотах, м. */
const VOID_FACE_DZ = 0.1;

/** Перекрытие этажа со вторым светом (плита с дырами под полом) и край пустоты. */
const INDOOR_SLAB_MATERIAL = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
const INDOOR_VOID_EDGE = new THREE.LineBasicMaterial({ color: 0x57534e });
const ESCALATOR_BELT = new THREE.MeshLambertMaterial({ color: 0xb0b6ba, side: THREE.DoubleSide });
const ESCALATOR_SIDE = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide });
const ESCALATOR_STEP = new THREE.MeshLambertMaterial({ color: 0x9da5aa, side: THREE.DoubleSide });
const ESCALATOR_BALUSTRADE = new THREE.MeshLambertMaterial({ color: 0xb9d3dc, side: THREE.DoubleSide,
  transparent: true, opacity: 0.4, depthWrite: false });
const ESCALATOR_HANDRAIL = new LineMaterial({ color: 0x656d73, linewidth: 5 });
const ESCALATOR_SELECTED = new THREE.MeshLambertMaterial({ color: HIGHLIGHT, side: THREE.DoubleSide });
const ESCALATOR_SELECTED_HANDRAIL = new LineMaterial({ color: HIGHLIGHT.getHex(), linewidth: 5 });
const ESCALATOR_PALE_BELT = new THREE.MeshLambertMaterial({ color: 0xd8dbdd, side: THREE.DoubleSide });
const ESCALATOR_PALE_SIDE = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x777777, side: THREE.DoubleSide });
const ESCALATOR_PALE_STEP = new THREE.MeshLambertMaterial({ color: 0xced2d4, side: THREE.DoubleSide });
const ESCALATOR_PALE_BALUSTRADE = new THREE.MeshLambertMaterial({ color: 0xdce9ed, side: THREE.DoubleSide,
  transparent: true, opacity: 0.4, depthWrite: false });
const ESCALATOR_PALE_HANDRAIL = new LineMaterial({ color: 0xc4c0bb, linewidth: 5 });

export interface DoorItem { key: string; at: LonLat; z: number; tags?: Record<string, string> }

/** План этажа для слоя. below — этажи под вторым светом (видны сквозь пустоты voids в перекрытии). */
export interface IndoorLevel {
  cut: number;
  /** Высота пола этажа, м. */
  floor: number;
  items: IndoorItem[];
  /** Не рисуются, только подсветка выбора: помещения в несколько этажей выше своего пола (z — пол основания). */
  highlights?: IndoorItem[];
  escalators?: EscalatorItem[];
  /** Все эскалаторы здания (и не видные с этажа): проёмы в планах нижних этажей. */
  cutEscalators?: EscalatorItem[];
  doors?: LonLat[];
  /** Matching rear-face cuts for a doorway through a solid wall. */
  doorCuts?: { at: LonLat; width: number; polygon?: LonLat[] }[];
  /** Пустоты в перекрытии этажа: многоугольники lon/lat ([внешнее кольцо, ...дыры]). */
  voids?: LonLat[][][];
  /** Высоты, на которых пустота прорезает перекрытия (пол этажа и полы промежуточных этажей), — по пустотам. */
  voidCuts?: { polygon: LonLat[][][]; zs: number[] }[];
  below?: { cut: number; items: IndoorItem[]; doors?: LonLat[]; doorCuts?: { at: LonLat; width: number; polygon?: LonLat[] }[]; doorModels?: DoorItem[]; /** Собственные проёмы этого этажа. */ voids?: LonLat[][][] }[];
}

export interface RenderedFeature { feature: Feature3D; roofApproximated: boolean }

export interface GraphicsOptions {
  /** Полусферический свет: небо сверху, земля снизу. */
  hemisphere: boolean;
  /** Поддельная окклюзия: затемнение низа стен у земли (цвет вершин). */
  groundAO: boolean;
  /** Контуры рёбер. */
  edges: boolean;
  /** Не рисовать стыки соседних частей, чьи грани у стыка лежат в одной плоскости (заметно дороже сборка рёбер). */
  partSeams?: boolean;
  /** Не выделять стекло: стеклянные стены и крыши — как обычные. */
  noGlass?: boolean;
  /** Здания без высоты и этажей поднимать на высоту по умолчанию (иначе — плоский след). */
  defaultHeight?: boolean;
  /** Деревья (natural=tree, ряды, леса) на карте. */
  trees?: boolean;
  /** Цвет лиственных — по времени года (сегодняшняя дата). */
  seasons?: boolean;
}

/** Высота, на которой затемнение у земли сходит на нет, м (для зданий выше AO_HEIGHT). */
const AO_HEIGHT = 6;
/** Доля высоты здания, на которой затемнение сходит на нет, — для низких зданий. */
const AO_FADE_SHARE = 0.5;
/** Яркость у самой земли для зданий не ниже AO_HEIGHT; у низких затемнение слабее. */
const AO_MIN = 0.55;
/** Порог угла между гранями для контуров, градусы: швы триангуляции на плоских гранях не рисуем. */
const EDGE_ANGLE = 25;
/** Сдвиг вертикали в конце стены внутрь неё, м: за примыкающей стеной вертикаль не просвечивает. */
const EDGE_INSET = 0.03;
/** Пунктир подземной части здания: виден только не закрытый зданием участок (земля карты глубину не пишет). */
const UNDERGROUND_MATERIAL = new THREE.LineDashedMaterial({ color: 0x111111, dashSize: 0.8, gapSize: 0.5, depthWrite: false, transparent: true, opacity: 0.85 });
/** Выбранный контур подземной части — целиком, сквозь здание. */
const UNDERGROUND_SELECTED = new THREE.LineDashedMaterial({ color: 0x2563eb, dashSize: 0.8, gapSize: 0.5, depthTest: false, depthWrite: false, transparent: true });
/** Насколько близко к пунктиру подземной части выбирает клик, px. */
const UNDERGROUND_PICK_PX = 6;
/** Вершина контура на прямой (поворот меньше этого, рад) — не угол: ни вертикали, ни разрыва пунктира. */
const CORNER_MIN_TURN = 0.05;
/** Стены плана: мелкие изломы коротких сегментов не образуют видимого ребра (12°). */
const INDOOR_EDGE_TURN = Math.PI / 15;

/** Вертикаль контура подземной части — в углах с поворотом не меньше этого, рад. */
const UNDERGROUND_POST_TURN = 0.35;
/** Вертикали контура подземной части — не ближе этого друг к другу, м. */
const UNDERGROUND_POST_GAP_M = 1;

/** Вершины выпуклой оболочки кольца (номера). */
function hullIndices(pts: Pt[]): Set<number> {
  const order = pts.map((_, i) => i).sort((a, b) => pts[a][0] - pts[b][0] || pts[a][1] - pts[b][1]);
  const cross = (o: number, a: number, b: number) =>
    (pts[a][0] - pts[o][0]) * (pts[b][1] - pts[o][1]) - (pts[a][1] - pts[o][1]) * (pts[b][0] - pts[o][0]);
  const half = (list: number[]) => {
    const h: number[] = [];
    for (const i of list) { while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], i) <= 1e-9) h.pop(); h.push(i); }
    return h;
  };
  return new Set([...half(order), ...half([...order].reverse())]);
}

/** Поворот контура в вершине i, рад (0 — прямая). */
function turnAt(pts: Pt[], i: number): number {
  const p = pts[(i + pts.length - 1) % pts.length], c = pts[i], n = pts[(i + 1) % pts.length];
  const a1 = Math.atan2(c[1] - p[1], c[0] - p[0]), a2 = Math.atan2(n[1] - c[1], n[0] - c[0]);
  return Math.abs(Math.atan2(Math.sin(a2 - a1), Math.cos(a2 - a1)));
}

/** Кольцо без вершин на прямых участках и без замыкающего повтора первой точки. */
function cornersOnly(ring: Pt[]): Pt[] {
  const pts = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring.slice();
  for (let changed = true; changed && pts.length > 3;) {
    changed = false;
    for (let i = 0; i < pts.length && pts.length > 3; i++) {
      const p = pts[(i + pts.length - 1) % pts.length], c = pts[i];
      if (turnAt(pts, i) < CORNER_MIN_TURN || Math.hypot(c[0] - p[0], c[1] - p[1]) < 1e-3) { pts.splice(i, 1); changed = true; i--; }
    }
  }
  return pts;
}
const EDGE_OPACITY = 0.55;
const EDGE_MATERIAL = new THREE.LineBasicMaterial({ color: 0x3a3a3a, transparent: true, opacity: EDGE_OPACITY });
/** Проход отрисовки: обычный или режим контуров (грани зданий только пишут глубину). */
/**
 * Проход отрисовки групп: 'all' — как есть; 'wire' — режим контуров (грани зданий только в глубину);
 * 'wire-fills' и 'wire-lines' — тот же режим двумя частями, между которыми рисуются поднятые подложки:
 * сначала видимые заливки (полы помещений и прочее), затем грани в глубину и все линии.
 */
type RenderPass = 'all' | 'wire' | 'wire-fills' | 'wire-lines';
/** Рёбра объёмов с проблемами проверки («Подсветить все»): ошибки — красные, предупреждения — оранжевые; толщина, px. */
const ISSUE_COLOUR = { error: 0xff1a1a, warning: 0xff8a00 };
const ISSUE_WIDTH_PX = 3;
/** Цвет рёбер соседей, которые правка тянет за собой (общие узлы). */
const LINKED_COLOUR = 0x7c3aed;
/** Превью автоисправления проверки: каркас объёма после исправления. */
const FIX_COLOUR = 0x16a34a;
/** Цикл анимации превью: пауза на текущем виде, переход, пауза на исправленном, мс. */
const FIX_HOLD_FROM = 500, FIX_MORPH = 900, FIX_HOLD_TO = 900;
/** Сквозь другие объёмы — тоньше и бледнее: проблемная часть может прятаться внутри здания. */
const ISSUE_XRAY_WIDTH_PX = 1.5;
/**
 * Скрытые рёбра выделенного в режиме здания: пунктир рисуется только там, где ребро закрыто
 * (глубина больше записанной). Видимые рёбра пунктиром не мерцают: грани отодвинуты от камеры (polygonOffset).
 * Сдвигать сами линии к камере нельзя: глубина MapLibre сильно нелинейна, и сдвиг на вид небольшой — это метры,
 * пунктир пропадал там, где закрывающая грань близко к ребру (у углов).
 */
const HIDDEN_EDGE_MATERIAL = new THREE.LineDashedMaterial({
  color: 0x2563eb, dashSize: 0.25, gapSize: 0.15, transparent: true, opacity: 0.9,
  depthFunc: THREE.GreaterDepth, depthWrite: false,
});
/** Цвет берётся из вершин (стены/крыша, подсветка, затемнение) — один материал на всё. */
// polygonOffset отодвигает грани от камеры: рёбра на плоскостях (основание части на крыше другой) не тонут в них
const MATERIAL = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
/**
 * Плоские контуры нулевой толщины (новая часть на крыше, отступ) лежат в плоскости чужой грани — с общим
 * материалом они мерцают полосами. Им — смещение к камере: всегда поверх своей плоскости, глубина та же.
 */
const THIN_MATERIAL = MATERIAL.clone();
THIN_MATERIAL.polygonOffsetFactor = -1;
THIN_MATERIAL.polygonOffsetUnits = -4;
/** Режим контуров: грани только пишут глубину — рёбра за ними скрыты, а самих граней не видно. */
const DEPTH_ONLY_MATERIAL = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
/** Видимые рёбра в режиме контуров — темнее обычных: кроме них от здания может ничего не остаться. */
const WIRE_EDGE_OPACITY = 0.9;
/** Рёбра выделенного в режиме контуров: цвет и толщина, px. */
const SELECTED_EDGE_COLOUR = 0x2563eb;
const SELECTED_EDGE_WIDTH_PX = 2;
/** То же в обычном режиме (с заливкой): тоньше — грани и так видны. */
const SELECTED_EDGE_WIDTH_SOLID_PX = 1;
/**
 * Заливка выделенного в режиме контуров: полупрозрачная голубая, только ближние грани (глубина та же, что у граней,
 * которые пишет DEPTH_ONLY_MATERIAL, — те же polygonOffset).
 */
const SELECTED_FILL_MATERIAL = new THREE.MeshBasicMaterial({ color: 0x60a5fa, transparent: true, opacity: 0.25, side: THREE.DoubleSide,
  depthWrite: false, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
/** Скрытые рёбра выделенного на карте: пунктир крупнее, чем в режиме здания (видно издалека), синий — как выделение. */
const MAP_HIDDEN_EDGE_MATERIAL = new THREE.LineDashedMaterial({
  color: 0x2563eb, dashSize: 1, gapSize: 0.7, transparent: true, opacity: 0.8,
  depthFunc: THREE.GreaterDepth, depthWrite: false,
});

/** Здание внутри группы: треугольники в локальных метрах и всё, что нужно для раскраски и выбора. */
interface Item {
  feature: Feature3D;
  /** Ключи объектов, с которыми у него общие грани (крыша–дно): их правка требует пересборки этого. */
  contacts: string;
  /** Теги для рисования: свои + унаследованные от контура/отношения. */
  tags: Record<string, string>;
  roofApproximated: boolean;
  /** Ждёт скелет из воркера. */
  pending: boolean;
  /** Треугольники: сначала стены, потом крыша, xyz. */
  positions: Float32Array;
  wallVertices: number;
  /** Перекрытия (плиты стеклянных частей и крыша под соседней частью) — последние вершины, после крыши. */
  floorVertices: number;
  wall: THREE.Color;
  roof: THREE.Color;
  top: number;
  box: THREE.Box3;
  /** Первая вершина в общей геометрии группы. */
  start: number;
  /** Стеклянные стены/крыша (building:material / roof:material = glass) — рисуются отдельным прозрачным мешем. */
  glassWalls: boolean;
  glassRoof: boolean;
  /** Первая вершина в стеклянной геометрии группы. */
  glassStart: number;
  /**
   * Стеклянные стены без участков, закрытых соседней частью (общая стена): вне оболочки этажей они совпадают
   * с соседней гранью и дают рябь. src — из каких positions посчитано; число вершин отличается от исходных стен.
   */
  glassTrim?: { src: Float32Array; walls: Float32Array; deps: Float32Array[] };
  /** Отдельный результат вычитания стен плана: glassTrim остаётся базой при переключении этажей. */
  glassPlanTrim?: { src: Float32Array; walls: Float32Array };
  /** Рёбра здания (отрезки xyz) — считаются один раз, когда контуры включены. */
  edges?: Float32Array;
  /** Режим этажей: positions — оболочка (без граней внутри соседних частей), здесь — исходные треугольники. */
  full?: { positions: Float32Array; wallVertices: number };
}

/**
 * Группа зданий со своей локальной системой координат (метры от origin).
 * Все здания группы слиты в одну геометрию — один draw call на группу вместо двух на здание.
 */
class MeshGroup {
  readonly scene = new THREE.Scene();
  readonly origin: MercatorCoordinate;
  readonly metersToMerc: number;
  readonly model: THREE.Matrix4;
  readonly camera = new THREE.Camera();
  items: Item[] = [];
  readonly byKey = new Map<string, Item>();
  mesh?: THREE.Mesh;
  edges?: THREE.LineSegments;
  wireHidden?: THREE.LineSegments;
  /** Слитая геометрия устарела: слой скрыт, пересборка отложена до показа. */
  stale = false;
  /** Скрытые (только для показа) объекты: не рисуются, не выбираются, без привязок. */
  readonly hidden = new Set<string>();
  /** Толщина плоского следа, м. */
  footprint = FOOTPRINT_HEIGHT;
  /** Рисовать плоским следом независимо от высоты (голый контур в режиме здания). */
  readonly flat = new Set<string>();
  /** Сцена режима здания: части без высоты и этажей — плоские, независимо от настройки высоты по умолчанию. */
  noDefaultHeight = false;
  /** Плоские верхи и дна объектов — чтобы не рисовать совпадающие грани соседних частей. */
  contacts?: Contacts;
  renderFootprints = new Map<string, Polygon[]>();
  /** Обводки контуров под частями (в просмотре вместо заливки). */
  strokes?: THREE.LineSegments;
  /** Выделенный плоский след в режиме здания: толстая обводка и полупрозрачная заливка. */
  strokeSelected: (LineSegments2 | THREE.Mesh | THREE.LineSegments)[] = [];
  /** Из чего посчитана оболочка (исходные треугольники, скрытые и плоские объекты, стекло) — не пересчитывать зря. */
  shellOf?: { bases: Float32Array[]; hidden: string };
  /** Оболочка для планов этажей (buildShell) и по каким данным посчитана — между переключениями этажей не пересчитывается. */
  planShell?: { bases: Float32Array[]; sig: string; shell: Shell };
  /** Висящие части в режиме этажей (ключ → низ, ниже которого части нет): см. floatingParts. */
  lift?: Map<string, number>;
  /** Кеши оболочки нескольких последних вариантов (у этажей свои открытые крыши; выход из этажей — тоже вариант). */
  shellCaches?: Map<string, NonNullable<MeshGroup['shellCache']>>;
  /** Кеш оболочки по частям (см. applyShell): sig — скрытые/голые объекты и стекло. */
  shellCache?: {
    sig: string;
    lifted: Map<Item, { src: Float32Array; lift: number; out: { positions: Float32Array; wallVertices: number } }>;
    solids: Map<Item, { base: Float32Array; solid: PreparedSolid }>;
    trimmed: Map<Item, { base: Float32Array; deps: PreparedSolid[]; positions: Float32Array; wallVertices: number }>;
    /** Подъёмы висящих частей — по тем же объектам (оболочка досчитывается порциями, не считать их каждый кадр). */
    floating?: { feats: Feature3D[]; lift: Map<string, number> };
    /** Рамки граней частей в плане — по тем же массивам вершин. */
    boxes?: WeakMap<Float32Array, [number, number, number, number]>;
    /** Соседи части — пока не менялся набор объёмов (solidsGen): порции не ищут их заново по всем частям. */
    deps?: WeakMap<Item, { base: Float32Array; gen: number; deps: PreparedSolid[] }>;
    solidsGen?: number;
    solidsCount?: number;
  };
  /** Сечения оболочки по высоте (см. sectionAt): те же, пока не менялись объёмы частей. */
  sections?: { solids: PreparedSolid[]; at: Map<number, ClipMulti> };
  private readonly ambient = new THREE.AmbientLight(0xffffff, 1.6);
  // Цвет «земли» — посередине между белым и 0x8a8478: контраст неба и земли вдвое меньше
  private readonly hemi = new THREE.HemisphereLight(0xffffff, 0xc4c2bc, 1.6);

  constructor(center: LonLat) {
    this.origin = MercatorCoordinate.fromLngLat({ lng: center[0], lat: center[1] }, 0);
    this.metersToMerc = this.origin.meterInMercatorCoordinateUnits();
    const s = this.metersToMerc;
    // Локальная система в метрах: x — восток, y — север, z — вверх
    this.model = new THREE.Matrix4().makeTranslation(this.origin.x, this.origin.y, 0).scale(new THREE.Vector3(s, -s, s));
    // HemisphereLight светит вдоль оси up — у нас вверх z
    this.hemi.position.set(0, 0, 1);
    const sun = new THREE.DirectionalLight(0xffffff, 1.8);
    sun.position.set(-0.5, -1, 1.5);
    this.scene.add(this.ambient, this.hemi, sun);
  }

  applyLighting(o: GraphicsOptions) {
    // Полусфера заменяет равномерный рассеянный свет
    this.ambient.visible = !o.hemisphere;
    this.hemi.visible = o.hemisphere;
  }

  toLocal = ([lng, lat]: LonLat): Pt => {
    const c = MercatorCoordinate.fromLngLat({ lng, lat }, 0);
    return [(c.x - this.origin.x) / this.metersToMerc, -(c.y - this.origin.y) / this.metersToMerc];
  };

  fromLocal = ([x, y]: Pt): LonLat => {
    const ll = new MercatorCoordinate(this.origin.x + x * this.metersToMerc, this.origin.y - y * this.metersToMerc, 0).toLngLat();
    return [ll.lng, ll.lat];
  };

  /** Стекло группы — прозрачное, поэтому отдельно от непрозрачной слитой геометрии. */
  glass?: THREE.Mesh;
  /** Входы на фасадах (entrance=*) и где они стоят — для выбора кликом. */
  entranceObj?: THREE.Group;
  entrances: EntrancePlace[] = [];

  disposeEntrances() {
    if (!this.entranceObj) return;
    this.scene.remove(this.entranceObj);
    this.entranceObj.traverse((o) => { if ((o instanceof THREE.Mesh || o instanceof THREE.LineSegments) && o.geometry !== DOOR_GEO) o.geometry.dispose(); });
    this.entranceObj = undefined;
  }

  disposeMesh() {
    this.disposeEntrances();
    this.disposeEdges();
    this.disposeStrokes();
    if (this.glass) { this.glass.geometry.dispose(); this.scene.remove(this.glass); this.glass = undefined; }
    if (!this.mesh) return;
    this.mesh.geometry.dispose();
    this.scene.remove(this.mesh);
    this.mesh = undefined;
  }

  disposeStrokes() {
    for (const o of this.strokeSelected) { this.scene.remove(o); o.geometry.dispose(); (o.material as THREE.Material).dispose(); }
    this.strokeSelected = [];
    if (!this.strokes) return;
    this.strokes.geometry.dispose();
    this.scene.remove(this.strokes);
    this.strokes = undefined;
  }

  disposeEdges() {
    if(this.wireHidden){this.wireHidden.geometry.dispose();(this.wireHidden.material as THREE.Material).dispose();this.scene.remove(this.wireHidden);this.wireHidden=undefined;}
    if (!this.edges) return;
    this.edges.geometry.dispose();
    this.scene.remove(this.edges);
    this.edges = undefined;
  }
}

/**
 * Матрица проекции MapLibre для отрисовки. Дальняя плоскость MapLibre рассчитана на землю: подземные этажи при
 * наклоне камеры срезаются ею. Сжимаем глубину: ближняя плоскость та же, дальняя — втрое дальше (ndc' = (ndc − 1) / 2).
 */
function depthMain(options: CustomRenderMethodInput): THREE.Matrix4 {
  const main = new THREE.Matrix4().fromArray(options.defaultProjectionData.mainMatrix as unknown as number[]);
  const e = main.elements;
  for (let c = 0; c < 4; c++) e[c * 4 + 2] = 0.5 * e[c * 4 + 2] - 0.5 * e[c * 4 + 3];
  return main;
}

/**
 * Custom layer MapLibre, рисующий здания OSM через three.js.
 * Здания разбиты на группы (область редактирования, тайлы данных API), у каждой свой origin —
 * так координаты остаются маленькими и точными для float32.
 */
export class BuildingsLayer implements CustomLayerInterface {
  readonly type = 'custom' as const;
  readonly renderingMode = '3d' as const;

  private map?: MlMap;
  private renderer?: THREE.WebGLRenderer;
  private readonly groups = new Map<string, MeshGroup>();
  /** Деревья тайлов — только на карте (в режиме здания не рисуются), без выбора и привязок. */
  private readonly trees = new Map<string, TreeGroup>();
  /** Асинхронные сборки групп: новая сборка или удаление группы отменяет предыдущую. */
  private readonly pending = new Map<string, symbol>();
  private selected = new Set<string>();
  /** Все здания белым, без цветов из тегов. */
  private monochrome = false;
  private graphics: GraphicsOptions = { hemisphere: false, groundAO: false, edges: false };
  /** Треугольников в последнем кадре — для оценки производительности. */
  lastTriangles = 0;
  visible = true;
  /** Непрозрачность слоя (1 — как есть): здания рисуются в отдельный буфер и кладутся на карту с этой альфой. */
  private opacity = 1;
  /** Режим контуров: заливки зданий нет (грани только закрывают рёбра за собой), рёбра — темнее. */
  private wireframe = false;
  /** Контуры из настроек графики (в режиме контуров рёбра есть всегда). */
  private userEdges = false;
  private composite?: { target: THREE.WebGLRenderTarget; scene: THREE.Scene; camera: THREE.OrthographicCamera; material: THREE.MeshBasicMaterial };
  /** Режим одного здания: рисуется и выбирается только группа FOCUS_GROUP (здание + земля). */
  private focused = false;
  /** Матрица проекции MapLibre из последнего кадра — чтобы проецировать сцену режима здания до её первой отрисовки. */
  private lastMain?: THREE.Matrix4;
  private selectedTreeKey?: string;
  /** Локальная система координат здания в режиме одного здания (в метрах сцены режима). */
  focusAxes?: LocalFrame;
  /** Точки привязки режима одного здания (в метрах сцены режима); undefined — пересчитать. */
  private snaps?: { points: SnapPoint[]; edges: SnapEdge[] };

  /** Подложки пользователя в режиме здания — под зданиями (рисуются первыми). */
  readonly underlays = new UnderlayMeshes(() => this.map?.triggerRepaint());

  constructor(readonly id: string) {}

  onAdd(map: MlMap, gl: WebGL2RenderingContext) {
    this.map = map;
    this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
    this.underlays.attach(this.renderer);
    this.renderer.autoClear = false;
    this.renderer.localClippingEnabled = true; // срез здания выше выбранного этажа
  }

  onRemove() {
    if (this.composite) { this.composite.target.dispose(); this.composite.material.dispose(); this.composite = undefined; }
    this.renderer?.dispose();
    this.renderer = undefined;
  }

  render(_gl: WebGL2RenderingContext, options: CustomRenderMethodInput) {
    if (!this.renderer) return;
    // Проекция кадра — и для инструментов, когда слой зданий скрыт (подгонка подложки на карте)
    this.lastMain = new THREE.Matrix4().fromArray(options.defaultProjectionData.mainMatrix as unknown as number[]);
    // Подложки: в режиме здания — его и общие, на карте (и в наброске на ней) — общие; список задаёт main.ts
    const underlays = this.underlays.size > 0;
    // В режиме контуров грани невидимы, но пишут глубину (прячут задние рёбра) — стоящие подложки рисуем до зданий,
    // иначе грани вырезали бы в них дыры; подложки глубину не пишут, рёбра остаются поверх
    // Но заливки (полы помещений) — до подложек: поднятая над полом подложка иначе оказывалась под ним
    const overFirst = this.visible && this.wireframe;
    const split = overFirst && underlays && this.underlays.hasOver();
    if (underlays) this.underlays.render(depthMain(options), 'under');
    if (split) {
      timed(`${this.id}: кадр (CPU)`, () => this.renderWire(options, 'wire-fills'), () => `${this.groups.size} групп`);
      this.underlays.render(depthMain(options), 'over');
      this.renderWire(options, 'wire-lines');
    } else {
      if (underlays && overFirst) this.underlays.render(depthMain(options), 'over');
      if (this.visible) timed(`${this.id}: кадр (CPU)`, () => this.renderTranslucent(options), () => `${this.groups.size} групп`);
    }
    if (underlays && !overFirst) this.underlays.render(depthMain(options), 'over');
    if (underlays) this.underlays.render(depthMain(options), 'outline');
    // Накладки инструментов (транспортир, оси, превью линий) — последними: поверх и подложек, поднятых над землёй
    const fg = this.groups.get(FOCUS_GROUP);
    if (this.toolOverlay.children.length && fg && this.focused) {
      this.toolCamera.projectionMatrix = depthMain(options).clone().multiply(fg.model);
      this.renderer.resetState();
      this.renderer.render(this.toolOverlay, this.toolCamera);
    }
  }

  /** Куда рисуются группы: буфер прозрачного слоя или сама карта. */
  private drawTarget: THREE.WebGLRenderTarget | null = null;

  /** resetState three сбрасывает и цель отрисовки — вернуть её. */
  private resetState() {
    this.renderer!.resetState();
    if (this.drawTarget) this.renderer!.setRenderTarget(this.drawTarget);
  }

  setOpacity(opacity: number) {
    this.opacity = Math.min(1, Math.max(0, opacity));
    this.map?.triggerRepaint();
  }

  /**
   * Прозрачный слой: просто прозрачные материалы просвечивали бы стенами и частями друг сквозь друга (сортировка
   * по объектам, а не по треугольникам) — рисуем здания непрозрачными в свой буфер и кладём его на карту целиком.
   */
  private renderTranslucent(options: CustomRenderMethodInput) {
    if (!this.wireframe) { this.renderFill(options, 'all'); return; }
    this.renderWire(options, 'wire');
  }

  private renderWire(options: CustomRenderMethodInput, pass: RenderPass) {
    EDGE_MATERIAL.opacity = WIRE_EDGE_OPACITY;
    try { this.renderGroups(options, pass); } finally { EDGE_MATERIAL.opacity = EDGE_OPACITY; }
  }

  /** Здания с прозрачностью слоя: непрозрачно — прямо на карту, иначе — через свой буфер. */
  private renderFill(options: CustomRenderMethodInput, pass: RenderPass) {
    const renderer = this.renderer!;
    if (this.opacity >= 1) { this.renderGroups(options, pass); return; }
    if (this.opacity <= 0) { this.lastTriangles = 0; return; }
    const gl = renderer.getContext();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    let c = this.composite;
    if (!c) {
      const target = new THREE.WebGLRenderTarget(w, h, { samples: 4, type: THREE.HalfFloatType });
      const material = new THREE.MeshBasicMaterial({ map: target.texture, transparent: true, depthTest: false, depthWrite: false, premultipliedAlpha: true });
      const scene = new THREE.Scene();
      scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));
      c = this.composite = { target, scene, material, camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1) };
    }
    if (c.target.width !== w || c.target.height !== h) c.target.setSize(w, h);
    this.drawTarget = c.target;
    this.resetState();
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, true);
    try { this.renderGroups(options, pass); } finally { this.drawTarget = null; }
    c.material.opacity = this.opacity;
    renderer.resetState();
    renderer.render(c.scene, c.camera);
  }

  /** Режим контуров: грани зданий группы — только в глубину. Возвращает, как вернуть сцену обратно. */
  private filterPass(g: MeshGroup, pass: RenderPass): () => void {
    if (pass === 'all') return () => {};
    DEPTH_ONLY_MATERIAL.clippingPlanes = MATERIAL.clippingPlanes;
    const fills = g.entranceObj?.children.filter((o): o is THREE.Mesh => o instanceof THREE.Mesh && !o.userData.entrancePoint) ?? [];
    const planFills: THREE.Mesh[] = [];
    if (g === this.groups.get(FOCUS_GROUP)) for (const root of [this.indoorObj, this.indoorSelObj]) root?.traverseVisible(o => {
      if (o instanceof THREE.Mesh && !(o.material instanceof LineMaterial)) planFills.push(o);
    });
    const swapped = [g.mesh, g.glass, ...fills, ...planFills].filter((o): o is THREE.Mesh => !!o).map((o) => [o, o.material, o.renderOrder] as const);
    for (const [o] of swapped) { o.material = DEPTH_ONLY_MATERIAL; o.renderOrder = -1000; }
    // Половина прохода: прячем то, что рисует другая половина
    const hidden: THREE.Object3D[] = [];
    if (pass !== 'wire') {
      const depthOnly = new Set<THREE.Object3D>(swapped.map(([o]) => o));
      const isLine = (o: THREE.Object3D) => o instanceof THREE.Line || o instanceof THREE.Points
        || (o as THREE.Mesh).material instanceof LineMaterial;
      g.scene.traverseVisible((o) => {
        if (!(o instanceof THREE.Mesh || o instanceof THREE.Line || o instanceof THREE.Points || o instanceof THREE.Sprite)) return;
        const line = isLine(o) || depthOnly.has(o);
        if (line === (pass === 'wire-fills')) hidden.push(o);
      });
      for (const o of hidden) o.visible = false;
    }
    return () => {
      for (const [o, m, order] of swapped) { o.material = m; o.renderOrder = order; }
      for (const o of hidden) o.visible = true;
    };
  }

  /** Режим контуров вкл/выкл. */
  setWireframe(on: boolean) {
    if (on === this.wireframe) return;
    this.wireframe = on;
    this.setGraphics({ ...this.graphics, edges: this.userEdges });
    if (this.level) { this.applyLevel(); this.applyIndoorSelection(); }
    this.updateHiddenEdges();
  }

  /** Значки осей сцены режима здания, которые масштабируются под экран каждый кадр. */
  private gizmos = new Set<THREE.Object3D>();

  private trackGizmo(o: THREE.Object3D): THREE.Object3D {
    this.gizmos.add(o);
    return o;
  }

  /** Длина стрелок — px пикселей: метров на пиксель у начала значка — по самой длинной на экране из трёх осей. */
  private scaleGizmos() {
    if (!this.gizmos.size) return;
    const project = this.focusProjector();
    if (!project) return;
    const p = new THREE.Vector3();
    for (const o of this.gizmos) {
      // Значок убрали со сцены (сменился инструмент, вышли из режима здания) — больше не следим
      let root: THREE.Object3D = o;
      while (root.parent) root = root.parent;
      if (!(root instanceof THREE.Scene)) { this.gizmos.delete(o); continue; }
      const { px, origin, arrows } = o.userData.gizmo as { px: number; origin: THREE.Vector3; arrows: THREE.Object3D };
      const a = project(origin);
      if (!a) continue;
      let best = 0;
      for (const d of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) {
        const b = project(p.set(origin.x + d[0], origin.y + d[1], origin.z + d[2]));
        if (b) best = Math.max(best, Math.hypot(b[0] - a[0], b[1] - a[1]));
      }
      if (best > 1e-6) arrows.scale.setScalar(px / best);
    }
  }

  private renderGroups(options: CustomRenderMethodInput, pass: RenderPass = 'all') {
    const renderer = this.renderer!;
    this.lastMain = new THREE.Matrix4().fromArray(options.defaultProjectionData.mainMatrix as unknown as number[]);
    this.scaleGizmos();
    const main = depthMain(options);
    let triangles = 0;
    for (const g of this.activeGroups()) {
      // Выбор и камера берут projectionMatrix с глубиной MapLibre — сжатая только на время отрисовки
      const pick = g.camera.projectionMatrix = this.lastMain.clone().multiply(g.model);
      g.camera.projectionMatrix = main.clone().multiply(g.model);
      this.resetState();
      const restore = this.filterPass(g, pass);
      try { renderer.render(g.scene, g.camera); } finally { restore(); }
      g.camera.projectionMatrix = pick;
      triangles += renderer.info.render.triangles;
    }
    // Деревья — один раз: во второй половине режима контуров они уже нарисованы
    if (!this.focused && this.graphics.trees !== false && pass !== 'wire-lines') {
      const height = renderer.getContext().drawingBufferHeight;
      for (const t of this.trees.values()) {
        t.camera.projectionMatrix = main.clone().multiply(t.model);
        if (!t.prepare(height)) continue;
        this.resetState();
        renderer.render(t.scene, t.camera);
        triangles += renderer.info.render.triangles;
      }
    }
    if (pass === 'wire-lines') this.lastTriangles += triangles; else this.lastTriangles = triangles;
  }

  /** Группы, которые сейчас рисуются и выбираются. */
  private activeGroups(): MeshGroup[] {
    // Набросок нового здания на карте: карта как есть плюс пустая сцена инструментов поверх
    if (this.sketching) return [...this.groups].map(([, g]) => g);
    if (!this.focused) return [...this.groups].filter(([k]) => k !== FOCUS_GROUP).map(([, g]) => g);
    const g = this.groups.get(FOCUS_GROUP);
    return g ? [g] : [];
  }

  /**
   * Режим одного здания: только эти объекты и плоскость земли с сеткой под ними, остальное не рисуется.
   * undefined — выйти. Пока режим включён, правки объектов обновляют и его копию (updateFeature).
   */
  /** Набросок нового здания прямо на карте (сцена инструментов без здания, карта не прячется). */
  private sketching = false;

  /**
   * Начать (center) или закончить (undefined) набросок: пустая сцена режима здания с началом в center и осями
   * по сторонам света — в ней работают инструменты рисования (луч на землю, проекция), а карта видна вся.
   */
  setSketch(center: LonLat | undefined) {
    this.mapSnaps = new WeakMap(); // здания карты могли смениться
    this.setFocus(undefined);
    this.focusLock = undefined;
    if (!center) { this.map?.triggerRepaint(); return; }
    const g = new MeshGroup(center);
    g.footprint = 0;
    this.focusAxes = { origin: [0, 0], x: [1, 0], y: [0, 1], size: [0, 0] };
    this.install(FOCUS_GROUP, g);
    this.focused = this.sketching = true;
  }

  setFocus(features: Feature3D[] | undefined, flat: Iterable<string> = []) {
    this.sketching = false;
    this.moveGuide = undefined;
    this.movingEdges?.geometry.dispose();
    this.movingEdges = undefined;
    this.removeGroup(FOCUS_GROUP);
    this.snaps = undefined;
    this.focused = !!features;
    if (!features) { this.level = undefined; this.applyLevel(); } // вне режима здания срезов нет
    if (!features?.length) { this.focusAxes = undefined; this.focusLock = undefined; this.map?.triggerRepaint(); return; }
    const box = new THREE.Box2();
    for (const f of features) for (const p of f.polygons) for (const [lng, lat] of p.outer) box.expandByPoint(new THREE.Vector2(lng, lat));
    // Начало сцены, оси и сетка фиксируются при входе в режим и не меняются от правок до выхода
    const lock = this.focusLock;
    const c = lock ? new THREE.Vector2(...lock.center) : box.getCenter(new THREE.Vector2());
    const g = new MeshGroup([c.x, c.y]);
    g.footprint = 0; // объекты нулевой высоты — точно на своём уровне: к ним привязываются следующие
    g.noDefaultHeight = true;
    for (const k of flat) g.flat.add(k);
    g.contacts = buildContacts(g, features);
    for (const f of features) if (shouldRender(f)) this.addItem(g, f);
    // Земля: квадрат с запасом вокруг здания, сетка 10 м
    const [x0, y0] = g.toLocal([box.min.x, box.min.y]), [x1, y1] = g.toLocal([box.max.x, box.max.y]);
    const size = lock?.size ?? Math.ceil((Math.max(x1 - x0, y1 - y0) * 3 + 60) / 20) * 20;
    // Земля без заливки — видна только сетка; меш остаётся для попадания курсором
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(size, size),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
    ground.position.z = -0.02;
    const pts: Pt[] = features.flatMap((f) => f.polygons.flatMap((p) => p.outer.map(g.toLocal)));
    this.focusAxes = lock ? lock.axes && { ...lock.axes } : orientedFrame(pts);
    // Начало — снаружи угла bbox, чтобы обозначение не сливалось со стенами
    if (this.focusAxes && !lock) {
      const { origin: o, x, y } = this.focusAxes;
      this.focusAxes.origin = [o[0] - (x[0] + y[0]) * ORIGIN_OFFSET, o[1] - (x[1] + y[1]) * ORIGIN_OFFSET];
    }
    if (!lock) this.focusLock = { center: [c.x, c.y], size, axes: this.focusAxes && { ...this.focusAxes } };
    // Сетка — вдоль осей здания, линии через начало координат (центр сетки в нём, шаг 10 м, размер кратен 20)
    const [ox, oy] = this.focusAxes?.origin ?? [0, 0];
    const gridSize = size + Math.ceil(Math.hypot(ox, oy) * 2 / 20) * 20;
    const grid = new THREE.GridHelper(gridSize, gridSize / GRID_STEP, GRID_COLOUR, GRID_COLOUR);
    grid.rotation.x = Math.PI / 2; // GridHelper лежит в XZ, у нас земля — XY
    const gridFrame = new THREE.Group();
    gridFrame.position.set(ox, oy, -0.01);
    if (this.focusAxes) gridFrame.rotation.z = Math.atan2(this.focusAxes.x[1], this.focusAxes.x[0]);
    gridFrame.add(grid);
    gridFrame.visible = this.gridVisible;
    this.gridFrame = gridFrame;
    g.scene.add(ground, gridFrame);
    if (this.focusAxes) g.scene.add(this.trackGizmo(axesGizmo(this.focusAxes, { px: AXES_PX, occluded: true, faint: true })));
    this.install(FOCUS_GROUP, g);
    this.updateHiddenEdges();
    this.applyLevel();
  }

  /** Срез режима здания (высота, м; выше не рисуется и не выбирается) и indoor-объекты выбранного этажа. */
  private level?: IndoorLevel;
  private indoorObj?: THREE.Group;

  /** Выбрать этаж: cut — высота среза, items — помещения этажа; undefined — всё здание без среза. */
  /** Выбранный indoor-объект этажа: пол залит цветом выделения, скрытые рёбра — пунктиром (как у частей). */
  private indoorSelected: string[] = [];
  private indoorIssueHighlighted: string[] = [];
  private indoorSelObj?: THREE.Group;
  private roomWallSelection: IndoorItem[] = [];
  private indoorWallPositions: number[] = [];
  private indoorEdgeOccluders: number[] = [];
  private indoorGlassBlockers: number[] = [];
  private escalatorObjects = new Map<string, THREE.Group>();
  /** Точные рёбра вырезанных проёмов, собранные при построении стен текущего этажа. */
  private doorOpeningEdges = new Map<string, Map<string, number[]>>();

  /** Точки дверей этажа (узлы OSM): маркеры на линии основания стены в проёме. */
  private doors: DoorItem[] = [];
  private doorObj?: THREE.Group;
  private indoorSnaps?: { points: SnapPoint[]; edges: SnapEdge[] };
  private doorMoveOffsets = new Map<string, THREE.Vector3>();

  private doorAt(d: { key: string; at: LonLat }): LonLat {
    if (this.doorPreview?.key === d.key) return this.doorPreview.at;
    const offset = this.doorMoveOffsets.get(d.key), g = this.groups.get(FOCUS_GROUP);
    if (!offset || !g) return d.at;
    const [x, y] = g.toLocal(d.at);
    return this.focusToLngLat(x + offset.x, y + offset.y) ?? d.at;
  }

  doorAnchor(key: string): THREE.Vector3 | undefined {
    const d = this.doors.find(d => d.key === key), g = this.groups.get(FOCUS_GROUP);
    if (!d || !g) return;
    const [x, y] = g.toLocal(this.doorAt(d));
    return new THREE.Vector3(x, y, d.z);
  }
  /** Перетаскиваемая дверь — её маркер в этой точке. */
  private doorPreview?: { key: string; at: LonLat };

  setDoors(doors: DoorItem[]) {
    this.doors = doors;
    this.applyDoors();
  }

  /** Предпросмотр перетаскивания двери (undefined — убрать): маркер и проём в стене — в новой точке. */
  previewDoor(p: { key: string; at: LonLat } | undefined) {
    this.doorPreview = p;
    this.applyDoors();
    // Проём — пересборкой плана этажа, не чаще кадра
    if (!this.doorFrame) this.doorFrame = requestAnimationFrame(() => { this.doorFrame = 0; this.applyLevel(); this.applyIndoorSelection(); });
    this.map?.triggerRepaint();
  }
  private doorFrame = 0;

  /** Проёмы этажа с перетаскиваемой дверью на её новом месте. */
  private previewDoors(doors: LonLat[]): LonLat[] {
    const p = this.doorPreview;
    const from = p && this.doors.find((d) => d.key === p.key)?.at;
    return doors.map(at => {
      if (p && from && Math.abs(at[0] - from[0]) < 1e-10 && Math.abs(at[1] - from[1]) < 1e-10) return p.at;
      const door = this.doors.find(d => Math.abs(at[0] - d.at[0]) < 1e-10 && Math.abs(at[1] - d.at[1]) < 1e-10);
      return door ? this.doorAt(door) : at;
    });
  }

  private applyDoors() {
    if (this.doorObj) {
      this.doorObj.parent?.remove(this.doorObj);
      this.doorObj.traverse((o) => { if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) o.geometry.dispose(); });
      this.doorObj = undefined;
    }
    const g = this.groups.get(FOCUS_GROUP);
    if (!g || !this.level) return;
    const root = new THREE.Group();
    const visible = [
      ...this.doors.map(d => ({ d, pale: false, items: this.level!.items, cut: this.level!.cut })),
      ...(this.level.below ?? []).flatMap(b => (b.doorModels ?? []).map(d => ({ d, pale: true, items: b.items, cut: b.cut }))),
    ];
    for (const { d, pale, items, cut } of visible) {
      const at = this.doorAt(d);
      const [x, y] = g.toLocal(at);
      const sel = this.indoorSelected.includes(d.key) || this.indoorIssueHighlighted.includes(d.key);
      const diameter = revolvingDoorDiameter(d.tags);
      if (diameter !== undefined) {
        const model = revolvingDoorModel(diameter, Math.max(0.1, Math.min(DOOR_HEIGHT, cut - d.z)), !pale && sel, pale);
        model.userData.doorKey = d.key;
        model.userData.pale = pale;
        model.position.set(x, y, d.z + 0.04);
        // Align the drum entrances with the nearest wall, including room boundaries.
        let nearest = Infinity;
        for (const item of items) for (const polygon of item.polygons) for (const ring of [polygon.outer, ...polygon.inners]) {
          for (let i = 1; i < ring.length; i++) {
            const a = g.toLocal(ring[i - 1]), b = g.toLocal(ring[i]);
            const dx = b[0] - a[0], dy = b[1] - a[1], length2 = dx * dx + dy * dy;
            if (!length2) continue;
            const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / length2));
            const distance = Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy);
            if (distance < nearest) { nearest = distance; model.rotation.z = Math.atan2(dy, dx); }
          }
        }
        root.add(model);
      }
      if (pale) continue;
      const dot = new THREE.Mesh(DOOR_GEO, DOOR_MATERIAL);
      dot.userData.doorKey = d.key;
      dot.position.set(x, y, d.z + 0.04);
      dot.renderOrder = 5;
      dot.frustumCulled = false;
      root.add(dot);
      if (sel) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.28, 0.025, 8, 24), DOOR_SELECTED_MATERIAL);
        ring.userData.doorKey = d.key;
        ring.position.set(x, y, d.z + 0.08);
        ring.renderOrder = 6;
        ring.frustumCulled = false;
        root.add(ring);
        const axisGeometry = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(x, y, d.z + 0.08),
          new THREE.Vector3(x, y, Math.min(cut, d.z + DOOR_HEIGHT)),
        ]);
        const axis = new THREE.LineSegments(axisGeometry, DOOR_AXIS_MATERIAL);
        axis.userData.doorKey = d.key;
        axis.computeLineDistances();
        axis.renderOrder = 1000;
        axis.frustumCulled = false;
        root.add(axis);
      }
    }
    for (const child of root.children) {
      const offset = this.doorMoveOffsets.get(child.userData.doorKey);
      child.userData.doorBasePosition = child.position.clone().sub(offset ?? new THREE.Vector3());
    }
    this.doorObj = root;
    g.scene.add(root);
  }

  /** Дверь под курсором: ближайший маркер не дальше DOOR_PICK_PX. */
  pickDoor(point: [number, number]): string | undefined {
    const g = this.groups.get(FOCUS_GROUP);
    if (!g || !this.map || !this.lastMain || !this.level) return;
    const m = this.lastMain.clone().multiply(g.model);
    const canvas = this.map.getCanvas();
    let best: { key: string; d: number } | undefined;
    for (const door of this.doors) {
      const [x, y] = g.toLocal(door.at);
      const v = new THREE.Vector4(x, y, door.z + 0.04, 1).applyMatrix4(m);
      if (v.w <= 0) continue;
      const px = (v.x / v.w + 1) / 2 * canvas.clientWidth, py = (1 - v.y / v.w) / 2 * canvas.clientHeight;
      const d = Math.hypot(px - point[0], py - point[1]);
      if (d <= DOOR_PICK_PX && (!best || d < best.d)) best = { key: door.key, d };
    }
    return best?.key;
  }

  /** lon/lat → локальные метры здания режима. */
  focusFromLngLat(at: LonLat): Pt | undefined {
    return this.groups.get(FOCUS_GROUP)?.toLocal(at);
  }

  setIndoorSelection(keys: string[]) {
    this.indoorSelected = keys;
    this.applyDoors();
    this.applyIndoorSelection();
    this.map?.triggerRepaint();
  }

  /** Выбранный кусок неразмеченной площади этажа (ещё не объект OSM) — подсвечивается как выделенное помещение. */
  private freeArea?: IndoorItem;
  setFreeArea(item: IndoorItem | undefined) {
    this.freeArea = item;
    this.applyIndoorSelection();
    this.map?.triggerRepaint();
  }

  setRoomWallSelection(items: IndoorItem[]) {
    this.roomWallSelection = items;
    this.applyIndoorSelection();
    this.map?.triggerRepaint();
  }

  setIndoorIssueHighlight(keys: string[]) {
    if (keys.length === this.indoorIssueHighlighted.length && keys.every((key) => this.indoorIssueHighlighted.includes(key))) return;
    this.indoorIssueHighlighted = keys;
    this.applyDoors();
    this.applyIndoorSelection();
    this.map?.triggerRepaint();
  }

  private applyIndoorSelection() {
    if (this.indoorSelObj) {
      this.indoorSelObj.parent?.remove(this.indoorSelObj);
      this.indoorSelObj.traverse((o) => {
        if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments || o instanceof LineSegments2) o.geometry.dispose();
        if (o instanceof LineSegments2) o.material.dispose();
      });
      this.indoorSelObj = undefined;
    }
    const g = this.groups.get(FOCUS_GROUP);
    const keys = new Set([...this.indoorSelected, ...this.indoorIssueHighlighted]);
    for (const [key, group] of this.escalatorObjects) group.traverse((o) => {
      if (!o.userData.escalatorMaterial) return;
      if (o instanceof THREE.Mesh && !(o instanceof Line2)) o.material = keys.has(key) ? ESCALATOR_SELECTED : o.userData.escalatorMaterial;
      else if (o instanceof Line2) o.material = keys.has(key) ? ESCALATOR_SELECTED_HANDRAIL : o.userData.escalatorMaterial;
    });
    const items = [...this.level?.items ?? [], ...this.level?.highlights ?? []].filter((i) => keys.has(i.key));
    if (this.level && this.wireframe) for (const b of this.level.below ?? []) items.push(...b.items.filter(it => keys.has(it.key) && !items.some(other=>other.key===it.key)));
    if (this.level) items.push(...this.roomWallSelection, ...(this.freeArea ? [this.freeArea] : []));
    if (!g || (!items.length && ![...keys].some((key) => this.doorOpeningEdges.has(key)))) return;
    const root = new THREE.Group();
    this.indoorSelObj = root;
    g.scene.add(root);
    for (const it of items) this.addIndoorHighlight(root, g, it);
    for (const key of keys) {
      const raw = [...(this.doorOpeningEdges.get(key)?.values() ?? [])].flat();
      const verticals = new Map<string, number>();
      const verticalKey = (i: number) => Math.hypot(raw[i] - raw[i+3], raw[i+1] - raw[i+4]) < 1e-5
        ? [raw[i], raw[i+1], Math.min(raw[i+2], raw[i+5]), Math.max(raw[i+2], raw[i+5])].map(v => v.toFixed(3)).join(',') : undefined;
      for (let i = 0; i < raw.length; i += 6) {
        const k = verticalKey(i);
        if (k) verticals.set(k, (verticals.get(k) ?? 0) + 1);
      }
      const edges: number[] = [];
      for (let i = 0; i < raw.length; i += 6) {
        const k = verticalKey(i);
        if (!k || verticals.get(k) === 1) edges.push(...raw.slice(i, i+6));
      }
      if (!edges.length) continue;
      const canvas = this.map!.getCanvas();
      const dpr = canvas.width / canvas.clientWidth;
      const geo = new LineSegmentsGeometry();
      geo.setPositions(edges);
      const material = new LineMaterial({ color: 0x2563eb, linewidth: 3 * dpr, depthTest: false, depthWrite: false });
      material.resolution.set(canvas.width, canvas.height);
      const line = new LineSegments2(geo, material);
      line.userData.doorKey = key;
      line.position.copy(this.doorMoveOffsets.get(key) ?? new THREE.Vector3());
      line.renderOrder = 1000;
      line.frustumCulled = false;
      root.add(line);
    }
  }

  /** Подсветка одного выбранного indoor-объекта: пол с контуром или (стена, колонна) вертикальные грани. */
  private addIndoorHighlight(root: THREE.Group, g: MeshGroup, it: IndoorItem) {
    // Стена и колонна — их вертикальные грани от пола до среза
    if (it.kind === 'wall' || it.kind === 'column') {
      const top = this.levelCut ?? this.level!.cut;
      const faces: number[] = [], edges: number[] = [];
      for (const p of it.polygons) for (const ring of it.line ? [p.outer] : [p.outer, ...p.inners]) {
        const rp = ring.map(g.toLocal);
        const closed = !it.line || (rp.length > 2 && Math.hypot(rp[0][0] - rp.at(-1)![0], rp[0][1] - rp.at(-1)![1]) < 1e-3);
        if (closed && rp.length > 1 && Math.hypot(rp[0][0] - rp.at(-1)![0], rp[0][1] - rp.at(-1)![1]) < 1e-3) rp.pop();
        const n = closed ? rp.length : rp.length - 1;
        for (let i = 0; i < n; i++) {
          const [ax, ay] = rp[i], [bx, by] = rp[(i + 1) % rp.length];
          faces.push(ax, ay, it.z, bx, by, it.z, bx, by, top, ax, ay, it.z, bx, by, top, ax, ay, top);
          edges.push(ax, ay, it.z, bx, by, it.z);
        }
      }
      const fg = new THREE.BufferGeometry();
      fg.setAttribute('position', new THREE.Float32BufferAttribute(faces, 3));
      const mesh = new THREE.Mesh(fg, INDOOR_SELECT_MATERIAL);
      mesh.renderOrder = 997;
      mesh.frustumCulled = false;
      root.add(mesh);
      this.addIndoorPerimeter(root, edges);
      return;
    }
    if (it.line) return;
    // На отметке пола, как сам пол: заливку поднимает сдвиг глубины материала, контур — сдвиг в шейдере
    const z = it.z;
    const lines: number[] = [];
    for (const p of it.polygons) {
      const v2 = (r: LonLat[]) => r.map((c) => new THREE.Vector2(...g.toLocal(c)));
      const shape = new THREE.Shape(v2(p.outer));
      for (const h of p.inners) shape.holes.push(new THREE.Path(v2(h)));
      const fill = new THREE.Mesh(new THREE.ShapeGeometry(shape), INDOOR_SELECT_MATERIAL);
      fill.position.z = z;
      // Заливка не пишет глубину для контура, поэтому рисуем её после обычного пола.
      fill.renderOrder = 997;
      fill.frustumCulled = false;
      root.add(fill);
      for (const r of [p.outer, ...p.inners]) {
        const rp = r.map(g.toLocal);
        for (let i = 0; i < rp.length; i++) {
          const a = rp[i], b = rp[(i + 1) % rp.length];
          lines.push(a[0], a[1], z, b[0], b[1], z);
        }
      }
    }
    this.addIndoorPerimeter(root, lines);
  }

  /** Нижний контур: 2 экранных пикселя, скрытые участки — пунктиром. */
  private addIndoorPerimeter(root: THREE.Group, positions: number[]) {
    const canvas = this.map?.getCanvas();
    const width = canvas?.width ?? 1, height = canvas?.height ?? 1;
    const dpr = width / Math.max(1, canvas?.clientWidth ?? 1);
    for (const hidden of [true, false]) {
      const geo = new LineSegmentsGeometry();
      geo.setPositions(positions);
      const material = new LineMaterial({ color: 0x2563eb, linewidth: 2 * dpr,
        depthTest: !hidden, depthWrite: false,
        dashed: hidden, dashSize: 0.25, gapSize: 0.15 });
      // Сначала сквозной пунктир, затем сплошная линия с проверкой глубины.
      // Как у обычных скрытых рёбер, сдвиг к камере устраняет самозатенение основания.
      material.onBeforeCompile = (shader) => {
        shader.vertexShader = shader.vertexShader.replace('gl_Position = clip;',
          'gl_Position = clip; gl_Position.z -= 0.001 * gl_Position.w;');
      };
      material.resolution.set(width, height);
      const line = new LineSegments2(geo, material);
      line.computeLineDistances();
      line.renderOrder = hidden ? 998 : 999;
      line.frustumCulled = false;
      root.add(line);
    }
  }

  /** doors — двери этажа (lon/lat): в стенах на их месте вырезаются проёмы. */
  setLevel(level: IndoorLevel | undefined) {
    const hadVoids = !!this.level?.voidCuts?.length, hasVoids = !!level?.voidCuts?.length;
    const toggled = !this.level !== !level;
    this.level = level;
    this.indoorSnaps = undefined;
    const focus = this.groups.get(FOCUS_GROUP);
    // Вход в этажи и выход — оболочка здания вместо частей и обратно
    if (focus && (hadVoids || hasVoids || toggled)) {
      // drawPlan needs the shell, but applyLevel merges the meshes after building the plan.
      // Avoid merging and trimming glass twice when entering a floor or changing atrium cuts.
      if (level) this.applyShell(focus);
      else this.rebuildGeometry(focus);
    }
    timed('этажи: план этажа', () => this.applyLevel(), () => `${level?.items.length ?? 0} объектов`);
    this.applyIndoorSelection();
    this.applyDoors();
    this.map?.triggerRepaint();
  }

  /**
   * Высота среза плана: чуть ниже потолка этажа. Части, начинающиеся чуть ниже потолка (ступени мавзолея с 2.8 м
   * при этажах по 3 м, relation/3272772), — тоже потолок: срез под их днищем, иначе днища ложатся на план крышкой.
   */
  private levelCut?: number;
  /** План этажа нарисован по сечению оболочки (а не по следам частей, пока её нет). */
  private planBySection = false;

  private cutZ(): number | undefined {
    const lv = this.level;
    if (!lv) return;
    let cut = lv.cut - CUT_BELOW_CEIL;
    const g = this.groups.get(FOCUS_GROUP);
    for (const it of g?.items ?? []) {
      if (!shellSolid(g!, it) || g!.flat.has(it.feature.key)) continue;
      const min = g!.lift?.get(it.feature.key) ?? computeHeights(it.tags).min;
      if (min < lv.cut && min >= lv.cut - CEIL_SNAP && min > lv.floor + CEIL_SNAP) cut = Math.min(cut, min - CUT_BELOW_CEIL);
    }
    return cut;
  }

  /**
   * Контур здания на высоте h (м сцены): сечение оболочки из объёмов частей (applyShell). undefined — оболочки
   * ещё нет (крыши считаются в воркере). Кеш — по набору объёмов: пересчёт только при изменении частей.
   */
  sectionAt(g: MeshGroup, h: number): ClipMulti | undefined {
    const cache = g.shellCache!;
    if (!cache || !g.shellOf) return;
    const solids = g.items.filter((it) => shellSolid(g, it, it.full?.positions)).map((it) => cache.solids.get(it)?.solid).filter((s): s is PreparedSolid => !!s);
    const memo = g.sections;
    if (!memo || memo.solids.length !== solids.length || memo.solids.some((s, i) => s !== solids[i])) g.sections = { solids, at: new Map() };
    const at = g.sections!.at;
    const key = Math.round(h * 1000) / 1000;
    let out = at.get(key);
    if (!out) at.set(key, out = timed('этажи: сечение оболочки', () => sectionOf(solids, key)));
    return out;
  }

  /** Контур здания режима на высоте h (lon/lat, кольца без замыкающей точки); undefined — оболочки ещё нет. */
  focusSection(h: number): LonLat[][][] | undefined {
    const g = this.groups.get(FOCUS_GROUP);
    const sec = g && this.sectionAt(g, h);
    return sec?.map((poly) => poly.map((r) => r.slice(0, -1).map(([x, y]) => g!.fromLocal([x, y]))));
  }

  private applyLevel() {
    this.doorOpeningEdges.clear();
    this.indoorWallPositions = [];
    this.indoorEdgeOccluders = [];
    this.indoorGlassBlockers = [];
    this.escalatorObjects.clear();
    // Чуть ниже потолка: днища частей, начинающихся на потолке, и крыши частей на этой высоте не накрывают план
    const cut = this.levelCut = this.cutZ();
    const planes = cut !== undefined ? [new THREE.Plane(new THREE.Vector3(0, 0, -1), cut)] : null;
    // Входы на контуре — тоже: у частей выше среза они висели бы в воздухе
    for (const m of [MATERIAL, THIN_MATERIAL, GLASS_MATERIAL, EDGE_MATERIAL, HIDDEN_EDGE_MATERIAL, ENTRANCE_MATERIAL, ENTRANCE_SELECTED_MATERIAL, ENTRANCE_LINE_MATERIAL]) m.clippingPlanes = planes;
    for (const m of [ESCALATOR_BELT, ESCALATOR_SIDE, ESCALATOR_STEP, ESCALATOR_BALUSTRADE, ESCALATOR_HANDRAIL,
      ESCALATOR_PALE_BELT, ESCALATOR_PALE_SIDE, ESCALATOR_PALE_STEP, ESCALATOR_PALE_BALUSTRADE, ESCALATOR_PALE_HANDRAIL, ESCALATOR_SELECTED, ESCALATOR_SELECTED_HANDRAIL]) m.clippingPlanes = planes;
    if (this.indoorObj) {
      this.indoorObj.parent?.remove(this.indoorObj);
      // Кешированные планы нижних этажей — не освобождать: понадобятся при следующем переключении
      for (const o of [...[...this.palePlans.values()].map((p) => p.group), ...[...this.paleLedges.values()].flatMap((l) => l.meshes)]) o.parent?.remove(o);
      this.indoorObj.traverse((o) => {
        if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments || o instanceof Line2) o.geometry.dispose();
        if (o instanceof LineSegments2 && o.material !== ESCALATOR_HANDRAIL && o.material !== ESCALATOR_PALE_HANDRAIL && o.material !== ESCALATOR_SELECTED_HANDRAIL) o.material.dispose();
      });
      this.indoorObj = undefined;
    }
    const g = this.groups.get(FOCUS_GROUP);
    if (!g || !this.level) return;
    const root = new THREE.Group();
    this.indoorObj = root;
    g.scene.add(root);
    // Полы и крышки — двумя слитыми мешами (по мешу на полигон — сотни вызовов отрисовки на этаж)
    const capPos: number[] = [], floorPos: number[] = [], floorCol: number[] = [];
    const fill = (outer: Pt[], holes: Pt[][], z: number, colour?: number) => {
      const v2 = (r: Pt[]) => r.map(([x, y]) => new THREE.Vector2(x, y));
      const contour = v2(outer), hs = holes.map(v2);
      if (THREE.ShapeUtils.isClockWise(contour)) contour.reverse();
      for (const h of hs) if (!THREE.ShapeUtils.isClockWise(h)) h.reverse();
      const pts = [...contour, ...hs.flat()];
      const c = colour === undefined ? undefined : new THREE.Color(colour);
      for (const tri of THREE.ShapeUtils.triangulateShape(contour, hs)) for (const i of tri) {
        (c ? floorPos : capPos).push(pts[i].x, pts[i].y, z);
        if (c) floorCol.push(c.r, c.g, c.b);
      }
    };
    const finish = () => {
      for (const [pos, col, mat] of [[capPos, undefined, INDOOR_CAP_MATERIAL], [floorPos, floorCol, INDOOR_FLOOR_MATERIAL]] as const) {
        if (!pos.length) continue;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        if (col) geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
        geo.computeVertexNormals();
        const mesh = new THREE.Mesh(geo, mat);
        mesh.frustumCulled = false;
        root.add(mesh);
      }
    };
    const top = cut!;
    let shellCache: Shell | undefined;
    const shell = () => (shellCache ??= planShell(g));
    // Внешний периметр этажа: объединение следов объектов здания, которые есть на высоте среза, — толстой линией
    const spans: ClipMulti = [];
    const columnSections: ClipMulti = [];
    // Есть части — контур здания (outline) не в счёт: его след накрывает и то, что у частей лишь крыша
    const hasParts = g.items.some((it) => it.feature.kind === 'part' && !g.hidden.has(it.feature.key));
    // Части, разрезанные срезом, — для проверки «сечение внутри другой части»
    const cutParts = g.items.filter((it) => !g.hidden.has(it.feature.key) && !g.flat.has(it.feature.key) && shellSolid(g, it) && !(hasParts && it.feature.kind === 'building' && it.feature.hasParts)
      && !(glassEnabled && it.glassWalls)).filter((it) => {
      const h = computeHeights(it.tags);
      return (g.lift?.get(it.feature.key) ?? h.min) <= top && h.wallTop >= top;
    }).map((it) => ({ it, rings: (g.renderFootprints.get(it.feature.key) ?? it.feature.polygons).map((p) => ({ outer: p.outer.map(g.toLocal), inners: p.inners.map((r) => r.map(g.toLocal)) })) }));
    const insideCut = (self: Item, outer: Pt[]) => {
      const n = outer.length > 1 && outer[0][0] === outer.at(-1)![0] && outer[0][1] === outer.at(-1)![1] ? outer.length - 1 : outer.length;
      const cx = outer.slice(0, n).reduce((a, v) => a + v[0], 0) / n, cy = outer.slice(0, n).reduce((a, v) => a + v[1], 0) / n;
      const probes = outer.slice(0, n).map(([x, y]): Pt => [x + (cx - x) * 0.02, y + (cy - y) * 0.02]);
      return cutParts.some(({ it, rings }) => it !== self && probes.every((q) => rings.some((r) => pointInLocalRing(q, r.outer) && !r.inners.some((h) => pointInLocalRing(q, h)))));
    };
    for (const it of g.items) {
      if (g.hidden.has(it.feature.key) || g.flat.has(it.feature.key)) continue;
      if (hasParts && it.feature.kind === 'building' && it.feature.hasParts) continue;
      // Срез должен пересекать стены, а не крышу (купол, скат выше стен — без обводки)
      const h = computeHeights(it.tags);
      if ((g.lift?.get(it.feature.key) ?? h.min) > top - 0.5 || h.wallTop < top) continue;
      const column = it.tags['building:part'] === 'column';
      for (const p of g.renderFootprints.get(it.feature.key) ?? it.feature.polygons) {
        const outer = p.outer.map(g.toLocal);
        spans.push([outer, ...p.inners.map((r) => r.map(g.toLocal))].map((rp) => [...rp, rp[0]]));
        // Колонна или мелкая часть (столб, пилон) на срезе — сплошное сечение с крышкой, а не открытая коробка
        if (!column && Math.abs(THREE.ShapeUtils.area(outer.map(([x, y]) => new THREE.Vector2(x, y)))) >= SOLID_PART_AREA) continue;
        // Внутри другой части, разрезанной тем же срезом (гребни в основании), — крышка не нужна: часть скрыта оболочкой
        if (!column && insideCut(it, outer)) continue;
        const holes = p.inners.map((h) => h.map(g.toLocal));
        if (column) columnSections.push([outer, ...holes].map(r => [...r, r[0]]));
        fill(outer, holes, top, column ? 0x000000 : undefined);
      }
    }
    // Периметр — сечение оболочки на высоте среза (под скатом — уже следа); пока оболочки нет — объединение следов
    const section = this.sectionAt(g, top);
    this.planBySection = !!section;
    if ((section?.length || spans.length || g.items.some(it => this.openRoofInPlan(g, it))) && this.map) {
      let union: ClipMulti = section ?? [];
      if (!section) try { union = polygonClipping.union(spans[0], ...spans.slice(1)); } catch (err) { console.warn('[levels] периметр не построен', err); }
      const canvas = this.map.getCanvas();
      const dpr = canvas.width / Math.max(1, canvas.clientWidth);
      const mat = new LineMaterial({ color: 0x000000, linewidth: PERIMETER_WIDTH_PX * dpr });
      mat.resolution.set(canvas.width, canvas.height);
      // A low sloping annex is opened along its roof, rather than capped at
      // another horizontal level. Preserve the slope in the heavy outline.
      for (const it of g.items) {
        if (!this.openRoofInPlan(g, it)) continue;
        const end = it.positions.length - it.floorVertices * 3;
        const outline = openRoofOutline(it.positions.subarray(it.wallVertices * 3, end), this.level.floor, it.positions.subarray(0, it.wallVertices * 3));
        if (!outline.length) continue;
        const geo = new LineSegmentsGeometry(); geo.setPositions(outline);
        const line = new LineSegments2(geo, mat); line.frustumCulled = false; root.add(line);
      }
      for (const poly of [...union, ...columnSections]) for (const ring of poly) {
        const geo = new LineGeometry();
        geo.setPositions(ring.flatMap(([x, y]) => [x, y, top]));
        const line = new Line2(geo, mat);
        line.frustumCulled = false;
        root.add(line);
      }
    }
    finish();
    // Второй свет: под полом этажа — сплошная плита с дырами-пустотами, под ней бледные планы этажей ниже
    const voids = this.level.voids ?? [];
    {
      const z = this.level.floor;
      const holes: ClipMulti = voids.map((poly) => poly.map((r) => { const rp = r.map(g.toLocal); return [...rp, rp[0]]; }));
      // Лифтовые шахты выше нижней остановки — тоже дыры в плите (обводка края — только у пустот)
      const shafts: ClipMulti = this.level.items.filter((it) => it.shaft).flatMap((it) => it.polygons.map((p) =>
        [p.outer, ...p.inners].map((r) => { const rp = r.map(g.toLocal); return [...rp, rp[0]]; })));
      const pools: ClipMulti = this.level.items.filter(it => it.pool).flatMap(it => it.polygons.map(p =>
        [p.outer, ...p.inners].map(r => { const points = r.map(g.toLocal); return [...points, points[0]]; })));
      const stairs = escalatorFloorHoles((this.level.cutEscalators ?? this.level.escalators ?? []).map(e => ({...e,line:e.line.map(g.toLocal)})), this.level.floor);
      const mappedFloors: ClipMulti = this.level.items.filter(it => !it.line && !it.shaft && !it.noFloor && !it.cutOnly && !it.pool
        && ['level','area','corridor','room'].includes(it.kind)).flatMap(it => it.polygons.map(p =>
          [p.outer, ...p.inners].map(r => { const points = r.map(g.toLocal); return [...points, points[0]]; })));
      let slab: ClipMulti = [];
      const mappedLevels: ClipMulti = this.level.items.filter(it => it.kind === 'level').flatMap(it => it.polygons.map(p =>
        [p.outer, ...p.inners].map(r => { const points = r.map(g.toLocal); return [...points, points[0]]; })));
      const floorSection = mappedLevels.length ? polygonClipping.union(mappedLevels[0], ...mappedLevels.slice(1)) : this.sectionAt(g, this.level.floor + SLAB_PROBE);
      // Низ перекрытия (потолок нижнего этажа) — под всем сечением, кроме пустот: «додуманная» геометрия
      let underside: ClipMulti = [];
      // Под нижним этажом потолка нет: низ плиты торчал бы из-под фасада
      if (this.level.below?.length) try { underside = floorSection ? polygonClipping.difference(floorSection, ...holes, ...shafts, ...pools, ...stairs) : []; } catch (err) { console.warn('[levels] низ перекрытия не построен', err); }
      try { slab = floorSection ? polygonClipping.difference(floorSection, ...holes, ...shafts, ...pools, ...stairs, ...mappedFloors) : spans.length ? polygonClipping.difference(polygonClipping.union(spans[0], ...spans.slice(1)), ...holes, ...shafts, ...pools, ...stairs, ...mappedFloors) : []; } catch (err) { console.warn('[levels] плита не построена', err); }
      const pos: number[] = [];
      for (const poly of slab) {
        const v2 = (r: Pt[]) => r.slice(0, -1).map(([x, y]) => new THREE.Vector2(x, y));
        const contour = v2(poly[0] as Pt[]), hs = poly.slice(1).map((r) => v2(r as Pt[]));
        const pts = [...contour, ...hs.flat()];
        for (const tri of THREE.ShapeUtils.triangulateShape(contour, hs)) for (const i of tri) pos.push(pts[i].x, pts[i].y, z);
      }
      if (pos.length) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        geo.computeVertexNormals();
        const mesh = new THREE.Mesh(geo, INDOOR_SLAB_MATERIAL);
        mesh.frustumCulled = false;
        root.add(mesh);
      }
      const below = z - SLAB_THICKNESS, under: number[] = [];
      for (const poly of underside) {
        const v2 = (r: Pt[]) => r.slice(0, -1).map(([x, y]) => new THREE.Vector2(x, y));
        const contour = v2(poly[0] as Pt[]), hs = poly.slice(1).map((r) => v2(r as Pt[]));
        const pts = [...contour, ...hs.flat()];
        for (const tri of THREE.ShapeUtils.triangulateShape(contour, hs)) for (const i of tri) under.push(pts[i].x, pts[i].y, below);
      }
      // Обводка пустот на уровне пола — край перекрытия
      const edge: number[] = [];
      // A floor opening has no exposed slab edge where a wall already bounds it.
      // Coplanar lines otherwise leak through the wall at the floor elevation.
      const wallSpans: PlanSeg[] = [];
      const addWallRing = (ring: Pt[], closed: boolean) => {
        for (let i = 0; i < ring.length - (closed ? 0 : 1); i++) {
          const a = ring[i], b = ring[(i + 1) % ring.length];
          wallSpans.push([...a, ...b]);
        }
      };
      for (const it of this.level.items) if (!it.cutOnly && ['room','wall','column'].includes(it.kind))
        for (const p of it.polygons) for (const r of [p.outer, ...p.inners]) addWallRing(r.map(g.toLocal), !it.line);
      for (const it of g.items) {
        if (g.hidden.has(it.feature.key) || strokeOnly(g, it)) continue;
        const h = computeHeights(it.tags), min = g.lift?.get(it.feature.key) ?? h.min;
        if (min > this.level.floor + .03 || h.wallTop <= this.level.floor + .03) continue;
        for (const p of g.renderFootprints.get(it.feature.key) ?? it.feature.polygons)
          for (const r of [p.outer, ...p.inners]) addWallRing(r.map(g.toLocal), true);
      }
      for (const poly of holes) for (const r of poly) for (let i = 0; i + 1 < r.length; i++) {
        const [ax,ay] = r[i], [bx,by] = r[i+1];
        for (const [lo,hi] of uncoveredSpans(ax,ay,bx,by,wallSpans,.03))
        {
          const [x0, y0, x1, y1] = [ax+(bx-ax)*lo, ay+(by-ay)*lo, ax+(bx-ax)*hi, ay+(by-ay)*hi], f = this.level.floor, b = f - SLAB_THICKNESS;
          edge.push(x0, y0, f, x1, y1, f, x0, y0, b, x1, y1, b);
          // Торец перекрытия у пустоты
          under.push(x0, y0, b, x1, y1, b, x1, y1, f, x0, y0, b, x1, y1, f, x0, y0, f);
        }
      }
      if (under.length) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(under, 3));
        geo.computeVertexNormals();
        const mesh = decor(new THREE.Mesh(geo, INDOOR_SLAB_MATERIAL));
        mesh.name = 'indoor-slab-underside';
        mesh.frustumCulled = false;
        root.add(mesh);
      }
      const eg = new THREE.BufferGeometry();
      eg.setAttribute('position', new THREE.Float32BufferAttribute(edge, 3));
      const el = new THREE.LineSegments(eg, INDOOR_VOID_EDGE);
      el.frustumCulled = false;
      root.add(el);
      // Нижние этажи видны целиком: отступ среза нужен только выбранному этажу, иначе между стенами щель.
      timed('этажи: планы нижних этажей', () => { for (const b of this.level!.below ?? []) this.drawPlan(root, g, b.items, b.doors ?? [], b.cut, true, shell(), b.voids); }, () => `${this.level!.below!.length} этажей`);
    }
    timed('этажи: план выбранного этажа', () => this.drawPlan(root, g, this.level!.items, this.previewDoors(this.level!.doors ?? []), top, false, shell()));
    timed('этажи: эскалаторы', () => this.drawEscalators(root, g));
    timed('этажи: слияние геометрии', () => this.rebuildGeometry(g));
  }

  /** Эскалатор с горизонтальными ступенями, подступенками и закрытым корпусом. */
  pickEscalator(point: [number, number]): { key: string; t: number } | undefined {
    const ray = this.focusRay(point);
    if (!ray) return;
    let best: { key: string; t: number } | undefined;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), hit = new THREE.Vector3();
    const take = (key: string, p: THREE.Vector3) => {
      if (this.levelCut !== undefined && p.z > this.levelCut + 1e-3) return;
      const t = p.clone().sub(ray.origin).dot(ray.direction);
      if (t > 0 && (!best || t < best.t)) best = { key, t };
    };
    for (const [key, model] of this.escalatorObjects) model.traverse((o) => {
      if (o instanceof THREE.Mesh && !(o instanceof Line2)) {
        const pos = o.geometry.getAttribute('position');
        if (!pos) return;
        for (let i = 0; i + 2 < pos.count; i += 3) {
          a.fromBufferAttribute(pos, i); b.fromBufferAttribute(pos, i + 1); c.fromBufferAttribute(pos, i + 2);
          if (ray.intersectTriangle(a, b, c, false, hit)) take(key, hit);
        }
      } else if (o instanceof Line2) {
        const start = o.geometry.getAttribute('instanceStart'), end = o.geometry.getAttribute('instanceEnd');
        if (!start || !end) return;
        for (let i = 0; i < start.count; i++) {
          a.fromBufferAttribute(start, i); b.fromBufferAttribute(end, i);
          if (ray.distanceSqToSegment(a, b, hit, c) < 0.12 ** 2) take(key, c);
        }
      }
    });
    if (!best) return;
    const limit = (best as { key: string; t: number }).t;
    let blocked = false;
    const check = (o: THREE.Object3D) => {
      if (blocked || !(o instanceof THREE.Mesh) || o instanceof Line2 || o.userData.escalatorMaterial) return;
      const pos = o.geometry.getAttribute('position');
      if (!pos) return;
      for (let i = 0; i + 2 < pos.count; i += 3) {
        a.fromBufferAttribute(pos, i); b.fromBufferAttribute(pos, i + 1); c.fromBufferAttribute(pos, i + 2);
        if (!ray.intersectTriangle(a, b, c, false, hit)) continue;
        if (this.levelCut !== undefined && hit.z > this.levelCut + 1e-3) continue;
        if (hit.distanceTo(ray.origin) < limit - 0.02) { blocked = true; break; }
      }
    };
    this.indoorObj?.traverse(check);
    const opaque = this.groups.get(FOCUS_GROUP)?.mesh;
    if (opaque) check(opaque);
    return blocked ? undefined : best;
  }

  private drawEscalators(root: THREE.Group, g: MeshGroup) {
    for (const item of this.level?.escalators ?? []) {
      const pts = item.line.map(g.toLocal);
      if (pts.length < 2 || item.top <= item.bottom) continue;
      const cumulative = [0];
      for (let i = 1; i < pts.length; i++) cumulative.push(cumulative[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
      const length = cumulative.at(-1)!;
      if (length < 2) continue;
      const model = new THREE.Group();
      model.name = 'escalator';
      model.userData.key = item.key;
      root.add(model);
      this.escalatorObjects.set(item.key, model);
      const landing = Math.min(1, length * 0.12);
      const halfWidth = Math.max(0.35, Math.min(2.5, item.width / 2));
      const at = (distance: number) => {
        let i = 1;
        while (i < cumulative.length - 1 && cumulative[i] < distance) i++;
        const span = cumulative[i] - cumulative[i - 1] || 1;
        const t = Math.max(0, Math.min(1, (distance - cumulative[i - 1]) / span));
        const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
        const dx = (bx - ax) / span, dy = (by - ay) / span;
        const rise = Math.max(0, Math.min(1, (distance - landing) / (length - 2 * landing)));
        const z = item.bottom + (item.top - item.bottom) * (item.incline === 'down' ? 1 - rise : rise) + 0.05;
        return { x: ax + (bx - ax) * t, y: ay + (by - ay) * t, nx: -dy, ny: dx, z };
      };
      const ascending = item.incline === 'up';
      const ramp = length - 2 * landing;
      const count = Math.max(1, Math.round(ramp / 0.42));
      const distances = [0, landing, ...Array.from({ length: count - 1 }, (_, i) => landing + ramp * (i + 1) / count), length - landing, length];
      const treads: number[] = [], risers: number[] = [], body: number[] = [], balustrades: number[] = [];
      const boxDepth = 0.7;
      const edge = (p: ReturnType<typeof at>, sign: number, z = p.z): [number, number, number] =>
        [p.x + sign * halfWidth * p.nx, p.y + sign * halfWidth * p.ny, z];
      const stepEdge = (p: ReturnType<typeof at>, sign: number, z: number): [number, number, number] =>
        [p.x + sign * (halfWidth - 0.1) * p.nx, p.y + sign * (halfWidth - 0.1) * p.ny, z];
      const quad = (out: number[], a: number[], b: number[], c: number[], d: number[]) =>
        out.push(...a, ...b, ...c, ...a, ...c, ...d);
      let previousTreadZ: number | undefined;
      for (let i = 1; i < distances.length; i++) {
        const a = at(distances[i - 1]), b = at(distances[i]);
        // На склоне проступь лежит на высоте верхнего конца отрезка.
        const z = i === 1 || i === distances.length - 1 ? a.z : ascending ? b.z : a.z;
        quad(treads, stepEdge(a, -1, z), stepEdge(b, -1, z), stepEdge(b, 1, z), stepEdge(a, 1, z));
        quad(body, edge(a, 1, a.z - boxDepth), edge(b, 1, b.z - boxDepth), edge(b, -1, b.z - boxDepth), edge(a, -1, a.z - boxDepth));
        for (const sign of [-1, 1]) {
          quad(body, edge(a, sign, a.z - boxDepth), edge(b, sign, b.z - boxDepth), edge(b, sign, z), edge(a, sign, z));
          quad(body, stepEdge(a, sign, z), stepEdge(b, sign, z), edge(b, sign, z), edge(a, sign, z));
        }
        if (previousTreadZ !== undefined && Math.abs(z - previousTreadZ) > 1e-4) {
          const low = Math.min(z, previousTreadZ), high = Math.max(z, previousTreadZ);
          quad(risers, stepEdge(a, -1, low), stepEdge(a, -1, high), stepEdge(a, 1, high), stepEdge(a, 1, low));
        }
        previousTreadZ = z;
      }
      for (const d of [0, length]) {
        const p = at(d);
        quad(body, edge(p, -1, p.z - boxDepth), edge(p, 1, p.z - boxDepth), edge(p, 1), edge(p, -1));
      }
      // Поручень идёт горизонтально над площадками и огибает торцы стеклянных опор.
      const bend = Math.min(0.6, ramp / 4);
      const railZ = (d: number) => {
        const u = Math.max(0, Math.min(ramp, d - landing));
        const rise = u < bend ? u * u / (2 * bend * (ramp - bend))
          : u > ramp - bend ? 1 - (ramp - u) ** 2 / (2 * bend * (ramp - bend))
          : (u - bend / 2) / (ramp - bend);
        return item.bottom + (item.top - item.bottom) * (ascending ? rise : 1 - rise) + 0.95;
      };
      const railDistances = [...new Set([...distances,
        ...Array.from({ length: 9 }, (_, i) => landing + bend * i / 8),
        ...Array.from({ length: 9 }, (_, i) => length - landing - bend * i / 8)].filter(
          (d) => d >= landing && d <= length - landing).sort((a, b) => a - b))];
      const sideEdge = (p: ReturnType<typeof at>, sign: number, z: number): [number, number, number] =>
        [p.x + sign * (halfWidth - 0.02) * p.nx, p.y + sign * (halfWidth - 0.02) * p.ny, z];
      const canvas = this.map!.getCanvas();
      const dpr = canvas.width / Math.max(1, canvas.clientWidth);
      const handrail = item.pale ? ESCALATOR_PALE_HANDRAIL : ESCALATOR_HANDRAIL;
      handrail.linewidth = 5 * dpr;
      handrail.resolution.set(canvas.width, canvas.height);
      ESCALATOR_SELECTED_HANDRAIL.linewidth = 5 * dpr;
      ESCALATOR_SELECTED_HANDRAIL.resolution.set(canvas.width, canvas.height);
      for (const sign of [-1, 1]) {
        const rail: number[] = [];
        const roundedEnd = (d: number, direction: number, reverse: boolean) => {
          const p = at(d);
          const low = p.z + 0.08, high = railZ(d) - 0.045;
          const mid = (low + high) / 2, halfHeight = (high - low) / 2;
          const radius = Math.min(0.6, landing * 0.8);
          const centre = sideEdge(p, sign, mid);
          let previous: [number, number, number] | undefined;
          for (let i = 0; i <= 12; i++) {
            const angle = Math.PI * (reverse ? 1 - i / 12 : i / 12);
            const curvedDistance = d + direction * radius * Math.sin(angle);
            const point = sideEdge(at(curvedDistance), sign, mid + halfHeight * Math.cos(angle));
            rail.push(...point);
            if (previous) balustrades.push(...centre, ...previous, ...point);
            previous = point;
          }
        };
        roundedEnd(landing, -1, true);
        for (let i = 0; i < railDistances.length; i++) {
          const d = railDistances[i], p = at(d), z = railZ(d);
          if (i) rail.push(...sideEdge(p, sign, z - 0.045));
          if (i) {
            const pd = railDistances[i - 1], prev = at(pd);
            quad(balustrades, sideEdge(prev, sign, prev.z + 0.08), sideEdge(p, sign, p.z + 0.08),
              sideEdge(p, sign, z - 0.045), sideEdge(prev, sign, railZ(pd) - 0.045));
          }
        }
        roundedEnd(length - landing, 1, false);
        const geometry = new LineGeometry();
        geometry.setPositions(rail);
        const line = new Line2(geometry, handrail);
        line.frustumCulled = false;
        line.userData.escalatorMaterial = handrail;
        model.add(line);
      }
      const mesh = (positions: number[], material: THREE.Material) => {
        if (!positions.length) return;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geo.computeVertexNormals();
        const object = new THREE.Mesh(geo, material);
        object.frustumCulled = false;
        object.userData.escalatorMaterial = material;
        model.add(object);
      };
      mesh(treads, item.pale ? ESCALATOR_PALE_BELT : ESCALATOR_BELT);
      mesh(risers, item.pale ? ESCALATOR_PALE_STEP : ESCALATOR_STEP);
      mesh(body, item.pale ? ESCALATOR_PALE_SIDE : ESCALATOR_SIDE);
      mesh(balustrades, item.pale ? ESCALATOR_PALE_BALUSTRADE : ESCALATOR_BALUSTRADE);
    }
  }

  /**
   * План этажа: стены помещений и стены-линии с проёмами, полы по видам, крышки колонн; pale — бледный (этаж под вторым светом).
   * Стены и крышки не выше оболочки здания (shell): под скатом крыши стена срезается по скату.
   */
  /** Бледные планы нижних этажей (видны сквозь второй свет): готовая геометрия по ключу входных данных, последние сверху. */
  private palePlans = new Map<string, { group: THREE.Group; occluders: number[]; blockers: number[] }>();
  /** Торцы площадок бледных планов: по ключу плана и пустотам выбранного этажа. */
  private paleLedges = new Map<string, { meshes: THREE.Object3D[]; blockers: number[] }>();

  private drawPlan(root: THREE.Group, g: MeshGroup, items: IndoorItem[], doorList: LonLat[], top: number, pale: boolean, shell?: Shell, ownVoids?: LonLat[][][]) {
    if (!items.length) return;
    const all = this.level?.escalators ?? [];
    if (!pale) {
      this.drawPlanBody(root, g, items, doorList, top, false, shell, all, this.level?.voids);
      this.drawLedges(root, g, items, false, ownVoids);
      return;
    }
    // Нижний этаж при переключении верхних не меняется — его план берём из кеша. Эскалаторы — только задевающие этаж
    // (проём в стенах — до 2 м над ступенями, вырез в полу — где короб проходит сквозь пол): с остальными план тот же
    const floor = items[0].z;
    const escalators = (this.level?.cutEscalators ?? all).filter((e) => e.bottom - 0.7 <= top && e.top + 2.05 >= floor - 0.1);
    const doorModels = [...this.doors, ...(this.level?.below ?? []).flatMap((b) => b.doorModels ?? [])]
      .filter((d) => Math.abs(d.z - floor) < 0.1).map((d) => `${d.key}@${this.doorAt(d).join(',')}:${JSON.stringify(d.tags ?? {})}`);
    const key = [objId(g), shell ? objId(shell) : 0, top, +this.graphics.edges, +glassEnabled,
      items.map((it) => `${it.key}:${it.kind}:${it.z}:${objId(it.polygons)}:${+!!it.line}:${it.colour ?? ''}:${it.doorWidth ?? ''}:${+!!it.shaft}:${+!!it.noFloor}:${+!!it.cutOnly}:${+!!it.areaLedge}`).join(','),
      doorList.map((d) => d.join(',')).join(';'), doorModels.join(';'),
      JSON.stringify([this.level?.doorCuts,...(this.level?.below??[]).map(b=>b.doorCuts),ownVoids,this.level?.items.map(it=>[it.key,it.noFloor]),g.items.filter(it=>this.openRoofInPlan(g,it)).map(it=>it.feature.key)]),
      escalators.map((e) => `${e.key}:${e.bottom}:${e.top}:${e.width}:${e.incline}:${objId(e.line)}`).join(',')].join('|');
    let plan = this.palePlans.get(key);
    if (plan) {
      this.palePlans.delete(key);
      for (const v of plan.occluders) this.indoorEdgeOccluders.push(v);
      this.indoorGlassBlockers = this.indoorGlassBlockers.concat(plan.blockers);
    } else {
      const group = new THREE.Group();
      group.userData.indoorBelow = true;
      const occ = this.indoorEdgeOccluders.length, blk = this.indoorGlassBlockers.length;
      this.drawPlanBody(group, g, items, doorList, top, true, shell, escalators, ownVoids);
      plan = { group, occluders: this.indoorEdgeOccluders.slice(occ), blockers: this.indoorGlassBlockers.slice(blk) };
    }
    this.palePlans.set(key, plan);
    // Этажей бывает десяток с лишним; больше — старые вон
    while (this.palePlans.size > PALE_PLAN_CACHE) {
      const [old, entry] = this.palePlans.entries().next().value!;
      this.palePlans.delete(old);
      disposePlanGroup(entry.group);
    }
    root.add(plan.group);
    // Торцы площадок зависят ещё и от пустот выбранного этажа
    const ledgeKey = `${key}|${(ownVoids ?? []).map(objId).join(',')}|${(this.level?.voids ?? []).map(objId).join(',')}`;
    let ledges = this.paleLedges.get(ledgeKey);
    if (ledges) {
      this.paleLedges.delete(ledgeKey);
      this.indoorGlassBlockers = this.indoorGlassBlockers.concat(ledges.blockers);
    } else {
      const group = new THREE.Group();
      const blk = this.indoorGlassBlockers.length;
      timed('этажи: торцы площадок', () => this.drawLedges(group, g, items, true, ownVoids));
      ledges = { meshes: [...group.children], blockers: this.indoorGlassBlockers.slice(blk) };
    }
    this.paleLedges.set(ledgeKey, ledges);
    while (this.paleLedges.size > PALE_PLAN_CACHE * 2) {
      const [old, entry] = this.paleLedges.entries().next().value!;
      this.paleLedges.delete(old);
      for (const m of entry.meshes) disposePlanGroup(m);
    }
    for (const m of ledges.meshes) root.add(m);
  }

  /** Нижняя грань свободного края площадки над пустотой (торец перекрытия). Зависит от пустот выбранного этажа — не кешируется. */
  private drawLedges(root: THREE.Group, g: MeshGroup, items: IndoorItem[], pale: boolean, ownVoids?: LonLat[][][]) {
    // Проверяем площадки после всех стен, включая стены помещений: дверь в стене не считается свободным краем.
    const ledgeWalls = new Map<string, PlanSeg[]>();
    const addLedgeWall = (a: Pt, b: Pt) => {
      const s: PlanSeg = [...a, ...b];
      for (const c of planCells(...s, 0)) (ledgeWalls.get(c) ?? ledgeWalls.set(c, []).get(c)!).push(s);
    };
    if (items.some((it) => it.kind === 'area' && it.areaLedge)) {
      const floor = items[0].z;
      for (const bi of g.items) {
        if (g.hidden.has(bi.feature.key) || strokeOnly(g, bi) || thinItem(bi)) continue;
        const h = computeHeights(bi.tags);
        if ((g.lift?.get(bi.feature.key) ?? h.min) > floor + 0.1 || h.wallTop <= floor + 0.1) continue;
        for (const p of g.renderFootprints?.get(bi.feature.key) ?? bi.feature.polygons) for (const r of [p.outer, ...p.inners]) {
          const ring = r.map(g.toLocal);
          for (let i = 0; i < ring.length; i++) addLedgeWall(ring[i], ring[(i + 1) % ring.length]);
        }
      }
      for (const it of items) if (it.kind === 'room' || it.kind === 'wall' || it.kind === 'column') {
        for (const p of it.polygons) for (const r of it.line ? [p.outer] : [p.outer, ...p.inners]) {
          const ring = r.map(g.toLocal), n = it.line ? ring.length - 1 : ring.length;
          for (let i = 0; i < n; i++) addLedgeWall(ring[i], ring[(i + 1) % ring.length]);
        }
      }
    }
    for (const it of items) {
      if (it.kind !== 'area' || !it.areaLedge || it.line) continue;
      const floorVoids = ownVoids ?? (Math.abs(it.z - this.level!.floor) < 1e-3 ? this.level!.voids ?? []
        : (this.level!.voidCuts ?? []).filter((c) => c.zs.some((z) => Math.abs(z - it.z) < 1e-3)).flatMap((c) => c.polygon));
      // Самый нижний видимый этаж может не иметь собственного проёма. Его свободный край всё равно
      // виден из атриума сверху; соседний размеченный пол, в отличие от пустоты, исключает торец.
      const voids = pale ? [...floorVoids, ...(this.level!.voids ?? [])] : floorVoids;
      if (!voids.length) continue;
      const localVoids = voids.map(([outer, ...holes]) => ({ outer: outer.map(g.toLocal), inners: holes.map((r) => r.map(g.toLocal)) }));
      const adjacentFloors = items.filter((f) => !f.line && (f.kind === 'area' || f.kind === 'room' || f.kind === 'corridor'))
        .flatMap((f) => f.polygons.map((p) => ({ outer: p.outer.map(g.toLocal), inners: p.inners.map((r) => r.map(g.toLocal)) })));
      const pos: number[] = [];
      for (const p of it.polygons) {
        const underside = areaLedgeTriangles({ outer: p.outer.map(g.toLocal), inners: p.inners.map((r) => r.map(g.toLocal)) },
          localVoids, planFloorZ(it), (a, b) => {
            const near = new Set<PlanSeg>();
            for (const c of planCells(...a, ...b, WALL_MERGE_DIST)) for (const s of ledgeWalls.get(c) ?? []) near.add(s);
            return uncoveredSpans(...a, ...b, near);
          }, adjacentFloors);
        for (const v of underside) pos.push(v);
      }
      if (!pos.length) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, pale ? INDOOR_PALE_WALL : INDOOR_SLAB_MATERIAL);
      mesh.name = 'indoor-area-underside';
      mesh.userData.key = it.key;
      mesh.frustumCulled = false;
      root.add(mesh);
      this.indoorGlassBlockers = this.indoorGlassBlockers.concat(pos);
    }
  }

  private drawPlanBody(root: THREE.Group, g: MeshGroup, items: IndoorItem[], doorList: LonLat[], top: number, pale: boolean, shell: Shell | undefined, escalators: NonNullable<IndoorLevel['escalators']>, floorVoids?: LonLat[][][]) {
    const capPos: number[] = [], floorPos: number[] = [], floorCol: number[] = [];
    const white = new THREE.Color(0xffffff);
    const fill = (outer: Pt[], holes: Pt[][], z: number | ((x: number, y: number) => number), colour?: number) => {
      const v2 = (r: Pt[]) => r.map(([x, y]) => new THREE.Vector2(x, y));
      const contour = v2(outer), hs = holes.map(v2);
      if (THREE.ShapeUtils.isClockWise(contour)) contour.reverse();
      for (const h of hs) if (!THREE.ShapeUtils.isClockWise(h)) h.reverse();
      const pts = [...contour, ...hs.flat()];
      const c = colour === undefined ? undefined : new THREE.Color(colour);
      if (c && pale) c.lerp(white, PALE_MIX);
      for (const tri of THREE.ShapeUtils.triangulateShape(contour, hs)) for (const i of tri) {
        (c ? floorPos : capPos).push(pts[i].x, pts[i].y, typeof z === 'number' ? z : z(pts[i].x, pts[i].y));
        if (c) floorCol.push(c.r, c.g, c.b);
      }
    };
    const finish = () => {
      for (const [pos, col, mat] of [[capPos, undefined, pale ? INDOOR_PALE_WALL : INDOOR_CAP_MATERIAL], [floorPos, floorCol, INDOOR_FLOOR_MATERIAL]] as const) {
        if (!pos.length) continue;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        if (col) geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
        geo.computeVertexNormals();
        const mesh = new THREE.Mesh(geo, mat);
        mesh.frustumCulled = false;
        root.add(mesh);
      }
    };
    // Сначала этажи целиком, затем площадки, коридоры и помещения — каждый следующий чуть выше
    const order = PLAN_ORDER;
    const floorZ = planFloorZ;
    const floorLevel = items[0]?.z ?? 0;
    const floorPolygons = items.filter(it => !it.line && it.kind !== 'wall' && it.kind !== 'column' && !it.shaft && !it.noFloor)
      .flatMap(it => it.polygons.map(p => ({ it, p, outer: p.outer.map(g.toLocal), inners: p.inners.map(r => r.map(g.toLocal)), z: floorZ(it) })));
    const visibleFloors = partitionFloors(floorPolygons, 0.1);
    // Под моделью эскалатора, проходящей сквозь пол, — вырез (площадка не ложится на пол, короб уходит вниз)
    const shaftHoles = items.filter(it => it.shaft).flatMap(it => it.polygons.map(p =>
      [p.outer, ...p.inners].map(r => { const l = r.map(g.toLocal); return [...l, l[0]]; }) as ClipMulti[number]));
    // Бассейн — тоже вырез: пол (и свой, и площадок под ним) уходит чашей вниз
    const pools = items.filter(it => it.pool && !it.line);
    const poolHoles = pools.flatMap(it => it.polygons.map(p =>
      [p.outer, ...p.inners].map(r => { const l = r.map(g.toLocal); return [...l, l[0]]; }) as ClipMulti[number]));
    const voidFloorHoles = (floorVoids ?? []).map(poly => poly.map(r => {const points=r.map(g.toLocal);return [...points,points[0]];}));
    const escalatorHoles = [...voidFloorHoles, ...escalatorFloorHoles(escalators.map(e => ({ ...e, line: e.line.map(g.toLocal) })), items[0]?.z ?? 0), ...shaftHoles, ...poolHoles];
    // Вырезы — только у кусков пола рядом с ними (кусков сотни, polygon-clipping платит за каждый)
    const holeBox = (r: Pt[]) => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const [x, y] of r) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); } return [x0, y0, x1, y1]; };
    const holeBoxes = escalatorHoles.map((h) => holeBox(h[0] as Pt[]));
    if (escalatorHoles.length) visibleFloors.forEach((pieces, i) => {
      visibleFloors[i] = pieces.flatMap(f => {
        const [x0, y0, x1, y1] = holeBox(f.outer);
        const near = escalatorHoles.filter((_, k) => { const q = holeBoxes[k]; return q[0] <= x1 && q[2] >= x0 && q[1] <= y1 && q[3] >= y0; });
        if (!near.length) return [f];
        return polygonClipping.difference([[...f.outer, f.outer[0]], ...f.inners.map(r => [...r, r[0]])] as ClipMulti[number], near)
          .map(p => ({ outer: p[0].slice(0, -1) as Pt[], inners: p.slice(1).map(r => r.slice(0, -1) as Pt[]), z: f.z }));
      });
    });
    const floorPieces = new Map(floorPolygons.map((entry,i) => [entry.p, visibleFloors[i]]));
    const lines: number[] = [];
    const walls: number[] = [];
    /** Цвета вершин стен: каждая сторона — цветом помещения, в которое смотрит. */
    const wallCols: number[] = [];
    // Полы с цветом назначения (локальные кольца, габарит; помещения раньше коридоров и площадок — меньшие сверху)
    const tinted = items.filter((it) => it.colour !== undefined && !it.line && !it.cutOnly).sort((a, b) => order.indexOf(b.kind) - order.indexOf(a.kind))
      .flatMap((it) => it.polygons.map((p) => {
        const outer = p.outer.map(g.toLocal), holes = p.inners.map((h) => h.map(g.toLocal));
        const box = outer.reduce((b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)], [Infinity, Infinity, -Infinity, -Infinity]);
        return { outer, holes, box, colour: new THREE.Color(it.colour!) };
      }));
    const WHITE_WALL = new THREE.Color(0xffffff);
    /** Цвет стены со стороны точки (x, y): пол помещения под ней, иначе белый. */
    const sideColour = (x: number, y: number): THREE.Color => {
      for (const t of tinted) {
        if (x < t.box[0] || x > t.box[2] || y < t.box[1] || y > t.box[3]) continue;
        if (pointInLocalRing([x, y], t.outer) && !t.holes.some((h) => pointInLocalRing([x, y], h))) return t.colour;
      }
      return WHITE_WALL;
    };
    // Рёбра стен (опция «рёбра»): низ и вертикали в концах и на изломах — по направлениям стен в каждой точке
    const escalatorCuts = escalators.map(e => ({ ...e, line: e.line.map(g.toLocal) }));
    const openingMasks: number[] = [];
    /** Контур проёмов эскалаторов — добавляется после обрезки рёбер масками (иначе их срежет). */
    const openingEdges: number[] = [];
    const edges: number[] = [];
    const floorContactEdges: number[] = [];
    const cutTopLines: number[] = [];
    const continuingRooms = new Set(!pale ? items.filter(it => it.kind === 'room' && this.level?.below?.some(b => b.items.some(other => other.key === it.key && other.kind === 'room'))).map(it => it.key) : []);
    let omitFloorSeam = false;
    let facadeFloorEdge = false;
    /** Ребро самого фасада: низ на полу рисуется всегда — и там, где у фасада нет помещения. */
    let facadeOwnFloorEdge = false;
    let omitCutTop = false;
    const continuesAbove = (it: IndoorItem) => pale && !!this.level?.items.some(other => other.key === it.key && other.noFloor);
    let linearCutTop = true;
    const edgeSurfaces = new Map<string, number[][]>();
    let edgeOcclusionOnly = false;
    const ends = new Map<string, { x: number; y: number; z0: number; z1: number; dirs: [number, number, number][] }>();
    const end = (x: number, y: number, z0: number, z1: number, dx: number, dy: number, length: number) => {
      const k = `${Math.round(x * 1000)},${Math.round(y * 1000)}`;
      const e = ends.get(k) ?? { x, y, z0, z1, dirs: [] };
      e.z1 = Math.max(e.z1, z1);
      // Совпадающие стороны соседних полигонов дают одно направление, а не дополнительный излом.
      if (!e.dirs.some(([ex, ey]) => ex * dx + ey * dy > Math.cos(INDOOR_EDGE_TURN))) e.dirs.push([dx, dy, length]);
      ends.set(k, e);
    };
    /** Кусок стены; верх — z1a в начале, z1b в конце (под скатом крыши — наклонный). */
    /** jambA/jambB — у конца откос проёма: вертикаль только до перемычки (выше стена сплошная, без шва). */
    const slab = (ax: number, ay: number, bx: number, by: number, z0: number, z1a: number, z1b: number, ends = true, jambA = Infinity, jambB = Infinity) => {
      if (edgeOcclusionOnly) {
        this.indoorEdgeOccluders.push(ax, ay, z0, bx, by, z0, bx, by, z1b, ax, ay, z0, bx, by, z1b, ax, ay, z1a);
        if (facadeOwnFloorEdge) {
          // Стену здания рисует оболочка; изнутри фасад красится в цвет помещения —
          // гранью чуть внутрь от плоскости фасада, чтобы не мерцать с оболочкой.
          const l0 = Math.hypot(bx - ax, by - ay) || 1, ux = (by - ay) / l0, uy = -(bx - ax) / l0;
          const mx = (ax + bx) / 2, my = (ay + by) / 2;
          for (const side of [1, -1]) {
            const c = sideColour(mx + side * ux * WALL_SIDE_PROBE, my + side * uy * WALL_SIDE_PROBE);
            if (c === WHITE_WALL) continue;
            const ox = side * ux * FACADE_TINT_INSET, oy = side * uy * FACADE_TINT_INSET;
            const [px, py, qx, qy] = [ax + ox, ay + oy, bx + ox, by + oy];
            const face = side > 0
              ? [px, py, z0, qx, qy, z0, qx, qy, z1b, px, py, z0, qx, qy, z1b, px, py, z1a]
              : [px, py, z0, qx, qy, z1b, qx, qy, z0, px, py, z0, px, py, z1a, qx, qy, z1b];
            for (const value of face) walls.push(value);
            for (let k = 0; k < 6; k++) wallCols.push(c.r, c.g, c.b);
          }
        }
        // A facade can own the wall face, but the indoor wall still owns its
        // floor contact. Preserve that edge without recreating the face.
        if (facadeOwnFloorEdge ? Math.abs(z0 - floorLevel) < 1e-3
          : facadeFloorEdge && !omitFloorSeam && Math.abs(z0 - floorLevel) < 1e-3 && !uncovered(ax, ay, bx, by).length) {
          const z = z0;
          // Низ по фасаду уже нарисован самим фасадом — стене помещения остаются только участки вне фасада.
          const spans: [number, number][] = facadeOwnFloorEdge ? [[0, 1]] : uncovered(ax, ay, bx, by, facadeFloor.near(ax, ay, bx, by));
          for (const [t0, t1] of spans)
            floorContactEdges.push(ax + (bx - ax) * t0, ay + (by - ay) * t0, z, ax + (bx - ax) * t1, ay + (by - ay) * t1, z);
        }
        return;
      }
      // Две грани: лицевая смотрит вправо от a→b, обратная — влево; у каждой цвет помещения со своей стороны
      const faces = [
        [ax, ay, z0, bx, by, z0, bx, by, z1b, ax, ay, z0, bx, by, z1b, ax, ay, z1a],
        [ax, ay, z0, bx, by, z1b, bx, by, z0, ax, ay, z0, ax, ay, z1a, bx, by, z1b],
      ];
      const l0 = Math.hypot(bx - ax, by - ay) || 1, nx = (by - ay) / l0 * WALL_SIDE_PROBE, ny = -(bx - ax) / l0 * WALL_SIDE_PROBE;
      const mx = (ax + bx) / 2, my = (ay + by) / 2;
      const colours = [sideColour(mx + nx, my + ny), sideColour(mx - nx, my - ny)];
      const masks = escalatorOpeningMasks(faces[0], escalatorCuts);
      for (const value of masks) openingMasks.push(value);
      for (let side = 0; side < 2; side++) {
        const face = masks.length ? trimCoplanarWalls(faces[side], masks) : faces[side];
        for (const value of face) walls.push(value);
        const c = colours[side];
        for (let k = 0; k < face.length / 3; k++) wallCols.push(c.r, c.g, c.b);
      }
      // Use the same 2 px cut outline for linear walls and solid polygon faces.
      if (!omitCutTop) (!pale ? cutTopLines : lines).push(ax, ay, z1a, bx, by, z1b);
      if (!this.graphics.edges) return;
      if (masks.length) for (const value of escalatorOpeningOutline(faces[0], masks)) openingEdges.push(value);
      // Реальные грани после вырезания дверей: конец соседней стены внутри
      // сплошной грани не должен оставлять вертикальный шов.
      for (let x = Math.floor(Math.min(ax, bx) / 4); x <= Math.floor(Math.max(ax, bx) / 4); x++)
        for (let y = Math.floor(Math.min(ay, by) / 4); y <= Math.floor(Math.max(ay, by) / 4); y++) {
          const key = `${x},${y}`;
          (edgeSurfaces.get(key) ?? edgeSurfaces.set(key, []).get(key)!).push([ax, ay, bx, by, z0, z1a, z1b]);
        }
      const zEdge = z0;
      if (!omitFloorSeam) {
        const target=Math.abs(z0-floorLevel)<1e-3?floorContactEdges:edges;
        target.push(ax, ay, zEdge, bx, by, zEdge);
      }
      if (!ends) return; // перемычка над проёмом: вертикали дают откосы соседних кусков
      const l = Math.hypot(bx - ax, by - ay) || 1;
      end(ax, ay, z0, Math.min(z1a, jambA), (bx - ax) / l, (by - ay) / l, l);
      end(bx, by, z0, Math.min(z1b, jambB), (ax - bx) / l, (ay - by) / l, l);
    };
    // Resolve metadata and local coordinates once, rather than scanning every door for each wall/door pair.
    const metadata = [...this.doors, ...(this.level?.below ?? []).flatMap(b => b.doorModels ?? [])].map(d => ({ key: d.key, at: g.toLocal(this.doorAt(d)), z: d.z, diameter: revolvingDoorDiameter(d.tags), width: tagWidth(d.tags) }));
    /** Ширина двери: тег width, иначе самая узкая из помещений, на стене которых она стоит, иначе DOOR_WIDTH. */
    const narrowRings = items.filter(it => it.doorWidth).flatMap(it => it.polygons.flatMap(p => [p.outer, ...p.inners].map(r => ({ ring: r.map(g.toLocal), width: it.doorWidth! }))));
    const roomDoorWidth = (p: Pt) => {
      let width: number | undefined;
      for (const { ring, width: w } of narrowRings) for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (len < 1e-6) continue;
        const t = ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / len;
        if (t < -DOOR_SNAP || t > len + DOOR_SNAP || Math.abs((p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0])) / len > DOOR_SNAP) continue;
        width = Math.min(width ?? Infinity, w);
      }
      return width;
    };
    const doors = doorList.map(at => {
      const p = g.toLocal(at);
      const door = metadata.find(d => Math.abs(d.z - items[0].z) < 0.1 && Math.hypot(d.at[0] - p[0], d.at[1] - p[1]) < 0.01);
      return { at: p, outline: true, key: pale ? undefined : door?.key, z: door?.z, diameter: door?.diameter, width: door?.width ?? roomDoorWidth(p) };
    });
    // A room boundary behind a thick wall must not close the rear of its doorway.
    const backCuts = [{z:this.level?.floor,cuts:this.level?.doorCuts},...(this.level?.below??[]).map(b=>({z:b.items[0]?.z,cuts:b.doorCuts}))]
      .filter(b=>b.z!==undefined&&Math.abs(b.z-items[0].z)<0.01).flatMap(b=>b.cuts??[]);
    for(const cut of backCuts) doors.push({at:g.toLocal(cut.at),outline:false,key:undefined,z:items[0].z,diameter:undefined,width:cut.width});
    const doorwayFootprints = backCuts.flatMap(c => c.polygon?.length ? [c.polygon.map(g.toLocal)] : []);
    const footprintGrid = new Map<string, Pt[][]>();
    for(const polygon of doorwayFootprints){
      const xs=polygon.map(p=>p[0]),ys=polygon.map(p=>p[1]);
      for(let x=Math.floor(Math.min(...xs)/4);x<=Math.floor(Math.max(...xs)/4);x++) for(let y=Math.floor(Math.min(...ys)/4);y<=Math.floor(Math.max(...ys)/4);y++){
        const key=`${x},${y}`;(footprintGrid.get(key)??footprintGrid.set(key,[]).get(key)!).push(polygon);
      }
    }
    // Сетка дверей 4 м: стене — только двери рядом (стен тысячи, дверей сотни)
    const doorReach = Math.max(DOOR_WIDTH, ...doors.map((d) => Math.max(d.width ?? 0, d.diameter ?? 0))) + DOOR_SNAP;
    const doorGrid = new Map<number, number[]>();
    const doorCell = (i: number, j: number) => (i + 32768) * 65536 + (j + 32768);
    doors.forEach((d, k) => {
      const key = doorCell(Math.floor(d.at[0] / 4), Math.floor(d.at[1] / 4));
      (doorGrid.get(key) ?? doorGrid.set(key, []).get(key)!).push(k);
    });
    const doorsNear = (ax: number, ay: number, bx: number, by: number) => {
      const found: number[] = [];
      for (let i = Math.floor((Math.min(ax, bx) - doorReach) / 4); i <= Math.floor((Math.max(ax, bx) + doorReach) / 4); i++)
        for (let j = Math.floor((Math.min(ay, by) - doorReach) / 4); j <= Math.floor((Math.max(ay, by) + doorReach) / 4); j++)
          for (const k of doorGrid.get(doorCell(i, j)) ?? []) found.push(k);
      return found.sort((p, q) => p - q).map((k) => doors[k]);
    };
    /** Стена с дверными проёмами (DOOR_WIDTH × DOOR_HEIGHT) там, где на ней стоит дверь. */
    const wall = (ax: number, ay: number, bx: number, by: number, z0: number, z1a: number, z1b: number, footprintProcessed = false) => {
      const len = Math.hypot(bx - ax, by - ay);
      const gaps: [number, number][] = [];
      const namedGaps: { key?: string; lo: number; hi: number }[] = [];
      if (len > 1e-6) {
        const dx = (bx - ax) / len, dy = (by - ay) / len;
        for (const door of doorsNear(ax, ay, bx, by)) {
          const [px, py] = door.at;
          const distance = (px - ax) * dy - (py - ay) * dx;
          const t = (px - ax) * dx + (py - ay) * dy;
          const diameter = door.z !== undefined && Math.abs(door.z - z0) < 0.1 ? door.diameter : undefined;
          const halfWidth = doorOpeningHalfWidth(distance, diameter, door.width ?? DOOR_WIDTH, DOOR_SNAP);
          if (!halfWidth || t + halfWidth <= 0 || t - halfWidth >= len) continue;
          const lo = Math.max(0, t - halfWidth) / len, hi = Math.min(len, t + halfWidth) / len;
          gaps.push([lo, hi]);
          if (door.outline) namedGaps.push({ key: door.key, lo, hi });
        }
      }
      // The notch is open through the entire cut height. Only its front connector
      // carries a door lintel; an old room perimeter at the rear must disappear fully.
      if (linearCutTop && !footprintProcessed) {
        const nearby = new Set<Pt[]>(), spans: [number, number][] = [];
        for (const key of planCells(ax, ay, bx, by, 0)) for (const polygon of footprintGrid.get(key) ?? []) nearby.add(polygon);
        for (const p of nearby) {
          const dx=p[1][0]-p[0][0],dy=p[1][1]-p[0][1],l=Math.hypot(dx,dy);
          const onFront=l>1e-6&&Math.abs((ax-p[0][0])*dy-(ay-p[0][1])*dx)/l<0.002&&Math.abs((bx-p[0][0])*dy-(by-p[0][1])*dx)/l<0.002;
          if (onFront) continue;
          const span=wallDoorwaySpan([ax,ay],[bx,by],p);if(span)spans.push(span);
        }
        if(spans.length){
          spans.sort((a,b)=>a[0]-b[0]);let from=0;
          const draw=(lo:number,hi:number)=>{if(hi-lo>1e-6)wall(ax+(bx-ax)*lo,ay+(by-ay)*lo,ax+(bx-ax)*hi,ay+(by-ay)*hi,z0,z1a+(z1b-z1a)*lo,z1a+(z1b-z1a)*hi,true);};
          for(const [lo,hi] of spans){draw(from,lo);from=Math.max(from,hi);}draw(from,1);return;
        }
      }
      if (!gaps.length) { slab(ax, ay, bx, by, z0, z1a, z1b); return; }
      gaps.sort((p, q) => p[0] - q[0]);
      const at = (t: number): [number, number] => [ax + (bx - ax) * t, ay + (by - ay) * t];
      const z1 = (t: number) => z1a + (z1b - z1a) * t;
      const lintel = z0 + DOOR_HEIGHT;
      if (this.graphics.edges) {
        const previous = edgeOcclusionOnly;
        edgeOcclusionOnly = true;
        for (const [lo, hi] of gaps) {
        // Внутри проёма не должно быть рёбер исходных частей здания.
        // Отступ только от настоящих откосов, а не от стыков ways внутри двери.
        const a = lo + (lo > 1e-6 ? 0.005 / len : 0);
        const b = hi - (hi < 1 - 1e-6 ? 0.005 / len : 0);
        if (b > a) slab(...at(a), ...at(b), z0, Math.min(lintel, z1(a)), Math.min(lintel, z1(b)), false);
        }
        edgeOcclusionOnly = previous;
      }
      for (const { key, lo, hi } of namedGaps) {
        if (!key) continue;
        const [lx, ly] = at(lo), [hx, hy] = at(hi);
        const zl = Math.min(lintel, z1(lo)), zh = Math.min(lintel, z1(hi));
        if (zl <= z0 || zh <= z0) continue;
        // Без направления: тот же кусок стены от соседнего помещения идёт навстречу — иначе он записан дважды,
        // и его откосы при подсветке приняты за внутренние стыки
        const pair = [[lx, ly], [hx, hy]].map((p) => p.map((n) => Math.round(n * 100))).sort((p, q) => p[0] - q[0] || p[1] - q[1]);
        const signature = [...pair.flat(), Math.round(z0 * 100)].join(',');
        const edges = [lx, ly, z0, hx, hy, z0, lx, ly, z0, lx, ly, zl,
          hx, hy, z0, hx, hy, zh, lx, ly, zl, hx, hy, zh];
        const bySegment = this.doorOpeningEdges.get(key) ?? new Map<string, number[]>();
        bySegment.set(signature, edges);
        this.doorOpeningEdges.set(key, bySegment);
      }
      let from = 0;
      const pieces: [number, number][] = [];
      for (const [lo, hi] of gaps) {
        if (lo > from) pieces.push([from, lo]);
        from = Math.max(from, hi);
      }
      if (from < 1) pieces.push([from, 1]);
      for (const [t0, t1] of pieces) slab(...at(t0), ...at(t1), z0, z1(t0), z1(t1), true, t0 > 0 ? lintel : Infinity, t1 < 1 ? lintel : Infinity);
      // Перемычки над проёмами (где проём выше стены под скатом — перемычки нет)
      let lo = gaps[0][0], hi = gaps[0][1];
      for (const [g0, g1] of [...gaps.slice(1), [2, 2] as [number, number]]) {
        if (g0 <= hi) { hi = Math.max(hi, g1); continue; }
        if (Math.max(z1(lo), z1(hi)) - lintel > 0.01) slab(...at(lo), ...at(hi), lintel, Math.max(lintel, z1(lo)), Math.max(lintel, z1(hi)), false);
        {
          const a=at(lo),b=at(hi),za=Math.min(lintel,z1(lo)),zb=Math.min(lintel,z1(hi));
          // Rear cut helpers must not create bold jambs on adjacent solid faces.
          // Only a real door in a linear wall owns the vertical opening outline.
          if(linearCutTop&&lo>1e-6&&za>z0&&namedGaps.some(g=>Math.abs(g.lo-lo)<1e-6))cutTopLines.push(...a,z0,...a,za);
          if(linearCutTop&&hi<1-1e-6&&zb>z0&&namedGaps.some(g=>Math.abs(g.hi-hi)<1e-6))cutTopLines.push(...b,z0,...b,zb);
          if(z1(lo)>lintel+0.01&&z1(hi)>lintel+0.01)cutTopLines.push(...a,lintel,...b,lintel);
        }
        [lo, hi] = [g0, g1];
      }
    };
    // Уже стоящие стены: периметр объектов здания и стены-линии; стены помещений, совпадающие с ними, — пропускаем
    // Сетка 4 м: стена сравнивается только со стенами из соседних ячеек (иначе тысячи × тысячи сравнений)
    type Seg = PlanSeg;
    const cells = planCells;
    const segGrid = () => {
      const grid = new Map<string, Seg[]>();
      return {
        push(sg: Seg) { for (const c of cells(...sg, 0)) (grid.get(c) ?? grid.set(c, []).get(c)!).push(sg); },
        near(x0: number, y0: number, x1: number, y1: number): Set<Seg> {
          const out = new Set<Seg>();
          for (const c of cells(x0, y0, x1, y1, WALL_MERGE_DIST)) for (const sg of grid.get(c) ?? []) out.add(sg);
          return out;
        },
      };
    };
    const taken = segGrid();
    /** Фасадные рёбра, у которых низ на полу уже нарисован фасадом. */
    const facadeFloor = segGrid();
    // Общая граница двух непрозрачных частей рядом (перекрываются по высоте) — стык, а не фасад: стены там нет, стену помещения
    // (колонны) она не заменяет. Части друг над другом с тем же контуром (фасад поясами) — фасад: высоту этажа
    // закрывают вместе
    const edgeSig = (a: LonLat, b: LonLat) => [a, b].map((q) => `${q[0].toFixed(8)},${q[1].toFixed(8)}`).sort().join('|');
    const span = (bi: Item) => { const h = computeHeights(bi.tags); return [g.lift?.get(bi.feature.key) ?? h.min, h.wallTop] as const; };
    const partEdges = new Map<string, { lo: number; hi: number; facade: boolean }[]>();
    for (const bi of g.items) {
      if (g.hidden.has(bi.feature.key)) continue;
      const [lo, hi] = span(bi);
      // Контур, тонкий объект и стекло стену помещения не заменяют; стыка с ними тоже нет: оболочка такой сосед
      // не режет — непрозрачная стена за стеклом остаётся, и стена помещения легла бы в её плоскость
      const facade = !strokeOnly(g, bi) && !thinItem(bi) && !(glassEnabled && bi.glassWalls);
      for (const p of g.renderFootprints?.get(bi.feature.key) ?? bi.feature.polygons) for (const r of [p.outer, ...p.inners]) for (let i = 0; i < r.length; i++) {
        const sig = edgeSig(r[i], r[(i + 1) % r.length]);
        (partEdges.get(sig) ?? partEdges.set(sig, []).get(sig)!).push({ lo, hi, facade });
      }
    }
    const z0 = items[0].z;
    /**
     * Фасад по ребру закрывает этаж от пола до среза. Где на ребре две непрозрачные части перекрываются по высоте
     * (соседи рядом, козырёк у стены), оболочка срезает обе стены — там стены здания нет: такие полосы высоты
     * возвращаются в junctions, их закрывает своя стена по ребру (стена помещения во всю высоту легла бы в плоскость
     * фасада выше и ниже козырька — relation/17943950, козырёк 1 м). Не закрыто ничем не больше FACADE_GAP — фасад.
     * undefined — не фасад: стена помещения нужна.
     */
    const facadeCovers = (sig: string): [number, number][] | undefined => {
      const list = (partEdges.get(sig) ?? []).filter((e) => e.facade && e.hi > z0 + 0.01 && e.lo < top - 0.01);
      const cuts = [...new Set([z0, top, ...list.flatMap((e) => [e.lo, e.hi]).filter((z) => z > z0 && z < top)])].sort((x, y) => x - y);
      let open = 0;
      const junctions: [number, number][] = [];
      for (let i = 0; i + 1 < cuts.length; i++) {
        const m = (cuts[i] + cuts[i + 1]) / 2;
        const n = list.filter((e) => e.lo <= m && e.hi >= m).length;
        if (n === 0) open += cuts[i + 1] - cuts[i];
        else if (n > 1) {
          const last = junctions[junctions.length - 1];
          if (last && Math.abs(last[1] - cuts[i]) < 1e-6) last[1] = cuts[i + 1]; else junctions.push([cuts[i], cuts[i + 1]]);
        }
      }
      // Ребро целиком — стык (соседние части во всю высоту этажа): не фасад, стена помещения нужна как была
      if (!list.length || junctions.reduce((a, [lo, hi]) => a + hi - lo, 0) > top - z0 - FACADE_GAP) return undefined;
      return open <= FACADE_GAP ? junctions : undefined;
    };
    /** Полосы стыков на фасадных рёбрах: стена по ребру только на эту высоту (после объявления wall/slab). */
    const junctionPatches: [number, number, number, number, number, number][] = [];
    const facadeDone = new Set<string>();
    // These faces already come from the sloping building shell. A room or
    // indoor=wall on the same boundary must not erect another vertical wall
    // up to the neighbouring (higher) roof, nor invent a horizontal junction.
    // Наружный контур здания на уровне: точка вне всех частей, стоящих на этом полу.
    const standing = g.items.filter((bi) => !g.hidden.has(bi.feature.key) && span(bi)[0] <= z0 + 0.01 && span(bi)[1] > z0 + 0.01)
      .flatMap((bi) => (g.renderFootprints?.get(bi.feature.key) ?? bi.feature.polygons).map((p) => ({ outer: p.outer.map(g.toLocal), inners: p.inners.map((h) => h.map(g.toLocal)) })));
    const outside = (x: number, y: number) => !standing.some((p) => pointInLocalRing([x, y], p.outer) && !p.inners.some((h) => pointInLocalRing([x, y], h)));
    for (const bi of g.items) {
      if (!this.openRoofInPlan(g, bi) || span(bi)[0] > z0 + 0.01) continue;
      for (const p of g.renderFootprints?.get(bi.feature.key) ?? bi.feature.polygons) for (const r of [p.outer, ...p.inners]) {
        const rp = r.map(g.toLocal);
        for (let i = 0; i < r.length; i++) {
          facadeDone.add(edgeSig(r[i], r[(i + 1) % r.length]));
          const [ax, ay] = rp[i], [bx, by] = rp[(i + 1) % rp.length];
          taken.push([ax, ay, bx, by]);
          // Стену рисует скатная оболочка; низ на полу по наружному контуру — свой (relation/17948425).
          const l = Math.hypot(bx - ax, by - ay);
          if (l < 1e-6 || Math.abs(z0 - floorLevel) > 1e-3) continue;
          const nx = (by - ay) / l * WALL_SIDE_PROBE, ny = -(bx - ax) / l * WALL_SIDE_PROBE, mx = (ax + bx) / 2, my = (ay + by) / 2;
          if (outside(mx + nx, my + ny) === outside(mx - nx, my - ny)) continue;
          const z = z0;
          floorContactEdges.push(ax, ay, z, bx, by, z);
          facadeFloor.push([ax, ay, bx, by]);
        }
      }
    }
    for (const bi of g.items) {
      if (g.hidden.has(bi.feature.key) || strokeOnly(g, bi) || thinItem(bi) || (glassEnabled && bi.glassWalls)) continue;
      const [lo, hi] = span(bi);
      if (hi <= z0 + 0.01 || lo >= top - 0.01) continue;
      for (const p of g.renderFootprints?.get(bi.feature.key) ?? bi.feature.polygons) for (const r of [p.outer, ...p.inners]) {
        const rp = r.map(g.toLocal);
        for (let i = 0; i < rp.length; i++) {
          const sig = edgeSig(r[i], r[(i + 1) % r.length]);
          if (facadeDone.has(sig)) continue;
          const junctions = facadeCovers(sig);
          if (!junctions) continue;
          facadeDone.add(sig);
          const a = rp[i], b = rp[(i + 1) % rp.length];
          // Facade openings also need a contour when the adjacent indoor space
          // is an area/corridor with no implicit walls of its own.
          edgeOcclusionOnly = true;
          const previousLinear: boolean = linearCutTop;
          linearCutTop = true;
          facadeOwnFloorEdge = true;
          wall(...a, ...b, Math.max(z0, lo), Math.min(top, hi), Math.min(top, hi), true);
          facadeOwnFloorEdge = false;
          facadeFloor.push([...a, ...b]);
          linearCutTop = previousLinear;
          edgeOcclusionOnly = false;
          taken.push([...a, ...b]);
          for (const [jlo, jhi] of junctions) if (jhi - jlo > 0.05) junctionPatches.push([...a, ...b, jlo, jhi]);
        }
      }
    }
    /** Участки ребра a→b, не закрытые уже стоящими стенами (по умолчанию — taken), — стена ставится только на них. */
    const uncovered = (ax: number, ay: number, bx: number, by: number, segments?: Iterable<Seg>, mergeDist = WALL_MERGE_DIST) =>
      uncoveredSpans(ax, ay, bx, by, segments ?? taken.near(ax, ay, bx, by), mergeDist);
    /** Стена от пола z0 до среза, обрезанная оболочкой здания. */
    const shellWall = (ax: number, ay: number, bx: number, by: number, z0: number) => {
      for (const [t0, t1, za, zb] of shellPieces(shell, ax, ay, bx, by, z0, top))
        wall(ax + (bx - ax) * t0, ay + (by - ay) * t0, ax + (bx - ax) * t1, ay + (by - ay) * t1, z0, za, zb);
    };
    /** Крышка сечения (колонна, стена-полигон, короб): на срезе, а под скатом — по скату; целиком над крышей — нет крышки. */
    const cap = (outer: Pt[], holes: Pt[][], z0: number, black = false) => {
      const colour = black && !pale ? 0x000000 : undefined;
      if (!shell) { fill(outer, holes, top, colour); return; }
      const zOf = (x: number, y: number) => Math.max(z0, Math.min(top, shell.at(x, y, z0) ?? top));
      const zs = [outer, ...holes].flat().map(([x, y]) => zOf(x, y));
      if (zs.every((z) => z >= top - 1e-3)) fill(outer, holes, top, colour);
      else if (zs.some((z) => z > z0 + 0.05)) fill(outer, holes, zOf, colour);
    };
    /** Стена на участках ребра, ещё не занятых другими стенами (совпадающие грани мерцали бы). */
    /** solid — грань толстой стены или колонны: её закрывает только совпадающая стена, а не стена с другой стороны толщины. */
    const wallFree = (ax: number, ay: number, bx: number, by: number, z0: number, solid = false) => {
      if (this.graphics.edges) {
        // Даже если фасад уже заменил геометрию indoor-стены, его рёбра
        // внутри этой плоскости должны скрываться по контуру плана.
        edgeOcclusionOnly = true;
        facadeFloorEdge = true;
        shellWall(ax, ay, bx, by, z0);
        facadeFloorEdge = false;
        edgeOcclusionOnly = false;
      }
      const previousLinear: boolean = linearCutTop;
      linearCutTop = !solid;
      for (const [t0, t1] of uncovered(ax, ay, bx, by, undefined, solid ? SOLID_MERGE_DIST : WALL_MERGE_DIST)) {
        const x0 = ax + (bx - ax) * t0, y0 = ay + (by - ay) * t0, x1 = ax + (bx - ax) * t1, y1 = ay + (by - ay) * t1;
        shellWall(x0, y0, x1, y1, z0);
        taken.push([x0, y0, x1, y1]);
      }
      linearCutTop = previousLinear;
    };
    // Стыки на фасаде (козырёк у стены): стены здания там нет — закрываем полосу стыка по ребру части
    for (const [ax, ay, bx, by, lo, hi] of junctionPatches) slab(ax, ay, bx, by, lo, hi, hi, false);
    // Сначала стены-линии (точная геометрия стен, без повторов между собой и с периметром), потом помещения
    // Помещения без пола на этом уровне (лестница, второй свет): низ стены-линии по их границе не рисуется.
    const voids = items.filter((it) => it.kind === 'room' && !it.line && (it.noFloor || continuingRooms.has(it.key)))
      .flatMap((it) => it.polygons.map((p) => ({ outer: p.outer.map(g.toLocal), inners: p.inners.map((h) => h.map(g.toLocal)) })));
    const inVoid = (x: number, y: number) => voids.some((p) => pointInLocalRing([x, y], p.outer) && !p.inners.some((h) => pointInLocalRing([x, y], h)));
    const bordersVoid = (ax: number, ay: number, bx: number, by: number) => {
      const l = Math.hypot(bx - ax, by - ay) || 1, nx = (by - ay) / l * WALL_SIDE_PROBE, ny = -(bx - ax) / l * WALL_SIDE_PROBE;
      const mx = (ax + bx) / 2, my = (ay + by) / 2;
      return inVoid(mx + nx, my + ny) || inVoid(mx - nx, my - ny);
    };
    for (const it of items) {
      if (!it.line) continue;
      omitCutTop = continuesAbove(it);
      for (const p of it.polygons) {
        const pts = p.outer.map(g.toLocal);
        // Замкнутая стена (короб, шахта, тонкая стена-контур) — с крышкой сечения, а не открытой коробкой.
        // Её противоположные грани ближе WALL_MERGE_DIST — сливаем только почти совпадающие, как у стен-полигонов
        const capRing = closedWallCap(pts);
        const closed = !!capRing;
        for (let i = 0; i + 1 < pts.length; i++) {
          omitFloorSeam = bordersVoid(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
          wallFree(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], it.z, closed);
        }
        omitFloorSeam = false;
        if (capRing) cap(capRing, [], it.z, it.kind === 'wall' || it.kind === 'column');
      }
    }
    // Solid faces own coincident room boundaries. A room doorway may suppress its
    // perimeter, but must not reserve the jamb and hide the solid face drawn later.
    for (const it of [...items].sort((a, b) => {
      const solid = (kind: IndoorKind) => kind === 'wall' || kind === 'column';
      return Number(solid(b.kind)) - Number(solid(a.kind)) || order.indexOf(a.kind) - order.indexOf(b.kind);
    })) {
      const solid = it.kind === 'wall' || it.kind === 'column';
      omitCutTop = continuesAbove(it);
      omitFloorSeam = !!it.noFloor || continuingRooms.has(it.key);
      const z = floorZ(it);
      for (const p of it.polygons) {
        if (it.line || it.cutOnly) continue; // нарисованы выше; только вырез — без стен
        // У колонны и стены-полигона — крышка сечения, у остальных — пол своего цвета
        if (solid) cap(p.outer.map(g.toLocal), p.inners.map((h) => h.map(g.toLocal)), it.z, it.kind === 'wall' || it.kind === 'column');
        else for (const piece of floorPieces.get(p) ?? []) fill(piece.outer, piece.inners, z, it.colour ?? INDOOR_COLOURS[it.kind]);
        for (const r of [p.outer, ...p.inners]) {
          const rp = r.map(g.toLocal);
          // Узкий внутренний контур помещения (стена, размеченная только дыркой, — её путь на других этажах):
          // объём стены с обеими гранями и крышкой. Толщина ~ 2·площадь/периметр
          let area = 0, perim = 0;
          for (let i = 0; i < rp.length; i++) {
            const [ax, ay] = rp[i], [bx, by] = rp[(i + 1) % rp.length];
            area += ax * by - bx * ay; perim += Math.hypot(bx - ax, by - ay);
          }
          const thin = it.kind === 'room' && r !== p.outer && perim > 0 && Math.abs(area) / perim < THIN_HOLE_WIDTH;
          if (thin) cap(rp, [], it.z, true);
          for (let i = 0; i < rp.length; i++) {
            const [ax, ay] = rp[i], [bx, by] = rp[(i + 1) % rp.length];
            if (solid) wallFree(ax, ay, bx, by, it.z, true);
            else if (it.kind === 'room') {
              // Стена помещения — там, где её ещё нет (периметр, indoor=wall с проёмами, соседнее помещение)
              wallFree(ax, ay, bx, by, it.z, thin);
            }
            if (!solid && !omitFloorSeam && !it.noFloor) lines.push(ax, ay, z, bx, by, z);
          }
        }
      }
    }
    omitFloorSeam = false;
    omitCutTop = false;
    // Дверь в просвете между двумя толстыми стенами (колонны, стены-полигоны): перемычка — объёмом на всю толщину.
    // Стена помещения даёт её только с одной стороны — без низа, крышки и обратной грани проём сквозной
    {
      const solids = items.filter((it) => !it.line && (it.kind === 'wall' || it.kind === 'column'))
        .flatMap((it) => it.polygons.flatMap((p) => [p.outer, ...p.inners].map((r) => ({ z: it.z, ring: r.map(g.toLocal) }))));
      for (const door of doors) {
        const [px, py] = door.at;
        // Explicit polygon-wall notches are already modelled by their solid jambs
        // and front connector. Do not invent a volume/lintel across the rear.
        if (doorwayFootprints.some(p => [[p[0],p[1]],[p[2],p[3]]].some(([a,b]) => Math.hypot(px-(a[0]+b[0])/2,py-(a[1]+b[1])/2)<0.02))) continue;
        const z0 = door.z ?? items[0].z;
        let best: { P: Pt; Q: Pt; P2: Pt; Q2: Pt; d: number } | undefined;
        const near = solids.filter((sd) => Math.abs(sd.z - z0) < 0.1)
          .flatMap((sd, si) => sd.ring.map((v, i) => ({ v, si, ring: sd.ring, i })).filter(({ v }) => Math.hypot(v[0] - px, v[1] - py) < DOOR_WIDTH * 1.5));
        for (const a of near) for (const b of near) {
          if (a.si === b.si && a.i === b.i) continue;
          const [P, Q] = [a.v, b.v], len = Math.hypot(Q[0] - P[0], Q[1] - P[1]);
          if (len < 0.3 || len > LINTEL_MAX_GAP) continue;
          const ux = (Q[0] - P[0]) / len, uy = (Q[1] - P[1]) / len;
          const t = (px - P[0]) * ux + (py - P[1]) * uy;
          if (t <= 0 || t >= len || Math.abs((px - P[0]) * uy - (py - P[1]) * ux) > 0.05) continue;
          // Откосы: соседние рёбра у концов просвета, поперёк него и в одну сторону
          for (const P2 of [a.ring[(a.i + 1) % a.ring.length], a.ring[(a.i - 1 + a.ring.length) % a.ring.length]])
            for (const Q2 of [b.ring[(b.i + 1) % b.ring.length], b.ring[(b.i - 1 + b.ring.length) % b.ring.length]]) {
              const pv = [P2[0] - P[0], P2[1] - P[1]], qv = [Q2[0] - Q[0], Q2[1] - Q[1]];
              const pl = Math.hypot(pv[0], pv[1]), ql = Math.hypot(qv[0], qv[1]);
              if (pl < 0.05 || ql < 0.05 || pl > LINTEL_MAX_DEPTH || ql > LINTEL_MAX_DEPTH) continue;
              if (Math.abs(pv[0] * ux + pv[1] * uy) / pl > 0.5 || Math.abs(qv[0] * ux + qv[1] * uy) / ql > 0.5) continue;
              const d = Math.hypot(pv[0] - qv[0], pv[1] - qv[1]);
              if (d < 0.1 && (!best || d < best.d)) best = { P, Q, P2, Q2, d };
            }
        }
        if (!best) continue;
        const { P, Q, P2, Q2 } = best;
        const lintel = z0 + DOOR_HEIGHT;
        const zTop = (x: number, y: number) => Math.max(z0, Math.min(top, shell?.at(x, y, z0) ?? top));
        const zq2 = zTop(...Q2), zp2 = zTop(...P2);
        if (Math.min(zq2, zp2) - lintel < 0.01) continue;
        // Обратная грань перемычки (лицевую дала стена помещения) и низ
        slab(P2[0], P2[1], Q2[0], Q2[1], lintel, zp2, zq2, false);
        const quad = [P, Q, Q2, P2];
        const c = WHITE_WALL;
        for (const [i, j, k] of [[0, 1, 2], [0, 2, 3], [0, 2, 1], [0, 3, 2]]) {
          for (const v of [quad[i], quad[j], quad[k]]) { walls.push(v[0], v[1], lintel); wallCols.push(c.r, c.g, c.b); }
        }
        if (this.graphics.edges) edges.push(P[0], P[1], lintel, Q[0], Q[1], lintel, P2[0], P2[1], lintel, Q2[0], Q2[1], lintel);
        cap(quad, [], z0);
        // Над проёмом перемычка продолжает грани стен: углы просвета — откосы только до неё
        for (const [x, y] of quad) {
          const e = ends.get(`${Math.round(x * 1000)},${Math.round(y * 1000)}`);
          if (e) e.z1 = Math.min(e.z1, lintel);
        }
      }
    }
    if (!pale) this.indoorWallPositions = walls;
    if (this.graphics.edges) for (const value of walls) this.indoorEdgeOccluders.push(value);
    this.indoorGlassBlockers = this.indoorGlassBlockers.concat(walls);
    if (walls.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(walls, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(wallCols, 3));
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, pale ? INDOOR_PALE_WALL : INDOOR_WALL_MATERIAL);
      mesh.frustumCulled = false;
      root.add(mesh);
    }
    // Вертикаль — в конце стены или где стены сходятся не по прямой (продолжение стены — без шва)
    const edgeCos = Math.cos(INDOOR_EDGE_TURN);
    for (const e of ends.values()) {
      const opposite = (a: [number, number, number], b: [number, number, number]) => {
        const dot = a[0] * b[0] + a[1] * b[1];
        // На коротких сегментах сантиметровая погрешность OSM даёт большой
        // угол. Сохраняем острые углы, но не рисуем шов при отклонении до 1 см.
        return dot < -edgeCos || (dot < -0.9 && Math.abs(a[0] * b[1] - a[1] * b[0]) * Math.min(a[2], b[2]) < 0.01);
      };
      const straight = e.dirs.length === 2 && opposite(e.dirs[0], e.dirs[1]);
      if (straight) continue;
      let spans: [number, number][] = [[e.z0, e.z1]];
      if (e.dirs.length === 1) {
        for (let x = Math.floor((e.x - 0.02) / 4); x <= Math.floor((e.x + 0.02) / 4); x++)
          for (let y = Math.floor((e.y - 0.02) / 4); y <= Math.floor((e.y + 0.02) / 4); y++)
            for (const [ax, ay, bx, by, z0, za, zb] of edgeSurfaces.get(`${x},${y}`) ?? []) {
              const len = Math.hypot(bx - ax, by - ay);
              if (len < 1e-6) continue;
              const dx = (bx - ax) / len, dy = (by - ay) / len;
              const t = (e.x - ax) * dx + (e.y - ay) * dy;
              if (t < -0.02 || t > len + 0.02 || Math.abs((e.x - ax) * dy - (e.y - ay) * dx) > 0.02) continue;
              const dot = dx * e.dirs[0][0] + dy * e.dirs[0][1];
              if (Math.abs(dot) < edgeCos || (t <= 0.02 && dot > -edgeCos) || (t >= len - 0.02 && dot < edgeCos)) continue;
              // Перемычка закрывает только верх вертикали: откос ниже неё остаётся.
              const top = za + (zb - za) * Math.max(0, Math.min(1, t / len));
              spans = spans.flatMap(([lo, hi]): [number, number][] => {
                if (top <= lo || z0 >= hi) return [[lo, hi]];
                const rest: [number, number][] = [];
                if (z0 > lo) rest.push([lo, z0]);
                if (top < hi) rest.push([top, hi]);
                return rest;
              });
            }
        if (!spans.length) continue;
      }
      // Стена упирается в другую (или в периметр): вертикаль чуть внутрь своей стены — с обратной стороны той стены
      // её закрывает сама стена (рёбра — линии, без отсечения задних граней). Конец в Т-образном примыкании —
      // внутрь примыкающей стены (у сквозной пары направлений — противоположные)
      const odd = e.dirs.length === 1 ? e.dirs[0]
        : e.dirs.length === 3 ? e.dirs.find((d, i) => e.dirs.some((o, j) => j !== i && !opposite(d, o)) && !e.dirs.some((o, j) => j !== i && opposite(d, o))) : undefined;
      const [x, y] = odd ? [e.x + odd[0] * EDGE_INSET, e.y + odd[1] * EDGE_INSET] : [e.x, e.y];
      for (const [lo, hi] of spans) if (hi - lo > 0.01) edges.push(x, y, lo, x, y, hi);
    }
    if (edges.length || openingEdges.length) {
      const eg = new THREE.BufferGeometry();
      const trimmed = trimIndoorBuildingEdges(new Float32Array(edges), openingMasks);
      const all = new Float32Array(trimmed.length + openingEdges.length);
      all.set(trimmed); all.set(openingEdges, trimmed.length);
      eg.setAttribute('position', new THREE.BufferAttribute(all, 3));
      const es = new THREE.LineSegments(eg, pale ? INDOOR_PALE_LINE : EDGE_MATERIAL);
      es.frustumCulled = false;
      root.add(es);
    }
    if(floorContactEdges.length){
      const positions=trimIndoorBuildingEdges(new Float32Array(floorContactEdges),openingMasks);
      let line: THREE.LineSegments | LineSegments2;
      if(this.map){
        const canvas=this.map.getCanvas(),dpr=canvas.width/Math.max(1,canvas.clientWidth);
        const geo=new LineSegmentsGeometry();geo.setPositions(positions);
        const material=new LineMaterial({color:pale?INDOOR_PALE_LINE.color.getHex():0x57534e,linewidth:dpr,depthWrite:false});
        material.resolution.set(canvas.width,canvas.height);
        material.onBeforeCompile=shader=>{shader.vertexShader=shader.vertexShader.replace('gl_Position = clip;', 'gl_Position = clip; gl_Position.z -= 2e-6 * gl_Position.w;');};
        line=new LineSegments2(geo,material);
      }else{
        const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.BufferAttribute(positions,3));
        line=new THREE.LineSegments(geo,pale?INDOOR_PALE_LINE:FLOOR_CONTACT_MATERIAL);
      }
      line.name='indoor-floor-contact';line.frustumCulled=false;line.renderOrder=999;
      root.add(line);
    }
    if (cutTopLines.length && this.map) {
      const positions = trimIndoorBuildingEdges(new Float32Array(cutTopLines), openingMasks);
      const geometry = new LineSegmentsGeometry();
      geometry.setPositions(positions);
      const canvas = this.map.getCanvas();
      const dpr = canvas.width / Math.max(1, canvas.clientWidth);
      const material = new LineMaterial({ color: pale ? INDOOR_PALE_LINE.color.getHex() : 0x000000, linewidth: 2 * dpr });
      material.resolution.set(canvas.width, canvas.height);
      const stroke = new LineSegments2(geometry, material);
      stroke.name = 'indoor-wall-cut-top';
      stroke.frustumCulled = false;
      root.add(stroke);
    }
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.BufferAttribute(trimIndoorBuildingEdges(new Float32Array(lines), openingMasks), 3));
    const seg = new THREE.LineSegments(lineGeo, pale ? INDOOR_PALE_LINE : INDOOR_LINE_MATERIAL);
    seg.frustumCulled = false;
    root.add(seg);
    finish();
    for (const it of pools) this.drawPool(root, g, it, pale);
  }

  /** Чаша бассейна: стенки по контуру (и вокруг островков) от пола вниз на глубину, дно и вода. */
  private drawPool(root: THREE.Group, g: MeshGroup, it: IndoorItem, pale: boolean) {
    const top = it.z, bottom = it.z - it.pool!, water = it.z - Math.min(POOL_WATER_DROP, it.pool! / 2);
    const tile: number[] = [], waterPos: number[] = [], rim: number[] = [];
    const flat = (outer: Pt[], holes: Pt[][], z: number, out: number[]) => {
      const v2 = (r: Pt[]) => r.map(([x, y]) => new THREE.Vector2(x, y));
      const contour = v2(outer), hs = holes.map(v2);
      if (THREE.ShapeUtils.isClockWise(contour)) contour.reverse();
      for (const h of hs) if (!THREE.ShapeUtils.isClockWise(h)) h.reverse();
      const pts = [...contour, ...hs.flat()];
      for (const tri of THREE.ShapeUtils.triangulateShape(contour, hs)) for (const i of tri) out.push(pts[i].x, pts[i].y, z);
    };
    for (const p of it.polygons) {
      const outer = p.outer.map(g.toLocal), holes = p.inners.map(r => r.map(g.toLocal));
      flat(outer, holes, bottom, tile);
      flat(outer, holes, water, waterPos);
      for (const r of [outer, ...holes]) for (let i = 0; i < r.length; i++) {
        const [ax, ay] = r[i], [bx, by] = r[(i + 1) % r.length];
        tile.push(ax, ay, bottom, bx, by, bottom, bx, by, top, ax, ay, bottom, bx, by, top, ax, ay, top);
        rim.push(ax, ay, top, bx, by, top, ax, ay, bottom, bx, by, bottom);
        if (turnAt(r, i) >= CORNER_MIN_TURN) rim.push(ax, ay, bottom, ax, ay, top);
      }
    }
    const mesh = (pos: number[], mat: THREE.Material) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.computeVertexNormals();
      const m = new THREE.Mesh(geo, mat);
      m.frustumCulled = false;
      return m;
    };
    root.add(mesh(tile, pale ? INDOOR_PALE_WALL : POOL_TILE_MATERIAL));
    const w = mesh(waterPos, POOL_WATER_MATERIAL);
    w.renderOrder = 1; // после дна и стенок: сквозь воду их видно
    root.add(w);
    if (!this.graphics.edges) return;
    const eg = new THREE.BufferGeometry();
    eg.setAttribute('position', new THREE.Float32BufferAttribute(rim, 3));
    const es = new THREE.LineSegments(eg, pale ? INDOOR_PALE_LINE : EDGE_MATERIAL);
    es.frustumCulled = false;
    root.add(es);
  }

  /**
   * Здание режима одного здания при текущей камере: прямоугольник его 3D-габаритов на экране (px)
   * и центр основания — для подлёта. mainMatrix — проекция другой (пробной) камеры MapLibre.
   */
  focusFrame(mainMatrix?: ArrayLike<number>): { rect: [number, number, number, number]; center: LngLat } | undefined {
    const g = this.groups.get(FOCUS_GROUP);
    const main = mainMatrix ? new THREE.Matrix4().fromArray(Array.from(mainMatrix)) : this.lastMain;
    if (!g || !this.map || !main) return;
    const box = groupBox(g);
    if (box.isEmpty()) return;
    const m = main.clone().multiply(g.model);
    const canvas = this.map.getCanvas();
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
      const v = new THREE.Vector4(x, y, z, 1).applyMatrix4(m);
      if (v.w <= 0) continue; // точка за камерой
      const px = (v.x / v.w + 1) / 2 * canvas.clientWidth, py = (1 - v.y / v.w) / 2 * canvas.clientHeight;
      x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py);
    }
    if (!Number.isFinite(x0)) return;
    const c = box.getCenter(new THREE.Vector3());
    const merc = new MercatorCoordinate(g.origin.x + c.x * g.metersToMerc, g.origin.y - c.y * g.metersToMerc, 0);
    return { rect: [x0, y0, x1, y1], center: merc.toLngLat() };
  }

  /**
   * Ближайшая к точке экрана привязка режима одного здания в пределах radius px.
   * Вершины важнее середин рёбер, середины — центров: при близких расстояниях побеждает более важная.
   * Привязки выделенного объекта важнее остальных, невидимые (заслонённые геометрией) — наименее важны.
   */
  /** Привязки включены (S в режиме здания). Выключены — инструменты двигают свободно. */
  snapsEnabled = true;
  /** Ребро под курсором и с какого момента (для взвода продолжения). */
  private edgeHover?: { id: string; since: number };
  /** Рёбра со взведённой привязкой к продолжению → до какого момента. */
  private armedEdges = new Map<string, number>();
  /** Сетка 10 м под зданием в режиме здания (G); выключенная — и без привязки к ней. */
  gridVisible = true;
  private gridFrame?: THREE.Object3D;

  setGridVisible(on: boolean) {
    this.gridVisible = on;
    if (this.gridFrame) this.gridFrame.visible = on;
    this.map?.triggerRepaint();
  }
  /**
   * Откладывание от вершины: курсор задержан над вершиной (TRACK_ARM_MS) — она становится якорем,
   * курсор ловится на оси через неё (горизонтальные рёбра, их продолжения и перпендикуляры к ним).
   * point — виртуальная точка, отложенная по оси числом с клавиатуры: привязка к ней, как к вершине.
   */
  tracking?: { anchor: THREE.Vector3; key: string; dirs: THREE.Vector3[]; px?: [number, number]; axis?: number; dist?: number; point?: THREE.Vector3; pointPx?: [number, number] };
  /** Включать откладывание (только в инструментах). */
  trackingEnabled = false;
  /** Ось откладывания и по вертикали (вдоль бокового ребра) — инструменту, которому нужны высоты («Рассечь»). */
  trackVertical = false;
  /** Якорь только что взведён задержкой курсора — перерисовать маркеры. */
  onTrackArmed?: () => void;
  private vertexHover?: { id: string; since: number; timer: ReturnType<typeof setTimeout> };

  clearTracking() {
    this.tracking = undefined;
    if (this.vertexHover) clearTimeout(this.vertexHover.timer);
    this.vertexHover = undefined;
  }

  /** Отложить виртуальную точку по текущей оси: dist > 0 — в сторону курсора, < 0 — в обратную. */
  placeTracked(dist: number, axis: number, side: number): boolean {
    const t = this.tracking;
    const u = t?.dirs[axis];
    if (!t || !u) return false;
    t.point = t.anchor.clone().addScaledVector(u, dist * side);
    return true;
  }

  /** Выключенные типы привязок (всплывашка у кнопки привязок). */
  snapKindsOff = new Set<SnapKind>();
  /** Alt зажат — привязки временно выключены. */
  snapsSuspended = false;

  /**
   * opts.from — последняя точка инструмента: от неё ищем основание перпендикуляра на ребре.
   * opts.noEdge — без точки на ребре (вытягиванию нужны высоты, а не произвольные точки вертикальных рёбер).
   * opts.skip — какие точки (и рёбра с таким концом) не брать: например, едущие вершины и их стороны.
   */
  snapAt(point: [number, number], filter: (key: string) => boolean = () => true, radius = SNAP_RADIUS_PX,
    opts: SnapOpts = {}): SnapHit | undefined {
    const own = timed('привязки: поиск', () => this.findSnap(point, filter, radius, opts));
    // В наброске на карте — и привязки к геометрии карты (сцена наброска своей почти не имеет): ближайшая на экране
    const on = this.sketching && this.snapsEnabled && !this.snapsSuspended;
    const d = (h: SnapHit) => Math.hypot(h.point[0] - point[0], h.point[1] - point[1]);
    // Фильтр инструмента — и для них (захват — только за свои); из нескольких — ближайшая на экране
    // Здания карты в 3D — их привязки (с высотой); плоские привязки контуров — только если 3D-зданий нет (низкий зум)
    const map3d = [...this.groups.keys()].some((k) => k !== FOCUS_GROUP);
    const cands = on ? [map3d ? this.mapGroupSnap(point, filter, radius, opts) : this.sketchSnap?.(point)].filter((h): h is SnapHit => !!h && filter(h.key)) : [];
    return [own, ...cands].filter((h): h is SnapHit => !!h).sort((a, b) => d(a) - d(b))[0];
  }

  /** Привязки зданий карты (по группе — один раз): точки и рёбра низа и верха стен. */
  private mapSnaps = new WeakMap<MeshGroup, ReturnType<typeof collectSnaps>>();

  /**
   * Привязка к зданиям карты в наброске (в 3D — с высотой: углы по верху стен, а не только контур на земле), в метрах
   * сцены наброска. Вершины важнее середин.
   */
  private mapGroupSnap(point: [number, number], filter: (key: string) => boolean, radius: number, opts: SnapOpts = {}): SnapHit | undefined {
    const f = this.groups.get(FOCUS_GROUP);
    if (!f || !this.map || !this.lastMain || !this.visible) return;
    const canvas = this.map.getCanvas();
    const toFocus = f.model.clone().invert();
    const v = new THREE.Vector4();
    const near: { s: SnapPoint; g: MeshGroup; d: number; px: [number, number] }[] = [];
    const off = this.snapKindsOff;
    for (const [key, g] of this.groups) {
      if (key === FOCUS_GROUP) continue;
      let snaps = this.mapSnaps.get(g);
      if (!snaps) { snaps = collectSnaps(g); this.mapSnaps.set(g, snaps); }
      const m = this.lastMain.clone().multiply(g.model);
      for (const s of snaps.points) {
        if (s.kind !== 'vertex' && s.kind !== 'midpoint') continue;
        if (off.has(s.kind) || !filter(s.key) || g.hidden.has(s.key)) continue;
        v.set(s.p.x, s.p.y, s.p.z, 1).applyMatrix4(m);
        if (v.w <= 0) continue;
        const px: [number, number] = [(v.x / v.w + 1) / 2 * canvas.clientWidth, (1 - v.y / v.w) / 2 * canvas.clientHeight];
        const d = Math.hypot(px[0] - point[0], px[1] - point[1]);
        if (d <= radius) near.push({ s, g, d: d + SNAP_PRIORITY[s.kind] * 6, px });
      }
      if (!opts.noEdge && !off.has('edge')) {
        // Луч сцены наброска переводим в локальные метры здания карты.
        const ray = this.focusRay(point)?.clone().applyMatrix4(f.model).applyMatrix4(g.model.clone().invert());
        const a = new THREE.Vector4(), b = new THREE.Vector4(), p = new THREE.Vector3();
        if (ray) for (const e of snaps.edges) {
          if (!filter(e.key) || g.hidden.has(e.key)) continue;
          // Дешёвый экранный отсев до поиска точки на 3D-отрезке.
          a.set(e.a.x, e.a.y, e.a.z, 1).applyMatrix4(m);
          b.set(e.b.x, e.b.y, e.b.z, 1).applyMatrix4(m);
          if (a.w <= 0 && b.w <= 0) continue;
          if (a.w > 0 && b.w > 0) {
            const ax = (a.x / a.w + 1) * canvas.clientWidth / 2;
            const ay = (1 - a.y / a.w) * canvas.clientHeight / 2;
            const bx = (b.x / b.w + 1) * canvas.clientWidth / 2;
            const by = (1 - b.y / b.w) * canvas.clientHeight / 2;
            if (point[0] < Math.min(ax, bx) - radius || point[0] > Math.max(ax, bx) + radius
                || point[1] < Math.min(ay, by) - radius || point[1] > Math.max(ay, by) + radius) continue;
          }
          ray.distanceSqToSegment(e.a, e.b, undefined, p);
          v.set(p.x, p.y, p.z, 1).applyMatrix4(m);
          if (v.w <= 0) continue;
          const px: [number, number] = [(v.x / v.w + 1) / 2 * canvas.clientWidth, (1 - v.y / v.w) / 2 * canvas.clientHeight];
          const d = Math.hypot(px[0] - point[0], px[1] - point[1]);
          if (d <= radius) near.push({ s: {kind: 'edge', key: e.key, p: p.clone()}, g, d: d + SNAP_PRIORITY.edge * 6, px });
        }
      }
    }
    // Заслонённые (вершина контура за стеной и т. п.) — «дальше»: выигрывают, только если видимых рядом нет
    const world = (n: (typeof near)[number]) => n.s.p.clone().applyMatrix4(n.g.model);
    near.sort((a, b) => a.d - b.d);
    for (const n of near.slice(0, 6)) {
      const hit = this.pickHit(n.px);
      if (!hit) continue;
      const w = world(n), h = MercatorCoordinate.fromLngLat(hit.lngLat, hit.altitude);
      const s = MercatorCoordinate.fromLngLat(hit.lngLat).meterInMercatorCoordinateUnits();
      if (Math.hypot(w.x - h.x, w.y - h.y, w.z - h.z) / s > 0.6) n.d += SNAP_HIDDEN_PENALTY_PX;
    }
    const best = near.sort((a, b) => a.d - b.d)[0];
    if (!best) return;
    const local = world(best).applyMatrix4(toFocus);
    const ll = this.focusToLngLat(local.x, local.y);
    if (!ll) return;
    return { kind: best.s.kind, key: best.s.key, local, lngLat: new LngLat(ll[0], ll[1]), altitude: local.z, point: best.px };
  }

  /** Привязки к геометрии карты в наброске (подключает main.ts); undefined — без них. */
  sketchSnap?: (point: [number, number]) => SnapHit | undefined;

  private findSnap(point: [number, number], filter: (key: string) => boolean, radius: number, opts: SnapOpts): SnapHit | undefined {
    if (!this.snapsEnabled || this.snapsSuspended) return;
    const g = this.groups.get(FOCUS_GROUP);
    if (!this.focused || !g || !this.map || !this.lastMain) return;
    this.snaps ??= timed('привязки: сбор геометрии', () => collectSnaps(g));
    const m = this.lastMain.clone().multiply(g.model);
    const canvas = this.map.getCanvas();
    const v = new THREE.Vector4();
    /** virtual — построение пользователя (оси якоря, перпендикуляр из него): видно сквозь геометрию. */
    type Near = { s: SnapPoint; d: number; px: [number, number]; along?: THREE.Vector3; virtual?: boolean };
    let best: Near | undefined;
    const near: Near[] = [];
    const off = this.snapKindsOff;
    this.indoorSnaps ??= (() => {
      const points: SnapPoint[] = [], edges: SnapEdge[] = [];
      for (const item of this.level?.items ?? []) for (const polygon of item.polygons) for (const ring of [polygon.outer, ...polygon.inners]) {
        const pts = ring.map(at => { const [x, y] = g.toLocal(at); return new THREE.Vector3(x, y, item.z); });
        for (const p of pts) points.push({ key: item.key, kind: 'vertex', p });
        for (let i = 0; i < pts.length - (item.line ? 1 : 0); i++) {
          const a = pts[i], b = pts[(i + 1) % pts.length];
          if (a.distanceToSquared(b) < 1e-10) continue;
          edges.push({ key: item.key, a, b });
          points.push({ key: item.key, kind: 'midpoint', p: a.clone().add(b).multiplyScalar(0.5) });
        }
      }
      return { points, edges };
    })();
    const doorPoints: SnapPoint[] = this.level ? this.doors.flatMap(d => {
      const p = this.doorAnchor(d.key)!;
      const radius = (revolvingDoorDiameter(d.tags) ?? 0) / 2;
      return [{ kind: 'center' as SnapKind, key: d.key, p }, ...[0, 1, 2, 3].flatMap(i => radius ? [{ kind: 'vertex' as SnapKind, key: d.key,
        p: p.clone().add(new THREE.Vector3(Math.cos(i * Math.PI / 2) * radius, Math.sin(i * Math.PI / 2) * radius, 0)) }] : [])];
    }) : [];
    // Свои точки инструмента (extra) — мимо фильтра объектов: инструмент сам решил, что они нужны
    const extra = new Set(opts.extra ?? []);
    for (const s of [...this.snaps.points, ...this.indoorSnaps.points, ...doorPoints, ...extra]) {
      if (off.has(s.kind) || (!extra.has(s) && !filter(s.key)) || opts.skip?.(s.p, s.key, s.kind)) continue;
      v.set(s.p.x, s.p.y, s.p.z, 1).applyMatrix4(m);
      if (v.w <= 0) continue;
      const px: [number, number] = [(v.x / v.w + 1) / 2 * canvas.clientWidth, (1 - v.y / v.w) / 2 * canvas.clientHeight];
      const d = Math.hypot(px[0] - point[0], px[1] - point[1]);
      if (d > radius) continue;
      // Штраф за менее важный тип — вершина в 6 px «ближе» середины ребра; выделенный объект — ещё на 8 px
      near.push({ s, d: d + SNAP_PRIORITY[s.kind] * 6 - (this.selected.has(s.key) ? SNAP_SELECTED_BONUS_PX : 0), px });
    }
    // Рёбра: ближайшая к лучу курсора точка ребра и основание перпендикуляра из opts.from
    const ray = this.focusRay(point);
    const onSeg = new THREE.Vector3(), foot = new THREE.Vector3(), ab = new THREE.Vector3(), ext0 = new THREE.Vector3(), ext1 = new THREE.Vector3();
    const toPx = (p: THREE.Vector3): [number, number] | undefined => {
      v.set(p.x, p.y, p.z, 1).applyMatrix4(m);
      return v.w > 0 ? [(v.x / v.w + 1) / 2 * canvas.clientWidth, (1 - v.y / v.w) / 2 * canvas.clientHeight] : undefined;
    };
    const bonus = (key: string) => (this.selected.has(key) ? SNAP_SELECTED_BONUS_PX : 0);
    // Продолжение ребра «взводится» задержкой курсора над ребром (EXTENSION_ARM_MS) и гаснет через EXTENSION_TTL_MS
    const now = performance.now();
    const edgeId = (e: { a: THREE.Vector3; b: THREE.Vector3 }) => `${e.a.x.toFixed(2)},${e.a.y.toFixed(2)},${e.a.z.toFixed(2)};${e.b.x.toFixed(2)},${e.b.y.toFixed(2)},${e.b.z.toFixed(2)}`;
    if (this.edgeHover && now - this.edgeHover.since >= EXTENSION_ARM_MS) this.armedEdges.set(this.edgeHover.id, now + EXTENSION_TTL_MS);
    for (const [id, until] of this.armedEdges) if (until < now) this.armedEdges.delete(id);
    let hovered: { id: string; d: number } | undefined;
    if (ray) for (const e of [...this.snaps.edges, ...this.indoorSnaps.edges]) {
      if (!filter(e.key) || opts.skip?.(e.a, e.key, 'edge') || opts.skip?.(e.b, e.key, 'edge')) continue;
      if (opts.from && !off.has('perpendicular')) {
        ab.subVectors(e.b, e.a);
        const l2 = ab.lengthSq();
        const t = l2 ? foot.subVectors(opts.from, e.a).dot(ab) / l2 : -1;
        // Только внутри ребра и не в его концах (там — вершины); from не на самой прямой
        if (t > 0.01 && t < 0.99) {
          foot.copy(e.a).addScaledVector(ab, t);
          const px = foot.distanceTo(opts.from) > 0.05 ? toPx(foot) : undefined;
          const d = px ? Math.hypot(px[0] - point[0], px[1] - point[1]) : Infinity;
          if (px && d <= radius) near.push({ s: { kind: 'perpendicular', key: e.key, p: foot.clone() }, d: d + SNAP_PRIORITY.perpendicular * 6 - bonus(e.key), px });
        }
      }
      if (opts.noEdge) continue;
      // Продолжение ребра за его концы (до EXTENSION_M): точка на прямой ребра вне самого ребра
      ab.subVectors(e.b, e.a);
      const len = ab.length();
      const id = edgeId(e);
      const armed = this.armedEdges.has(id);
      if (armed && len > 0.05 && !off.has('extension')) {
        const k = EXTENSION_M / len;
        ext0.copy(e.a).addScaledVector(ab, -k);
        ext1.copy(e.b).addScaledVector(ab, k);
        ray.distanceSqToSegment(ext0, ext1, undefined, onSeg);
        const t = foot.subVectors(onSeg, e.a).dot(ab) / (len * len);
        if (t < -0.02 || t > 1.02) {
          const px = toPx(onSeg);
          const d = px ? Math.hypot(px[0] - point[0], px[1] - point[1]) : Infinity;
          if (px && d <= Math.min(radius, EXTENSION_RADIUS_PX)) {
            near.push({ s: { kind: 'extension', key: e.key, p: onSeg.clone() }, d: d + SNAP_PRIORITY.extension * 6 - bonus(e.key), px,
              along: (t < 0 ? e.a : e.b).clone() });
            this.armedEdges.set(id, now + EXTENSION_TTL_MS); // пока пользуемся — не гаснет
          }
        }
      }
      ray.distanceSqToSegment(e.a, e.b, undefined, onSeg);
      const px = toPx(onSeg);
      const d = px ? Math.hypot(px[0] - point[0], px[1] - point[1]) : Infinity;
      if (px && d <= radius && !off.has('edge')) near.push({ s: { kind: 'edge', key: e.key, p: onSeg.clone() }, d: d + SNAP_PRIORITY.edge * 6 - bonus(e.key), px });
      if (px && d <= EXTENSION_HOVER_PX && (!hovered || d < hovered.d)) hovered = { id, d };
    }
    if (!hovered) this.edgeHover = undefined;
    else if (this.edgeHover?.id !== hovered.id) this.edgeHover = { id: hovered.id, since: now };
    // Оси откладывания через якорь и отложенная по ним виртуальная точка
    const track = this.trackingEnabled && !off.has('tracking') ? this.tracking : undefined;
    if (track) {
      track.px = toPx(track.anchor);
      track.pointPx = track.point && toPx(track.point);
      if (track.point && filter(track.key)) {
        const px = track.pointPx;
        const d = px ? Math.hypot(px[0] - point[0], px[1] - point[1]) : Infinity;
        if (px && d <= radius) near.push({ s: { kind: 'tracked', key: track.key, p: track.point.clone() }, d: d + SNAP_PRIORITY.tracked * 6, px, along: track.anchor.clone() });
      }
      if (ray) track.dirs.forEach((u, i) => {
        ext0.copy(track.anchor).addScaledVector(u, -TRACK_M);
        ext1.copy(track.anchor).addScaledVector(u, TRACK_M);
        ray.distanceSqToSegment(ext0, ext1, undefined, onSeg);
        const dist = foot.subVectors(onSeg, track.anchor).dot(u);
        if (Math.abs(dist) < 0.02) return;
        const px = toPx(onSeg);
        const d = px ? Math.hypot(px[0] - point[0], px[1] - point[1]) : Infinity;
        // Ось — построение пользователя: на ребре выделенного объекта она совпадает с ним и не должна ему уступать
        // (у ребра бонус выделенного — без него ось проигрывала, и число на ней не набиралось)
        if (px && d <= Math.min(radius, TRACK_RADIUS_PX)) near.push({ s: { kind: 'tracking', key: track.key, p: onSeg.clone(), axis: i, dist }, d: d + SNAP_PRIORITY.tracking * 6 - SNAP_SELECTED_BONUS_PX, px, along: track.anchor.clone() });
      });
    }
    // Перпендикуляр из якоря на линию от from (по оси Shift или к курсору): основание — угол 90° у линии
    if (track && opts.from && ray && !off.has('perpendicular')) {
      const a = opts.from, b = track.anchor;
      let d = opts.dir?.clone().setZ(0);
      if (!d && Math.abs(ray.direction.z) > 1e-6) {
        const t = (a.z - ray.origin.z) / ray.direction.z;
        if (t > 0) d = ray.at(t, new THREE.Vector3()).sub(a).setZ(0);
      }
      if (d && d.lengthSq() > 1e-8) {
        d.normalize();
        const s = (b.x - a.x) * d.x + (b.y - a.y) * d.y;
        const c = new THREE.Vector3(a.x + d.x * s, a.y + d.y * s, a.z);
        // Не у самой from и не когда якорь на линии (основание совпало бы с ним)
        if (Math.abs(s) > 0.05 && Math.hypot(b.x - c.x, b.y - c.y) > 0.05) {
          const px = toPx(c);
          const dist = px ? Math.hypot(px[0] - point[0], px[1] - point[1]) : Infinity;
          if (px && dist <= radius) near.push({ s: { kind: 'perpendicular', key: track.key, p: c }, d: dist + SNAP_PRIORITY.perpendicular * 6, px, along: b.clone(), virtual: true });
        }
      }
    }
    // Узел сетки основания (земля, вдоль осей здания) под курсором
    const grid = !off.has('grid') && filter(GRID_SNAP_KEY) && !this.sketching && this.gridVisible ? this.gridSnap(point) : undefined; // в наброске сетки не видно
    if (grid) {
      v.set(grid.x, grid.y, 0, 1).applyMatrix4(m);
      if (v.w > 0) {
        const px: [number, number] = [(v.x / v.w + 1) / 2 * canvas.clientWidth, (1 - v.y / v.w) / 2 * canvas.clientHeight];
        const d = Math.hypot(px[0] - point[0], px[1] - point[1]);
        if (d <= radius) near.push({ s: { kind: 'grid', key: GRID_SNAP_KEY, p: grid }, d: d + SNAP_PRIORITY.grid * 6, px });
      }
    }
    // Видимость проверяем только у кандидатов в радиусе (луч на каждый — недёшево): заслонённые — в конец
    for (const c of near.sort((a, b) => a.d - b.d)) {
      if (best && c.d >= best.d) continue;
      // Оси и отложенная точка — построения пользователя: видны сквозь геометрию
      if (!c.virtual && c.s.kind !== 'tracking' && c.s.kind !== 'tracked' && this.snapHidden(c.s.p, c.px)) c.d += SNAP_HIDDEN_PENALTY_PX;
      if (!best || c.d < best.d) best = c;
    }
    if (track) { track.axis = best?.s.kind === 'tracking' ? best.s.axis : undefined; track.dist = best?.s.dist; }
    this.armTracking(best?.s.kind === 'vertex' && this.trackingEnabled && !off.has('tracking') ? best.s : undefined);
    if (!best) return;
    const { s, px, along } = best;
    const merc = new MercatorCoordinate(g.origin.x + s.p.x * g.metersToMerc, g.origin.y - s.p.y * g.metersToMerc, 0);
    return { kind: s.kind, key: s.key, local: s.p.clone(), lngLat: merc.toLngLat(), altitude: s.p.z, point: px, along, label: s.label, dist: s.dist };
  }

  /** Задержка курсора над вершиной с горизонтальными рёбрами взводит её якорем откладывания. */
  private armTracking(s: SnapPoint | undefined) {
    const id = s && `${s.key}:${s.p.x.toFixed(3)},${s.p.y.toFixed(3)},${s.p.z.toFixed(3)}`;
    if (this.vertexHover?.id === id) return;
    if (this.vertexHover) clearTimeout(this.vertexHover.timer);
    this.vertexHover = undefined;
    if (!s || !id || (this.tracking && !this.tracking.point && this.tracking.anchor.distanceTo(s.p) < 1e-3)) return;
    const timer = setTimeout(() => {
      this.vertexHover = undefined;
      const dirs: THREE.Vector3[] = [];
      const add = (u: THREE.Vector3) => { if (!dirs.some((v) => v.clone().cross(u).length() < 0.02)) dirs.push(u); };
      for (const e of [...this.snaps?.edges ?? [], ...this.indoorSnaps?.edges ?? []]) {
        const other = e.a.distanceTo(s.p) < 1e-3 ? e.b : e.b.distanceTo(s.p) < 1e-3 ? e.a : undefined;
        if (!other) continue;
        if (Math.abs(e.a.z - e.b.z) > 1e-3) {
          if (this.trackVertical && Math.hypot(e.a.x - e.b.x, e.a.y - e.b.y) < 1e-3) add(new THREE.Vector3(0, 0, 1));
          continue;
        }
        const u = other.clone().sub(s.p).setZ(0).normalize();
        add(u);
        add(new THREE.Vector3(-u.y, u.x, 0));
      }
      if (!dirs.length) return;
      this.tracking = { anchor: s.p.clone(), key: s.key, dirs };
      this.onTrackArmed?.();
    }, TRACK_ARM_MS);
    this.vertexHover = { id, since: performance.now(), timer };
  }

  /** Ближайший к лучу через точку экрана узел сетки на земле (z = 0). */
  private gridSnap(point: [number, number]): THREE.Vector3 | undefined {
    const ray = this.focusRay(point);
    if (!ray || Math.abs(ray.direction.z) < 1e-6) return;
    const t = -ray.origin.z / ray.direction.z;
    if (t <= 0) return;
    const q = ray.at(t, new THREE.Vector3());
    const f = this.focusAxes;
    const o: Pt = f?.origin ?? [0, 0], x: Pt = f?.x ?? [1, 0], y: Pt = f?.y ?? [0, 1];
    const dx = q.x - o[0], dy = q.y - o[1];
    const u = Math.round((dx * x[0] + dy * x[1]) / GRID_STEP) * GRID_STEP, w = Math.round((dx * y[0] + dy * y[1]) / GRID_STEP) * GRID_STEP;
    return new THREE.Vector3(o[0] + x[0] * u + y[0] * w, o[1] + x[1] * u + y[1] * w, 0);
  }

  /** Точка привязки заслонена геометрией сцены (между ней и камерой есть грань). */
  private snapHidden(p: THREE.Vector3, px: [number, number]): boolean {
    const ray = this.focusRay(px), g = this.groups.get(FOCUS_GROUP);
    if (!ray || !g) return false;
    const toSnap = ray.origin.distanceTo(p);
    const limit = toSnap - Math.max(0.05, toSnap * 0.002);
    const cut = this.level ? (this.levelCut ?? this.level.cut) + 1e-3 : Infinity;
    for (const it of g.items) {
      if (g.hidden.has(it.feature.key) || strokeOnly(g,it) || it.box.min.z > cut || !ray.intersectsBox(it.box)) continue;
      if (occludedByTriangles(it.positions,ray,limit,cut)) return true;
      // Дно здания не входит в буфер стен и крыши.
      if (Math.abs(ray.direction.z) > 1e-6 && it.box.min.z <= cut) {
        const t = (it.box.min.z-ray.origin.z)/ray.direction.z;
        if (t>0 && t<limit) {
          const q=ray.at(t,new THREE.Vector3());
          if(it.feature.polygons.some(poly=>pointInLocalRing([q.x,q.y],poly.outer.map(g.toLocal)) && !poly.inners.some(r=>pointInLocalRing([q.x,q.y],r.map(g.toLocal))))) return true;
        }
      }
    }
    return false;
  }

  /** Луч из камеры через точку экрана — в метрах сцены режима одного здания. */
  focusRay(point: [number, number]): THREE.Ray | undefined {
    const g = this.groups.get(FOCUS_GROUP);
    if (!g || !this.map || !this.lastMain) return;
    const canvas = this.map.getCanvas();
    const inv = this.lastMain.clone().multiply(g.model).invert();
    const x = (point[0] / canvas.clientWidth) * 2 - 1, y = 1 - (point[1] / canvas.clientHeight) * 2;
    const near = new THREE.Vector3(x, y, -1).applyMatrix4(inv), far = new THREE.Vector3(x, y, 1).applyMatrix4(inv);
    return new THREE.Ray(near, far.sub(near).normalize());
  }

  /** Точка сцены режима одного здания на экране (px); undefined — за камерой. */
  /** Проекция многих точек за кадр: матрица считается один раз (focusProject — для одной). */
  focusProjector(): ((p: THREE.Vector3) => [number, number] | undefined) | undefined {
    const g = this.groups.get(FOCUS_GROUP);
    if (!g || !this.map || !this.lastMain) return;
    const m = this.lastMain.clone().multiply(g.model);
    const canvas = this.map.getCanvas();
    const w = canvas.clientWidth, h = canvas.clientHeight, v = new THREE.Vector4();
    return (p) => {
      v.set(p.x, p.y, p.z, 1).applyMatrix4(m);
      return v.w <= 0 ? undefined : [(v.x / v.w + 1) / 2 * w, (1 - v.y / v.w) / 2 * h];
    };
  }

  /** Проектор точек lon/lat + высота над землёй (м) в пиксели экрана по матрице последнего кадра. */
  geoProjector(): ((lngLat: LonLat, altitude: number) => [number, number] | undefined) | undefined {
    if (!this.map || !this.lastMain) return;
    const m = this.lastMain;
    const canvas = this.map.getCanvas();
    const w = canvas.clientWidth, h = canvas.clientHeight, v = new THREE.Vector4();
    return ([lng, lat], altitude) => {
      const c = MercatorCoordinate.fromLngLat({ lng, lat }, altitude);
      v.set(c.x, c.y, c.z, 1).applyMatrix4(m);
      return v.w <= 0 ? undefined : [(v.x / v.w + 1) / 2 * w, (1 - v.y / v.w) / 2 * h];
    };
  }

  focusProject(p: THREE.Vector3): [number, number] | undefined {
    const g = this.groups.get(FOCUS_GROUP);
    if (!g || !this.map || !this.lastMain) return;
    const v = new THREE.Vector4(p.x, p.y, p.z, 1).applyMatrix4(this.lastMain.clone().multiply(g.model));
    if (v.w <= 0) return;
    const canvas = this.map.getCanvas();
    return [(v.x / v.w + 1) / 2 * canvas.clientWidth, (1 - v.y / v.w) / 2 * canvas.clientHeight];
  }

  /**
   * Все пересечения луча из точки экрана с объектами сцены режима здания, по удалённости. У объекта нет
   * треугольников дна — нижнюю грань (плоскость низа внутри контура) добавляем как отдельное пересечение.
   * wall — стена (почти вертикальный треугольник).
   */
  focusRayHits(point: [number, number], allowed: (key: string) => boolean = () => true): FocusHit[] {
    const g = this.groups.get(FOCUS_GROUP);
    const ray = this.focusRay(point);
    if (!g || !ray) return [];
    const out: FocusHit[] = [];
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), p = new THREE.Vector3(), n = new THREE.Vector3();
    for (const it of g.items) {
      const key = it.feature.key;
      if (g.hidden.has(key) || strokeOnly(g, it) || !allowed(key) || !ray.intersectsBox(it.box)) continue;
      const pos = it.positions;
      for (let i = 0; i < pos.length; i += 9) {
        a.fromArray(pos, i); b.fromArray(pos, i + 3); c.fromArray(pos, i + 6);
        if (!ray.intersectTriangle(a, b, c, false, p)) continue;
        if (this.level && p.z > (this.levelCut ?? this.level.cut) + 1e-3) continue; // выше среза этажа — не видно
        n.subVectors(c, b).cross(a.clone().sub(b));
        if (n.lengthSq() < 1e-10) continue;
        n.normalize();
        // Горизонтальный треугольник на высоте низа объекта с объёмом — его дно, а не крыша
        const bottom = Math.abs(n.z) >= 0.3 && Math.abs(p.z - it.box.min.z) < 1e-3 && it.box.max.z - it.box.min.z >= MIN_THICKNESS;
        out.push({ key, t: p.distanceTo(ray.origin), local: p.clone(), face: Math.abs(n.z) < 0.3 ? 'wall' : bottom ? 'bottom' : 'roof' });
      }
      // Дно: плоскость низа, точка внутри контура
      const z = it.box.min.z;
      if (Math.abs(ray.direction.z) > 1e-6) {
        const t = (z - ray.origin.z) / ray.direction.z;
        if (t > 0) {
          const q = ray.at(t, new THREE.Vector3());
          const inside = it.feature.polygons.some((poly) => pointInLocalRing([q.x, q.y], poly.outer.map(g.toLocal))
            && !poly.inners.some((r) => pointInLocalRing([q.x, q.y], r.map(g.toLocal))));
          if (inside && !(this.level && q.z > (this.levelCut ?? this.level.cut) + 1e-3)) out.push({ key, t, local: q, face: 'bottom' });
        }
      }
    }
    // Совпадающие грани (плоский контур на крыше соседа, отступ) — первым выделенный объект, затем плоский:
    // иначе инструмент берёт соседа, хотя выделен и виден новый контур
    const rank = (h: FocusHit) => (this.selected.has(h.key) ? 0 : thinItem(g.byKey.get(h.key)!) ? 1 : 2);
    // У плоского контура верх и низ совпадают — первым верх (тянуть вверх), низ — вторым (Shift: задняя грань)
    const faceRank = (h: FocusHit) => (h.face === 'roof' ? 0 : h.face === 'wall' ? 1 : 2);
    return out.sort((x, y) => (Math.abs(x.t - y.t) < TIE_DEPTH
      ? rank(x) - rank(y) || (x.key === y.key ? faceRank(x) - faceRank(y) : 0) || x.t - y.t : x.t - y.t));
  }

  /**
   * Попадания луча в плоские следы сцены режима здания (контур под частями — focusRayHits их не видит): верх следа
   * внутри контура. Для «Рассечь» — кольцо можно начать и в контуре здания.
   */
  focusFlatHits(point: [number, number]): FocusHit[] {
    const g = this.groups.get(FOCUS_GROUP);
    const ray = this.focusRay(point);
    if (!g || !ray || Math.abs(ray.direction.z) < 1e-6) return [];
    const out: FocusHit[] = [];
    for (const it of g.items) {
      if (g.hidden.has(it.feature.key) || !strokeOnly(g, it) || it.box.isEmpty()) continue;
      const t = (it.box.max.z - ray.origin.z) / ray.direction.z;
      if (!(t > 0)) continue;
      const q = ray.at(t, new THREE.Vector3());
      const inside = it.feature.polygons.some((poly) => pointInLocalRing([q.x, q.y], poly.outer.map(g.toLocal))
        && !poly.inners.some((r) => pointInLocalRing([q.x, q.y], r.map(g.toLocal))));
      if (inside) out.push({ key: it.feature.key, t, local: q, face: 'roof' });
    }
    return out;
  }

  /** Контуры объекта сцены режима здания в метрах (для работы с рёбрами). */
  indoorEditPolygons?: (key: string) => { outer: Pt[]; inners: Pt[][] }[] | undefined;
  indoorMovePreview?: (keys: string[], offset: THREE.Vector3 | undefined) => boolean;

  focusPolygons(key: string): { outer: Pt[]; inners: Pt[][] }[] | undefined {
    const g = this.groups.get(FOCUS_GROUP);
    const it = g?.byKey.get(key);
    if (!g || !it) return this.indoorEditPolygons?.(key);
    return it.feature.polygons.map((p) => ({ outer: p.outer.map(g.toLocal), inners: p.inners.map((r) => r.map(g.toLocal)) }));
  }

  /** Габариты объекта в сцене режима здания (метры). */
  /** Габариты всего здания режима здания (метры сцены). */
  focusBox(): THREE.Box3 | undefined {
    const g = this.groups.get(FOCUS_GROUP);
    const box = g && groupBox(g);
    return box && !box.isEmpty() ? box : undefined;
  }

  focusItemBox(key: string): THREE.Box3 | undefined {
    return this.groups.get(FOCUS_GROUP)?.byKey.get(key)?.box;
  }

  /** Сменить плоские следы сцены режима здания (контур получил или потерял building:part); вернёт, чьи сменились — их перестроить. */
  setFocusFlat(flat: Iterable<string>): string[] {
    const g = this.groups.get(FOCUS_GROUP);
    if (!g) return [];
    const next = new Set(flat);
    const changed = [...new Set([...g.flat, ...next])].filter((k) => g.flat.has(k) !== next.has(k));
    g.flat.clear();
    for (const k of next) g.flat.add(k);
    return changed;
  }

  /** Плоский след в сцене режима здания (контур под частями): высоты у него нет. */
  focusFlat(key: string): boolean {
    const g = this.groups.get(FOCUS_GROUP);
    const it = g?.byKey.get(key);
    return !!g && !!it && strokeOnly(g, it);
  }

  /** Временно перестроить объект сцены режима здания по другим тегам (превью инструмента «Вытянуть»). */
  previewFocusFeature(f: Feature3D) {
    const g = this.groups.get(FOCUS_GROUP);
    if (!g?.byKey.has(f.key)) return;
    this.replaceItems(g, [f]);
    this.snaps = undefined;
    this.updateHiddenEdges();
  }

  /**
   * Верхние точки сгенерированной крыши объекта (конёк, вершина пирамиды или купола, верхнее ребро односкатной),
   * метры сцены режима здания; у крыши нулевой высоты непустой формы — те же места на уровне верха стен.
   * Пусто — крыша плоская.
   */
  focusRoofTop(key: string): THREE.Vector3[] {
    const g = this.groups.get(FOCUS_GROUP);
    const it = g?.byKey.get(key);
    if (!g || !it || it.box.isEmpty()) return [];
    let pos: ArrayLike<number> = it.positions;
    let from = it.wallVertices * 3;
    const wallTop = Math.min(computeHeights(it.tags).wallTop, it.box.max.z);
    let top = -Infinity;
    for (let i = from; i < pos.length; i += 3) top = Math.max(top, pos[i + 2]);
    // Крыша нулевой высоты непустой формы: где был бы конёк — по пробной крыше высотой 1 м (в сцену не идёт),
    // точки — на уровне верха стен: за них конёк вытягивают обратно
    let flatten = false;
    if (!(top > wallTop + 0.05)) {
      const prep = prepItem(g, it.feature);
      if (prep.heights.roofShape === 'flat') return [];
      pos = buildTriangles(prep.polys, { ...prep.heights, top: prep.heights.wallTop + 1, roofHeight: 1 }, prep.tags).roof;
      from = 0;
      top = -Infinity;
      for (let i = 0; i < pos.length; i += 3) top = Math.max(top, pos[i + 2]);
      if (!(top > prep.heights.wallTop + 0.05)) return [];
      flatten = true;
    }
    const out: THREE.Vector3[] = [];
    for (let i = from; i < pos.length; i += 3) {
      if (pos[i + 2] < top - 0.05) continue;
      const p = new THREE.Vector3(pos[i], pos[i + 1], flatten ? wallTop : pos[i + 2]);
      if (!out.some((q) => q.distanceToSquared(p) < 0.01)) out.push(p);
    }
    return out;
  }

  /**
   * Профиль над стеной a–b объекта (метры сцены): точки его геометрии выше верха стен, лежащие в вертикальной плоскости
   * стены (фронтон двускатной крыши, высокая сторона односкатной), — верхняя огибающая, от b к a. Пусто — над стеной
   * ничего нет (вальма уходит от стены).
   */
  focusWallProfile(key: string, a: Pt, b: Pt, wallTop: number): THREE.Vector3[] {
    const it = this.groups.get(FOCUS_GROUP)?.byKey.get(key);
    const ex = b[0] - a[0], ey = b[1] - a[1], len = Math.hypot(ex, ey);
    if (!it || len < 1e-6) return [];
    const pos = it.positions;
    const pts: { s: number; z: number }[] = [];
    for (let i = 0; i < pos.length; i += 3) {
      const z = pos[i + 2];
      if (z <= wallTop + 0.05) continue;
      const dx = pos[i] - a[0], dy = pos[i + 1] - a[1];
      const s = (dx * ex + dy * ey) / (len * len);
      if (Math.abs(dx * ey - dy * ex) / len < 0.05 && s > -1e-3 && s < 1 + 1e-3) pts.push({ s, z });
    }
    // Верхняя огибающая (монотонная цепь): внутренние точки треугольников фронтона не нужны
    pts.sort((p, q) => p.s - q.s || p.z - q.z);
    const hull: { s: number; z: number }[] = [];
    for (const p of pts) {
      const last = hull[hull.length - 1];
      if (last && Math.abs(last.s - p.s) < 1e-6 && Math.abs(last.z - p.z) < 1e-6) continue; // та же точка соседних треугольников
      while (hull.length >= 2) {
        const o = hull[hull.length - 2], q = hull[hull.length - 1];
        if ((q.s - o.s) * (p.z - o.z) - (q.z - o.z) * (p.s - o.s) >= 0) hull.pop(); else break;
      }
      hull.push(p);
    }
    return hull.reverse().map(({ s, z }) => new THREE.Vector3(a[0] + s * ex, a[1] + s * ey, z));
  }

  /** Точки привязки объекта сцены режима здания (вершины, середины, центры) по текущей геометрии. */
  focusSnapPoints(key: string): NonNullable<SnapOpts['extra']> {
    const g = this.groups.get(FOCUS_GROUP);
    if (!g) return [];
    this.snaps ??= collectSnaps(g);
    return this.snaps.points.filter((s) => s.key === key).map((s) => ({ kind: s.kind, key: s.key, p: s.p.clone(), label: s.label }));
  }

  /** Метры сцены режима → координаты. */
  /**
   * Стена или колонна плана этажа под курсором: луч против их вертикальных граней (от пола до среза) и крышек
   * сечения. t — расстояние вдоль луча (сравнить с полом помещения: что ближе, то и выбрано).
   */
  pickIndoorSolid(point: [number, number], rooms = false): { key: string; t: number; side?: { polygon: number; ring: number; edge: number } } | undefined {
    const g = this.groups.get(FOCUS_GROUP), lv = this.level;
    const ray = this.focusRay(point);
    if (!g || !lv || !ray) return;
    const top = this.levelCut ?? lv.cut;
    let best: { key: string; t: number; side?: { polygon: number; ring: number; edge: number } } | undefined;
    const take = (key: string, t: number, side?: { polygon: number; ring: number; edge: number }) => {
      if (t > 0 && (!best || t < best.t - 1e-4 || (Math.abs(t - best.t) < 1e-4 && !side))) best = { key, t, side };
    };
    const o = ray.origin, d = ray.direction;
    // Производную сторону можно выбрать только там, где действительно нарисована стена:
    // без наружного периметра, дверных проёмов и участков, отсечённых оболочкой крыши.
    let wallT = Infinity;
    if (rooms) {
      const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), hit = new THREE.Vector3();
      for (let i = 0; i < this.indoorWallPositions.length; i += 9) {
        a.fromArray(this.indoorWallPositions, i); b.fromArray(this.indoorWallPositions, i + 3); c.fromArray(this.indoorWallPositions, i + 6);
        if (ray.intersectTriangle(a, b, c, false, hit)) wallT = Math.min(wallT, hit.distanceTo(o));
      }
    }
    for (const it of lv.items) {
      if (it.kind !== 'wall' && it.kind !== 'column' && !(rooms && it.kind === 'room')) continue;
      for (const [polygon, p] of it.polygons.entries()) {
        for (const [ringIndex, ring] of (it.line ? [p.outer] : [p.outer, ...p.inners]).entries()) {
          const rp = ring.map(g.toLocal);
          const n = it.line ? rp.length - 1 : rp.length;
          for (let i = 0; i < n; i++) {
            const [ax, ay] = rp[i], [bx, by] = rp[(i + 1) % rp.length];
            // Вертикальная плоскость стены: нормаль (ny, -nx) к отрезку; толщины у стены нет — допуск по краям
            const ex = bx - ax, ey = by - ay, len = Math.hypot(ex, ey);
            if (len < 1e-6) continue;
            const nx = ey / len, ny = -ex / len;
            const den = d.x * nx + d.y * ny;
            if (Math.abs(den) < 1e-9) continue;
            const t = ((ax - o.x) * nx + (ay - o.y) * ny) / den;
            const hx = o.x + d.x * t, hy = o.y + d.y * t, hz = o.z + d.z * t;
            const u = ((hx - ax) * ex + (hy - ay) * ey) / (len * len);
            if (u < -0.02 || u > 1.02 || hz < it.z - 0.01 || hz > top + 0.01) continue;
            if (it.kind === 'room' && Math.abs(t - wallT) > 0.02) continue;
            take(it.key, t, it.kind === 'room' ? { polygon, ring: ringIndex, edge: i } : undefined);
          }
        }
        // Крышка сечения колонны и стены-полигона
        const capOuter = it.line ? closedWallCap(p.outer.map(g.toLocal)) : p.outer.map(g.toLocal);
        if (it.kind !== 'room' && capOuter && Math.abs(d.z) > 1e-9) {
          const t = (top - o.z) / d.z;
          const q: Pt = [o.x + d.x * t, o.y + d.y * t];
          if (pointInLocalRing(q, capOuter) && (it.line || !p.inners.some((h) => pointInLocalRing(q, h.map(g.toLocal))))) take(it.key, t);
        }
      }
    }
    return best;
  }

  focusToLngLat(x: number, y: number): LonLat | undefined {
    const g = this.groups.get(FOCUS_GROUP);
    if (!g) return;
    const ll = new MercatorCoordinate(g.origin.x + x * g.metersToMerc, g.origin.y - y * g.metersToMerc, 0).toLngLat();
    return [ll.lng, ll.lat];
  }

  /** Координаты → метры сцены режима. */
  focusToLocal(p: LonLat): Pt | undefined {
    return this.groups.get(FOCUS_GROUP)?.toLocal(p);
  }

  /**
   * Превью перемещения: вершины объектов сдвигаются прямо в слитой геометрии (без пересборки).
   * offset undefined — вернуть на место.
   */
  setMovePreview(keys: string[], offset: THREE.Vector3 | undefined) {
    if (this.indoorMovePreview?.(keys, offset)) return;
    const doors = keys.filter(key => this.doors.some(d => d.key === key));
    const wasMoving = doors.some(key => this.doorMoveOffsets.has(key));
    for (const key of doors) {
      if (offset) this.doorMoveOffsets.set(key, offset.clone());
      else this.doorMoveOffsets.delete(key);
    }
    if (doors.length) {
      // При движении меняем только трансформации моделей. Пересборка этажа,
      // CSG проёмов и рёбра нужны после записи геометрии, а не на каждом mousemove.
      for (const child of this.doorObj?.children ?? []) {
        if (!doors.includes(child.userData.doorKey) || !child.userData.doorBasePosition) continue;
        child.position.copy(child.userData.doorBasePosition).add(offset ?? new THREE.Vector3());
      }
      if (!wasMoving || !offset) this.applyIndoorSelection();
      for (const child of this.indoorSelObj?.children ?? []) {
        if (doors.includes(child.userData.doorKey)) child.position.copy(offset ?? new THREE.Vector3());
      }
      this.map?.triggerRepaint();
    }
    const buildings = keys.filter(key => !doors.includes(key));
    if (!buildings.length) return;
    this.setTransformPreview(buildings, offset && new THREE.Matrix4().makeTranslation(offset.x, offset.y, offset.z));
  }

  /** Предпросмотр поворота keys на angle (радианы, против часовой) вокруг вертикали через pivot; undefined — сбросить. */
  setRotatePreview(keys: string[], pivot: THREE.Vector3 | undefined, angle: number) {
    this.setTransformPreview(keys, pivot && new THREE.Matrix4().makeTranslation(pivot.x, pivot.y, 0)
      .multiply(new THREE.Matrix4().makeRotationZ(angle)).multiply(new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, 0)));
  }

  /** Предпросмотр произвольного преобразования m (масштаб); undefined — сбросить. */
  setMatrixPreview(keys: string[], m: THREE.Matrix4 | undefined) {
    this.setTransformPreview(keys, m);
  }

  /** Предпросмотр преобразования m у объектов keys (перемещение, поворот); undefined — вернуть как было. */
  private setTransformPreview(keys: string[], m: THREE.Matrix4 | undefined) {
    const g = this.groups.get(FOCUS_GROUP);
    const attr = g?.mesh?.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!g || !attr) return;
    const pos = attr.array as Float32Array;
    const e = (m ?? new THREE.Matrix4()).elements;
    const tx = (b: Float32Array, i: number, out: Float32Array, o: number) => {
      const x = b[i], y = b[i + 1], z = b[i + 2];
      out[o] = e[0] * x + e[4] * y + e[8] * z + e[12];
      out[o + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
      out[o + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
    };
    for (const k of keys) {
      const it = g.byKey.get(k);
      if (!it || g.hidden.has(k)) continue;
      const base = it.positions, o = it.start * 3;
      for (let i = 0; i < base.length; i += 3) tx(base, i, pos, o + i);
      // Стекло — в своём буфере, в общем его диапазоны нулевые
      const gattr = g.glass?.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
      let go = it.glassStart * 3;
      for (const [a, b] of glassRanges(it)) pos.fill(0, o + a * 3, o + b * 3);
      if (gattr && it.glassStart >= 0) {
        const gp = gattr.array as Float32Array;
        for (const src of glassParts(it)) for (let i = 0; i < src.length; i += 3, go += 3) tx(src, i, gp, go);
        gattr.needsUpdate = true;
      }
    }
    attr.needsUpdate = true;
    // Рёбра преобразуемых — отдельным объектом с той же матрицей; остальные остаются на месте
    if (m && !this.movingEdges && this.graphics.edges && g.mesh) {
      this.applyEdges(g, new Set(keys));
      this.movingEdges = edgeLines(keys.filter((k) => !g.hidden.has(k)).map((k) => g.byKey.get(k)).filter((it): it is Item => !!it), EDGE_MATERIAL);
      g.scene.add(this.movingEdges);
    } else if (!m && this.movingEdges) {
      this.movingEdges.parent?.remove(this.movingEdges);
      this.movingEdges.geometry.dispose();
      this.movingEdges = undefined;
      this.applyEdges(g);
    }
    for (const obj of [this.movingEdges, ...(this.selEdges.get(g) ?? [])]) {
      if (!obj) continue;
      obj.matrixAutoUpdate = false;
      obj.matrix.copy(m ?? new THREE.Matrix4());
      obj.matrixWorldNeedsUpdate = true;
    }
    this.map?.triggerRepaint();
  }

  /** Не рисуемые в режиме просмотра объекты (голые контуры отношений) — копятся по мере загрузки тайлов. */
  private readonly viewHidden = new Set<string>();

  hideInView(keys: string[]) {
    for (const k of keys) this.viewHidden.add(k);
  }

  /** После правки тегов объект мог перестать (или начать) быть голым контуром; геометрию пересоберёт updateFeature. */
  setViewHidden(key: string, hidden: boolean) {
    if (hidden) this.viewHidden.add(key); else this.viewHidden.delete(key);
    for (const [k, g] of this.groups) {
      if (k === FOCUS_GROUP || !g.byKey.has(key)) continue;
      if (hidden) g.hidden.add(key); else g.hidden.delete(key);
    }
  }

  /** Скрыть объекты режима здания (глазик в списке частей) — только показ, на данные не влияет. */
  setFocusHidden(keys: Iterable<string>) {
    const g = this.groups.get(FOCUS_GROUP);
    if (!g) return;
    g.hidden.clear();
    for (const k of keys) g.hidden.add(k);
    this.snaps = undefined;
    // Соприкасающиеся грани — без скрытых: части, у которых контакты поменялись, пересобираем
    if (g.contacts) {
      g.contacts = buildContacts(g, g.items.map((it) => it.feature));
      for (let i = 0; i < g.items.length; i++) {
        const it = g.items[i];
        if (contactKeys(g, it.feature) === it.contacts) continue;
        const item = buildItem(g, it.feature);
        if (it.edges) item.edges = itemEdges(item);
        g.items[i] = item;
        g.byKey.set(item.feature.key, item);
      }
    }
    this.rebuildGeometry(g);
    this.updateHiddenEdges();
    this.map?.triggerRepaint();
  }

  private hovered?: string;

  /** Подсветка объема при наведении (как выделение). */
  setHover(key: string | undefined) {
    if (key === this.hovered) return;
    const prev = this.hovered;
    this.hovered = key;
    for (const g of this.activeGroups()) {
      for (const k of [prev, key]) {
        const it = k ? g.byKey.get(k) : undefined;
        if (it) this.paintItem(g, it);
      }
      if (g.strokes || [prev, key].some((k) => k && g.byKey.has(k))) this.applyStrokes(g);
    }
    this.updateHiddenEdges();
    this.map?.triggerRepaint();
  }

  /** Рёбра выделенного по группам: пунктир закрытых другими объектами и (в режиме контуров) синие видимые. */
  private selEdges = new Map<MeshGroup, (THREE.LineSegments | LineSegments2 | THREE.Mesh)[]>();
  private movingEdges?: THREE.LineSegments;

  private updateHiddenEdges() {
    for (const g of [...this.selEdges.keys()]) if (![...this.groups.values()].includes(g)) this.selEdges.delete(g);
    for (const g of this.groups.values()) this.updateSelEdges(g);
  }

  /**
   * Рёбра выделенного в группе. Скрытые — пунктиром: в режиме здания всегда (у выделенного, в режиме контуров —
   * и у наведённого), на карте — только в режиме контуров (там выделение видно по заливке, а пунктир на сложных
   * зданиях дорог). Видимые рёбра выделенного — синие, в режиме контуров.
   */
  private updateSelEdges(g: MeshGroup) {
    for (const o of this.selEdges.get(g) ?? []) {
      o.parent?.remove(o);
      o.geometry.dispose();
      if (o instanceof LineSegments2) o.material.dispose();
    }
    this.selEdges.delete(g);
    const inFocus = g === this.groups.get(FOCUS_GROUP);
    if (inFocus !== this.focused) return;
    const pick = (keys: Iterable<string>) => [...new Set(keys)].filter((k) => !g.hidden.has(k)).map((k) => g.byKey.get(k))
      .filter((it): it is Item => !!it && !strokeOnly(g, it));
    const selected = pick(this.selected);
    const dashed = inFocus && this.wireframe ? pick([...this.selected, ...(this.hovered ? [this.hovered] : [])]) : selected;
    const out: (THREE.LineSegments | LineSegments2 | THREE.Mesh)[] = [];
    if ((this.wireframe || inFocus) && dashed.length) {
      const hidden = edgeLines(dashed, inFocus ? HIDDEN_EDGE_MATERIAL : MAP_HIDDEN_EDGE_MATERIAL);
      hidden.computeLineDistances();
      hidden.renderOrder = 999; // после зданий: глубина уже записана
      out.push(hidden);
    }
    // Видимые рёбра выделенного — толстой синей обводкой: в режиме контуров и в обычном режиме здания
    if ((this.wireframe || inFocus) && selected.length && this.map) {
      // Толстые линии (полосы из треугольников) — их можно сдвинуть к камере: поверх серых рёбер на том же месте,
      // но за гранями, которые их закрывают
      const canvas = this.map.getCanvas();
      const dpr = canvas.width / Math.max(1, canvas.clientWidth);
      const geo = new LineSegmentsGeometry();
      geo.setPositions(edgeLines(selected, EDGE_MATERIAL).geometry.getAttribute('position').array as Float32Array);
      const mat = new LineMaterial({ color: SELECTED_EDGE_COLOUR, linewidth: (this.wireframe ? SELECTED_EDGE_WIDTH_PX : SELECTED_EDGE_WIDTH_SOLID_PX) * dpr, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8 });
      mat.clippingPlanes = MATERIAL.clippingPlanes;
      mat.resolution.set(canvas.width, canvas.height);
      const lines = new LineSegments2(geo, mat);
      lines.frustumCulled = false;
      lines.renderOrder = 998; // после серых рёбер
      out.push(lines);
    }
    // Заливка выделенного — только в режиме контуров (в обычном у граней своя)
    if (this.wireframe && selected.length) {
      const fill = new THREE.BufferGeometry();
      const pos = new Float32Array(selected.reduce((n, it) => n + it.positions.length, 0));
      let o = 0;
      for (const it of selected) { pos.set(it.positions, o); o += it.positions.length; }
      fill.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      SELECTED_FILL_MATERIAL.clippingPlanes = MATERIAL.clippingPlanes;
      const mesh = new THREE.Mesh(fill, SELECTED_FILL_MATERIAL);
      mesh.frustumCulled = false;
      mesh.renderOrder = 997;
      out.push(mesh);
    }
    if (!out.length) return;
    for (const o of out) g.scene.add(o);
    this.selEdges.set(g, out);
  }

  private snapLine?: THREE.Line;
  private underground?: THREE.LineSegments;
  private undergroundSpec?: { rings: LonLat[][]; depth: number };
  /** Отрезки пунктира подземной части (локальные метры здания режима) — для выбора кликом. */
  private undergroundSegs: [THREE.Vector3, THREE.Vector3][] = [];
  private undergroundSelected = false;

  /**
   * Контур подземной части здания в режиме здания: пунктир — кольца на глубине depth (м, < 0) и на земле,
   * вертикали в заметных углах. Виден только не закрытый зданием участок;
   * выбранный — синий и целиком, сквозь здание. undefined — убрать.
   */
  setUnderground(spec: { rings: LonLat[][]; depth: number } | undefined) {
    const same = (a?: typeof spec, b?: typeof spec) => a === b || (!!a && !!b && a.depth === b.depth && JSON.stringify(a.rings) === JSON.stringify(b.rings));
    if (same(spec, this.undergroundSpec)) return;
    this.undergroundSpec = spec;
    if (!spec) this.undergroundSelected = false;
    if (this.underground) {
      this.underground.parent?.remove(this.underground);
      this.underground.geometry.dispose();
      this.underground = undefined;
    }
    this.undergroundSegs = [];
    this.attachUnderground();
    this.map?.triggerRepaint();
  }

  /** Выделить контур подземной части (подсветка сквозь здание). */
  selectUnderground(on: boolean) {
    if (this.undergroundSelected === on) return;
    this.undergroundSelected = on;
    if (this.underground) this.underground.material = on ? UNDERGROUND_SELECTED : UNDERGROUND_MATERIAL;
    this.map?.triggerRepaint();
  }

  /**
   * Клик по контуру подземной части: ближе UNDERGROUND_PICK_PX к видимому участку пунктира (не за гранью здания).
   */
  pickUnderground(point: PointLike): boolean {
    const g = this.groups.get(FOCUS_GROUP);
    if (!g || !this.underground || !this.map) return false;
    const [px, py] = Array.isArray(point) ? point : [point.x, point.y];
    const canvas = this.map.getCanvas();
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const m = g.camera.projectionMatrix;
    const scr = (v: THREE.Vector3) => { const q = v.clone().applyMatrix4(m); return [(q.x + 1) / 2 * w, (1 - q.y) / 2 * h, q.z] as const; };
    let best: { d: number; z: number } | undefined;
    for (const [a, b] of this.undergroundSegs) {
      const [ax, ay, az] = scr(a), [bx, by, bz] = scr(b);
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
      const d = Math.hypot(ax + t * dx - px, ay + t * dy - py);
      if (d <= UNDERGROUND_PICK_PX && (!best || d < best.d)) best = { d, z: az + t * (bz - az) };
    }
    if (!best) return false;
    // Здание перед пунктиром — клик по зданию
    const hit = this.pickHitImpl(point);
    if (!hit) return true;
    // Плоский след (контур под частями, голый контур подземного здания) не закрывает: заливки у него не видно
    const hitItem = g.byKey.get(hit.key);
    if (hitItem && (strokeOnly(g, hitItem) || thinItem(hitItem))) return true;
    const [lx, ly] = g.toLocal([hit.lngLat.lng, hit.lngLat.lat]);
    return best.z <= new THREE.Vector3(lx, ly, hit.altitude).applyMatrix4(m).z + 1e-4;
  }

  /** Пунктир подземной части — в сцену здания режима (её группа пересоздаётся). */
  private attachUnderground() {
    const g = this.groups.get(FOCUS_GROUP), spec = this.undergroundSpec;
    if (!g || !spec) return;
    if (!this.underground) {
      const segs: [THREE.Vector3, THREE.Vector3][] = [];
      for (const ring of spec.rings) {
        const loc = cornersOnly(ring.map(g.toLocal));
        // Углы выпуклой оболочки — всегда с вертикалью (маленький выступ, угол здания); прореживаются только зубцы внутри
        const hull = hullIndices(loc);
        let last: Pt | undefined;
        for (let i = 0; i < loc.length; i++) {
          const [x0, y0] = loc[i], [x1, y1] = loc[(i + 1) % loc.length];
          // Кольца на глубине и на земле (контур подземного здания на земле сам не обведён)
          for (const z of [spec.depth, 0]) segs.push([new THREE.Vector3(x0, y0, z), new THREE.Vector3(x1, y1, z)]);
          // Вертикали — только в заметных углах и не теснее UNDERGROUND_POST_GAP_M (зубцы контура — без частокола)
          if (turnAt(loc, i) < UNDERGROUND_POST_TURN || (!hull.has(i) && last && Math.hypot(x0 - last[0], y0 - last[1]) < UNDERGROUND_POST_GAP_M)) continue;
          segs.push([new THREE.Vector3(x0, y0, spec.depth), new THREE.Vector3(x0, y0, 0)]);
          last = loc[i];
        }
      }
      this.undergroundSegs = segs;
      this.underground = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(segs.flat()), this.undergroundSelected ? UNDERGROUND_SELECTED : UNDERGROUND_MATERIAL);
      this.underground.computeLineDistances();
      this.underground.frustumCulled = false;
      this.underground.renderOrder = 998;
      this.underground.raycast = () => {};
    }
    if (this.underground.parent !== g.scene) g.scene.add(this.underground);
  }

  /** Пунктир продолжения ребра: от конца ребра до точки привязки. undefined — убрать. */
  setSnapLine(line: [THREE.Vector3, THREE.Vector3] | undefined) {
    if (this.snapLine) {
      this.snapLine.parent?.remove(this.snapLine);
      this.snapLine.geometry.dispose();
      (this.snapLine.material as THREE.Material).dispose();
      this.snapLine = undefined;
    }
    const g = this.groups.get(FOCUS_GROUP);
    if (line && g) {
      this.snapLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints(line),
        new THREE.LineDashedMaterial({ color: 0x7c3aed, dashSize: 0.4, gapSize: 0.25, depthTest: false, depthWrite: false, transparent: true }));
      this.snapLine.computeLineDistances();
      this.snapLine.renderOrder = 1000;
      g.scene.add(this.snapLine);
    }
    this.map?.triggerRepaint();
  }

  private moveGuide?: THREE.Object3D;

  /**
   * Направляющие инструмента перемещения: значок осей в точке захвата и линия до текущей точки
   * (цветом оси, если движение по оси). undefined — убрать.
   */
  /** Значок осей в точке захвата и пунктир к курсору; axes — свои оси вместо осей здания (например, по ребру); free — доступные оси. */
  setMoveGuide(guide: { from: THREE.Vector3; to?: THREE.Vector3; path?: THREE.Vector3[]; axis?: 0 | 1 | 2; locked?: 0 | 1 | 2; axes?: { x: Pt; y: Pt }; dashSize?: number; gapSize?: number; gizmoScale?: number; free?: readonly (0 | 1 | 2)[];
    /** Толщина линии, px (по умолчанию — тонкая линия WebGL). */
    widthPx?: number } | undefined) {
    const g = this.groups.get(FOCUS_GROUP);
    if (this.moveGuide) {
      this.moveGuide.parent?.remove(this.moveGuide);
      this.moveGuide.traverse((o) => { if (o instanceof THREE.Mesh || o instanceof THREE.Line) { o.geometry.dispose(); (o.material as THREE.Material).dispose(); } });
      this.moveGuide = undefined;
    }
    if (guide && g && this.focusAxes) {
      const root = new THREE.Group();
      const frame = { ...this.focusAxes, ...(guide.axes ?? {}), origin: [guide.from.x, guide.from.y] as Pt };
      // Значок на высоте точки захвата; gizmoScale — доля обычного размера (у вершины — меньше), но не мельче половины
      const gizmo = axesGizmo(frame, { px: TOOL_AXES_PX * Math.max(guide.gizmoScale ?? 1, 0.5), z: guide.from.z, locked: guide.locked, free: guide.free });
      root.add(this.trackGizmo(gizmo));
      if (guide.to && guide.widthPx && this.map) {
        // Толстая пунктирная линия (Line2): тонкую на светлой крыше почти не видно
        const canvas = this.map.getCanvas();
        const dpr = canvas.width / Math.max(1, canvas.clientWidth);
        const geo = new LineGeometry();
        geo.setPositions([guide.from, ...(guide.path ?? []), guide.to].flatMap((p) => [p.x, p.y, p.z]));
        const mat = new LineMaterial({ color: guide.axis === undefined ? 0x1d4ed8 : AXIS_COLOURS[guide.axis], linewidth: guide.widthPx * dpr,
          dashed: true, dashSize: guide.dashSize ?? 0.5, gapSize: guide.gapSize ?? 0.3, depthTest: false, depthWrite: false, transparent: true });
        mat.resolution.set(canvas.width, canvas.height);
        const line = new Line2(geo, mat);
        line.computeLineDistances();
        line.renderOrder = 1002;
        line.frustumCulled = false;
        root.add(line);
      } else if (guide.to) {
        const line = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([guide.from, ...(guide.path ?? []), guide.to]),
          new THREE.LineDashedMaterial({ color: guide.axis === undefined ? 0x333333 : AXIS_COLOURS[guide.axis], dashSize: guide.dashSize ?? 0.5, gapSize: guide.gapSize ?? 0.3,
            depthTest: false, depthWrite: false, transparent: true }),
        );
        line.computeLineDistances();
        line.renderOrder = 1002;
        root.add(line);
      }
      g.scene.add(root);
      this.moveGuide = root;
    }
    this.map?.triggerRepaint();
  }

  private drawPreview?: THREE.Group;
  /** Сцена накладок инструментов (метры сцены режима здания): рисуется после всего, в том числе подложек. */
  private readonly toolOverlay = new THREE.Scene();
  private readonly toolCamera = new THREE.Camera();
  private protractor?: THREE.LineSegments;
  private rotateAxes?: THREE.Group;

  /**
   * Стрелки осей у центра поворота (оси растра у «Повернуть»): dirs — x, y, z (единичные), len — длина, м;
   * active — подсвеченная ось (курсор идёт вдоль неё), locked — зафиксированная. undefined — убрать.
   */
  setRotateAxes(p: { from: THREE.Vector3; dirs: THREE.Vector3[]; len: number; active?: number; locked?: number } | undefined) {
    if (this.rotateAxes) {
      this.rotateAxes.parent?.remove(this.rotateAxes);
      this.rotateAxes.traverse((o) => { if (o instanceof THREE.Line || o instanceof THREE.Mesh) { o.geometry.dispose(); (o.material as THREE.Material).dispose(); } });
      this.rotateAxes = undefined;
    }
    const g = this.groups.get(FOCUS_GROUP);
    if (p && g) {
      const root = new THREE.Group();
      p.dirs.forEach((d, i) => {
        const on = p.locked === i || (p.locked === undefined && p.active === i);
        const dim = !on && (p.locked !== undefined || p.active !== undefined);
        const end = p.from.clone().addScaledVector(d, p.len * (on ? 1.25 : 1));
        // Наконечник — две короткие черты к концу стрелки
        const side = new THREE.Vector3().crossVectors(d, Math.abs(d.z) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1)).normalize();
        const back = end.clone().addScaledVector(d, -p.len * 0.18);
        const pts = [p.from, end, end, back.clone().addScaledVector(side, p.len * 0.08), end, back.clone().addScaledVector(side, -p.len * 0.08)];
        // Толстые линии (как оси у «Переместить»): тонкие теряются на картинке подложки
        const geo = new LineSegmentsGeometry();
        geo.setPositions(pts.flatMap((q) => [q.x, q.y, q.z]));
        const canvas = this.map?.getCanvas();
        const dpr = canvas ? canvas.width / Math.max(1, canvas.clientWidth) : 1;
        const mat = new LineMaterial({ color: AXIS_COLOURS[i], linewidth: (on ? 4 : 2.5) * dpr, depthTest: false, depthWrite: false, transparent: true, opacity: dim ? 0.45 : 1 });
        if (canvas) mat.resolution.set(canvas.width, canvas.height);
        const line = new LineSegments2(geo, mat);
        line.frustumCulled = false;
        line.renderOrder = 1004;
        root.add(line);
        // Подсвеченная или зафиксированная ось — продолжение в обе стороны пунктиром
        if (on) {
          const guide = new THREE.Line(new THREE.BufferGeometry().setFromPoints([p.from.clone().addScaledVector(d, -p.len * 20), p.from.clone().addScaledVector(d, p.len * 20)]),
            new THREE.LineDashedMaterial({ color: AXIS_COLOURS[i], dashSize: p.len * 0.15, gapSize: p.len * 0.1, depthTest: false, depthWrite: false, transparent: true, opacity: 0.8 }));
          guide.computeLineDistances();
          guide.renderOrder = 1003;
          root.add(guide);
        }
      });
      this.toolOverlay.add(root);
      this.rotateAxes = root;
    }
    this.map?.triggerRepaint();
  }

  /**
   * Транспортир «Повернуть» (как в SketchUp): круг с делениями через 15° в плоскости поворота (u, v — её оси, r — радиус,
   * м). Цвет — ось здания (x, y, z), axis undefined — произвольная ось (по грани). undefined — убрать.
   */
  setProtractor(p: { center: THREE.Vector3; u: THREE.Vector3; v: THREE.Vector3; r: number; axis?: 0 | 1 | 2 } | undefined) {
    if (this.protractor) {
      this.protractor.parent?.remove(this.protractor);
      this.protractor.geometry.dispose();
      (this.protractor.material as THREE.Material).dispose();
      this.protractor = undefined;
    }
    const g = this.groups.get(FOCUS_GROUP);
    if (p && g) {
      const at = (a: number, r: number) => p.center.clone().addScaledVector(p.u, Math.cos(a) * r).addScaledVector(p.v, Math.sin(a) * r);
      const pts: THREE.Vector3[] = [];
      const N = 72;
      for (let i = 0; i < N; i++) pts.push(at((i / N) * 2 * Math.PI, p.r), at(((i + 1) / N) * 2 * Math.PI, p.r));
      for (let i = 0; i < 24; i++) { const a = (i / 24) * 2 * Math.PI; pts.push(at(a, p.r * (i % 6 ? 0.88 : 0.75)), at(a, p.r)); }
      const line = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: p.axis === undefined ? 0x333333 : AXIS_COLOURS[p.axis], depthTest: false, depthWrite: false, transparent: true }));
      line.renderOrder = 1003;
      this.toolOverlay.add(line);
      this.protractor = line;
    }
    this.map?.triggerRepaint();
  }
  /** Начало сцены, размер земли и оси режима здания — с момента входа до выхода. */
  private focusLock?: { center: [number, number]; size: number; axes?: LocalFrame };

  /**
   * Контур в процессе рисования (метры сцены режима здания): сплошные стороны, пунктиром — замыкающая
   * (если closed) и полупрозрачная заливка, когда точек ≥ 3. Поверх геометрии.
   */
  private outline: Line2[] = [];
  private outlineFill?: THREE.Mesh;
  /**
   * Жирная обводка замкнутых контуров поверх всего — например, грань, от которой пойдёт отступ (с дворами);
   * widthPx 0 — без обводки; fill — полупрозрачная заливка грани (кольца в одной плоскости; кольцо внутри другого — дыра).
   */
  setOutline(rings: THREE.Vector3[][] | undefined, widthPx = 3, fill = false) {
    const g = this.groups.get(FOCUS_GROUP);
    for (const l of this.outline) { l.parent?.remove(l); l.geometry.dispose(); l.material.dispose(); }
    this.outline = [];
    if (this.outlineFill) {
      this.outlineFill.parent?.remove(this.outlineFill);
      this.outlineFill.geometry.dispose();
      (this.outlineFill.material as THREE.Material).dispose();
      this.outlineFill = undefined;
    }
    if (rings && g && fill) {
      const geo = planarFill(rings);
      if (geo) {
        const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x1d4ed8, transparent: true, opacity: 0.22,
          depthTest: false, depthWrite: false, side: THREE.DoubleSide }));
        mesh.renderOrder = 1003;
        mesh.frustumCulled = false;
        g.scene.add(mesh);
        this.outlineFill = mesh;
      }
    }
    if (rings && g && this.map && widthPx > 0) {
      const canvas = this.map.getCanvas();
      const dpr = canvas.width / Math.max(1, canvas.clientWidth);
      for (const points of rings) {
        if (points.length < 2) continue;
        const geo = new LineGeometry();
        geo.setPositions([...points, points[0]].flatMap((p) => [p.x, p.y, p.z]));
        const mat = new LineMaterial({ color: 0x2563eb, linewidth: widthPx * dpr, depthTest: false, depthWrite: false, transparent: true });
        mat.resolution.set(canvas.width, canvas.height);
        const line = new Line2(geo, mat);
        line.renderOrder = 1004;
        line.frustumCulled = false;
        g.scene.add(line);
        this.outline.push(line);
      }
    }
    this.map?.triggerRepaint();
  }

  private handles?: THREE.Group;
  /**
   * Маркеры вершин (инструмент «Форма»): квадраты поверх всей геометрии, active — захваченная или под курсором
   * (крупнее, другим цветом; может быть несколько — выбранные рамкой); roof — ручки крыши, eave — верха стен (своими цветами).
   * Заслонённые геометрией (в том числе стенами самого объекта) — полые и бледные. undefined — убрать.
   */
  setHandles(points: THREE.Vector3[] | undefined, active?: number | number[], roof?: { points: THREE.Vector3[]; active?: number },
    eave?: { points: THREE.Vector3[]; active?: number }) {
    const g = this.groups.get(FOCUS_GROUP);
    if (this.handles) {
      this.handles.parent?.remove(this.handles);
      this.handles.traverse((o) => { if (o instanceof THREE.Points) { o.geometry.dispose(); (o.material as THREE.Material).dispose(); } });
      this.handles = undefined;
    }
    if (points?.length && g && this.map) {
      const canvas = this.map.getCanvas();
      const dpr = canvas.width / Math.max(1, canvas.clientWidth);
      const root = new THREE.Group();
      const layer = (pts: THREE.Vector3[], size: number, color: number, order: number, opacity = 1) => {
        if (!pts.length) return;
        const p = new THREE.Points(new THREE.BufferGeometry().setFromPoints(pts),
          new THREE.PointsMaterial({ color, size: size * dpr, sizeAttenuation: false, depthTest: false, depthWrite: false, transparent: true, opacity }));
        p.renderOrder = order;
        p.frustumCulled = false;
        root.add(p);
      };
      const split = (pts: THREE.Vector3[]) => {
        const open: THREE.Vector3[] = [], hidden: THREE.Vector3[] = [];
        for (const p of pts) {
          const px = this.focusProject(p);
          (px && this.snapHidden(p, px) ? hidden : open).push(p);
        }
        return { open, hidden };
      };
      // Открытые — сплошной квадрат с белой окантовкой; заслонённые — полый (белая середина) и бледный
      const marks = (pts: THREE.Vector3[], size: number, color: number, order: number) => {
        const { open, hidden } = split(pts);
        layer(hidden, size + 3, color, order, 0.6);
        layer(hidden, size - 1, 0xffffff, order + 1, 0.9);
        layer(open, size + 3, 0xffffff, order);
        layer(open, size, color, order + 1);
      };
      marks(points, 6, 0x2563eb, 1005);
      if (roof?.points.length) marks(roof.points, 8, 0x0d9488, 1005);
      if (eave?.points.length) marks(eave.points, 7, 0x7c3aed, 1005);
      const hot = [...(typeof active === 'number' ? [active] : active ?? []).map((i) => points[i]),
        ...(roof?.active !== undefined ? [roof.points[roof.active]] : []),
        ...(eave?.active !== undefined ? [eave.points[eave.active]] : [])].filter(Boolean);
      if (hot.length) marks(hot, 9, 0xf97316, 1007);
      g.scene.add(root);
      this.handles = root;
    }
    this.map?.triggerRepaint();
  }

  /**
   * Набросок контура; open — просто ломаная (без замыкания и заливки: стороны угла поворота). gain — участки, которые
   * добавятся (метры сцены, кольца: внешнее и дыры), — ярче заливки.
   */
  setDrawPreview(points: THREE.Vector3[] | undefined, closed = false, open = false, gain: [number, number][][][] = []) {
    const g = this.groups.get(FOCUS_GROUP);
    if (this.drawPreview) {
      this.drawPreview.parent?.remove(this.drawPreview);
      this.drawPreview.traverse((o) => { if (o instanceof THREE.Mesh || o instanceof THREE.Line) { o.geometry.dispose(); (o.material as THREE.Material).dispose(); } });
      this.drawPreview = undefined;
    }
    if (points && points.length >= 2 && g) {
      const root = new THREE.Group();
      const overlay = { depthTest: false, depthWrite: false, transparent: true };
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color: 0x1d4ed8, ...overlay }));
      line.renderOrder = 1003;
      root.add(line);
      if (points.length >= 3 && !open) {
        const close = new THREE.Line(new THREE.BufferGeometry().setFromPoints([points[points.length - 1], points[0]]),
          closed ? new THREE.LineBasicMaterial({ color: 0x1d4ed8, ...overlay })
            : new THREE.LineDashedMaterial({ color: 0x1d4ed8, dashSize: 0.4, gapSize: 0.3, ...overlay }));
        close.computeLineDistances();
        close.renderOrder = 1003;
        const shape = new THREE.Shape(points.map((p) => new THREE.Vector2(p.x, p.y)));
        const fill = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshBasicMaterial({ color: 0x3b82f6, opacity: 0.25, side: THREE.DoubleSide, ...overlay }));
        fill.position.z = points[0].z;
        fill.renderOrder = 1002;
        root.add(close, fill);
      }
      for (const [outer, ...holes] of gain) {
        const shape = new THREE.Shape(outer.map(([x, y]) => new THREE.Vector2(x, y)));
        shape.holes = holes.map((h) => new THREE.Path(h.map(([x, y]) => new THREE.Vector2(x, y))));
        const fill = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshBasicMaterial({ color: 0xf97316, opacity: 0.75, side: THREE.DoubleSide, ...overlay }));
        fill.position.z = points[0].z;
        fill.renderOrder = 1003;
        const edge = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(outer.map(([x, y]) => new THREE.Vector3(x, y, points[0].z))),
          new THREE.LineBasicMaterial({ color: 0xc2410c, ...overlay }));
        edge.renderOrder = 1004;
        root.add(fill, edge);
      }
      this.toolOverlay.add(root);
      this.drawPreview = root;
    }
    this.map?.triggerRepaint();
  }

  /** Экранная точка indoor-объекта с учётом высоты этажа и наклона камеры. */
  focusScreenPoint(at: LonLat, altitude: number): [number, number] | undefined {
    const g = this.groups.get(FOCUS_GROUP);
    if (!g || !this.map) return;
    const [x, y] = g.toLocal(at);
    const p = new THREE.Vector4(x, y, altitude, 1).applyMatrix4(g.camera.projectionMatrix);
    if (p.w <= 0 || p.z < -p.w || p.z > p.w) return;
    const canvas = this.map.getCanvas();
    return [(p.x / p.w + 1) / 2 * canvas.clientWidth, (1 - p.y / p.w) / 2 * canvas.clientHeight];
  }

  /** Центр здания в режиме одного здания: координаты, высота (середина) и положение на экране. */
  focusCenter(): { lngLat: LngLat; altitude: number; point: [number, number] } | undefined {
    const g = this.groups.get(FOCUS_GROUP);
    if (!this.focused || !g || !this.map) return;
    const box = groupBox(g);
    if (box.isEmpty()) return;
    const p = box.getCenter(new THREE.Vector3());
    const ndc = p.clone().applyMatrix4(g.camera.projectionMatrix);
    const canvas = this.map.getCanvas();
    const point: [number, number] = [(ndc.x + 1) / 2 * canvas.clientWidth, (1 - ndc.y) / 2 * canvas.clientHeight];
    const merc = new MercatorCoordinate(g.origin.x + p.x * g.metersToMerc, g.origin.y - p.y * g.metersToMerc, 0);
    return { lngLat: merc.toLngLat(), altitude: p.z, point };
  }

  /** Заменяет содержимое группы (или создаёт её) — синхронно. */
  setGroup(key: string, features: Feature3D[], center: LonLat): RenderedFeature[] {
    this.pending.delete(key);
    const g = new MeshGroup(center);
    g.contacts = buildContacts(g, features);
    timed(`${this.id}: треугольники (синхронно)`, () => { for (const f of features) if (shouldRender(f)) this.addItem(g, f); }, () => `${key}, ${features.length}`);
    this.install(key, g);
    return g.items.map(rendered);
  }

  /**
   * То же, но здания собираются порциями по кадрам, а группа подменяется целиком в конце —
   * старая остаётся на экране до готовности новой. undefined — сборку отменили.
   */
  async setGroupAsync(key: string, features: Feature3D[], center: LonLat): Promise<RenderedFeature[] | undefined> {
    const token = Symbol(key);
    this.pending.set(key, token);
    const g = new MeshGroup(center);
    const todo = features.filter(shouldRender);
    // Стыки — тоже порциями: тайл у горизонта то входит в кадр, то уходит, и сборку часто отменяют на середине;
    // и начало (остатки контуров) — не в вызывающем кадре: туда же попадают moveend и показ соседних тайлов
    // Бюджет кадра — общий для всех сборок (nextFrameSlot): при зуме собираются сразу несколько тайлов
    await nextFrameSlot();
    if (this.pending.get(key) !== token) return;
    const contacts = timed(`${this.id}: стыки тайла (начало)`, () => contactsBuilder(g, todo));
    for (let done = false; !done;) {
      const deadline = await nextFrameSlot();
      if (this.pending.get(key) !== token) return;
      done = timed(`${this.id}: стыки тайла (порция)`, () => contacts.step(deadline));
    }
    g.contacts = contacts.contacts;
    let i = 0;
    while (i < todo.length) {
      const deadline = await nextFrameSlot();
      if (this.pending.get(key) !== token) return;
      timed(`${this.id}: треугольники (порция)`, () => {
        while (i < todo.length && performance.now() < deadline) this.addItem(g, todo[i++]);
      });
    }
    if (this.pending.get(key) !== token) return;
    this.pending.delete(key);
    this.install(key, g);
    return g.items.map(rendered);
  }

  private install(key: string, g: MeshGroup) {
    this.removeGroup(key);
    if (key !== FOCUS_GROUP) for (const it of g.items) if (this.viewHidden.has(it.feature.key)) g.hidden.add(it.feature.key);
    g.applyLighting(this.graphics);
    timed(`${this.id}: слияние геометрии`, () => this.rebuildGeometry(g), () => `${key}, ${g.items.length} зданий`);
    this.groups.set(key, g);
    this.map?.triggerRepaint();
  }

  /** Пересобирает одно здание группы (после правки тегов). Выделение сохраняется. */
  /** Заменить здания тайла (и сцены режима здания) новыми данными: слитая геометрия пересобирается один раз. */
  updateFeatures(groupKey: string, fs: Feature3D[]): RenderedFeature[] {
    const g = this.groups.get(groupKey);
    const focus = this.groups.get(FOCUS_GROUP);
    const inFocus = focus ? fs.filter((f) => focus.byKey.has(f.key)) : [];
    if (inFocus.length) { this.replaceItems(focus!, inFocus); this.snaps = undefined; this.updateHiddenEdges(); }
    const own = g ? fs.filter((f) => g.byKey.has(f.key)) : [];
    if (!own.length) return [];
    this.replaceItems(g!, own);
    return own.map((f) => rendered(g!.byKey.get(f.key)!));
  }

  /**
   * Точечно поменять здания тайла без пересборки всего тайла: upsert — заменить или добавить, remove — убрать.
   * Слитая геометрия пересобирается один раз (это быстро: треугольники остальных зданий уже посчитаны).
   */
  patchGroup(groupKey: string, upsert: Feature3D[], remove: string[]): RenderedFeature[] {
    const g = this.groups.get(groupKey);
    if (!g) return [];
    for (const k of remove) {
      const it = g.byKey.get(k);
      if (!it) continue;
      g.items.splice(g.items.indexOf(it), 1);
      g.byKey.delete(k);
    }
    this.refreshContacts(g, upsert, new Set([...upsert.map((f) => f.key), ...remove]));
    for (const f of upsert) {
      const old = g.byKey.get(f.key);
      if (!old) { this.addItem(g, f); continue; }
      const item = timed('здание: треугольники', () => buildItem(g, f), () => describeFeature(f));
      if (this.graphics.edges) item.edges = itemEdges(item);
      g.items[g.items.indexOf(old)] = item;
      g.byKey.set(f.key, item);
    }
    if (this.viewHidden.size) for (const it of g.items) if (this.viewHidden.has(it.feature.key)) g.hidden.add(it.feature.key); else g.hidden.delete(it.feature.key);
    this.rebuildGeometry(g);
    this.map?.triggerRepaint();
    return upsert.map((f) => g.byKey.get(f.key)).filter((it): it is Item => !!it).map(rendered);
  }

  /**
   * Пересобирает здания, подходящие под условие (например, когда догрузился straight skeleton).
   * Треугольники считаются порциями по кадрам, геометрия группы пересобирается один раз в конце.
   */
  async rebuildWhere(pred: (f: Feature3D) => boolean, onRebuilt: (r: RenderedFeature) => void = () => {}) {
    for (const [key, g] of [...this.groups]) {
      const todo = g.items.map((it) => it.feature).filter(pred);
      const done: Feature3D[] = [];
      while (done.length < todo.length) {
        const deadline = await nextFrameSlot();
        while (done.length < todo.length && performance.now() < deadline) done.push(todo[done.length]);
        if (this.groups.get(key) !== g) break; // группу убрали или заменили, пока ждали кадр
      }
      if (this.groups.get(key) !== g || !done.length) continue;
      this.replaceItems(g, done, true);
      for (const f of done) onRebuilt(rendered(g.byKey.get(f.key)!));
    }
  }

  /**
   * Пересобирает здания, ждавшие скелет (вызывать, когда воркер досчитал). Слитая геометрия тайла
   * пересобирается, только если хоть одно здание действительно получило крышу.
   */
  rebuildPending(onRebuilt: (r: RenderedFeature) => void = () => {}) {
    for (const g of this.groups.values()) {
      const done: Feature3D[] = [];
      for (let i = 0; i < g.items.length; i++) {
        const old = g.items[i];
        if (!old.pending) continue;
        const item = buildItem(g, old.feature);
        if (item.pending) continue; // скелет ещё считается — геометрия та же
        g.items[i] = item;
        g.byKey.set(item.feature.key, item);
        done.push(item.feature);
      }
      if (!done.length) continue;
      timed(`${this.id}: слияние геометрии (крыши)`, () => this.rebuildGeometry(g), () => `${g.items.length} зданий, новых крыш ${done.length}`);
      for (const f of done) onRebuilt(rendered(g.byKey.get(f.key)!));
    }
    this.map?.triggerRepaint();
  }

  private overlay: { scene: THREE.Scene; obj: THREE.Object3D }[] = [];

  /**
   * Подсветка поверх всего (без проверки глубины): контур объекта и полупрозрачная заливка на уровне его верха.
   * Нужна, чтобы показать объект, закрытый другими (например, плоский контур под частями).
   */
  /** at: 'top' — залитый след по верху; 'base' — только контур на уровне основания. */
  setOverlay(keys: string | string[] | undefined, at: 'top' | 'base' = 'top') {
    for (const { scene, obj } of this.overlay) {
      scene.remove(obj);
      obj.traverse((o) => { if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) { o.geometry.dispose(); (o.material as THREE.Material).dispose(); } });
    }
    this.overlay = [];
    for (const key of keys === undefined ? [] : typeof keys === 'string' ? [keys] : keys) {
      const g = this.activeGroups().find((x) => x.byKey.has(key));
      const it = g?.byKey.get(key);
      if (!g || !it) continue;
      const z = it.box.isEmpty() ? 0 : at === 'base' ? it.box.min.z + 0.05 : it.box.max.z + 0.05;
      const obj = new THREE.Group();
      const lines: number[] = [];
      const fill: number[] = [];
      for (const p of it.feature.polygons) {
        const outer = p.outer.map(g.toLocal), holes = p.inners.map((r) => r.map(g.toLocal));
        for (const ring of [outer, ...holes]) {
          for (let i = 0; i < ring.length; i++) {
            const a = ring[i], b = ring[(i + 1) % ring.length];
            lines.push(a[0], a[1], z, b[0], b[1], z);
          }
        }
        const v2 = (r: Pt[]) => r.map(([x, y]) => new THREE.Vector2(x, y));
        const flat = [...outer, ...holes.flat()];
        for (const t of THREE.ShapeUtils.triangulateShape(v2(outer), holes.map(v2))) for (const i of t) fill.push(flat[i][0], flat[i][1], z);
      }
      const overlayMat = { depthTest: false, depthWrite: false, transparent: true };
      const lineGeo = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
      const fillGeo = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(fill, 3));
      const fillMesh = new THREE.Mesh(fillGeo, new THREE.MeshBasicMaterial({ color: OVERLAY_COLOUR, opacity: 0.55, side: THREE.DoubleSide, ...overlayMat }));
      const lineMesh = new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({ color: OVERLAY_COLOUR, ...overlayMat }));
      fillMesh.renderOrder = lineMesh.renderOrder = 1000;
      if (at === 'top') obj.add(fillMesh, lineMesh);
      else { fillGeo.dispose(); (fillMesh.material as THREE.Material).dispose(); obj.add(lineMesh); }
      g.scene.add(obj);
      this.overlay.push({ scene: g.scene, obj });
    }
    this.map?.triggerRepaint();
  }

  /** Нарисован ли объект в какой-либо группе. */
  hasFeature(key: string): boolean {
    for (const g of this.groups.values()) if (g.byKey.has(key)) return true;
    return false;
  }

  hasGroup(key: string): boolean {
    return this.groups.has(key);
  }

  /** Группы тайлов (без сцены режима одного здания — ею управляет setFocus). */
  groupKeys(): string[] {
    return [...this.groups.keys()].filter((k) => k !== FOCUS_GROUP);
  }

  removeGroup(key: string) {
    this.pending.delete(key);
    const g = this.groups.get(key);
    if (!g) return;
    g.disposeMesh();
    this.groups.delete(key);
    this.map?.triggerRepaint();
  }

  clear() {
    this.lastTriangles = 0;
    for (const key of [...this.groups.keys(), ...this.pending.keys()]) this.removeGroup(key);
    for (const key of [...this.trees.keys()]) this.setTrees(key, undefined);
  }

  /** Деревья тайла (undefined — убрать). */
  /** Выбранный вход (id узла) — синим. */
  private entranceSelected?: number;
  /** Перетаскиваемый вход: место на стене в метрах сцены режима здания. */
  private entrancePreview?: { id: number; place: Omit<EntrancePlace, 'id'> };

  setEntranceSelection(id: number | undefined) {
    if (this.entranceSelected === id) return;
    this.entranceSelected = id;
    for (const g of this.groups.values()) if (g.entrances.length) this.applyEntrances(g);
    this.map?.triggerRepaint();
  }

  previewEntrance(p: { id: number; place: Omit<EntrancePlace, 'id'> } | undefined) {
    this.entrancePreview = p;
    const g = this.groups.get(FOCUS_GROUP);
    if (g) this.applyEntrances(g);
    this.map?.triggerRepaint();
  }

  /** Вход на месте в сцене режима здания: id узла → где стоит. */
  focusEntrance(id: number): EntrancePlace | undefined {
    return this.groups.get(FOCUS_GROUP)?.entrances.find((e) => e.id === id);
  }

  /** Курсор у точки выбранного входа (узел у основания стены) — за неё вход переносят. */
  pickEntrancePoint(point: [number, number]): boolean {
    const e = this.entranceSelected === undefined ? undefined : this.focusEntrance(this.entranceSelected);
    const px = e && this.focusProject(new THREE.Vector3(e.p[0], e.p[1], e.z + 0.04));
    return !!px && Math.hypot(px[0] - point[0], px[1] - point[1]) <= DOOR_PICK_PX;
  }

  /** Вход под курсором в режиме здания: id узла. */
  pickEntrance(point: [number, number]): number | undefined {
    const g = this.groups.get(FOCUS_GROUP), ray = this.focusRay(point);
    if (!g || !ray) return;
    let best: number | undefined, bestT = Infinity;
    const hit = new THREE.Vector3();
    for (const e of g.entrances) {
      const n = new THREE.Vector3(e.n[0], e.n[1], 0);
      const c = new THREE.Vector3(e.p[0] + e.n[0] * ENTRANCE_OFFSET, e.p[1] + e.n[1] * ENTRANCE_OFFSET, e.z);
      if (!ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(n, c), hit)) continue;
      const u = (hit.x - c.x) * e.t[0] + (hit.y - c.y) * e.t[1], v = hit.z - e.z;
      const t = hit.distanceTo(ray.origin);
      // Чуть шире самого прямоугольника — попасть проще
      if (Math.abs(u) <= (e.width ?? ENTRANCE_WIDTH) / 2 + 0.15 && v >= -0.15 && v <= ENTRANCE_HEIGHT + 0.15 && t < bestT) { best = e.id; bestT = t; }
    }
    return best;
  }

  /** Входы группы: у вершин контуров с entrance=* (по текущей геометрии — вершина едет, вход за ней). */
  private applyEntrances(g: MeshGroup) {
    g.disposeEntrances();
    const tags = new Map<number, Record<string, string>>();
    for (const it of g.items) for (const e of it.feature.entrances ?? []) tags.set(e.id, e.tags);
    g.entrances = [];
    if (!tags.size) return;
    // Режим здания: вход со скрытого объекта (контур скрыт по умолчанию; глазик, изоляция) — только на стене
    // видимого, иначе при изоляции части висели бы входы чужих стен. На карте скрыт голый контур — его входы нужны
    const shown = g === this.groups.get(FOCUS_GROUP)
      ? g.items.filter((it) => !g.hidden.has(it.feature.key)).flatMap((it) => it.feature.polygons.flatMap((p) => [p.outer, ...p.inners].map((r) => r.map(g.toLocal))))
      : undefined;
    const onShownWall = (q: Pt) => shown!.some((r) => r.some((a, i) => distToSegment(q, a, r[(i + 1) % r.length]) <= ENTRANCE_ON_WALL));
    // Узел в нескольких объектах (контур и часть, соседние части) — на самой низкой видимой стене
    const best = new Map<number, { place: EntrancePlace; rank: number }>();
    for (const it of g.items) {
      const offstage = !!shown && g.hidden.has(it.feature.key);
      // Низ — по тегам, не по габаритам: пока часть пересобирается (крыша из воркера), box бывает пустым,
      // и вход перескакивал на соседнюю часть выше (на крышу нижней)
      const min = g.lift?.get(it.feature.key) ?? computeHeights(it.tags).min;
      // Вход — у земли: решает самый низкий низ. Контур под частями (только обводка, а в режиме здания — плоский
      // скрытый след) ниже части-кровли, на которой узел тоже есть, — вход по нему; видимому объёму он уступает лишь
      // на той же высоте
      const rank = min + (strokeOnly(g, it) || g.hidden.has(it.feature.key) || thinItem(it) ? 1e-3 : 0);
      for (const p of it.feature.polygons) {
        const rings = [p.outer, ...p.inners].map((r) => r.map(g.toLocal));
        [p.outerIds, ...(p.innerIds ?? [])].forEach((ids, r) => ids?.forEach((id, i) => {
          if (!tags.has(id) || (best.get(id)?.rank ?? Infinity) <= rank) return;
          const place = entrancePlace(rings, r, i, min);
          if (place && (!offstage || onShownWall(place.p))) best.set(id, { place: { id, ...place, width: tagWidth(tags.get(id)) }, rank });
        }));
      }
    }
    const preview = this.entrancePreview;
    if (preview && g === this.groups.get(FOCUS_GROUP)) best.set(preview.id, { place: { id: preview.id, ...preview.place }, rank: -Infinity });
    if (!best.size) return;
    const root = new THREE.Group();
    const plain: number[] = [], selected: number[] = [], lines: number[] = [];
    const level = g === this.groups.get(FOCUS_GROUP) ? this.level : undefined;
    const onPlan = (e: EntrancePlace) => !!level && e.z >= level.floor - 1e-3;
    for (const { place: e } of best.values()) {
      g.entrances.push(e);
      // План этажа рисует проём и маркер двери сам; вход ниже выбранного этажа — на сплошном фасаде, нужен прямоугольник
      if (onPlan(e)) continue;
      const out = e.id === this.entranceSelected ? selected : plain;
      const w = (e.width ?? ENTRANCE_WIDTH) / 2, ox = e.p[0] + e.n[0] * ENTRANCE_OFFSET, oy = e.p[1] + e.n[1] * ENTRANCE_OFFSET;
      const a = [ox - e.t[0] * w, oy - e.t[1] * w], b = [ox + e.t[0] * w, oy + e.t[1] * w];
      const z0 = e.z, z1 = e.z + ENTRANCE_HEIGHT;
      out.push(a[0], a[1], z0, b[0], b[1], z0, b[0], b[1], z1, a[0], a[1], z0, b[0], b[1], z1, a[0], a[1], z1);
      lines.push(a[0], a[1], z0, a[0], a[1], z1, a[0], a[1], z1, b[0], b[1], z1, b[0], b[1], z1, b[0], b[1], z0);
    }
    for (const [pos, mat] of [[plain, ENTRANCE_MATERIAL], [selected, ENTRANCE_SELECTED_MATERIAL]] as const) {
      if (!pos.length) continue;
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      const mesh = new THREE.Mesh(geom, mat);
      mesh.renderOrder = 1;
      mesh.frustumCulled = false;
      root.add(mesh);
    }
    // Выбранный — точка узла на контуре у основания (за неё вход и переносят), как у дверей на плане этажа
    const sel = g.entrances.find((e) => e.id === this.entranceSelected && !onPlan(e));
    if (sel) {
      const dot = new THREE.Mesh(DOOR_GEO, DOOR_MATERIAL);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.28, 0.025, 8, 24), DOOR_SELECTED_MATERIAL);
      dot.position.set(sel.p[0], sel.p[1], sel.z + 0.04);
      ring.position.set(sel.p[0], sel.p[1], sel.z + 0.08);
      for (const o of [dot, ring]) { o.userData.entrancePoint = true; o.renderOrder = 5; o.frustumCulled = false; root.add(o); }
    }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
    const ls = new THREE.LineSegments(lg, ENTRANCE_LINE_MATERIAL);
    ls.renderOrder = 2;
    ls.frustumCulled = false;
    root.add(ls);
    // После граней зданий: в режиме контуров они пишут только глубину — обводки входов за стенами прячутся
    root.renderOrder = 1;
    g.entranceObj = root;
    g.scene.add(root);
  }

  setTrees(key: string, trees: TreeGroup | undefined) {
    const old = this.trees.get(key);
    if (old === trees) return;
    old?.dispose();
    if (trees) { trees.applyLighting(this.graphics.hemisphere); trees.select(this.selectedTreeKey); this.trees.set(key, trees); } else this.trees.delete(key);
    this.map?.triggerRepaint();
  }

  /** Подпись набора, из которого собраны деревья тайла (undefined — деревьев тайла нет). */
  treeSignature(key: string): string | undefined {
    return this.trees.get(key)?.signature;
  }

  treeKeys(): string[] {
    return [...this.trees.keys()];
  }

  setTreeSelection(key: string | undefined) {
    if (this.selectedTreeKey === key) return;
    this.selectedTreeKey = key;
    for (const group of this.trees.values()) group.select(key);
    this.map?.triggerRepaint();
  }

  pickTree(point: PointLike): string | undefined {
    if (!this.visible || this.focused || this.graphics.trees === false || !this.map || !this.lastMain) return undefined;
    const [x, y] = Array.isArray(point) ? point : [point.x, point.y];
    const canvas = this.map.getCanvas();
    let best: { key: string; depth: number } | undefined;
    for (const group of this.trees.values()) {
      const projection = this.lastMain.clone().multiply(group.model);
      const hit = group.pick(x, y, canvas.clientWidth, canvas.clientHeight, projection);
      if (hit && (!best || hit.depth < best.depth)) best = hit;
    }
    return best?.key;
  }

  setVisible(visible: boolean) {
    this.visible = visible;
    if (visible) for (const g of this.groups.values()) if (g.stale) this.rebuildGeometry(g);
    this.map?.triggerRepaint();
  }

  /** Возвращает ключ ближайшего здания под точкой экрана (CSS px). */
  pick(point: PointLike): string | undefined {
    return this.pickHit(point)?.key;
  }

  /** Ближайшее здание под точкой экрана и 3D-точка попадания (lng/lat + высота в метрах). */
  pickHit(point: PointLike): { key: string; lngLat: LngLat; altitude: number; local: THREE.Vector3 } | undefined {
    return timed(`${this.id}: выбор под курсором`, () => this.pickHitImpl(point));
  }

  /** Все объекты под курсором — от ближнего к дальнему (Alt+клик перебирает их). */
  pickAll(point: PointLike): string[] {
    if (!this.visible || !this.map) return [];
    const [px, py] = Array.isArray(point) ? point : [point.x, point.y];
    const canvas = this.map.getCanvas();
    const x = (px / canvas.clientWidth) * 2 - 1;
    const y = 1 - (py / canvas.clientHeight) * 2;
    const depth = new Map<string, { d: number; dist: number; area: number }>();
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), hitPoint = new THREE.Vector3();
    for (const g of this.activeGroups()) {
      const m = g.camera.projectionMatrix;
      const inv = m.clone().invert();
      const near = new THREE.Vector3(x, y, -1).applyMatrix4(inv);
      const far = new THREE.Vector3(x, y, 1).applyMatrix4(inv);
      const ray = new THREE.Ray(near, far.sub(near).normalize());
      if (!ray.intersectsBox(groupBox(g))) continue;
      for (const item of g.items) {
        const key = item.feature.key;
        if (g.hidden.has(key) || !ray.intersectsBox(item.box)) continue;
        const pos = item.positions;
        for (let i = 0; i < pos.length; i += 9) {
          a.fromArray(pos, i); b.fromArray(pos, i + 3); c.fromArray(pos, i + 6);
          if (!ray.intersectTriangle(a, b, c, false, hitPoint)) continue;
          if (this.hiddenByCut(g, hitPoint)) continue;
          const dist = hitPoint.distanceTo(ray.origin);
          const d = hitPoint.applyMatrix4(m).z;
          if (!(d >= (depth.get(key)?.d ?? Infinity))) depth.set(key, { d, dist, area: itemArea(g, item) });
        }
      }
    }
    // Наложенные в одной плоскости (плоские следы друг на друге) — от меньшего по площади к большему
    return [...depth.entries()].sort(([, p], [, q]) => (Math.abs(p.dist - q.dist) < TIE_DEPTH ? p.area - q.area || p.d - q.d : p.d - q.d)).map(([k]) => k);
  }

  /** Точка здания режима выше среза этажа: там геометрия отсечена и не видна — не попадание. */
  private hiddenByCut(g: MeshGroup, p: THREE.Vector3): boolean {
    return !!this.level && g === this.groups.get(FOCUS_GROUP) && p.z > (this.levelCut ?? this.level.cut) + 1e-3;
  }

  private pickHitImpl(point: PointLike): { key: string; lngLat: LngLat; altitude: number; local: THREE.Vector3 } | undefined {
    if (!this.visible || !this.map) return;
    const [px, py] = Array.isArray(point) ? point : [point.x, point.y];
    const canvas = this.map.getCanvas();
    const x = (px / canvas.clientWidth) * 2 - 1;
    const y = 1 - (py / canvas.clientHeight) * 2;
    let best: { key: string; depth: number; g: MeshGroup; p: THREE.Vector3 } | undefined;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), hitPoint = new THREE.Vector3();
    for (const g of this.activeGroups()) {
      const m = g.camera.projectionMatrix;
      const inv = m.clone().invert();
      const near = new THREE.Vector3(x, y, -1).applyMatrix4(inv);
      const far = new THREE.Vector3(x, y, 1).applyMatrix4(inv);
      const ray = new THREE.Ray(near, far.sub(near).normalize());
      // Плоские следы (контур под частями) в меш не входят — их габариты проверяем отдельно: клик внутри следа выделяет его
      if (!ray.intersectsBox(groupBox(g)) && !g.items.some((it) => strokeOnly(g, it) && !g.hidden.has(it.feature.key) && ray.intersectsBox(it.box))) continue;
      // Сначала габариты зданий, треугольники — только у задетых
      let groupBest: { item: Item; dist: number; p: THREE.Vector3 } | undefined;
      for (const item of g.items) {
        if (g.hidden.has(item.feature.key) || !ray.intersectsBox(item.box)) continue;
        const pos = item.positions;
        for (let i = 0; i < pos.length; i += 9) {
          a.fromArray(pos, i); b.fromArray(pos, i + 3); c.fromArray(pos, i + 6);
          if (!ray.intersectTriangle(a, b, c, false, hitPoint)) continue;
          if (this.hiddenByCut(g, hitPoint)) continue;
          const dist = hitPoint.distanceTo(ray.origin);
          // В одной плоскости с уже найденным (наложенные плоские следы) — меньший по площади
          const tie = groupBest && Math.abs(dist - groupBest.dist) < TIE_DEPTH;
          if (!groupBest || (tie ? groupBest.item !== item && itemArea(g, item) < itemArea(g, groupBest.item) : dist < groupBest.dist)) groupBest = { item, dist, p: hitPoint.clone() };
        }
      }
      if (!groupBest) continue;
      // Группы в разных локальных системах — сравниваем по глубине в clip space
      const depth = groupBest.p.clone().applyMatrix4(m).z;
      if (!best || depth < best.depth) best = { key: groupBest.item.feature.key, depth, g, p: groupBest.p };
    }
    if (!best) return;
    const { g, p } = best;
    const merc = new MercatorCoordinate(g.origin.x + p.x * g.metersToMerc, g.origin.y - p.y * g.metersToMerc, 0);
    return { key: best.key, lngLat: merc.toLngLat(), altitude: p.z, local: p };
  }

  /** Подсветить объект или несколько (группу type=building). */
  select(keys: string | string[] | undefined) {
    const prev = this.selected;
    this.selected = new Set(keys === undefined ? [] : typeof keys === 'string' ? [keys] : keys);
    for (const g of this.groups.values()) {
      for (const k of new Set([...prev, ...this.selected])) {
        const item = k ? g.byKey.get(k) : undefined;
        if (item) this.paintItem(g, item);
      }
      if (g.strokes || [...prev, ...this.selected].some((k) => g.byKey.has(k))) this.applyStrokes(g);
    }
    this.updateHiddenEdges();
    this.map?.triggerRepaint();
  }

  setGraphics(o: GraphicsOptions) {
    const glassChanged = glassEnabled === !!o.noGlass;
    glassEnabled = !o.noGlass;
    // Высота по умолчанию: пересобрать здания без высоты и этажей (только их — порциями по кадрам)
    const raise = o.defaultHeight !== false;
    if (raise !== raiseDefault) {
      raiseDefault = raise;
      void this.rebuildWhere((f) => computeHeights(f.tags).source === 'default');
    }
    this.userEdges = o.edges;
    this.graphics = { ...o, edges: o.edges || this.wireframe };
    // Стекло — отдельный меш: при переключении пересобираем слитую геометрию
    if (glassChanged) for (const g of this.groups.values()) if (g.mesh) this.rebuildGeometry(g);
    for (const g of this.groups.values()) {
      g.applyLighting(o);
      this.paintGroup(g);
      this.applyEdges(g);
    }
    setTreesSeasonal(!!o.seasons);
    for (const t of this.trees.values()) { t.applyLighting(o.hemisphere); t.recolour(); }
    this.applyLevel(); // рёбра внутренних стен
    this.map?.triggerRepaint();
  }

  setMonochrome(on: boolean) {
    this.monochrome = on;
    ESCALATOR_BELT.color.setHex(on ? 0xffffff : 0xb0b6ba);
    ESCALATOR_SIDE.color.setHex(0xffffff);
    ESCALATOR_STEP.color.setHex(on ? 0xffffff : 0x9da5aa);
    ESCALATOR_BALUSTRADE.color.setHex(on ? 0xffffff : 0xb9d3dc);
    ESCALATOR_HANDRAIL.color.setHex(on ? 0x57534e : 0x656d73);
    ESCALATOR_PALE_BELT.color.setHex(on ? 0xffffff : 0xd8dbdd);
    ESCALATOR_PALE_STEP.color.setHex(on ? 0xffffff : 0xced2d4);
    ESCALATOR_PALE_BALUSTRADE.color.setHex(on ? 0xffffff : 0xdce9ed);
    setTreesMonochrome(on);
    for (const t of this.trees.values()) t.recolour();
    for (const g of this.groups.values()) this.paintGroup(g);
    this.map?.triggerRepaint();
  }

  private addItem(g: MeshGroup, f: Feature3D) {
    const item = timed('здание: треугольники', () => buildItem(g, f), () => describeFeature(f));
    this.shapeSigs.set(item, shapeSig(f));
    // Контуры включены — считаем рёбра здесь, в порционной сборке, а не разом при слиянии
    if (this.graphics.edges) item.edges = timed('здание: рёбра', () => itemEdges(item));
    g.byKey.set(f.key, item);
    g.items.push(item);
  }

  /** Из чего собрана часть (shapeSig) — перечитанный тайл с той же частью не пересобирает её. */
  private shapeSigs = new WeakMap<Item, string>();

  private replaceItems(g: MeshGroup, features: Feature3D[], force = false) {
    // Та же часть из перечитанного тайла (новый объект, то же содержимое) — без пересборки: иначе пропадают
    // кеши по частям (оболочка здания в режиме этажей — секунды на сотнях частей)
    features = features.filter((f) => {
      const old = g.byKey.get(f.key);
      if (force || !old || old.pending || this.shapeSigs.get(old) !== shapeSig(f)) return true;
      old.feature = f;
      return false;
    });
    if (!features.length) { this.rebuildGeometry(g); this.map?.triggerRepaint(); return; }
    const refreshColumnSections = !!this.level && g === this.groups.get(FOCUS_GROUP) && features.some(f =>
      f.tags['building:part'] === 'column' || g.byKey.get(f.key)?.tags['building:part'] === 'column');
    const changed = new Set(features.filter((f) => g.byKey.has(f.key)).map((f) => f.key));
    this.refreshContacts(g, features, changed);
    for (const f of features) {
      const old = g.byKey.get(f.key);
      if (!old) continue;
      const item = timed('здание: треугольники', () => buildItem(g, f), () => describeFeature(f));
      // Треугольники те же (пересборка всех частей ради стеклянных) — остаётся прежний объект с его кешами
      if (sameItemGeometry(old, item)) { old.feature = f; old.tags = item.tags; this.shapeSigs.set(old, shapeSig(f)); continue; }
      this.shapeSigs.set(item, shapeSig(f));
      g.items[g.items.indexOf(old)] = item;
      g.byKey.set(f.key, item);
    }
    this.rebuildGeometry(g);
    // Column caps belong to the floor overlay, separate from the updated building mesh.
    if (refreshColumnSections) { this.applyLevel(); this.applyIndoorSelection(); }
    this.map?.triggerRepaint();
  }

  /**
   * Пересчитать индекс соприкасающихся граней с новыми версиями объектов и пересобрать соседей,
   * у которых контакты поменялись (часть сдвинули с крыши, поставили на крышу, удалили).
   */
  private refreshContacts(g: MeshGroup, fresh: Feature3D[], changed: Set<string>) {
    if (!g.contacts) return;
    const byKey = new Map(g.items.map((it) => [it.feature.key, it.feature]));
    for (const k of changed) byKey.delete(k);
    for (const f of fresh) byKey.set(f.key, f);
    g.contacts = buildContacts(g, byKey.values());
    for (let i = 0; i < g.items.length; i++) {
      const it = g.items[i];
      if (changed.has(it.feature.key)) continue;
      if (contactKeys(g, it.feature) === it.contacts && !it.contacts.split(',').some((k) => changed.has(k))) continue;
      const item = buildItem(g, it.feature);
      if (it.edges) item.edges = itemEdges(item);
      g.items[i] = item;
      g.byKey.set(item.feature.key, item);
    }
  }

  /** Сливает здания группы в одну геометрию. */
  private doorCutSources = new WeakMap<Item, { positions: Float32Array; wallVertices: number; cut: Float32Array }>();
  /** A few recent floor configurations per part; edits replace the source array and invalidate the cache. */
  private doorCuts = new WeakMap<Item, { source: Float32Array; wallVertices: number; entries: Map<string, { positions: Float32Array; wallVertices: number }> }>();

  private openRoofInPlan(g: MeshGroup, it: Item): boolean {
    if (!this.level || g !== this.groups.get(FOCUS_GROUP) || g.hidden.has(it.feature.key) || strokeOnly(g, it)) return false;
    const h = computeHeights(it.tags);
    return h.roofShape !== 'flat' && h.roofHeight > 0 && h.top > this.level.floor
      && h.top < (this.cutZ() ?? this.level.cut);
  }

  private rebuildGeometry(g: MeshGroup) {
    // Скрытый слой на карте не рисуется — не сливаем геометрию зря, соберём при показе
    if (!this.visible && !this.focused) { g.stale = true; return; }
    g.stale = false;
    g.disposeMesh();
    for (const it of g.items) {
      const source = this.doorCutSources.get(it);
      if (source && it.positions === source.cut) {
        it.positions = source.positions;
        it.wallVertices = source.wallVertices;
        it.edges = undefined;
      }
      this.doorCutSources.delete(it);
    }
    this.applyShell(g);
    // План нарисован до оболочки (крыши ещё считались) — периметр и плита по следам; теперь — по сечению
    if (this.level && g === this.groups.get(FOCUS_GROUP) && this.indoorObj && !this.planBySection && g.shellOf) { this.applyLevel(); return; }
    if (this.level && g === this.groups.get(FOCUS_GROUP)) {
      const levels = [{ items: this.level.items, doors: this.previewDoors(this.level.doors ?? []), cuts:this.level.doorCuts??[], z: this.level.floor },
        ...(this.level.below ?? []).map(b => ({ items: b.items, doors: b.doors ?? [], cuts:b.doorCuts??[], z: b.items[0]?.z ?? b.doorModels?.[0]?.z }))];
      const knownDoors = [...this.doors, ...(this.level.below ?? []).flatMap(b => b.doorModels ?? [])];
      const doors = levels.flatMap(l => l.z === undefined ? [] : l.doors.map(at => {
        const [x, y] = g.toLocal(at); const door = knownDoors.find(d => Math.abs(d.z - l.z!) < 0.1 && Math.hypot(...g.toLocal(this.doorAt(d)).map((v, i) => v - [x, y][i])) < 0.01);
        return { x, y, z: l.z!, diameter: revolvingDoorDiameter(door?.tags), width:tagWidth(door?.tags??{}) };
      }).concat(l.cuts.map(c=>{const [x,y]=g.toLocal(c.at);return {x,y,z:l.z!,diameter:undefined,width:c.width};})));
      const escalators = (this.level.escalators ?? []).map(e => ({ ...e, line: e.line.map(g.toLocal) }));
      const escalatorSignature = JSON.stringify(escalators);
      for (const it of g.items) {
        if (g.hidden.has(it.feature.key) || strokeOnly(g, it) || !it.wallVertices) continue;
        // Кеш части зависит только от проёмов, которые могут пересечь её объём.
        // Сдвиг одной двери не должен инвалидировать все остальные части здания.
        const nearbyDoors = doors.filter(d => {
          const pad = (d.diameter ?? d.width ?? DOOR_WIDTH) / 2 + DOOR_SNAP;
          return d.x + pad >= it.box.min.x && d.x - pad <= it.box.max.x
            && d.y + pad >= it.box.min.y && d.y - pad <= it.box.max.y
            && d.z < it.box.max.z && d.z + DOOR_HEIGHT > it.box.min.z;
        });
        if (!nearbyDoors.length && !escalators.length) continue;
        const doorSignature = nearbyDoors.map(d => [d.x, d.y, d.z, d.diameter ?? '', d.width ?? ''].join(',')).join(';') + escalatorSignature;
        const source = { positions: it.positions, wallVertices: it.wallVertices };
        let cache = this.doorCuts.get(it);
        if (!cache || cache.source !== source.positions || cache.wallVertices !== source.wallVertices) {
          cache = { source: source.positions, wallVertices: source.wallVertices, entries: new Map() };
          this.doorCuts.set(it, cache);
        }
        let result = cache.entries.get(doorSignature);
        if (!result) {
          const walls = cutEscalatorOpenings(cutDoorOpenings(source.positions.subarray(0, source.wallVertices * 3), nearbyDoors, DOOR_WIDTH, DOOR_HEIGHT, DOOR_SNAP), escalators);
          if (walls.length === source.wallVertices * 3 && walls.every((v, i) => v === source.positions[i])) result = source;
          else {
            const cut = new Float32Array(walls.length + source.positions.length - source.wallVertices * 3);
            cut.set(walls); cut.set(source.positions.subarray(source.wallVertices * 3), walls.length);
            result = { positions: cut, wallVertices: walls.length / 3 };
          }
          if (cache.entries.size >= 3) cache.entries.delete(cache.entries.keys().next().value!);
          cache.entries.set(doorSignature, result);
        }
        if (result.positions === source.positions) continue;
        this.doorCutSources.set(it, { ...source, cut: result.positions });
        it.positions = result.positions; it.wallVertices = result.wallVertices;
        it.edges = undefined;
      }
    }
    let total = 0;
    for (const it of g.items) { it.start = total; total += it.positions.length / 3; }
    const positions = new Float32Array(total * 3);
    // Скрытые остаются нулями — вырожденные треугольники не видны. Контуры под частями в просмотре — тоже:
    // их рисует обводка, а выбор кликом идёт по треугольникам здания (pickHit), так что выделить можно
    for (const it of g.items) {
      if (g.hidden.has(it.feature.key) || strokeOnly(g, it)) continue;
      positions.set(it.positions, it.start * 3);
      if (this.openRoofInPlan(g, it)) positions.fill(0, (it.start + it.wallVertices) * 3,
        (it.start + it.positions.length / 3 - it.floorVertices) * 3);
      // Стеклянные диапазоны — в отдельный буфер, в общем остаются нулями
      for (const [a, b] of glassRanges(it)) positions.fill(0, (it.start + a) * 3, (it.start + b) * 3);
    }
    // The floor plan supplies the floor here. Flat parts and structural slabs
    // at the same elevation otherwise fight with its coloured room surfaces.
    // Only change the render buffer: source geometry remains available for picking
    // and is restored automatically when leaving the floor plan.
    if (this.level && g === this.groups.get(FOCUS_GROUP)) {
      const floor = this.level.floor;
      for (let i = 0; i + 8 < positions.length; i += 9) {
        const z = positions[i + 2];
        if (Math.abs(z - floor) < 0.1 && Math.abs(positions[i + 5] - z) < 1e-5
          && Math.abs(positions[i + 8] - z) < 1e-5) positions.fill(0, i, i + 9);
      }
    }
    timed('геометрия: пустоты', () => this.cutVoids(g, positions));
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(total * 3), 3));
    geom.computeVertexNormals(); // без индексов — нормаль на треугольник
    // Плоские контуры — своей группой отрисовки (подряд идущие — одним диапазоном)
    let run: { start: number; thin: boolean } | undefined;
    for (const it of g.items) {
      const thin = thinItem(it), n = it.positions.length / 3;
      if (!n) continue;
      if (run && run.thin === thin) continue;
      if (run) geom.addGroup(run.start, it.start - run.start, run.thin ? 1 : 0);
      run = { start: it.start, thin };
    }
    if (run) geom.addGroup(run.start, total - run.start, run.thin ? 1 : 0);
    g.mesh = new THREE.Mesh(geom, [MATERIAL, THIN_MATERIAL]);
    g.mesh.frustumCulled = false; // своя матрица проекции — штатный culling не годится
    g.scene.add(g.mesh);
    timed('геометрия: стекло', () => this.rebuildGlass(g));
    this.applyEntrances(g);
    this.paintGroup(g);
    timed('геометрия: рёбра', () => this.applyEdges(g));
    if (g === this.groups.get(FOCUS_GROUP)) this.attachUnderground();
    this.applyStrokes(g);
  }

  /** Стекло пересобирается отдельно: набор непрозрачных indoor-стен меняется при выборе этажа. */
  private rebuildGlass(g: MeshGroup) {
    if (g.glass) {
      g.scene.remove(g.glass);
      g.glass.geometry.dispose();
      g.glass = undefined;
    }
    this.hideCoveredGlass(g);
    const indoor = g === this.groups.get(FOCUS_GROUP) && this.level ? this.indoorGlassBlockers : [];
    let glassTotal = 0;
    for (const it of g.items) {
      it.glassStart = -1;
      it.glassPlanTrim = undefined;
      if (g.hidden.has(it.feature.key) || strokeOnly(g, it)) continue;
      if (indoor.length && glassEnabled && it.glassWalls && it.wallVertices) {
        const walls = it.glassTrim?.src === it.positions ? it.glassTrim.walls : it.positions.subarray(0, it.wallVertices * 3);
        it.glassPlanTrim = { src: it.positions, walls: new Float32Array(trimCoplanarWalls(walls, indoor)) };
      }
      it.glassStart = glassTotal;
      for (const src of glassParts(it)) glassTotal += src.length / 3;
    }
    if (glassTotal) {
      const gp = new Float32Array(glassTotal * 3);
      for (const it of g.items) {
        if (g.hidden.has(it.feature.key) || strokeOnly(g, it)) continue;
        let o = it.glassStart;
        for (const src of glassParts(it)) { gp.set(src, o * 3); o += src.length / 3; }
      }
      this.cutVoids(g, gp);
      const gg = new THREE.BufferGeometry();
      gg.setAttribute('position', new THREE.BufferAttribute(gp, 3));
      gg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(glassTotal * 3), 3));
      gg.computeVertexNormals();
      g.glass = new THREE.Mesh(gg, GLASS_MATERIAL);
      g.glass.frustumCulled = false;
      g.glass.renderOrder = 1; // после непрозрачного
      g.scene.add(g.glass);
    }
  }

  /**
   * Режим этажей: здание рисуется оболочкой — грани частей, спрятанные внутри соседних частей (общие стены,
   * крыша подиума внутри башни), вырезаны, чтобы на срезе этажа не торчали стенки «кубиков». Вне этажей —
   * исходные треугольники (правка частей работает с ними).
   */
  private applyShell(g: MeshGroup) {
    const on = !!this.level && g === this.groups.get(FOCUS_GROUP);
    if (!on) {
      if (!g.shellOf) return;
      for (const it of g.items) {
        if (!it.full) continue;
        it.positions = it.full.positions;
        it.wallVertices = it.full.wallVertices;
        it.full = undefined;
        if (it.edges) it.edges = itemEdges(it);
      }
      g.shellOf = undefined;
      g.shellCache = undefined;
      g.lift = undefined;
      return;
    }
    const bases = g.items.map((it) => it.full?.positions ?? it.positions);
    // Скрытые, голые контуры и стекло меняют, что чем закрыто
    // На срезе этажа стекло соседа закрывает стену, как непрозрачная: граница частей внутри здания
    // (стена высокой части за стеклянной пристройкой) иначе прошла бы поперёк помещений
    const glassShell = glassEnabled && !this.level;
    const hidden = `${[...g.hidden].sort().join(',')}|${[...g.flat].sort().join(',')}|${glassShell}|${g.items.filter(it => this.openRoofInPlan(g, it)).map(it => it.feature.key).join(',')}`;
    if (g.shellOf && g.shellOf.hidden === hidden && g.shellOf.bases.length === bases.length && g.shellOf.bases.every((b, i) => b === bases[i])) return;
    // Крыши ещё считаются в воркере — оболочку посчитаем, когда придёт последняя (иначе пересчёт на каждую порцию)
    if (g.items.some((it) => it.pending && !g.hidden.has(it.feature.key))) return;
    // Кеш по частям: крыши приходят из воркера по одной — пересчитываются только изменившаяся часть и её соседи
    if (g.shellCache?.sig !== hidden) {
      const caches = g.shellCaches ??= new Map();
      g.shellCache = caches.get(hidden) ?? { sig: hidden, lifted: new Map(), solids: new Map(), trimmed: new Map() };
      caches.delete(hidden);
      caches.set(hidden, g.shellCache);
      while (caches.size > SHELL_CACHES) caches.delete(caches.keys().next().value!);
    }
    const cache = g.shellCache!;
    let done = 0, incomplete = false;
    timed('этажи: оболочка здания', () => {
      // Висящие части (забытый min_height) — без столба от земли до низа охватывающей части
      const feats = g.items.filter((it) => !g.hidden.has(it.feature.key)).map((it) => it.feature);
      const fl = cache.floating;
      if (!fl || fl.feats.length !== feats.length || fl.feats.some((f, i) => f !== feats[i])) {
        const floating = timed('этажи: оболочка: висящие части', () => floatingParts(feats));
        cache.floating = { feats, lift: new Map([...floating].map(([k, f]) => [k, f.lift])) };
      }
      g.lift = cache.floating!.lift;
      const base = new Map<Item, { positions: Float32Array; wallVertices: number }>();
      for (const it of g.items) {
        it.full ??= { positions: it.positions, wallVertices: it.wallVertices };
        const full = it.full;
        const lift = g.lift.get(it.feature.key);
        if (lift === undefined) { base.set(it, full); continue; }
        const hit = cache.lifted.get(it);
        if (hit && hit.src === full.positions && hit.lift === lift) { base.set(it, hit.out); continue; }
        const end = full.positions.length / 3 - it.floorVertices;
        const walls = clipAbove(full.positions, 0, full.wallVertices, lift), roof = clipAbove(full.positions, full.wallVertices, end, lift);
        const slabs = full.positions.slice(end * 3);
        // Плиты под низом — вырожденными: число вершин плит (floorVertices) не меняется
        for (let i = 0; i + 8 < slabs.length; i += 9) if (slabs[i + 2] < lift - 1e-3) slabs.fill(0, i, i + 9);
        const pos = new Float32Array(walls.length + roof.length + slabs.length);
        pos.set(walls, 0);
        pos.set(roof, walls.length);
        pos.set(slabs, walls.length + roof.length);
        const out = { positions: pos, wallVertices: walls.length / 3 };
        cache.lifted.set(it, { src: full.positions, lift, out });
        base.set(it, out);
      }
      const solids = new Map<Item, PreparedSolid>();
      const tSolids = performance.now();
      for (const it of g.items) {
        const full = base.get(it)!;
        if (!shellSolid(g, it, full.positions)) continue;
        const hit = cache.solids.get(it);
        if (hit && hit.base === full.positions) { solids.set(it, hit.solid); continue; }
        const h = computeHeights(it.tags);
        const end = full.positions.length / 3 - it.floorVertices;
        const solid = prepareSolid({
          polys: (g.renderFootprints.get(it.feature.key) ?? it.feature.polygons).map((p) => ({ outer: p.outer.map(g.toLocal), inners: p.inners.map((r) => r.map(g.toLocal)) })),
          min: g.lift.get(it.feature.key) ?? h.min,
          // Неподдерживаемая крыша — стены до самого верха
          wallTop: it.roofApproximated ? h.top : h.wallTop,
          roof: full.positions.subarray(full.wallVertices * 3, end * 3),
          glassWalls: glassShell && it.glassWalls,
          glassRoof: glassShell && it.glassRoof,
        });
        cache.solids.set(it, { base: full.positions, solid });
        solids.set(it, solid);
        cache.solidsGen = (cache.solidsGen ?? 0) + 1;
      }
      // Набор объёмов мог и сократиться (часть заменили) — тоже другое поколение
      if (cache.solidsCount !== solids.size) cache.solidsGen = (cache.solidsGen ?? 0) + 1;
      cache.solidsCount = solids.size;
      const gen = cache.solidsGen ?? 0;
      const depsMemo = cache.deps ??= new WeakMap();
      recordMs('этажи: оболочка: объёмы частей', performance.now() - tSolids, `${solids.size}`);
      let tTrim = 0, tEdges = 0, tDeps = 0;
      // Бюджет — на обрезку граней: остальное выше кешируется по частям и в следующих порциях почти бесплатно
      const deadline = performance.now() + SHELL_BUDGET_MS;
      // Кандидаты в соседи — один раз: openRoofInPlan на каждую пару (сотни частей собора) — десятки секунд
      const neighbours = [...solids].filter(([o]) => !this.openRoofInPlan(g, o));
      for (const it of g.items) {
        const full = base.get(it)!;
        if (g.hidden.has(it.feature.key) || strokeOnly(g, it)) {
          it.positions = full.positions;
          it.wallVertices = full.wallVertices;
          if (it.edges) it.edges = itemEdges(it);
          continue;
        }
        // Соседи — объёмы, чей прямоугольник в плане задевает часть
        const boxes = cache.boxes ??= new WeakMap();
        const b = boxes.get(full.positions) ?? boxes.set(full.positions, positionsBox(full.positions)).get(full.positions)!;
        const t0 = performance.now();
        const memo = depsMemo.get(it);
        const deps = memo && memo.base === full.positions && memo.gen === gen ? memo.deps
          : neighbours.filter(([o, sd]) => o !== it && sd.box[0] <= b[2] + 0.1 && sd.box[2] >= b[0] - 0.1 && sd.box[1] <= b[3] + 0.1 && sd.box[3] >= b[1] - 0.1).map(([, sd]) => sd);
        if (deps !== memo?.deps) depsMemo.set(it, { base: full.positions, gen, deps });
        tDeps += performance.now() - t0;
        const hit = cache.trimmed.get(it);
        if (hit && hit.base === full.positions && (hit.deps === deps || (hit.deps.length === deps.length && hit.deps.every((d, i) => d === deps[i])))) {
          if (it.positions !== hit.positions) {
            it.positions = hit.positions;
            it.wallVertices = hit.wallVertices;
            if (it.edges) it.edges = itemEdges(it);
          }
          continue;
        }
        if (!deps.length) {
          it.positions = full.positions;
          it.wallVertices = full.wallVertices;
        } else if (trimWorkersAvailable()) {
          // В воркер: пока считается — исходные грани; результат ляжет в кеш, и оболочка соберётся заново
          incomplete = true;
          this.queueTrim(g, cache, it, full, deps);
          if (it.positions === full.positions) continue;
          it.positions = full.positions;
          it.wallVertices = full.wallVertices;
          if (it.edges) it.edges = itemEdges(it);
          continue;
        } else if (done > 0 && performance.now() > deadline) {
          // Время порции вышло — пока как есть, досчитает продолжение (continueShell); рёбра — только если сменились грани
          incomplete = true;
          if (it.positions === full.positions) continue;
          it.positions = full.positions;
          it.wallVertices = full.wallVertices;
        } else {
          const t1 = performance.now();
          // Часть — целиком: прерванная на середине не кешируется, и крупная (дольше порции) не досчиталась бы никогда
          const r = composeTrim(full, it.floorVertices, trimSync(this.trimJob(g, it, full, []), deps));
          it.positions = r.positions;
          it.wallVertices = r.wallVertices;
          done++;
          tTrim += performance.now() - t1;
        }
        cache.trimmed.set(it, { base: full.positions, deps, positions: it.positions, wallVertices: it.wallVertices });
        const t2 = performance.now();
        if (it.edges) it.edges = itemEdges(it);
        tEdges += performance.now() - t2;
      }
      recordMs('этажи: оболочка: соседи', tDeps);
      recordMs('этажи: оболочка: обрезка граней', tTrim);
      recordMs('этажи: оболочка: рёбра', tEdges);
      // Заменённые части (пришла крыша, правка) — из кеша вон
      const live = new Set(g.items);
      for (const m of [cache.lifted, cache.solids, cache.trimmed] as Map<Item, unknown>[]) for (const k of m.keys()) if (!live.has(k)) m.delete(k);
    }, () => `${g.items.length} объектов, пересчитано ${done}${incomplete ? ', остальное — в фоне' : ''}`);
    // Не досчитано — оболочку не запоминаем: следующий вызов продолжит с кеша по частям
    if (incomplete) { this.continueShell(g); return; }
    g.shellOf = { bases: g.items.map((it) => it.full!.positions), hidden };
  }

  /** Задание обрезки части: её грани, след в метрах сцены и соседи. */
  private trimJob(g: MeshGroup, it: Item, full: { positions: Float32Array; wallVertices: number }, deps: PreparedSolid[]): TrimJob {
    const polys = (g.renderFootprints.get(it.feature.key) ?? it.feature.polygons).map((p) => ({ outer: p.outer.map(g.toLocal), inners: p.inners.map((r) => r.map(g.toLocal)) }));
    return { positions: full.positions, wallVertices: full.wallVertices, floorVertices: it.floorVertices, polys,
      glassWalls: glassEnabled && !!it.glassWalls, glassRoof: glassEnabled && !!it.glassRoof, thin: thinItem(it), deps };
  }

  /** Части в воркерах обрезки: не отправлять ту же (с теми же гранями и соседями) повторно. */
  private trimQueued = new WeakMap<Item, { base: Float32Array; deps: PreparedSolid[] }>();
  private trimPending = 0;

  private queueTrim(g: MeshGroup, cache: NonNullable<MeshGroup['shellCache']>, it: Item, full: { positions: Float32Array; wallVertices: number }, deps: PreparedSolid[]) {
    const q = this.trimQueued.get(it);
    if (q && q.base === full.positions && q.deps === deps) return;
    this.trimQueued.set(it, { base: full.positions, deps });
    this.trimPending++;
    const done = () => {
      if (this.trimQueued.get(it)?.deps === deps) this.trimQueued.delete(it);
      if (--this.trimPending === 0 && this.shellContinuing === g) requestAnimationFrame(() => this.continueShell(g, true));
    };
    trimInWorker(this.trimJob(g, it, full, deps)).then((r) => {
      // Часть могли заменить, пока считалось: applyShell сверяет грани и соседей записи, устаревшая не подойдёт
      const t = composeTrim(full, it.floorVertices, r);
      cache.trimmed.set(it, { base: full.positions, deps, positions: t.positions, wallVertices: t.wallVertices });
    }, (err) => console.warn('[levels] обрезка граней в воркере', it.feature.key, err)).finally(done);
  }

  /**
   * Досчитать оболочку и один раз пересобрать геометрию, когда готова: с воркерами — когда придут все результаты
   * (resume), без них — порциями по SHELL_BUDGET_MS за кадр.
   */
  private shellContinuing?: MeshGroup;
  private continueShell(g: MeshGroup, resume = false) {
    if (resume) { if (this.shellContinuing !== g) return; this.shellContinuing = undefined; }
    if (this.shellContinuing === g) return;
    // Ждём воркеры: продолжим по последнему результату (queueTrim)
    if (this.trimPending > 0 && !resume) { this.shellContinuing = g; return; }
    this.shellContinuing = g;
    const step = () => {
      // Вышли из этажей или из режима здания — продолжать нечего (applyShell сам вернёт исходные грани)
      if (!this.level || g !== this.groups.get(FOCUS_GROUP)) { this.shellContinuing = undefined; return; }
      this.shellContinuing = undefined;
      this.applyShell(g);
      if (this.shellContinuing === g) return; // ещё не всё — applyShell запланировал следующую порцию
      if (g.shellOf) timed('этажи: оболочка готова, слияние', () => this.rebuildGeometry(g));
      this.map?.triggerRepaint();
    };
    this.shellContinuing = g;
    requestAnimationFrame(() => { if (this.shellContinuing === g) step(); });
  }

  /**
   * Стеклянные стены, совпадающие с непрозрачной соседней частью того же слоя (стеклянная пристройка к стене),
   * — вырезаются (glassTrim): две грани в одной плоскости дают рябь. Общая стена двух стеклянных частей остаётся
   * у одной из них (с меньшим ключом). Кровельные объёмы проверяем и в режиме этажей: applyShell их не учитывает.
   */
  private hideCoveredGlass(g: MeshGroup) {
    const glassy = g.items.filter((it) => glassEnabled && it.glassWalls && it.wallVertices && !g.hidden.has(it.feature.key) && !strokeOnly(g, it));
    for (const it of g.items) if (!glassy.includes(it)) it.glassTrim = undefined;
    if (!glassy.length) return;
    let others: { it: Item; box: [number, number, number, number]; solid?: PreparedSolid }[] | undefined;
    for (const it of glassy) {
      others ??= g.items.filter((o) => shellSolid(g, o) || (isRoofPart(o.tags) && !thinItem(o)
        && !g.hidden.has(o.feature.key) && !strokeOnly(g, o))).map((o) => ({ it: o, box: positionsBox(o.positions) }));
      const b = positionsBox(it.positions.subarray(0, it.wallVertices * 3));
      const key = it.feature.key;
      const near = others.filter((o) => (!(glassEnabled && o.it.glassWalls) || o.it.feature.key < key) && o.it !== it && o.box[0] <= b[2] + 0.1 && o.box[2] >= b[0] - 0.1 && o.box[1] <= b[3] + 0.1 && o.box[3] >= b[1] - 0.1);
      const refs = near.map((o) => o.it.positions);
      const cached = it.glassTrim;
      if (cached?.src === it.positions && cached.deps.length === refs.length && cached.deps.every((p, i) => p === refs[i])) continue;
      const deps = near.map((o) => {
        if (!o.solid) {
          const h = computeHeights(o.it.tags);
          const n = o.it.positions.length / 3;
          o.solid = prepareSolid({
            polys: (g.renderFootprints.get(o.it.feature.key) ?? o.it.feature.polygons).map((p) => ({ outer: p.outer.map(g.toLocal), inners: p.inners.map((r) => r.map(g.toLocal)) })),
            min: g.lift?.get(o.it.feature.key) ?? h.min, wallTop: o.it.roofApproximated ? h.top : h.wallTop,
            roof: o.it.positions.subarray(o.it.wallVertices * 3, (n - o.it.floorVertices) * 3),
            glassWalls: false, glassRoof: glassEnabled && o.it.glassRoof,
          });
        }
        return o.solid;
      });
      let walls = it.positions.subarray(0, it.wallVertices * 3);
      if (deps.length) {
        const polys = (g.renderFootprints.get(it.feature.key) ?? it.feature.polygons).map((p) => ({ outer: p.outer.map(g.toLocal), inners: p.inners.map((r) => r.map(g.toLocal)) }));
        walls = new Float32Array(trimTriangles(it.positions, 0, it.wallVertices, polys, true, deps));
      }
      it.glassTrim = { src: it.positions, walls, deps: refs };
    }
  }

  /**
   * Второй свет: горизонтальные грани частей здания на высоте пола этажа (крыши нижних частей, перекрытия,
   * плиты стеклянных частей), попавшие в пустоту, — вырожденными: сквозь пустоту видно этажи ниже.
   */
  private cutVoids(g: MeshGroup, pos: Float32Array) {
    const lv = this.level;
    if (!lv?.voidCuts?.length || !lv.below?.length || g !== this.groups.get(FOCUS_GROUP)) return;
    for (const cut of lv.voidCuts) this.cutVoid(g, pos, cut.polygon, cut.zs);
  }

  private cutVoid(g: MeshGroup, pos: Float32Array, polygon: LonLat[][][], zs: number[]) {
    const rings = polygon.map((poly) => poly.map((r) => r.map(g.toLocal)));
    const inside = (x: number, y: number) => rings.some(([outer, ...holes]) => pointInLocalRing([x, y], outer) && !holes.some((h) => pointInLocalRing([x, y], h)));
    const near = (z: number) => zs.some((h) => Math.abs(z - h) <= VOID_FACE_DZ);
    // Габарит пустоты: треугольники в стороне от неё — без точных проверок
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const poly of rings) for (const [x, y] of poly[0] ?? []) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    for (let i = 0; i + 8 < pos.length; i += 9) {
      const z0 = pos[i + 2], z1 = pos[i + 5], z2 = pos[i + 8];
      if (Math.abs(z0 - z1) > 1e-3 || Math.abs(z0 - z2) > 1e-3 || !near(z0)) continue;
      if (Math.max(pos[i], pos[i + 3], pos[i + 6]) < x0 || Math.min(pos[i], pos[i + 3], pos[i + 6]) > x1
        || Math.max(pos[i + 1], pos[i + 4], pos[i + 7]) < y0 || Math.min(pos[i + 1], pos[i + 4], pos[i + 7]) > y1) continue;
      // Любое пересечение с пустотой (центр длинного узкого треугольника бывает снаружи): снаружи пустоты
      // место грани закрывает плита перекрытия этажа
      const t: Pt[] = [[pos[i], pos[i + 1]], [pos[i + 3], pos[i + 4]], [pos[i + 6], pos[i + 7]]];
      const probes: Pt[] = [...t, [(t[0][0] + t[1][0] + t[2][0]) / 3, (t[0][1] + t[1][1] + t[2][1]) / 3],
        ...t.map((p, k): Pt => [(p[0] + t[(k + 1) % 3][0]) / 2, (p[1] + t[(k + 1) % 3][1]) / 2])];
      const hit = probes.some(([x, y]) => inside(x, y))
        || rings.some((poly) => poly.some((r) => r.some((q) => pointInLocalRing(q, t))))
        || rings.some((poly) => poly.some((r) => r.some((q, k) => t.some((p, m) => segmentsCross(q, r[(k + 1) % r.length], p, t[(m + 1) % 3])))));
      if (hit) pos.fill(0, i, i + 9);
    }
  }

  /** Обводка контуров под частями: серая, у выделенного — цветом выделения. */
  private applyStrokes(g: MeshGroup) {
    g.disposeStrokes();
    const lines: number[] = [], colors: number[] = [];
    const focusGroup = g === this.groups.get(FOCUS_GROUP);
    // Выделенный плоский след в режиме здания: тонкую линию трудно разглядеть — толще и с заливкой
    const fat: number[] = [], fill: number[] = [];
    for (const it of g.items) {
      // Голый контур отношения в просмотре не рисуется объёмом — только тонкой обводкой
      const bare = !focusGroup && this.viewHidden.has(it.feature.key);
      if (!bare && (!(strokeOnly(g, it) || thinItem(it)) || g.hidden.has(it.feature.key))) continue;
      // Оболочка этажей: плоский объект целиком внутри соседних частей (навес в объёме подиума) — без обводки
      if (!strokeOnly(g, it) && it.full?.positions.length && !it.positions.length) continue;
      const c = this.selected.has(it.feature.key) || this.hovered === it.feature.key ? STROKE_SELECTED : STROKE_COLOUR;
      const z = bare || it.box.isEmpty() ? g.footprint : it.box.max.z;
      const selected = focusGroup && strokeOnly(g, it) && this.selected.has(it.feature.key);
      for (const p of it.feature.polygons) {
        for (const ring of [p.outer, ...p.inners]) {
          const pts = ring.map(g.toLocal);
          for (let i = 0; i < pts.length; i++) {
            const a = pts[i], b = pts[(i + 1) % pts.length];
            (selected ? fat : lines).push(a[0], a[1], z, b[0], b[1], z);
            if (!selected) colors.push(c.r, c.g, c.b, c.r, c.g, c.b);
          }
        }
        if (selected) fill.push(...bottomTriangles([{ outer: p.outer.map(g.toLocal), inners: p.inners.map((r) => r.map(g.toLocal)) }], z));
      }
    }
    if (fat.length) {
      const canvas = this.map!.getCanvas();
      const dpr = canvas.width / Math.max(1, canvas.clientWidth);
      const geo = new LineSegmentsGeometry();
      geo.setPositions(fat);
      const mat = new LineMaterial({ color: STROKE_SELECTED.getHex(), linewidth: SELECTED_STROKE_PX * dpr });
      mat.resolution.set(canvas.width, canvas.height);
      const line = new LineSegments2(geo, mat);
      line.frustumCulled = false;
      const fg = new THREE.BufferGeometry();
      fg.setAttribute('position', new THREE.Float32BufferAttribute(fill, 3));
      const mesh = new THREE.Mesh(fg, new THREE.MeshBasicMaterial({ color: STROKE_SELECTED, transparent: true, opacity: SELECTED_FILL_OPACITY,
        side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
      mesh.frustumCulled = false;
      // Закрытая объёмами часть — пунктиром сквозь них, как скрытые рёбра выделенной части
      const hg = new THREE.BufferGeometry();
      hg.setAttribute('position', new THREE.Float32BufferAttribute(fat, 3));
      const hidden = new THREE.LineSegments(hg, HIDDEN_EDGE_MATERIAL.clone());
      hidden.computeLineDistances();
      hidden.frustumCulled = false;
      hidden.renderOrder = 999; // после зданий: глубина уже записана
      g.strokeSelected = [line, mesh, hidden];
      g.scene.add(line, mesh, hidden);
    }
    if (!lines.length) return;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
    geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    g.strokes = new THREE.LineSegments(geom, STROKE_MATERIAL);
    g.strokes.frustumCulled = false;
    g.scene.add(g.strokes);
  }

  /**
   * Контуры рёбер: считаются по зданиям и кешируются на них (EdgesGeometry на весь тайл — ~150 мс,
   * а тайл пересобирается при каждой порции крыш), при слиянии только склеиваются.
   */
  private applyEdges(g: MeshGroup, exclude?: Set<string>) {
    g.disposeEdges();
    this.applyIssueEdges(g);
    // Пересборка тайла: рёбра выделенного — по новым треугольникам (в режиме здания ими ведают его правки)
    if (g !== this.groups.get(FOCUS_GROUP)) this.updateSelEdges(g);
    if (!this.graphics.edges || !g.mesh) return;
    g.edges = edgeLines(g.items.filter((it) => !exclude?.has(it.feature.key) && !g.hidden.has(it.feature.key) && !strokeOnly(g, it)), EDGE_MATERIAL, !!this.graphics.partSeams);
    if (this.level && g === this.groups.get(FOCUS_GROUP)) {
      const positions = g.edges.geometry.getAttribute('position').array as Float32Array;
      const corners: Pt[]=[];
      // Classify corners on the merged exterior, not on each part: a corner
      // of two adjoining boxes can be a straight facade seam in the building.
      const section=this.sectionAt(g,this.level.floor+0.1);
      const rings=section?.flatMap(p=>p.map(r=>r.slice(0,-1) as Pt[])) ?? [];
      for(const ring of rings)for(let i=0;i<ring.length;i++){
        const a=ring[(i+ring.length-1)%ring.length],b=ring[i],c=ring[(i+1)%ring.length];
        const ux=b[0]-a[0],uy=b[1]-a[1],vx=c[0]-b[0],vy=c[1]-b[1];
        if(Math.abs(ux*vy-uy*vx)>Math.hypot(ux,uy)*Math.hypot(vx,vy)*Math.sin(5*Math.PI/180))corners.push(b);
      }
      g.edges.geometry.setAttribute('position', new THREE.BufferAttribute(trimIndoorBuildingEdges(positions, this.indoorEdgeOccluders, corners), 3));
    }
    g.scene.add(g.edges);
    if (this.wireframe && g === this.groups.get(FOCUS_GROUP)) {
      const positions=wireframeEdges([g.edges,...(this.indoorObj?[this.indoorObj]:[])],this.level?.floor);
      const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.BufferAttribute(positions,3));
      const material=new THREE.LineDashedMaterial({color:0x555555,dashSize:.25,gapSize:.15,depthFunc:THREE.GreaterDepth,depthWrite:false,clippingPlanes:MATERIAL.clippingPlanes});
      const hidden=new THREE.LineSegments(geometry,material);hidden.computeLineDistances();hidden.renderOrder=998;hidden.frustumCulled=false;
      g.wireHidden=hidden;g.scene.add(hidden);
    }
  }

  private issueLevels = new Map<string, 'error' | 'warning'>();
  /** Области проблем (непокрытый частями участок контура) — заливкой на земле. */
  private issueAreas: IssueArea[] = [];
  private issueFills = new WeakMap<MeshGroup, THREE.Mesh[]>();
  private issueEdges = new WeakMap<MeshGroup, LineSegments2[]>();

  /** Подсветить рёбрами объёмы с проблемами проверки (пусто — снять). */
  setIssueHighlight(levels: Map<string, 'error' | 'warning'>, areas: IssueArea[] = []) {
    this.issueLevels = levels;
    this.issueAreas = areas;
    for (const g of this.activeGroups()) this.applyIssueEdges(g);
    this.map?.triggerRepaint();
  }

  private linkedLines: LineSegments2[] = [];

  /**
   * Рёбра объектов сцены режима здания, которые текущая правка тянет за собой (соседи с общими узлами),
   * по их текущей (в т. ч. предварительной) геометрии; сквозь другие объекты — бледнее. Пусто — снять.
   */
  setLinked(keys: string[]) {
    for (const l of this.linkedLines) { l.geometry.dispose(); l.material.dispose(); l.parent?.remove(l); }
    this.linkedLines = [];
    const g = this.groups.get(FOCUS_GROUP);
    const items = g ? keys.map((k) => g.byKey.get(k)).filter((it): it is Item => !!it && !g.hidden.has(it.feature.key) && !!it.positions.length) : [];
    if (g && this.map && items.length) {
      const canvas = this.map.getCanvas();
      const dpr = canvas.width / Math.max(1, canvas.clientWidth);
      for (const it of items) it.edges ??= itemEdges(it);
      const pos = new Float32Array(items.reduce((n, it) => n + it.edges!.length, 0));
      let o = 0;
      for (const it of items) { pos.set(it.edges!, o); o += it.edges!.length; }
      for (const xray of [false, true]) {
        const geo = new LineSegmentsGeometry();
        geo.setPositions(pos);
        const mat = new LineMaterial({ color: LINKED_COLOUR, linewidth: (xray ? ISSUE_XRAY_WIDTH_PX : ISSUE_WIDTH_PX) * dpr,
          transparent: xray, opacity: xray ? 0.35 : 1, depthTest: !xray, depthWrite: false });
        mat.resolution.set(canvas.width, canvas.height);
        const line = new LineSegments2(geo, mat);
        line.frustumCulled = false;
        line.renderOrder = 14 + (xray ? 1 : 0);
        g.scene.add(line);
        this.linkedLines.push(line);
      }
    }
    this.map?.triggerRepaint();
  }

  private fixLines: LineSegments2[] = [];
  private fixFrame = 0;

  /**
   * Превью автоисправления: каркас объекта сцены режима здания по исправленным тегам, по кругу перетекающий
   * из текущего вида в исправленный (min_height — объём отрывается от земли). Рёбра одной топологии
   * (меняются только высоты) — плавный морфинг, иначе — смена прозрачности. Без отличий в геометрии
   * и без аргумента — снять.
   */
  setFixPreview(f: Feature3D | undefined) {
    cancelAnimationFrame(this.fixFrame);
    for (const l of this.fixLines) { l.geometry.dispose(); l.material.dispose(); l.parent?.remove(l); }
    this.fixLines = [];
    const g = this.groups.get(FOCUS_GROUP);
    const cur = f && g?.byKey.get(f.key);
    if (!f || !g || !cur || !this.map || g.hidden.has(f.key) || !cur.positions.length) return void this.map?.triggerRepaint();
    const from = (cur.edges ??= itemEdges(cur));
    let to: Float32Array;
    try { to = itemEdges(buildItem(g, f)); } catch { return; }
    if (to.length === from.length && to.every((v, i) => Math.abs(v - from[i]) < 1e-3)) return;
    const canvas = this.map.getCanvas();
    const dpr = canvas.width / Math.max(1, canvas.clientWidth);
    const make = (pos: Float32Array, xray: boolean) => {
      const geo = new LineSegmentsGeometry();
      geo.setPositions(pos);
      const mat = new LineMaterial({ color: FIX_COLOUR, linewidth: (xray ? ISSUE_XRAY_WIDTH_PX : ISSUE_WIDTH_PX) * dpr,
        transparent: true, opacity: xray ? 0.45 : 1, depthTest: !xray, depthWrite: false });
      mat.resolution.set(canvas.width, canvas.height);
      const line = new LineSegments2(geo, mat);
      line.frustumCulled = false;
      line.renderOrder = 16 + (xray ? 1 : 0);
      g.scene.add(line);
      this.fixLines.push(line);
      return line;
    };
    // Морфинг: одна пара линий с перемешиваемыми вершинами; иначе — старый и новый каркас попеременно
    const matched = matchSegments(from, to);
    const src = matched?.[0] ?? from, dst = matched?.[1] ?? to;
    const mixed = matched ? new Float32Array(src) : undefined;
    const pairs = mixed ? [[make(mixed, false), make(mixed, true)]] : [[make(from, false), make(from, true)], [make(to, false), make(to, true)]];
    const period = FIX_HOLD_FROM + FIX_MORPH + FIX_HOLD_TO;
    const start = performance.now();
    const tick = (now: number) => {
      const t = (now - start) % period;
      const k = Math.min(1, Math.max(0, (t - FIX_HOLD_FROM) / FIX_MORPH));
      const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2; // ease-in-out
      if (mixed) {
        for (let i = 0; i < mixed.length; i++) mixed[i] = src[i] + (dst[i] - src[i]) * e;
        for (const l of pairs[0]) {
          const attr = l.geometry.attributes.instanceStart as THREE.InterleavedBufferAttribute;
          (attr.data.array as Float32Array).set(mixed);
          attr.data.needsUpdate = true;
          l.geometry.computeBoundingSphere();
        }
      } else {
        pairs.forEach((pair, n) => pair.forEach((l, x) => { l.material.opacity = (n ? e : 1 - e) * (x ? 0.45 : 1); }));
      }
      this.map?.triggerRepaint();
      this.fixFrame = requestAnimationFrame(tick);
    };
    this.fixFrame = requestAnimationFrame(tick);
  }

  private applyIssueEdges(g: MeshGroup) {
    for (const l of this.issueEdges.get(g) ?? []) { l.geometry.dispose(); l.material.dispose(); g.scene.remove(l); }
    this.issueEdges.delete(g);
    for (const m of this.issueFills.get(g) ?? []) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); g.scene.remove(m); }
    this.issueFills.delete(g);
    if (!this.issueLevels.size || !this.map) return;
    const fills: THREE.Mesh[] = [];
    for (const a of this.issueAreas) {
      if (!g.byKey.has(a.key)) continue;
      const pos: number[] = [];
      const z = g.footprint + 0.05;
      for (const p of a.polygons) {
        const outer = p.outer.map((c) => new THREE.Vector2(...g.toLocal(c))), holes = p.inners.map((r) => r.map((c) => new THREE.Vector2(...g.toLocal(c))));
        const pts = [outer, ...holes].flat();
        for (const t of THREE.ShapeUtils.triangulateShape(outer, holes)) for (const i of t) pos.push(pts[i].x, pts[i].y, z);
      }
      if (!pos.length) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: ISSUE_COLOUR[a.level], transparent: true, opacity: 0.35,
        side: THREE.DoubleSide, depthWrite: false }));
      mesh.frustumCulled = false;
      mesh.renderOrder = 9;
      g.scene.add(mesh);
      fills.push(mesh);
    }
    if (fills.length) this.issueFills.set(g, fills);
    const canvas = this.map.getCanvas();
    const dpr = canvas.width / Math.max(1, canvas.clientWidth);
    const out: LineSegments2[] = [];
    for (const level of ['warning', 'error'] as const) {
      // Объём — по рёбрам; скрытый или плоский контур (под частями, голый контур отношения) — по кольцам на земле
      const items = g.items.filter((it) => this.issueLevels.get(it.feature.key) === level);
      if (!items.length) continue;
      const segs = items.map((it) => (strokeOnly(g, it) || g.hidden.has(it.feature.key) || !it.positions.length ? ringSegments(g, it, g.footprint) : (it.edges ??= itemEdges(it))));
      const pos = new Float32Array(segs.reduce((n, e) => n + e.length, 0));
      let o = 0;
      for (const e of segs) { pos.set(e, o); o += e.length; }
      const make = (width: number, xray: boolean) => {
        const geo = new LineSegmentsGeometry();
        geo.setPositions(pos);
        const mat = new LineMaterial({ color: ISSUE_COLOUR[level], linewidth: width * dpr, transparent: xray, opacity: xray ? 0.35 : 1,
          depthTest: !xray, depthWrite: false });
        mat.resolution.set(canvas.width, canvas.height);
        const line = new LineSegments2(geo, mat);
        line.frustumCulled = false;
        line.renderOrder = (level === 'error' ? 11 : 10) + (xray ? 2 : 0);
        return line;
      };
      const lines = make(ISSUE_WIDTH_PX, false), xray = make(ISSUE_XRAY_WIDTH_PX, true);
      g.scene.add(lines, xray);
      out.push(lines, xray);
    }
    this.issueEdges.set(g, out);
  }

  private paintGroup(g: MeshGroup) {
    for (const it of g.items) this.writeColors(g, it);
    const attr = g.mesh?.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
    if (attr) attr.needsUpdate = true;
    const glass = g.glass?.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
    if (glass) glass.needsUpdate = true;
  }

  private paintItem(g: MeshGroup, it: Item) {
    this.writeColors(g, it);
    const glassAttr = g.glass?.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
    if (glassAttr && glassRanges(it).length) glassAttr.needsUpdate = true;
    const attr = g.mesh?.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
    if (!attr) return;
    // Диапазоны копятся до загрузки в GPU (three сам очищает их после неё):
    // при смене выделения старое и новое здание часто лежат в одной группе.
    attr.addUpdateRange(it.start * 3, it.positions.length);
    attr.needsUpdate = true;
  }

  /**
   * Цвет вершин здания: стены/крыша из тегов (или белый/подсветка) × затемнение у земли:
   * - сходит на нет на min(AO_HEIGHT, AO_FADE_SHARE · высота) — у низких зданий только самый низ;
   * - глубина пропорциональна высоте до AO_HEIGHT — сарай в 2 м темнеет у земли лишь до ~85%.
   */
  private writeColors(g: MeshGroup, it: Item) {
    const attr = g.mesh?.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
    if (!attr) return;
    const colors = attr.array as Float32Array;
    const selected = this.selected.has(it.feature.key) || this.hovered === it.feature.key;
    const ao = this.graphics.groundAO;
    const fade = Math.max(0.5, Math.min(AO_HEIGHT, AO_FADE_SHARE * it.top));
    const depth = (1 - AO_MIN) * Math.min(1, it.top / AO_HEIGHT);
    const n = it.positions.length / 3;
    for (let v = 0; v < n; v++) {
      const base = selected ? HIGHLIGHT : this.monochrome ? MONOCHROME : v < it.wallVertices ? it.wall : v >= n - it.floorVertices ? FLOOR_SLAB : it.roof;
      let k = 1;
      if (ao) {
        const t = Math.min(1, Math.max(0, it.positions[v * 3 + 2] / fade));
        k = 1 - depth * (1 - t * t * (3 - 2 * t));
      }
      const o = (it.start + v) * 3;
      colors[o] = base.r * k;
      colors[o + 1] = base.g * k;
      colors[o + 2] = base.b * k;
    }
    // Стекло: свой цвет в обоих режимах (и без цветов), без затемнения у земли
    const glassAttr = g.glass?.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
    if (!glassAttr || it.glassStart < 0) return;
    const gc = glassAttr.array as Float32Array;
    const c = selected ? HIGHLIGHT : this.monochrome ? GLASS_MONO : GLASS;
    let o = it.glassStart * 3;
    for (const src of glassParts(it)) for (let v = 0; v < src.length; v += 3, o += 3) { gc[o] = c.r; gc[o + 1] = c.g; gc[o + 2] = c.b; }
  }
}

/** Рёбра нескольких объектов одним LineSegments. */
function edgeLines(items: Item[], material: THREE.LineBasicMaterial, seams = false): THREE.LineSegments {
  for (const it of items) it.edges ??= itemEdges(it);
  const parts = seams ? timed('рёбра: стыки частей', () => dropPartSeams(items as (Item & { edges: Float32Array })[], EDGE_ANGLE, PLANAR_ROOF_EDGE_ANGLE), () => `${items.length} объектов`) : items.map((it) => it.edges!);
  const lines = new Float32Array(parts.reduce((n, e) => n + e.length, 0));
  let o = 0;
  for (const e of parts) { lines.set(e, o); o += e.length; }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(lines, 3));
  const out = new THREE.LineSegments(geom, material);
  out.frustumCulled = false;
  return out;
}

/**
 * Рёбра здания: изломы круче EDGE_ANGLE и границы. Стык стен с крышей — всегда: у шпилей и крутых
 * пирамид угол между стеной и скатом меньше порога, и без этого граница стен пропадает.
 */
/** Крыши с кривыми поверхностями (купол, луковица, бочка): их грани — аппроксимация, изломы не рисуем. */
const CURVED_ROOFS = new Set(['dome', 'onion', 'round', 'cone', 'conical', 'spherical', 'apse_gabled']);
const PLANAR_ROOF_EDGE_ANGLE = 6;
const WALL_ROOF_EDGE_ANGLE = 1;

/**
 * Пары рёбер «до» и «после» для морфинга превью исправления: порядок рёбер в двух сборках разный, поэтому
 * сопоставляем по плану — концы с теми же x, y (меняются только высоты), внутри одной проекции — по высоте
 * по порядку, концы ребра — снизу вверх. Не сопоставилось (изменилась форма) — undefined.
 */
function matchSegments(a: Float32Array, b: Float32Array): [Float32Array, Float32Array] | undefined {
  if (a.length !== b.length) return undefined;
  const group = (arr: Float32Array) => {
    const m = new Map<string, number[][]>();
    for (let i = 0; i < arr.length; i += 6) {
      let p = [arr[i], arr[i + 1], arr[i + 2]], q = [arr[i + 3], arr[i + 4], arr[i + 5]];
      const pk = `${p[0].toFixed(2)},${p[1].toFixed(2)}`, qk = `${q[0].toFixed(2)},${q[1].toFixed(2)}`;
      // Концы по порядку: в плане, а у вертикального ребра — снизу вверх
      if (pk > qk || (pk === qk && p[2] > q[2])) [p, q] = [q, p];
      const k = pk < qk ? pk + ';' + qk : qk + ';' + pk;
      (m.get(k) ?? m.set(k, []).get(k)!).push([...p, ...q]);
    }
    for (const list of m.values()) list.sort((x, y) => x[2] + x[5] - y[2] - y[5]);
    return m;
  };
  const ga = group(a), gb = group(b);
  const outA = new Float32Array(a.length), outB = new Float32Array(b.length);
  let o = 0;
  for (const [k, la] of ga) {
    const lb = gb.get(k);
    if (!lb || lb.length !== la.length) return undefined;
    for (let i = 0; i < la.length; i++) { outA.set(la[i], o); outB.set(lb[i], o); o += 6; }
  }
  return [outA, outB];
}

/** Buffers are immutable here; moving previews modify only the merged mesh. */
const edgeCache = new WeakMap<Float32Array, { wallVertices: number; roofShape: string; edges: Float32Array }>();
function itemEdges(it: Item): Float32Array {
  const roofShape = it.tags['roof:shape'] ?? 'flat';
  const hit = edgeCache.get(it.positions);
  if (hit && hit.wallVertices === it.wallVertices && hit.roofShape === roofShape) return hit.edges;
  const edges = computeItemEdges(it);
  edgeCache.set(it.positions, { wallVertices: it.wallVertices, roofShape, edges });
  return edges;
}

/**
 * v.toFixed(2) из кеша: ключи вершин рёбер строятся из координат Float32Array, а они в здании и тайле
 * повторяются — toFixed на каждую было заметной долей сборки рёбер. Строки те же, что у toFixed.
 */
const fixedCache = new Map<number, string>();
function fixed2(v: number): string {
  let s = fixedCache.get(v);
  if (s === undefined) {
    if (fixedCache.size > 200000) fixedCache.clear();
    fixedCache.set(v, s = v.toFixed(2));
  }
  return s;
}

function computeItemEdges(it: Item): Float32Array {
  if (it.wallVertices * 3 >= it.positions.length) return edgePass(it.positions, [EDGE_ANGLE]).full[0];
  // Один проход по всей сетке: рёбра при обычном угле, острые стыки (стена/крыша) и — снимком на границе
  // стен — отдельно стены: их верхний край — граница (одна грань), он есть при любом угле
  const pass = edgePass(it.positions, [EDGE_ANGLE, WALL_ROOF_EDGE_ANGLE], it.wallVertices);
  const [all, sharp] = pass.full;
  const walls = pass.prefix![0];
  // У плоских скатов скрываем лишь почти плоские стыки, сохраняя изломы мансарды. У кривых
  // (купол, луковица, бочка) не добавляем рёбра аппроксимации.
  const roof = !CURVED_ROOFS.has(it.tags['roof:shape'] ?? 'flat')
    ? edgePass(it.positions.subarray(it.wallVertices * 3), [PLANAR_ROOF_EDGE_ANGLE]).full[0] : new Float32Array();
  const key = (a: Float32Array, i: number) => {
    const p = `${fixed2(a[i])},${fixed2(a[i + 1])},${fixed2(a[i + 2])}`;
    const q = `${fixed2(a[i + 3])},${fixed2(a[i + 4])},${fixed2(a[i + 5])}`;
    return p < q ? p + q : q + p;
  };
  // Стык стены с крышей и изломы скатов — только где грани не в одной плоскости: у вальмы и полувальмы
  // на неправильном контуре скат бывает вертикальным и продолжает стену — там ребра нет
  const creases = new Set<string>();
  for (let i = 0; i < sharp.length; i += 6) creases.add(key(sharp, i));
  const seen = new Set<string>();
  for (let i = 0; i < all.length; i += 6) seen.add(key(all, i));
  const extra: number[] = [];
  for (const src of [walls, roof]) {
    for (let i = 0; i < src.length; i += 6) {
      const k = key(src, i);
      if (seen.has(k) || !creases.has(k)) continue;
      seen.add(k);
      for (let j = 0; j < 6; j++) extra.push(src[i + j]);
    }
  }
  const out = new Float32Array(all.length + extra.length);
  out.set(all);
  out.set(extra, all.length);
  return dropFlatSeams(out, it.positions);
}

/**
 * Убрать отрезки внутри плоскости: фронтон и стена под ним, вертикальный скат вальмы и стена — одна плоскость,
 * но их вершины не совпадают (Т-стык), и EdgesGeometry считает стык краем. Отрезок отбрасываем, если все
 * треугольники, на сторонах которых он лежит, параллельны (и их больше одного). Заодно — нулевые отрезки.
 */
function dropFlatSeams(segs: Float32Array, positions: Float32Array): Float32Array {
  const tris = positions.length / 9;
  const P = positions;
  const vkey = (arr: ArrayLike<number>, o: number) => `${fixed2(arr[o])},${fixed2(arr[o + 1])},${fixed2(arr[o + 2])}`;
  const ekey = (k1: string, k2: string) => (k1 < k2 ? k1 + '|' + k2 : k2 + '|' + k1);
  // Точные стыки проверяем по нормалям тоже: стена и фронтон могут иметь
  // противоположный порядок вершин, и EdgesGeometry оставляет плоский стык.
  const shared = new Map<string, number[]>();
  // Ключ вершины — один раз на вершину, а не на каждую сторону каждого треугольника
  const vk: string[] = new Array(P.length / 3);
  for (let v = 0; v < vk.length; v++) vk[v] = vkey(P, v * 3);
  const normals = new Float32Array(tris * 3);
  const triangleBounds = new Float64Array(tris * 6);
  // Вырожденные треугольники (у фронтонов над карнизом — нулевой высоты) не в счёт: нормаль у них случайная
  const degenerate = new Uint8Array(tris);
  for (let t = 0; t < tris; t++) {
    const o = t * 9;
    for (let k = 0; k < 3; k++) {
      triangleBounds[t * 6 + k] = Math.min(P[o + k], P[o + 3 + k], P[o + 6 + k]);
      triangleBounds[t * 6 + 3 + k] = Math.max(P[o + k], P[o + 3 + k], P[o + 6 + k]);
    }
    const ux = P[o + 3] - P[o], uy = P[o + 4] - P[o + 1], uz = P[o + 5] - P[o + 2];
    const vx = P[o + 6] - P[o], vy = P[o + 7] - P[o + 1], vz = P[o + 8] - P[o + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    // Относительный порог: «щепки» с высотой в миллиметры (подъём фронтона на 1 мм) — тоже вырожденные
    if (l < 1e-3 * Math.max(ux * ux + uy * uy + uz * uz, vx * vx + vy * vy + vz * vz)) { degenerate[t] = 1; continue; }
    normals[t * 3] = nx / l; normals[t * 3 + 1] = ny / l; normals[t * 3 + 2] = nz / l;
    for (let k = 0; k < 3; k++) {
      const key = ekey(vk[t * 3 + k], vk[t * 3 + (k + 1) % 3]);
      const list = shared.get(key) ?? [];
      list.push(t);
      shared.set(key, list);
    }
  }
  const EPS = 0.02;
  // Триангулятор может снова склеить коллинеарные стороны. Разделяем
  // кандидаты на рёбра в Т-узлах: на одной части может быть излом,
  // а на продолжении — две почти совпадающие плоскости.
  const split: number[] = [];
  const vertices = new Map<string, number>();
  for (let o = 0; o < P.length; o += 3) vertices.set(vk[o / 3], o);
  // Вершины по x: каждому отрезку — только попадающие в его габарит по x (двоичный поиск), а не все
  const byX = [...vertices.values()].sort((a, b) => P[a] - P[b]);
  const firstX = (x: number) => {
    let lo = 0, hi = byX.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (P[byX[mid]] < x) lo = mid + 1; else hi = mid; }
    return lo;
  };
  for (let i = 0; i < segs.length; i += 6) {
    const p = [segs[i], segs[i + 1], segs[i + 2]];
    const d = [segs[i + 3] - p[0], segs[i + 4] - p[1], segs[i + 5] - p[2]];
    const len = Math.hypot(...d);
    if (len < EPS) continue;
    const cuts = [0, 1];
    const low = p.map((v, k) => Math.min(v, v + d[k]) - 0.001);
    const high = p.map((v, k) => Math.max(v, v + d[k]) + 0.001);
    for (let n = firstX(low[0]); n < byX.length && P[byX[n]] <= high[0]; n++) {
      const o = byX[n];
      if (P[o] < low[0] || P[o] > high[0] || P[o + 1] < low[1] || P[o + 1] > high[1] || P[o + 2] < low[2] || P[o + 2] > high[2]) continue;
      const t = d.reduce((s, v, k) => s + v * (P[o + k] - p[k]), 0) / (len * len);
      if (t * len < EPS || (1 - t) * len < EPS) continue;
      if (Math.hypot(...d.map((v, k) => P[o + k] - p[k] - t * v)) < 0.001) cuts.push(t);
    }
    cuts.sort((a, b) => a - b);
    for (let k = 1; k < cuts.length; k++) {
      if ((cuts[k] - cuts[k - 1]) * len < EPS) continue;
      for (const t of [cuts[k - 1], cuts[k]]) for (let j = 0; j < 3; j++) split.push(p[j] + t * d[j]);
    }
  }
  segs = new Float32Array(split);
  const keep: number[] = [];
  const near = flatSeamGrid(triangleBounds, degenerate, tris, segs.length / 6, 4 * EPS);
  for (let i = 0; i < segs.length; i += 6) {
    const px = segs[i], py = segs[i + 1], pz = segs[i + 2];
    let dx = segs[i + 3] - px, dy = segs[i + 4] - py, dz = segs[i + 5] - pz;
    const len = Math.hypot(dx, dy, dz);
    if (len < EPS) continue;
    const exact = shared.get(ekey(vkey(segs, i), vkey(segs, i + 3)));
    if (exact && exact.length >= 2) {
      const first = exact[0];
      const flat = exact.every((t) => Math.abs(normals[t * 3] * normals[first * 3] + normals[t * 3 + 1] * normals[first * 3 + 1] + normals[t * 3 + 2] * normals[first * 3 + 2]) >= FLAT_COS);
      if (!flat) for (let j = 0; j < 6; j++) keep.push(segs[i + j]);
      continue;
    }
    dx /= len; dy /= len; dz /= len;
    // Расстояние точки до прямой отрезка и её положение вдоль него
    const off = (o: number) => {
      const ex = P[o] - px, ey = P[o + 1] - py, ez = P[o + 2] - pz;
      return Math.hypot(ey * dz - ez * dy, ez * dx - ex * dz, ex * dy - ey * dx);
    };
    const along = (o: number) => (P[o] - px) * dx + (P[o + 1] - py) * dy + (P[o + 2] - pz) * dz;
    const tm = len / 2;
    let first = -1, flat = true, count = 0;
    const mx = px + dx * tm, my = py + dy * tm, mz = pz + dz * tm;
    // Кандидаты по возрастанию номера — тот же порядок, что при полном переборе (first — первый подходящий)
    const cands = near?.(mx, my);
    const total = cands ? cands.length : tris;
    for (let n = 0; n < total && flat; n++) {
      const t = cands ? cands[n] : n;
      if (degenerate[t]) continue;
      const b = t * 6, margin = 2 * EPS;
      if (mx < triangleBounds[b] - margin || mx > triangleBounds[b + 3] + margin
        || my < triangleBounds[b + 1] - margin || my > triangleBounds[b + 4] + margin
        || mz < triangleBounds[b + 2] - margin || mz > triangleBounds[b + 5] + margin) continue;
      for (let k = 0; k < 3; k++) {
        const oa = t * 9 + k * 3, ob = t * 9 + ((k + 1) % 3) * 3;
        if (off(oa) > EPS || off(ob) > EPS) continue;
        const ta = along(oa), tb = along(ob);
        if (tm < Math.min(ta, tb) - EPS || tm > Math.max(ta, tb) + EPS) continue;
        count++;
        if (first < 0) first = t;
        else if (Math.abs(normals[t * 3] * normals[first * 3] + normals[t * 3 + 1] * normals[first * 3 + 1] + normals[t * 3 + 2] * normals[first * 3 + 2]) < FLAT_COS) flat = false;
        break;
      }
    }
    if (!(flat && count > 1)) for (let j = 0; j < 6; j++) keep.push(segs[i + j]);
  }
  return new Float32Array(keep);
}
const FLAT_COS = Math.cos(THREE.MathUtils.degToRad(1));


/**
 * Сетка треугольников по xy для поиска тех, на сторонах которых может лежать середина отрезка: у больших
 * зданий (сотни треугольников и отрезков) полный перебор — квадратичный. Списки клеток идут по возрастанию
 * номера треугольника. undefined — сетка не окупится, перебираем всё.
 */
function flatSeamGrid(bounds: Float64Array, degenerate: Uint8Array, tris: number, segs: number, margin: number):
  ((x: number, y: number) => number[]) | undefined {
  if (tris * segs < 5000) return;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let t = 0; t < tris; t++) {
    if (degenerate[t]) continue;
    x0 = Math.min(x0, bounds[t * 6]); y0 = Math.min(y0, bounds[t * 6 + 1]);
    x1 = Math.max(x1, bounds[t * 6 + 3]); y1 = Math.max(y1, bounds[t * 6 + 4]);
  }
  if (!(x1 >= x0)) return;
  const N = 16;
  const cx = Math.max((x1 - x0) / N, 1e-6), cy = Math.max((y1 - y0) / N, 1e-6);
  const cell = (v: number, o: number, c: number) => Math.min(N - 1, Math.max(0, Math.floor((v - o) / c)));
  const cells: number[][] = Array.from({ length: N * N }, () => []);
  for (let t = 0; t < tris; t++) {
    if (degenerate[t]) continue;
    const b = t * 6;
    const i0 = cell(bounds[b] - margin, x0, cx), i1 = cell(bounds[b + 3] + margin, x0, cx);
    const j0 = cell(bounds[b + 1] - margin, y0, cy), j1 = cell(bounds[b + 4] + margin, y0, cy);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) cells[j * N + i].push(t);
  }
  return (x, y) => cells[cell(y, y0, cy) * N + cell(x, x0, cx)];
}

/** Габариты всей группы — чтобы не перебирать здания тайлов, мимо которых луч проходит. */
const FOCUS_GROUP = '@focus';
/** Пересечение луча с объектом сцены режима здания. */
export interface FocusHit { key: string; t: number; local: THREE.Vector3; face: 'wall' | 'roof' | 'bottom' }

/** Отрезки ab и cd пересекаются (собственно, не касанием). */
function segmentsCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o = (p: Pt, q: Pt, r: Pt) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

function pointInLocalRing([x, y]: Pt, ring: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Оболочка здания для плана этажа: indoor-стены и крышки не выходят наружу сквозь скаты крыш. */
interface Shell {
  /** Низ крыши над (x, y) для пола z0 — по частям, стоящим не выше пола; undefined — над точкой нет оболочки. */
  at(x: number, y: number, z0: number): number | undefined;
  /** Доли (0…1) отрезка a→b, где крыша над ним ломается или обрывается: рёбра скатов и контуры частей. */
  breaks(ax: number, ay: number, bx: number, by: number): number[];
}

const SHELL_CELL = 4;
/** Часть начинается не выше пола этажа (с этим допуском, м) — её крыша накрывает этаж. */
const SHELL_LEVEL_TOL = 0.5;
/** Точка ближе этого (м) к контуру части — считается под её крышей. */
const SHELL_EDGE_TOL = 0.05;

function buildShell(g: MeshGroup): Shell {
  type Part = { min: number; top: number; flat: boolean; polys: { outer: Pt[]; inners: Pt[][] }[]; box: [number, number, number, number] };
  const parts: Part[] = [];
  /** Треугольники скатов (x, y, z × 3) и номер части; сетка — номера треугольников и отрезки контуров/рёбер. */
  const tris: number[] = [], triPart: number[] = [];
  // Ключи клеток — числа: строки на каждый запрос at() (десятки тысяч на план) заметно дороже
  const partGrid = new Map<number, number[]>();
  const triGrid = new Map<number, number[]>(), segGrid = new Map<number, number[][]>();
  const cellKey = (i: number, j: number) => (i + 32768) * 65536 + (j + 32768);
  const cellAt = (x: number, y: number) => cellKey(Math.floor(x / SHELL_CELL), Math.floor(y / SHELL_CELL));
  const cellsOf = (x0: number, y0: number, x1: number, y1: number) => {
    const out: number[] = [];
    for (let i = Math.floor(Math.min(x0, x1) / SHELL_CELL); i <= Math.floor(Math.max(x0, x1) / SHELL_CELL); i++)
      for (let j = Math.floor(Math.min(y0, y1) / SHELL_CELL); j <= Math.floor(Math.max(y0, y1) / SHELL_CELL); j++) out.push(cellKey(i, j));
    return out;
  };
  const addSeg = (x0: number, y0: number, x1: number, y1: number) => {
    const sg = [x0, y0, x1, y1];
    for (const c of cellsOf(x0, y0, x1, y1)) (segGrid.get(c) ?? segGrid.set(c, []).get(c)!).push(sg);
  };
  const hasParts = g.items.some((it) => it.feature.kind === 'part' && !g.hidden.has(it.feature.key));
  for (const it of g.items) {
    if (g.hidden.has(it.feature.key) || g.flat.has(it.feature.key)) continue;
    if (hasParts && it.feature.kind === 'building' && it.feature.hasParts) continue;
    const h = computeHeights(it.tags);
    const polys = (g.renderFootprints.get(it.feature.key) ?? it.feature.polygons).map((p) => ({ outer: p.outer.map(g.toLocal), inners: p.inners.map((r) => r.map(g.toLocal)) }));
    const box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const p of polys) for (const [x, y] of p.outer) { box[0] = Math.min(box[0], x); box[1] = Math.min(box[1], y); box[2] = Math.max(box[2], x); box[3] = Math.max(box[3], y); }
    if (!(box[0] <= box[2])) continue;
    const flat = h.roofShape === 'flat' || h.roofHeight <= 0;
    const idx = parts.push({ min: g.lift?.get(it.feature.key) ?? h.min, top: flat ? h.wallTop : h.top, flat, polys, box }) - 1;
    for (const cell of cellsOf(box[0] - SHELL_EDGE_TOL, box[1] - SHELL_EDGE_TOL, box[2] + SHELL_EDGE_TOL, box[3] + SHELL_EDGE_TOL))
      (partGrid.get(cell) ?? partGrid.set(cell, []).get(cell)!).push(idx);
    for (const p of polys) for (const r of [p.outer, ...p.inners]) for (let i = 0; i < r.length; i++) addSeg(...r[i], ...r[(i + 1) % r.length]);
    if (flat) continue;
    // Скаты — треугольники крыши (между стенами и перекрытиями); вертикальные (торцы) не в счёт.
    // Исходные, а не оболочка: скат под соседней частью — тоже крыша над этим местом
    const pos = it.full?.positions ?? it.positions;
    for (let o = (it.full?.wallVertices ?? it.wallVertices) * 3; o + 9 <= pos.length - it.floorVertices * 3; o += 9) {
      const [x0, y0, x1, y1, x2, y2] = [pos[o], pos[o + 1], pos[o + 3], pos[o + 4], pos[o + 6], pos[o + 7]];
      if (Math.abs((x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)) < 1e-6) continue;
      const t = tris.length / 9;
      for (let k = 0; k < 9; k++) tris.push(pos[o + k]);
      triPart.push(idx);
      for (const c of cellsOf(Math.min(x0, x1, x2), Math.min(y0, y1, y2), Math.max(x0, x1, x2), Math.max(y0, y1, y2))) (triGrid.get(c) ?? triGrid.set(c, []).get(c)!).push(t);
      addSeg(x0, y0, x1, y1); addSeg(x1, y1, x2, y2); addSeg(x2, y2, x0, y0);
    }
  }
  // Внутри части или на её контуре (стена по границе двух частей — под крышей более высокой)
  const inside = (p: Part, x: number, y: number) => {
    const e = SHELL_EDGE_TOL;
    if (x < p.box[0] - e || x > p.box[2] + e || y < p.box[1] - e || y > p.box[3] + e) return false;
    const q: Pt = [x, y];
    for (const poly of p.polys) if (pointInLocalRing(q, poly.outer) && !poly.inners.some((r) => pointInLocalRing(q, r))) return true;
    for (const poly of p.polys) for (const r of [poly.outer, ...poly.inners]) {
      for (let i = 0; i < r.length; i++) {
        const a = r[i], b = r[(i + 1) % r.length], dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
        const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l2)) : 0;
        const ex = x - a[0] - dx * t, ey = y - a[1] - dy * t;
        if (ex * ex + ey * ey < e * e) return true;
      }
    }
    return false;
  };
  return {
    at(x, y, z0) {
      // Скат над точкой по каждой части: накрывающий треугольник (наивысший), иначе ближайший —
      // для точек на самом контуре части
      const roof = new Map<number, { score: number; z: number }>();
      const cell = cellAt(x, y);
      for (const t of triGrid.get(cell) ?? []) {
        // Скаты частей выше пола этажа не в счёт (ниже их тоже отсеет проверка части) — не считаем
        if (parts[triPart[t]].min > z0 + SHELL_LEVEL_TOL) continue;
        const o = t * 9;
        const x0 = tris[o], y0 = tris[o + 1], z0t = tris[o + 2], x1 = tris[o + 3], y1 = tris[o + 4], z1t = tris[o + 5], x2 = tris[o + 6], y2 = tris[o + 7], z2t = tris[o + 8];
        const d = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
        const l0 = ((y1 - y2) * (x - x2) + (x2 - x1) * (y - y2)) / d, l1 = ((y2 - y0) * (x - x2) + (x0 - x2) * (y - y2)) / d, l2 = 1 - l0 - l1;
        const score = Math.min(0, l0, l1, l2);
        if (score < -0.05) continue;
        const z = l0 * z0t + l1 * z1t + l2 * z2t, p = triPart[t], cur = roof.get(p);
        if (!cur || score > cur.score + 1e-9 || (score >= cur.score - 1e-9 && z > cur.z)) roof.set(p, { score, z });
      }
      let best: number | undefined;
      for (const i of partGrid.get(cell) ?? []) {
        const p = parts[i];
        if (p.min > z0 + SHELL_LEVEL_TOL || !inside(p, x, y)) continue;
        const z = p.flat ? p.top : roof.get(i)?.z ?? p.top;
        best = best === undefined ? z : Math.max(best, z);
      }
      return best;
    },
    breaks(ax, ay, bx, by) {
      const out: number[] = [];
      const seen = new Set<number[]>();
      const dx = bx - ax, dy = by - ay;
      for (const c of cellsOf(ax, ay, bx, by)) for (const sg of segGrid.get(c) ?? []) {
        if (seen.has(sg)) continue;
        seen.add(sg);
        const [px, py, qx, qy] = sg, ex = qx - px, ey = qy - py;
        const den = dx * ey - dy * ex;
        if (Math.abs(den) < 1e-12) continue;
        const t = ((px - ax) * ey - (py - ay) * ex) / den, u = ((px - ax) * dy - (py - ay) * dx) / den;
        if (t > 0 && t < 1 && u >= -1e-9 && u <= 1 + 1e-9) out.push(t);
      }
      return out.sort((p, q) => p - q);
    },
  };
}

/** Отрезок стены на плане (x0, y0, x1, y1), локальные метры. */
type PlanSeg = [number, number, number, number];
/** Клетки сетки 4 м, которые задевает прямоугольник отрезка (с отступом pad). */
function planCells(x0: number, y0: number, x1: number, y1: number, pad: number): string[] {
  const out: string[] = [];
  for (let i = Math.floor((Math.min(x0, x1) - pad) / 4); i <= Math.floor((Math.max(x0, x1) + pad) / 4); i++)
    for (let j = Math.floor((Math.min(y0, y1) - pad) / 4); j <= Math.floor((Math.max(y0, y1) + pad) / 4); j++) out.push(`${i},${j}`);
  return out;
}

/** Участки ребра a→b (доли 0…1), не закрытые уже стоящими стенами, — стена ставится только на них. */
/** mergeDist — насколько далеко может стоять стена, закрывающая ребро. */
function uncoveredSpans(ax: number, ay: number, bx: number, by: number, segments: Iterable<PlanSeg>, mergeDist = WALL_MERGE_DIST): [number, number][] {
  const len = Math.hypot(bx - ax, by - ay);
  if (len < 1e-6) return [];
  const dx = (bx - ax) / len, dy = (by - ay) / len;
  const cover: [number, number][] = [];
  for (const [px, py, qx, qy] of segments) {
    const l = Math.hypot(qx - px, qy - py);
    if (l < 1e-6 || Math.abs(((qx - px) * dx + (qy - py) * dy) / l) < WALL_MERGE_COS) continue;
    // Оба конца отрезка — близко к прямой ребра
    if (Math.abs((px - ax) * dy - (py - ay) * dx) > mergeDist || Math.abs((qx - ax) * dy - (qy - ay) * dx) > mergeDist) continue;
    const t0 = ((px - ax) * dx + (py - ay) * dy) / len, t1 = ((qx - ax) * dx + (qy - ay) * dy) / len;
    const lo = Math.max(0, Math.min(t0, t1)), hi = Math.min(1, Math.max(t0, t1));
    if ((hi - lo) * len > 1e-6) cover.push([lo, hi]);
  }
  // Короткий исходный сегмент — тоже стена. Порог 5 см относится
  // только к остаточным щелям после вычитания перекрывающих стен.
  if (!cover.length) return [[0, 1]];
  cover.sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  const minGap = 0.05 / len; // щели короче 5 см — не стена
  let at = 0;
  for (const [lo, hi] of cover) {
    if (lo - at > minGap) out.push([at, lo]);
    at = Math.max(at, hi);
  }
  if (1 - at > minGap) out.push([at, 1]);
  return out;
}

/** Сколько высоты этажа (м) на ребре может быть без стены здания, чтобы оно всё же считалось фасадом. */
const FACADE_GAP = 0.5;

/** Порядок слоёв пола плана: этаж целиком, площадки, коридоры, помещения — каждый следующий чуть выше. */
const PLAN_ORDER: IndoorKind[] = ['level', 'area', 'corridor', 'room', 'column', 'wall'];
/** Пол — на отметке этажа; наложения видов разведены partitionFloors, а не высотой. */
const planFloorZ = (it: IndoorItem) => it.z;

/**
 * «Додуманная» геометрия — только для вида (потолок нижнего этажа, торцы перекрытий): её нет в данных,
 * поэтому к ней нет привязки, выбора и наведения. Такие объекты не попадают в привязки (snaps, indoorSnaps),
 * окклюдеры рёбер и блокеры стекла; raycast у них пустой.
 */
export function decor<T extends THREE.Object3D>(o: T): T {
  o.userData.decor = true;
  o.raycast = () => {};
  return o;
}

/** Номер объекта для ключей кешей (по идентичности). */
const objIds = new WeakMap<object, number>();
let nextObjId = 0;
function objId(o: object): number {
  let id = objIds.get(o);
  if (id === undefined) objIds.set(o, id = ++nextObjId);
  return id;
}

/** Освободить геометрию плана этажа (материалы бледных планов общие). */
function disposePlanGroup(group: THREE.Object3D) {
  group.traverse((o) => { if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) o.geometry.dispose(); });
}

/** Новая сборка части совпадает со старой: те же треугольники, стекло и соседи. */
function sameItemGeometry(old: Item, item: Item): boolean {
  if (old.pending || item.pending || old.contacts !== item.contacts || old.floorVertices !== item.floorVertices
    || old.glassWalls !== item.glassWalls || old.glassRoof !== item.glassRoof
    || !old.wall.equals(item.wall) || !old.roof.equals(item.roof)) return false;
  const src = old.full ?? old;
  if (src.wallVertices !== item.wallVertices) return false;
  const a = src.positions, b = item.positions;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Подпись версии объекта для рендера: геометрия, теги и роль в здании. */
function shapeSig(f: Feature3D): string {
  return JSON.stringify([f.kind, f.hasParts, f.tags, f.polygons]);
}

/** Оболочка группы для планов этажей: та же, пока не менялись треугольники, скрытые и висящие части. */
function planShell(g: MeshGroup): Shell {
  const bases = g.items.map((it) => it.full?.positions ?? it.positions);
  const sig = `${[...g.hidden].sort().join(',')}|${[...g.flat].sort().join(',')}|${[...g.lift ?? []].map(([k, v]) => `${k}:${v}`).join(',')}`;
  const hit = g.planShell;
  if (hit && hit.sig === sig && hit.bases.length === bases.length && hit.bases.every((b, i) => b === bases[i])) return hit.shell;
  const shell = buildShell(g);
  g.planShell = { bases, sig, shell };
  return shell;
}

/** Куски стен под оболочкой: те же стены считаются и для каждого видимого сквозь второй свет этажа, и при каждом переключении. */
const shellPiecesCache = new WeakMap<Shell, Map<string, [number, number, number, number][]>>();

/** Стена a→b от пола z0 до top под оболочкой: куски [t0, t1, верх в t0, верх в t1]; где крыша ниже пола — стены нет. */
function shellPieces(shell: Shell | undefined, ax: number, ay: number, bx: number, by: number, z0: number, top: number): [number, number, number, number][] {
  const len = Math.hypot(bx - ax, by - ay);
  if (!shell || len < 1e-6) return [[0, 1, top, top]];
  const memo = shellPiecesCache.get(shell) ?? shellPiecesCache.set(shell, new Map()).get(shell)!;
  const key = `${ax},${ay},${bx},${by},${z0},${top}`;
  const hit = memo.get(key);
  if (hit) return hit;
  const pieces = shellPiecesImpl(shell, ax, ay, bx, by, z0, top, len);
  if (memo.size > 200000) memo.clear();
  memo.set(key, pieces);
  return pieces;
}

function shellPiecesImpl(shell: Shell, ax: number, ay: number, bx: number, by: number, z0: number, top: number, len: number): [number, number, number, number][] {
  const ts = [0, ...shell.breaks(ax, ay, bx, by), 1].filter((t, i, a) => i === 0 || t - a[i - 1] > 1e-9);
  const h = (t: number) => shell.at(ax + (bx - ax) * t, ay + (by - ay) * t, z0) ?? top;
  const pieces: [number, number, number, number][] = [];
  const push = (t0: number, t1: number, za: number, zb: number) => {
    const last = pieces[pieces.length - 1];
    // Продолжение без излома — тем же куском (необрезанная стена остаётся одной)
    if (last && Math.abs(last[1] - t0) < 1e-9 && Math.abs(last[3] - za) < 1e-6
      && Math.abs((last[3] - last[2]) / (last[1] - last[0]) - (zb - za) / (t1 - t0)) * len < 1e-4) { last[1] = t1; last[3] = zb; return; }
    pieces.push([t0, t1, za, zb]);
  };
  for (let i = 0; i + 1 < ts.length; i++) {
    const t0 = ts[i], t1 = ts[i + 1];
    // Крыша над промежутком между изломами — линейна: берём её у концов изнутри (скачок на контуре части — снаружи)
    const e = Math.min(1e-3 / len, (t1 - t0) / 4);
    const h0 = h(t0 + e), h1 = h(t1 - e);
    const k = (h1 - h0) / (t1 - t0 - 2 * e);
    const hA = h0 - k * e, hB = h1 + k * e;
    const cuts = [t0, t1];
    for (const lvl of [top, z0]) if ((hA - lvl) * (hB - lvl) < 0) cuts.push(t0 + ((t1 - t0) * (lvl - hA)) / (hB - hA));
    cuts.sort((p, q) => p - q);
    const zAt = (t: number) => Math.max(z0, Math.min(top, hA + ((hB - hA) * (t - t0)) / (t1 - t0)));
    for (let j = 0; j + 1 < cuts.length; j++) {
      const u0 = cuts[j], u1 = cuts[j + 1];
      if (u1 - u0 < 1e-9 || zAt((u0 + u1) / 2) <= z0 + 0.05) continue;
      push(u0, u1, zAt(u0), zAt(u1));
    }
  }
  return pieces;
}

export type SnapKind = 'vertex' | 'midpoint' | 'center' | 'shape' | 'grid' | 'perpendicular' | 'edge' | 'extension' | 'tracking' | 'tracked';
/** Ключ привязки к узлу сетки основания: фильтр snapAt пропускает его, если инструменту нужна и сетка. */
export const GRID_SNAP_KEY = '@grid';
/** axis, dist — у оси откладывания: номер оси якоря и расстояние от него со знаком. */
interface SnapPoint { kind: SnapKind; key: string; p: THREE.Vector3; label?: string; axis?: number; dist?: number }
interface SnapEdge { key: string; a: THREE.Vector3; b: THREE.Vector3 }
/** Привязка под курсором: тип, объект, точка (в метрах сцены режима и географически) и положение на экране. */
/** along — у продолжения ребра: конец ребра, от которого идёт продолжение (для пунктира). */
/**
 * Параметры поиска привязки: from — последняя точка инструмента (перпендикуляры); noEdge — без точек на рёбрах;
 * skip — какие точки (и рёбра с таким концом) не брать; extra — свои точки инструмента (например, середины сторон
 * до правки), наравне с точками сцены.
 */
export interface SnapOpts {
  from?: THREE.Vector3; noEdge?: boolean;
  /** Направление линии от from (ось, зафиксированная Shift); без него — от from к курсору. */
  dir?: THREE.Vector3;
  skip?: (p: THREE.Vector3, key: string, kind: SnapKind) => boolean;
  extra?: { kind: SnapKind; key: string; p: THREE.Vector3; label?: string }[];
}
export interface SnapHit { kind: SnapKind; key: string; local: THREE.Vector3; lngLat: LngLat; altitude: number; point: [number, number]; along?: THREE.Vector3; label?: string; /** У оси откладывания — расстояние от якоря со знаком. */ dist?: number }
const SNAP_RADIUS_PX = 12;
/** Длина стрелок осей в начале координат здания, м — одна клетка сетки. */
const AXES_PX = 56;
/** Длина стрелок осей у точки захвата инструментов, м. */
const TOOL_AXES_PX = 72;
/** Начало координат здания — бледнее значка инструмента. */
const FAINT_AXES_OPACITY = 0.7;
/** Привязки выделенного объекта «ближе» на столько px. */
const SNAP_SELECTED_BONUS_PX = 8;
/** Заслонённые привязки «дальше» на столько px — выигрывают, только если видимых рядом нет. */
const SNAP_HIDDEN_PENALTY_PX = 100;
/** Точка на ребре — последней: курсор у ребра почти всегда, она не должна перебивать вершины и середины. */
const SNAP_PRIORITY: Record<SnapKind, number> = { vertex: 0, midpoint: 1, perpendicular: 1, shape: 1, grid: 2, center: 2, extension: 4, edge: 3, tracked: 0, tracking: 2 };
/** Как далеко за конец ребра тянется его продолжение, м. */
const EXTENSION_M = 30;
/** Продолжение ловит курсор ближе обычного (px): иначе срабатывает почти везде вокруг здания. */
const EXTENSION_RADIUS_PX = 6;
/** Сколько держать курсор над ребром, чтобы включить привязку к его продолжению, мс. */
const EXTENSION_ARM_MS = 1000;
/** Через сколько после последнего использования привязка к продолжению ребра гаснет, мс. */
const EXTENSION_TTL_MS = 4000;
/** Курсор «над ребром» — ближе этого к нему на экране, px. */
const EXTENSION_HOVER_PX = 6;
/** Сколько держать курсор над вершиной, чтобы откладывать от неё по осям, мс. */
const TRACK_ARM_MS = 1000;
/** Длина осей откладывания в обе стороны от якоря, м. */
const TRACK_M = 100;
/** Ось откладывания ловит курсор ближе этого, px. */
const TRACK_RADIUS_PX = 8;
/** Шаг сетки основания режима здания, м. */
const GRID_STEP = 10;

/**
 * Точки привязки здания: вершины контуров внизу и на верху стен, вершины крыши выше стен, середины рёбер (нижних, верхних
 * и вертикальных) и центры габаритов объектов. Крыши пока не учитываются, кроме конька в центре.
 */
function collectSnaps(g: MeshGroup): { points: SnapPoint[]; edges: SnapEdge[] } {
  const out: SnapPoint[] = [];
  const edges: SnapEdge[] = [];
  const seen = new Set<string>();
  const addEdge = (key: string, ax: number, ay: number, az: number, bx: number, by: number, bz: number) => {
    // Повтор ребра у того же объекта — одно (в любом направлении). Общие рёбра соседних частей — у каждой свои:
    // инструмент может исключить свой объект (перемещение), и общее ребро не должно пропасть вместе с ним
    const p = `${ax.toFixed(2)}:${ay.toFixed(2)}:${az.toFixed(2)}`, q = `${bx.toFixed(2)}:${by.toFixed(2)}:${bz.toFixed(2)}`;
    const id = `e:${key}:${p < q ? p + q : q + p}`;
    if (seen.has(id)) return;
    seen.add(id);
    edges.push({ key, a: new THREE.Vector3(ax, ay, az), b: new THREE.Vector3(bx, by, bz) });
  };
  const add = (kind: SnapKind, key: string, x: number, y: number, z: number, label?: string) => {
    // Повтор точки у того же объекта — одна; общие вершины соседних частей — у каждой своя (см. addEdge)
    const id = `${kind}:${key}:${x.toFixed(2)}:${y.toFixed(2)}:${z.toFixed(2)}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ kind, key, p: new THREE.Vector3(x, y, z), label });
  };
  for (const it of g.items) {
    if (it.box.isEmpty() || g.hidden.has(it.feature.key)) continue;
    const key = it.feature.key;
    const z0 = it.box.min.z;
    const z1 = Math.max(z0, Math.min(computeHeights(it.tags).wallTop, it.box.max.z));
    const levels = z1 - z0 > 0.2 ? [z0, z1] : [z0]; // у плоских следов — один уровень
    for (const p of it.feature.polygons) {
      for (const ring of [p.outer, ...p.inners]) {
        const pts = ring.map(g.toLocal);
        for (let i = 0; i < pts.length; i++) {
          const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length];
          for (const z of levels) {
            add('vertex', key, ax, ay, z);
            add('midpoint', key, (ax + bx) / 2, (ay + by) / 2, z);
            addEdge(key, ax, ay, z, bx, by, z);
          }
          if (levels.length > 1) { add('midpoint', key, ax, ay, (z0 + z1) / 2); addEdge(key, ax, ay, z0, ax, ay, z1); } // вертикальное ребро
        }
      }
      // Центр фигуры: прямоугольник, правильный многоугольник, окружность — внизу и вверху стен
      const shape = shapeOf(p.outer.map(g.toLocal));
      if (shape) for (const z of levels) add('shape', key, shape.c[0], shape.c[1], z, shape.label);
    }
    // Вершины, которых нет в контуре: сгенерированная крыша (конёк, вершина пирамиды и т. п.)
    const pos = it.positions;
    for (let i = it.wallVertices * 3; i < pos.length; i += 3) {
      if (pos[i + 2] > z1 + 0.05) add('vertex', key, pos[i], pos[i + 1], pos[i + 2]);
    }
    const c = it.box.getCenter(new THREE.Vector3());
    add('center', key, c.x, c.y, c.z);
  }
  return { points: out, edges };
}

/** Отступ начала координат от угла bbox наружу по x и y, м. */
const ORIGIN_OFFSET = 5;
const AXIS_DIM_COLOUR = 0x9ca3af;
/** Длина направляющей зафиксированной оси в каждую сторону, м. */
const LOCK_GUIDE_M = 300;
/** Насколько видны оси начала координат сквозь модель (доля обычной непрозрачности). */
const OCCLUDED_AXES_OPACITY = 0.2;
const AXIS_COLOURS = [0xd43a3a, 0x3fa34d, 0x3a52b4]; // x, y, z — как в 3D-редакторах

/**
 * Обозначение начала координат: оси x/y/z стрелками в положительную сторону, отрицательные — тонкой линией.
 * Значок инструмента рисуется поверх геометрии (без проверки глубины), чтобы не терялся за стенами;
 * occluded (начало координат на сетке) — модель его закрывает, а сквозь неё он лишь слегка просвечивает.
 */
/**
 * Треугольники плоской грани из колец (метры сцены): плоскость — по первому кольцу (метод Ньюэлла), кольцо внутри
 * другого — дыра в нём. undefined — колец нет или они вырождены.
 */
function planarFill(rings: THREE.Vector3[][]): THREE.BufferGeometry | undefined {
  const first = rings.find((r) => r.length >= 3);
  if (!first) return;
  const n = new THREE.Vector3();
  first.forEach((p, i) => {
    const q = first[(i + 1) % first.length];
    n.x += (p.y - q.y) * (p.z + q.z); n.y += (p.z - q.z) * (p.x + q.x); n.z += (p.x - q.x) * (p.y + q.y);
  });
  if (n.lengthSq() < 1e-12) return;
  n.normalize();
  const u = new THREE.Vector3().crossVectors(Math.abs(n.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0), n).normalize();
  const v = new THREE.Vector3().crossVectors(n, u);
  const flat = rings.filter((r) => r.length >= 3).map((r) => ({ pts3: r, pts: r.map((p) => new THREE.Vector2(p.dot(u), p.dot(v))) }));
  const inside = (q: THREE.Vector2, r: THREE.Vector2[]) => {
    let c = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      if ((r[i].y > q.y) !== (r[j].y > q.y) && q.x < ((r[j].x - r[i].x) * (q.y - r[i].y)) / (r[j].y - r[i].y) + r[i].x) c = !c;
    }
    return c;
  };
  const positions: number[] = [];
  flat.forEach((ring, i) => {
    if (flat.some((o, j) => j !== i && inside(ring.pts[0], o.pts))) return; // дыра — уйдёт в свой внешний контур
    const holes = flat.filter((o, j) => j !== i && inside(o.pts[0], ring.pts));
    const all = [ring, ...holes];
    const verts = all.flatMap((r) => r.pts3);
    for (const t of THREE.ShapeUtils.triangulateShape(ring.pts, holes.map((h) => h.pts))) {
      for (const k of t) positions.push(verts[k].x, verts[k].y, verts[k].z);
    }
  });
  if (!positions.length) return;
  return new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
}

/**
 * Стрелки осей постоянного экранного размера: геометрия единичной длины в дочерней группе, которую каждый кадр
 * масштабирует scaleGizmos (длина стрелки — px пикселей при любом приближении). Направляющая зафиксированной оси —
 * в метрах, не масштабируется. faint — бледнее (начало координат здания не спорит со значком инструмента).
 */
function axesGizmo(frame: LocalFrame, opts: { px: number; z?: number; locked?: number; occluded?: boolean; free?: readonly number[]; faint?: boolean }): THREE.Object3D {
  const { locked, occluded = false, free } = opts;
  const len = 1, r = len * 0.012, head = len * 0.12;
  const root = new THREE.Group();
  // Базис: x, y — оси здания на земле, z — вверх
  root.matrixAutoUpdate = false;
  root.matrix.makeBasis(
    new THREE.Vector3(frame.x[0], frame.x[1], 0), new THREE.Vector3(frame.y[0], frame.y[1], 0), new THREE.Vector3(0, 0, 1),
  ).setPosition(frame.origin[0], frame.origin[1], opts.z ?? 0);
  const arrows = new THREE.Group();
  root.add(arrows);
  root.userData.gizmo = { px: opts.px, origin: new THREE.Vector3(frame.origin[0], frame.origin[1], opts.z ?? 0), arrows };
  const fade = opts.faint ? FAINT_AXES_OPACITY : 1;
  const dirs = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
  const up = new THREE.Vector3(0, 1, 0); // цилиндр и конус в three.js вытянуты по y
  dirs.forEach((d, i) => {
    // Ось зафиксирована — остальные серые и бледные; free — по каким осям вообще можно двигать (остальные серые)
    const dim = locked !== undefined ? locked !== i : !!free && !free.includes(i);
    const colour = dim ? AXIS_DIM_COLOUR : AXIS_COLOURS[i];
    const mat = new THREE.MeshBasicMaterial({ color: colour, depthTest: false, depthWrite: false, transparent: true, opacity: (dim ? 0.45 : 1) * fade });
    const q = new THREE.Quaternion().setFromUnitVectors(up, d);
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len - head, 8), mat);
    shaft.quaternion.copy(q);
    shaft.position.copy(d).multiplyScalar((len - head) / 2);
    const tip = new THREE.Mesh(new THREE.ConeGeometry(head * 0.35, head, 12), mat);
    tip.quaternion.copy(q);
    tip.position.copy(d).multiplyScalar(len - head / 2);
    const neg = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), d.clone().multiplyScalar(-len * 0.6)]),
      new THREE.LineBasicMaterial({ color: colour, depthTest: false, depthWrite: false, transparent: true, opacity: (dim ? 0.25 : 0.5) * fade }),
    );
    // Зафиксированная ось — длинная направляющая в обе стороны
    if (locked === i) {
      const guide = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([d.clone().multiplyScalar(-LOCK_GUIDE_M), d.clone().multiplyScalar(LOCK_GUIDE_M)]),
        new THREE.LineBasicMaterial({ color: colour, depthTest: false, depthWrite: false, transparent: true, opacity: 0.6 }),
      );
      guide.renderOrder = 1001;
      root.add(guide);
    }
    for (const o of [shaft, tip, neg]) {
      o.renderOrder = 1001;
      arrows.add(o);
      if (!occluded) continue;
      // Видимая часть — с проверкой глубины; закрытая моделью — бледной копией поверх
      // (материал у стержня и наконечника общий — копия со своими параметрами)
      const mat = o.material as THREE.Material;
      const ghostMat = mat.clone();
      Object.assign(ghostMat, { depthTest: false, opacity: mat.opacity * OCCLUDED_AXES_OPACITY });
      const ghost = o.clone() as typeof o;
      (ghost as THREE.Mesh).material = ghostMat;
      ghost.renderOrder = 1002;
      arrows.add(ghost);
      mat.depthTest = true;
    }
  });
  return root;
}
const GRID_COLOUR = 0xc9c6bf;

function groupBox(g: MeshGroup): THREE.Box3 {
  if (!g.mesh) return new THREE.Box3();
  const geom = g.mesh.geometry;
  if (!geom.boundingBox) geom.computeBoundingBox();
  return geom.boundingBox!;
}

const rendered = (it: Item): RenderedFeature => ({ feature: it.feature, roofApproximated: it.roofApproximated });

/** Теги Simple 3D, задающие объём: с ними подземный объект рисуем (автор явно задал его форму). */
const S3D_TAGS = ['height', 'min_height', 'building:levels', 'building:min_level', 'roof:shape', 'roof:height', 'roof:levels'];

/**
 * Рисуем ли здание (контур с частями — да, но плоским следом, см. buildItem): подземное (location=underground) без тегов
 * Simple 3D — тоже нет: иначе парковки и переходы под площадями торчат над землёй дефолтной коробкой.
 */
function shouldRender(f: Feature3D): boolean {
  return !isHiddenUnderground(f);
}

/** Подземное здание, которое не рисуем объёмом (на карте — пунктирный контур на поверхности). */
export function isHiddenUnderground(f: Feature3D): boolean {
  return f.tags.location === 'underground' && !S3D_TAGS.some((t) => f.tags[t] !== undefined);
}

/** Для лога медленных зданий: ключ, форма крыши, число вершин и полигонов. */
function describeFeature(f: Feature3D): string {
  const vertices = f.polygons.reduce((n, p) => n + p.outer.length + p.inners.reduce((m, r) => m + r.length, 0), 0);
  const holes = f.polygons.reduce((n, p) => n + p.inners.length, 0);
  return `${f.key}, roof:shape=${f.tags['roof:shape'] ?? 'flat'}, вершин ${vertices}, полигонов ${f.polygons.length}, дыр ${holes}`;
}

/** Стекло: голубовато-бирюзовое, полупрозрачное; без цветов — светлее. */
const GLASS = new THREE.Color('#7fc4cc');
const GLASS_MONO = new THREE.Color('#bfe3e6');
// Отодвинуто дальше сплошных граней (MATERIAL: 1/1): стекло в одной плоскости со сплошной стеной под ней не мерцает
const GLASS_MATERIAL = new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: 0.45, depthWrite: false,
  side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 4 });

/** Цвет перекрытий (срезов этажей) внутри здания. */
const FLOOR_SLAB = new THREE.Color(0xffffff);

/** Отступ плиты от низа и верха стен, м: у самого края плита совпала бы с дном или крышей. */
const SLAB_MARGIN = 0.3;

/**
 * Высоты полов этажей здания (та же раскладка, что у планов этажей) — задаёт main; undefined — здание без
 * раскладки (одиночное), тогда плиты считаются по тегам самой части.
 */
/** Высота пола и пустоты второго света в перекрытии на ней (lon/lat). */
export interface SlabLevel { z: number; holes: LonLat[][][] }
let levelGridFor: (f: Feature3D) => SlabLevel[] | undefined = () => undefined;
export function setLevelGrid(fn: (f: Feature3D) => SlabLevel[] | undefined) { levelGridFor = fn; }

/** Плиты перекрытий между этажами: по раскладке этажей здания, иначе по building:levels (с min_level); без этажности — нет. */
function floorSlabs(polys: LocalPolygon[], h: Heights, tags: Record<string, string>, grid?: { z: number; holes: Pt[][][] }[]): number[] {
  if (grid?.length) {
    const out: number[] = [];
    for (const { z, holes } of grid) {
      if (z <= h.min + SLAB_MARGIN || z >= h.wallTop - SLAB_MARGIN) continue;
      // Второй свет: пустоты этажа в плите вырезаем — объём над атриумом не режется перекрытиями
      let slab = polys;
      const ring = (p: Pt[][]) => p.map((r) => [...r, r[0]] as [number, number][]);
      try {
        if (holes.length) slab = fromClip(polygonClipping.difference(toClip(slab), ...holes.map(ring)));
      } catch { /* вырожденная геометрия — плита целиком */ }
      out.push(...bottomTriangles(slab, z));
    }
    return out;
  }
  const span = h.wallTop - h.min;
  const levels = Number(tags['building:levels']), minLevel = Number(tags['building:min_level'] ?? 0) || 0;
  // Этажность не указана — перекрытий не выдумываем; указана с ошибкой (building:levels не больше
  // building:min_level) — тоже не угадываем
  if (tags['building:levels'] === undefined || !Number.isFinite(levels) || levels - minLevel < 1) return [];
  const count = Math.round(levels - minLevel);
  if (count < 2 || span / count < 1.5) return [];
  const out: number[] = [];
  for (let i = 1; i < count; i++) out.push(...bottomTriangles(polys, h.min + span * i / count));
  return out;
}

const isGlass = (v: string | undefined) => !!v && v.split(';')[0].trim().toLowerCase() === 'glass';

/** Выключатель стекла в настройках графики (одна сцена на страницу — достаточно модульного флага). */
let glassEnabled = true;

/** Диапазоны вершин здания, рисуемые стеклом: [от, до). */
/** Вершины стеклянного буфера части по порядку: стены (подрезанные соседями, если посчитано) и крыша. */
function glassParts(it: Item): Float32Array[] {
  return glassRanges(it).map(([a, b]) => a === 0 && it.glassPlanTrim?.src === it.positions ? it.glassPlanTrim.walls
    : a === 0 && it.glassTrim?.src === it.positions ? it.glassTrim.walls : it.positions.subarray(a * 3, b * 3));
}

function glassRanges(it: Item): [number, number][] {
  const n = it.positions.length / 3, out: [number, number][] = [];
  if (!glassEnabled) return out;
  if (it.glassWalls && it.wallVertices) out.push([0, it.wallVertices]);
  if (it.glassRoof && n - it.floorVertices > it.wallVertices) out.push([it.wallVertices, n - it.floorVertices]);
  return out;
}

/**
 * Бюджет расчёта оболочки здания в режиме этажей, мс — страховка: дальше грани остаются как есть. Храм из ~450 частей
 * (relation/3224486) считается около 1.5 с, 600 мс ему не хватало.
 */
/** Сколько вариантов оболочки (этажей) держать посчитанными. */
const SHELL_CACHES = 6;
/** Порция обрезки граней оболочки за кадр, мс: остальное досчитывается в следующих кадрах (continueShell). */
const SHELL_BUDGET_MS = 40;

/** Объект закрывает собой грани соседей в оболочке: объём с высотой (не навес building:part=roof, не плоский след). */
/** Прямоугольник треугольников в плане: [x0, y0, x1, y1]. */
/** Грани части после обрезки: стены, крыша и плиты (их число вершин не меняется — убранное вырожденными). */
function composeTrim(full: { positions: Float32Array }, floorVertices: number, r: TrimResult): { positions: Float32Array; wallVertices: number } {
  const end = full.positions.length / 3 - floorVertices;
  let floors: ArrayLike<number> = full.positions.subarray(end * 3);
  if (r.cut.length <= floors.length) { const f = new Float32Array(floors.length); f.set(r.cut); floors = f; }
  const pos = new Float32Array(r.walls.length + r.roof.length + floorVertices * 3);
  pos.set(r.walls, 0);
  pos.set(r.roof, r.walls.length);
  pos.set(floors, r.walls.length + r.roof.length);
  return { positions: pos, wallVertices: r.walls.length / 3 };
}

function positionsBox(pos: ArrayLike<number>): [number, number, number, number] {
  const b: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < pos.length; i += 3) {
    if (pos[i] < b[0]) b[0] = pos[i];
    if (pos[i] > b[2]) b[2] = pos[i];
    if (pos[i + 1] < b[1]) b[1] = pos[i + 1];
    if (pos[i + 1] > b[3]) b[3] = pos[i + 1];
  }
  return b;
}

/** positions — по каким граням судить (оболочка — по исходным: обрезанная целиком часть всё равно объём для соседей). */
function shellSolid(g: MeshGroup, it: Item, positions = it.positions): boolean {
  return !g.hidden.has(it.feature.key) && !strokeOnly(g, it) && !thinItem(it) && !isRoofPart(it.tags) && positions.length > 0;
}

function isRoofPart(tags: Record<string, string>): boolean {
  return tags['building:part'] === 'roof' || tags.building === 'roof';
}

function roofPartWallMaterial(tags: Record<string, string>): string | undefined {
  return tags['building:material'] ?? tags.material ?? (isRoofPart(tags) ? tags['roof:material'] : undefined);
}

function roofPartBottomless(tags: Record<string, string>): boolean {
  return isRoofPart(tags) && (tags.wall === 'no' || isGlass(roofPartWallMaterial(tags)) || isGlass(tags['roof:material']));
}

/** Контур под частями (и голый контур в режиме здания): только обводка — заливку всё равно закрывают части. */
/** Подсвечиваемая область проблемы проверки. */
export interface IssueArea { key: string; level: 'error' | 'warning'; polygons: Polygon[] }

/** Рёбра колец контура объекта на высоте z (пары точек). */
function ringSegments(g: MeshGroup, it: Item, z: number): Float32Array {
  const out: number[] = [];
  for (const p of it.feature.polygons) for (const ring of [p.outer, ...p.inners]) {
    const pts = ring.map(g.toLocal);
    for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; out.push(a[0], a[1], z, b[0], b[1], z); }
  }
  return new Float32Array(out);
}

/** Площадь объекта в плане, м² (кеш по объекту): при наложении в одной плоскости первым выбирается меньший. */
const areaCache = new WeakMap<Item, number>();
function itemArea(g: MeshGroup, it: Item): number {
  let a = areaCache.get(it);
  if (a !== undefined) return a;
  const ring = (r: [number, number][]) => {
    let s = 0;
    const pts = r.map(g.toLocal);
    for (let i = 0; i < pts.length; i++) { const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length]; s += x1 * y2 - x2 * y1; }
    return Math.abs(s) / 2;
  };
  a = it.feature.polygons.reduce((n, p) => n + ring(p.outer) - p.inners.reduce((m, r) => m + ring(r), 0), 0);
  areaCache.set(it, a);
  return a;
}
function strokeOnly(g: MeshGroup, it: Item): boolean {
  return it.feature.hasParts || g.flat.has(it.feature.key);
}
/** Вход на стене: точка у основания (м сцены), направление стены t и наружная нормаль n (единичные), низ z. */
export interface EntrancePlace { id: number; p: Pt; t: Pt; n: Pt; z: number; width?: number }

/**
 * Место входа у вершины i кольца r (кольца в метрах сцены, 0 — внешнее): стена — по соседним вершинам
 * (на углу — средняя), наружу — туда, где нет самого объекта.
 */
export function entrancePlace(rings: Pt[][], r: number, i: number, z: number): Omit<EntrancePlace, 'id'> | undefined {
  const ring = rings[r], n = ring.length;
  if (n < 3) return;
  const p = ring[i];
  let a: Pt | undefined, b: Pt | undefined;
  for (let k = 1; k < n && !a; k++) { const q = ring[(i - k + n) % n]; if (Math.hypot(q[0] - p[0], q[1] - p[1]) > 1e-6) a = q; }
  for (let k = 1; k < n && !b; k++) { const q = ring[(i + k) % n]; if (Math.hypot(q[0] - p[0], q[1] - p[1]) > 1e-6) b = q; }
  if (!a || !b) return;
  const unit = (x: number, y: number): Pt | undefined => { const l = Math.hypot(x, y); return l > 1e-9 ? [x / l, y / l] : undefined; };
  const u1 = unit(p[0] - a[0], p[1] - a[1]), u2 = unit(b[0] - p[0], b[1] - p[1]);
  if (!u1 || !u2) return;
  const t = unit(u1[0] + u2[0], u1[1] + u2[1]) ?? u2;
  let nrm: Pt = [t[1], -t[0]];
  const probe: Pt = [p[0] + nrm[0] * 0.2, p[1] + nrm[1] * 0.2];
  const inside = pointInLocalRing(probe, rings[0]) && !rings.slice(1).some((h) => pointInLocalRing(probe, h));
  if (inside) nrm = [-nrm[0], -nrm[1]];
  return { p, t, n: nrm, z };
}

/** Объект нулевой толщины (нарисованная часть до выдавливания): рёбер у него нет — обводим контур. */
function thinItem(it: Item): boolean {
  return !it.box.isEmpty() && it.box.max.z - it.box.min.z < 1e-3;
}
const STROKE_COLOUR = new THREE.Color(0x8a8a8a);
const STROKE_SELECTED = new THREE.Color('#2f7cff');
/** Обводка выделенного плоского следа в режиме здания, px, и непрозрачность его заливки. */
const SELECTED_STROKE_PX = 2, SELECTED_FILL_OPACITY = 0.18;
const STROKE_MATERIAL = new THREE.LineBasicMaterial({ vertexColors: true });
/**
 * Обводка лежит в плоскости своей заливки, а заливку плоских объектов THIN_MATERIAL сдвигает к камере — без
 * такого же сдвига она закрыла бы свою обводку. У линий polygonOffset нет: сдвигаем глубину в шейдере.
 */
STROKE_MATERIAL.onBeforeCompile = (shader) => {
  shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\n  gl_Position.z -= STROKE_DEPTH_BIAS * gl_Position.w;')
    .replace('void main() {', 'const float STROKE_DEPTH_BIAS = 2e-5;\nvoid main() {');
};

/** Высота плоского следа на земле, м: на отметке земли, как в режиме здания (подложка карты не пишет глубину). */
const FOOTPRINT_HEIGHT = 0;
/** Тоньше этого объект считаем нулевой высоты (плоский след); тонкие плиты (8 см, relation/17247078) — объёмом. */
const MIN_THICKNESS = 0.01;
/** Пересечения ближе этого друг к другу по лучу — одна поверхность (совпадающие грани разных объектов), м. */
const TIE_DEPTH = 0.02;

/** Поднимать здания без высоты и этажей на высоту по умолчанию (настройка «Поднимать здания с дефолтной высотой»). */
let raiseDefault = true;

/** Унаследованные частью теги (цвета, форма крыши, материалы контура/отношения) — задаёт main. */
let inheritFor: (f: Feature3D) => Record<string, string> | undefined = () => undefined;
export function setInheritance(fn: (f: Feature3D) => Record<string, string> | undefined) { inheritFor = fn; }

/** Теги для рисования, контур в локальных метрах и высоты объекта (с поправкой на плоский след). */
function prepItem(g: MeshGroup, f: Feature3D) {
  // Свои теги главнее унаследованных; в данных объекта ничего не меняется — только для рисования
  const inherited = inheritFor(f);
  const tags = inherited && Object.keys(inherited).length ? { ...inherited, ...f.tags } : f.tags;
  const polys = (g.renderFootprints.get(f.key) ?? f.polygons).map((p) => ({ outer: p.outer.map(g.toLocal), inners: p.inners.map((r) => r.map(g.toLocal)) }));
  let heights = computeHeights(tags);
  // Контур под частями и здания нулевой высоты — плоский след на земле: видно и можно выделить;
  // без высоты и этажей — тоже, если высоту по умолчанию выключили в настройках; части в режиме здания — всегда
  const flat = f.hasParts || g.flat.has(f.key);
  const unraised = heights.source === 'default' && (f.kind === 'building' || !raiseDefault || (g.noDefaultHeight && f.kind === 'part'));
  if (flat || unraised || heights.top - heights.min < MIN_THICKNESS) {
    const min = flat ? 0 : heights.min;
    heights = { ...heights, min, wallTop: min + g.footprint, top: min + g.footprint, roofShape: 'flat', roofHeight: 0 };
  }
  return { tags, polys, heights, flat };
}

/** Совпадающие по высоте грани ближе этого — одна плоскость (крыша нижней части под дном верхней), м. */
const CONTACT_DZ = 0.05;

interface ContactFace { key: string; z: number; polys: LocalPolygon[]; box: THREE.Box2 }
/** Плоские верхи и дна объектов группы по высоте (ключ — высота шагом CONTACT_DZ). */
interface Contacts { tops: Map<number, ContactFace[]>; bottoms: Map<number, ContactFace[]> }

function hasBottom(prep: ReturnType<typeof prepItem>): boolean {
  const { tags, heights, flat } = prep;
  return !flat && !roofPartBottomless(tags) && heights.min > 0.01 && heights.top - heights.min >= MIN_THICKNESS;
}
function hasFlatTop(prep: ReturnType<typeof prepItem>): boolean {
  return !prep.flat && prep.heights.roofShape === 'flat';
}

/** Индекс плоских верхов и дон группы: по нему разбираются соприкасающиеся грани соседних частей. */
function buildContacts(g: MeshGroup, features: Iterable<Feature3D>): Contacts {
  const b = contactsBuilder(g, [...features]);
  b.step(Infinity);
  return b.contacts;
}

/** То же порциями: step(deadline) считает до срока (performance.now()), true — всё посчитано. */
function contactsBuilder(g: MeshGroup, features: Feature3D[]): { contacts: Contacts; step: (deadline: number) => boolean } {
  g.renderFootprints = outlineRemainders(features.filter(f => !g.hidden.has(f.key)));
  const c: Contacts = { tops: new Map(), bottoms: new Map() };
  const add = (m: Map<number, ContactFace[]>, face: ContactFace) => {
    const k = Math.round(face.z / CONTACT_DZ);
    (m.get(k) ?? m.set(k, []).get(k)!).push(face);
  };
  let i = 0;
  const step = (deadline: number) => {
    while (i < features.length && performance.now() < deadline) addFeature(features[i++]);
    return i >= features.length;
  };
  const addFeature = (f: Feature3D) => {
    // Скрытые (глазик, изоляция) не стоят на крышах: иначе под ними у соседа вместо крыши — плита перекрытия
    if (!shouldRender(f) || g.hidden.has(f.key)) return;
    const prep = prepItem(g, f);
    const top = hasFlatTop(prep), bottom = hasBottom(prep);
    if (!top && !bottom) return;
    const box = new THREE.Box2();
    for (const p of prep.polys) for (const [x, y] of p.outer) box.expandByPoint(new THREE.Vector2(x, y));
    if (top) add(c.tops, { key: f.key, z: prep.heights.wallTop, polys: prep.polys, box });
    if (bottom) add(c.bottoms, { key: f.key, z: prep.heights.min, polys: prep.polys, box });
  };
  return { contacts: c, step };
}

/** Грани другого объекта на высоте z, пересекающие рамку box (кроме самого объекта). */
function contactFaces(m: Map<number, ContactFace[]>, key: string, z: number, box: THREE.Box2): ContactFace[] {
  const k = Math.round(z / CONTACT_DZ), out: ContactFace[] = [];
  for (let i = k - 1; i <= k + 1; i++) {
    for (const face of m.get(i) ?? []) {
      if (face.key !== key && Math.abs(face.z - z) < CONTACT_DZ && face.box.intersectsBox(box)) out.push(face);
    }
  }
  return out;
}

const toClip = (polys: LocalPolygon[]): ClipMulti => polys.map((p) => [p.outer, ...p.inners].map((r) => [...r, r[0]] as [number, number][]));

const fromClip = (m: ClipMulti): LocalPolygon[] =>
  m.map(([outer, ...inners]) => ({ outer: outer.slice(0, -1) as Pt[], inners: inners.map((r) => r.slice(0, -1) as Pt[]) }));

/** Контур без участков, закрытых гранями faces; undefined — вычитать нечего. */
function subtractFaces(polys: LocalPolygon[], faces: ContactFace[]): LocalPolygon[] | undefined {
  if (!faces.length) return;
  try {
    return fromClip(polygonClipping.difference(toClip(polys), ...faces.map((f) => toClip(f.polys))));
  } catch {
    return; // вырожденная геометрия — оставляем грань как есть
  }
}

/** Участки контура, закрытые гранями faces (объединением); undefined — не получилось или нечего. */
function coveredBy(polys: LocalPolygon[], faces: ContactFace[]): LocalPolygon[] | undefined {
  if (!faces.length) return;
  try {
    const cover = polygonClipping.union(toClip(faces[0].polys), ...faces.slice(1).map((f) => toClip(f.polys)));
    return fromClip(polygonClipping.intersection(toClip(polys), cover));
  } catch {
    return;
  }
}

/** Ключи объектов, чьи грани соприкасаются с этим (по рамкам): поменялись — объект надо пересобрать. */
function contactKeys(g: MeshGroup, f: Feature3D): string {
  if (!g.contacts) return '';
  const prep = prepItem(g, f);
  const box = new THREE.Box2();
  for (const p of prep.polys) for (const [x, y] of p.outer) box.expandByPoint(new THREE.Vector2(x, y));
  const keys: string[] = [];
  if (hasFlatTop(prep)) keys.push(...contactFaces(g.contacts.bottoms, f.key, prep.heights.wallTop, box).map((x) => x.key));
  if (hasBottom(prep)) keys.push(...contactFaces(g.contacts.tops, f.key, prep.heights.min, box).map((x) => x.key));
  return keys.sort().join(',') + '|' + JSON.stringify(g.renderFootprints.get(f.key) ?? null);
}

function buildItem(g: MeshGroup, f: Feature3D): Item {
  const prep = timed('здание: подготовка', () => prepItem(g, f));
  const { tags, polys, heights, flat } = prep;
  const box2 = new THREE.Box2();
  for (const p of polys) for (const [x, y] of p.outer) box2.expandByPoint(new THREE.Vector2(x, y));
  const tri = timed('здание: стены и крыша', () => buildTriangles(polys, heights, tags));
  // Плоская крыша, на которой стоят другие части: закрытый ими участок — уже не крыша, а перекрытие между
  // частями (видно сквозь стекло) — рисуем его плитой перекрытия, остальное — крышей
  let joint: number[] = [];
  if (g.contacts && hasFlatTop(prep) && tri.roof.length) {
    timed('здание: перекрытие под частями', () => {
      const faces = contactFaces(g.contacts!.bottoms, f.key, heights.wallTop, box2);
      const rest = subtractFaces(polys, faces), covered = rest && coveredBy(polys, faces);
      if (rest && covered) { tri.roof = bottomTriangles(rest, heights.wallTop); joint = bottomTriangles(covered, heights.wallTop); }
    });
  }
  // Часть-кровля сохраняет короткую боковую стенку и дно. wall=no убирает стенку;
  // прозрачная кровля остаётся без дна. Явные height/min_height задают толщину.
  const roofOnly = !flat && isRoofPart(tags) && tri.roof.length > 0;
  if (roofOnly && tags.wall === 'no') tri.walls = [];
  // Дно — у объектов с объёмом над землёй (видно снизу); на земле его не видно — треугольники не тратим. Цвет — как у стен.
  // Участки, лежащие на плоских крышах других частей, вырезаем: совпадающие грани мерцают, а дно стеклянной части
  // просвечивает поверх крыши. Крышу оставляем — она и есть перекрытие между частями (видна сквозь стекло)
  if (hasBottom(prep)) {
    timed('здание: дно', () => {
      const rest = g.contacts && subtractFaces(polys, contactFaces(g.contacts.tops, f.key, heights.min, box2));
      tri.walls.push(...bottomTriangles(rest ?? polys, heights.min));
    });
  }
  // Стеклянный фасад: внутри видны перекрытия — плиты на границах этажей (непрозрачные, после крыши)
  const glassWalls = isGlass(roofPartWallMaterial(tags));
  const floors = [...joint, ...(glassWalls && !flat && !roofOnly ? timed('здание: перекрытия за стеклом', () => floorSlabs(polys, heights, tags, levelGridFor(f)?.map((l) => ({ z: l.z, holes: l.holes.map((p) => p.map((r) => r.map(g.toLocal))) })))) : [])];
  const positions = new Float32Array(tri.walls.length + tri.roof.length + floors.length);
  positions.set(tri.walls, 0);
  positions.set(tri.roof, tri.walls.length);
  positions.set(floors, tri.walls.length + tri.roof.length);
  const wall = tags['building:colour'] ?? tags.colour ?? DEFAULT_WALL;
  const roof = tags['roof:colour'] ?? (tags['roof:shape'] && tags['roof:shape'] !== 'flat' ? DEFAULT_ROOF : wall);
  const box = new THREE.Box3();
  if (positions.length) box.setFromArray(positions);
  return {
    contacts: contactKeys(g, f),
    feature: f,
    tags,
    roofApproximated: tri.roofApproximated,
    pending: !!tri.pending,
    positions,
    wallVertices: tri.walls.length / 3,
    floorVertices: floors.length / 3,
    wall: parseColour(wall),
    roof: parseColour(roof),
    top: heights.top,
    box,
    start: 0,
    // material на здании — устаревший вариант building:material: только фасад
    glassWalls,
    glassRoof: isGlass(tags['roof:material']),
    glassStart: 0,
  };
}

/** Разобранные цвета: одинаковых значений тегов мало, а зданий — тысячи. */
const colourCache = new Map<string, THREE.Color>();
const unknownColours = new Set<string>();

/**
 * Цвет из тега; в OSM бывает несколько через ';' — берём первый. Вершинные цвета — в линейном пространстве.
 * Опечатки в тегах (lightgre, rgey) — частое дело: исправляем их (normalizeColour), чтобы three.js
 * не писал предупреждение в консоль на каждое здание, и сообщаем о каждом значении один раз.
 */
function parseColour(colour: string): THREE.Color {
  const value = colour.split(';')[0].trim();
  let color = colourCache.get(value);
  if (!color) {
    color = new THREE.Color(DEFAULT_WALL);
    const fixed = normalizeColour(value);
    if (fixed) {
      color.setStyle(fixed);
      if (fixed !== value && !unknownColours.has(value)) {
        unknownColours.add(value);
        console.debug(`Цвет в теге «${value}» понят как «${fixed}»`);
      }
    } else if (!unknownColours.has(value)) {
      unknownColours.add(value);
      console.debug(`Неизвестный цвет в теге: «${value}» — рисуем цветом по умолчанию`);
    }
    colourCache.set(value, color);
  }
  return color;
}

function isCssColour(value: string): boolean {
  return typeof CSS === 'undefined' ? /^#[0-9a-f]{3,8}$/i.test(value) : CSS.supports('color', value);
}

/**
 * Привести значение тега к цвету CSS: как есть; hex без '#'; без регистра, пробелов и знаков
 * (light grey, orange'pink → lightgrey, orangepink); составное «a-b» — первый известный цвет;
 * опечатки — ближайшее имя CSS (lihgtgrey, peachpuf), обрубки — по началу имени (pin → pink).
 */
function normalizeColour(value: string): string | undefined {
  if (isCssColour(value)) return value;
  if (/^[0-9a-f]{6}$|^[0-9a-f]{3}$/i.test(value)) return `#${value}`;
  const lower = value.toLowerCase();
  const joined = lower.replace(/[^a-z]/g, '');
  if (!joined) return;
  if (joined in THREE.Color.NAMES) return joined;
  for (const part of lower.split(/[^a-z]+/)) if (part.length > 2 && part in THREE.Color.NAMES) return part;
  return closestColourName(joined);
}

function closestColourName(word: string): string | undefined {
  const names = Object.keys(THREE.Color.NAMES);
  if (word.length >= 3) {
    const prefixed = names.filter((n) => n.startsWith(word)).sort((a, b) => a.length - b.length)[0];
    if (prefixed) return prefixed;
  }
  // Допуск: 1 правка для коротких слов, 2 — для длинных
  const limit = word.length <= 5 ? 1 : 2;
  let best: string | undefined, bestDist = limit + 1;
  for (const n of names) {
    if (Math.abs(n.length - word.length) > limit) continue;
    const d = editDistance(word, n);
    if (d < bestDist) { bestDist = d; best = n; }
  }
  return best;
}

/** Расстояние Дамерау–Левенштейна (перестановка соседних букв — одна правка). */
function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

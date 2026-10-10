import * as THREE from 'three';
import polygonClipping, { type MultiPolygon as ClipMulti } from 'polygon-clipping';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { MercatorCoordinate, type LngLat, type CustomLayerInterface, type CustomRenderMethodInput, type Map as MlMap, type PointLike } from 'maplibre-gl';
import { computeHeights, type Heights } from '../osm/heights';
import type { Feature3D, IndoorKind, LonLat, Polygon } from '../osm/model';
import { bottomTriangles, buildTriangles, shapeOf, type LocalPolygon, type Pt } from './building-geometry';
import { timed } from '../perf';
import { orientedFrame, type LocalFrame } from './oriented-box';

const DEFAULT_WALL = '#ffffff';
const DEFAULT_ROOF = '#ffffff';
/** Подсветка поверх всего (выбор контура) — яркий оранжевый, чтобы отличалась от выделения. */
const OVERLAY_COLOUR = new THREE.Color('#ff6a00');
const HIGHLIGHT = new THREE.Color('#97beff'); // #2f7cff, смешанный с белым пополам
const MONOCHROME = new THREE.Color('#ffffff');

/** Indoor-объект выбранного этажа: контуры (lon/lat) и высота пола, м. */
export interface IndoorItem { key: string; kind: IndoorKind; polygons: Polygon[]; line?: boolean; z: number }

/** Заливка пола по виду indoor-объекта. */
const INDOOR_COLOURS: Record<IndoorKind, number> = { level: 0xe7e5e4, area: 0xffffff, corridor: 0xffffff, room: 0xf6ead2, wall: 0xffffff, column: 0xffffff, poi: 0xffffff };
/** Части здания меньше этой площади (м²) на срезе этажа закрываются крышкой — колонны, столбы. */
const SOLID_PART_AREA = 6;
/** Толщина контура внешнего периметра этажа на срезе, px. */
const PERIMETER_WIDTH_PX = 3;
/** Дверной проём в стенах плана: ширина и высота, м; дверь дальше DOOR_SNAP от стены её не режет. */
const DOOR_WIDTH = 1;
const DOOR_HEIGHT = 2.2;
const DOOR_SNAP = 0.15;
/** Насколько ниже потолка этажа проходит срез, м. */
const CUT_BELOW_CEIL = 0.1;
/** Стены, перегородки и колонны — белые, как здание; в полную высоту этажа (до среза). */
const INDOOR_WALL_MATERIAL = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
/** Выделенное помещение: заливка цветом выделения частей и контур. */
const INDOOR_SELECT_MATERIAL = new THREE.MeshBasicMaterial({ color: HIGHLIGHT, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 });
const INDOOR_SELECT_LINE = new THREE.LineBasicMaterial({ color: 0x2563eb });
/** Полы помещений, коридоров и площадок — цвет вершин по виду. */
const INDOOR_FLOOR_MATERIAL = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
/** Крышка сечения замкнутых стен и колонн — освещается как верх здания. */
const INDOOR_CAP_MATERIAL = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide });
/** Стена помещения совпадает с уже нарисованной (периметр, indoor=wall, соседнее помещение): ближе этого, м. */
const WALL_MERGE_DIST = 0.3;
const WALL_MERGE_COS = Math.cos(THREE.MathUtils.degToRad(10));
const INDOOR_LINE_MATERIAL = new THREE.LineBasicMaterial({ color: 0x57534e });
/** Этаж под вторым светом — бледнее: стены и крышки высветлены, полы смешаны с белым, линии светлее. */
const INDOOR_PALE_WALL = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x777777, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
const INDOOR_PALE_LINE = new THREE.LineBasicMaterial({ color: 0xc4c0bb });
const PALE_MIX = 0.5;
/** Грани частей здания ближе этого к полу этажа со вторым светом — вырезаются в пустотах, м. */
const VOID_FACE_DZ = 0.1;

/** Перекрытие этажа со вторым светом (плита с дырами под полом) и край пустоты. */
const INDOOR_SLAB_MATERIAL = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide });
const INDOOR_VOID_EDGE = new THREE.LineBasicMaterial({ color: 0x57534e });

/** План этажа для слоя. below — этажи под вторым светом (видны сквозь пустоты voids в перекрытии). */
export interface IndoorLevel {
  cut: number;
  /** Высота пола этажа, м. */
  floor: number;
  items: IndoorItem[];
  doors?: LonLat[];
  /** Пустоты в перекрытии этажа: многоугольники lon/lat ([внешнее кольцо, ...дыры]). */
  voids?: LonLat[][][];
  /** Высоты, на которых пустота прорезает перекрытия (пол этажа и полы промежуточных этажей), — по пустотам. */
  voidCuts?: { polygon: LonLat[][][]; zs: number[] }[];
  below?: { cut: number; items: IndoorItem[]; doors?: LonLat[] }[];
}

export interface RenderedFeature { feature: Feature3D; roofApproximated: boolean }

export interface GraphicsOptions {
  /** Полусферический свет: небо сверху, земля снизу. */
  hemisphere: boolean;
  /** Поддельная окклюзия: затемнение низа стен у земли (цвет вершин). */
  groundAO: boolean;
  /** Контуры рёбер. */
  edges: boolean;
  /** Не выделять стекло: стеклянные стены и крыши — как обычные. */
  noGlass?: boolean;
  /** Здания без высоты и этажей поднимать на высоту по умолчанию (иначе — плоский след). */
  defaultHeight?: boolean;
}

/** Высота, на которой затемнение у земли сходит на нет, м (для зданий выше AO_HEIGHT). */
const AO_HEIGHT = 6;
/** Доля высоты здания, на которой затемнение сходит на нет, — для низких зданий. */
const AO_FADE_SHARE = 0.5;
/** Яркость у самой земли для зданий не ниже AO_HEIGHT; у низких затемнение слабее. */
const AO_MIN = 0.55;
/** Порог угла между гранями для контуров, градусы: швы триангуляции на плоских гранях не рисуем. */
const EDGE_ANGLE = 25;
const EDGE_MATERIAL = new THREE.LineBasicMaterial({ color: 0x3a3a3a, transparent: true, opacity: 0.55 });
/**
 * Скрытые рёбра выделенного в режиме здания: пунктир рисуется только там, где ребро закрыто
 * (глубина больше записанной). Линии чуть подвинуты к камере — видимые рёбра не мерцают пунктиром.
 */
const HIDDEN_EDGE_MATERIAL = new THREE.LineDashedMaterial({
  color: 0xd2401e, dashSize: 0.6, gapSize: 0.4, transparent: true, opacity: 0.9,
  depthFunc: THREE.GreaterDepth, depthWrite: false,
});
HIDDEN_EDGE_MATERIAL.onBeforeCompile = (sh) => {
  sh.vertexShader = sh.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\n  gl_Position.z -= 0.001 * gl_Position.w;');
};
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
/** Бюджет асинхронной сборки группы на кадр, мс. */
const FRAME_BUDGET_MS = 8;

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
  /** Рёбра здания (отрезки xyz) — считаются один раз, когда контуры включены. */
  edges?: Float32Array;
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
  /** Скрытые (только для показа) объекты: не рисуются, не выбираются, без привязок. */
  readonly hidden = new Set<string>();
  /** Толщина плоского следа, м: на карте — чуть выше подложки, в режиме здания подложки нет — ноль. */
  footprint = FOOTPRINT_HEIGHT;
  /** Рисовать плоским следом независимо от высоты (голый контур в режиме здания). */
  readonly flat = new Set<string>();
  /** Плоские верхи и дна объектов — чтобы не рисовать совпадающие грани соседних частей. */
  contacts?: Contacts;
  /** Обводки контуров под частями (в просмотре вместо заливки). */
  strokes?: THREE.LineSegments;
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

  /** Стекло группы — прозрачное, поэтому отдельно от непрозрачной слитой геометрии. */
  glass?: THREE.Mesh;

  disposeMesh() {
    this.disposeEdges();
    this.disposeStrokes();
    if (this.glass) { this.glass.geometry.dispose(); this.scene.remove(this.glass); this.glass = undefined; }
    if (!this.mesh) return;
    this.mesh.geometry.dispose();
    this.scene.remove(this.mesh);
    this.mesh = undefined;
  }

  disposeStrokes() {
    if (!this.strokes) return;
    this.strokes.geometry.dispose();
    this.scene.remove(this.strokes);
    this.strokes = undefined;
  }

  disposeEdges() {
    if (!this.edges) return;
    this.edges.geometry.dispose();
    this.scene.remove(this.edges);
    this.edges = undefined;
  }
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
  /** Асинхронные сборки групп: новая сборка или удаление группы отменяет предыдущую. */
  private readonly pending = new Map<string, symbol>();
  private selected = new Set<string>();
  /** Все здания белым, без цветов из тегов. */
  private monochrome = false;
  private graphics: GraphicsOptions = { hemisphere: false, groundAO: false, edges: false };
  /** Треугольников в последнем кадре — для оценки производительности. */
  lastTriangles = 0;
  visible = true;
  /** Режим одного здания: рисуется и выбирается только группа FOCUS_GROUP (здание + земля). */
  private focused = false;
  /** Матрица проекции MapLibre из последнего кадра — чтобы проецировать сцену режима здания до её первой отрисовки. */
  private lastMain?: THREE.Matrix4;
  /** Локальная система координат здания в режиме одного здания (в метрах сцены режима). */
  focusAxes?: LocalFrame;
  /** Точки привязки режима одного здания (в метрах сцены режима); undefined — пересчитать. */
  private snaps?: { points: SnapPoint[]; edges: SnapEdge[] };

  constructor(readonly id: string) {}

  onAdd(map: MlMap, gl: WebGL2RenderingContext) {
    this.map = map;
    this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
    this.renderer.autoClear = false;
    this.renderer.localClippingEnabled = true; // срез здания выше выбранного этажа
  }

  onRemove() {
    this.renderer?.dispose();
    this.renderer = undefined;
  }

  render(_gl: WebGL2RenderingContext, options: CustomRenderMethodInput) {
    if (!this.visible || !this.renderer) return;
    timed(`${this.id}: кадр (CPU)`, () => this.renderGroups(options), () => `${this.groups.size} групп`);
  }

  private renderGroups(options: CustomRenderMethodInput) {
    const renderer = this.renderer!;
    const main = new THREE.Matrix4().fromArray(options.defaultProjectionData.mainMatrix as unknown as number[]);
    this.lastMain = main;
    let triangles = 0;
    for (const g of this.activeGroups()) {
      g.camera.projectionMatrix = main.clone().multiply(g.model);
      renderer.resetState();
      renderer.render(g.scene, g.camera);
      triangles += renderer.info.render.triangles;
    }
    this.lastTriangles = triangles;
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
    this.hiddenEdges?.geometry.dispose();
    this.hiddenEdges = undefined;
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
    if (this.focusAxes) g.scene.add(axesGizmo(this.focusAxes));
    this.install(FOCUS_GROUP, g);
    this.updateHiddenEdges();
    this.applyLevel();
  }

  /** Срез режима здания (высота, м; выше не рисуется и не выбирается) и indoor-объекты выбранного этажа. */
  private level?: IndoorLevel;
  private indoorObj?: THREE.Group;

  /** Выбрать этаж: cut — высота среза, items — помещения этажа; undefined — всё здание без среза. */
  /** Выбранный indoor-объект этажа: пол залит цветом выделения, скрытые рёбра — пунктиром (как у частей). */
  private indoorSelected?: string;
  private indoorSelObj?: THREE.Group;

  setIndoorSelection(key: string | undefined) {
    this.indoorSelected = key;
    this.applyIndoorSelection();
    this.map?.triggerRepaint();
  }

  private applyIndoorSelection() {
    if (this.indoorSelObj) {
      this.indoorSelObj.parent?.remove(this.indoorSelObj);
      this.indoorSelObj.traverse((o) => { if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) o.geometry.dispose(); });
      this.indoorSelObj = undefined;
    }
    const g = this.groups.get(FOCUS_GROUP);
    const it = this.level?.items.find((i) => i.key === this.indoorSelected);
    if (!g || !it || it.line) return;
    const root = new THREE.Group();
    const z = it.z + 0.06;
    const lines: number[] = [];
    for (const p of it.polygons) {
      const v2 = (r: LonLat[]) => r.map((c) => new THREE.Vector2(...g.toLocal(c)));
      const shape = new THREE.Shape(v2(p.outer));
      for (const h of p.inners) shape.holes.push(new THREE.Path(v2(h)));
      const fill = new THREE.Mesh(new THREE.ShapeGeometry(shape), INDOOR_SELECT_MATERIAL);
      fill.position.z = z;
      fill.frustumCulled = false;
      root.add(fill);
      for (const r of [p.outer, ...p.inners]) {
        const rp = r.map(g.toLocal);
        for (let i = 0; i < rp.length; i++) lines.push(rp[i][0], rp[i][1], z, rp[(i + 1) % rp.length][0], rp[(i + 1) % rp.length][1], z);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
    const visible = new THREE.LineSegments(geo, INDOOR_SELECT_LINE);
    const hidden = new THREE.LineSegments(geo.clone(), HIDDEN_EDGE_MATERIAL);
    hidden.computeLineDistances();
    hidden.renderOrder = 999; // после стен: глубина уже записана
    for (const o of [visible, hidden]) { o.frustumCulled = false; root.add(o); }
    this.indoorSelObj = root;
    g.scene.add(root);
  }

  /** doors — двери этажа (lon/lat): в стенах на их месте вырезаются проёмы. */
  setLevel(level: IndoorLevel | undefined) {
    const hadVoids = !!this.level?.voidCuts?.length, hasVoids = !!level?.voidCuts?.length;
    this.level = level;
    const focus = this.groups.get(FOCUS_GROUP);
    if (focus && (hadVoids || hasVoids)) this.rebuildGeometry(focus);
    timed('этажи: план этажа', () => this.applyLevel(), () => `${level?.items.length ?? 0} объектов`);
    this.applyIndoorSelection();
    this.map?.triggerRepaint();
  }

  private applyLevel() {
    // Чуть ниже потолка: днища частей, начинающихся на потолке, и крыши частей на этой высоте не накрывают план
    const planes = this.level ? [new THREE.Plane(new THREE.Vector3(0, 0, -1), this.level.cut - CUT_BELOW_CEIL)] : null;
    for (const m of [MATERIAL, THIN_MATERIAL, GLASS_MATERIAL, EDGE_MATERIAL, HIDDEN_EDGE_MATERIAL]) m.clippingPlanes = planes;
    if (this.indoorObj) {
      this.indoorObj.parent?.remove(this.indoorObj);
      this.indoorObj.traverse((o) => {
        if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments || o instanceof Line2) o.geometry.dispose();
        if (o instanceof Line2) o.material.dispose();
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
    const top = this.level.cut - CUT_BELOW_CEIL;
    // Внешний периметр этажа: объединение следов объектов здания, которые есть на высоте среза, — толстой линией
    const spans: ClipMulti = [];
    // Есть части — контур здания (outline) не в счёт: его след накрывает и то, что у частей лишь крыша
    const hasParts = g.items.some((it) => it.feature.kind === 'part' && !g.hidden.has(it.feature.key));
    for (const it of g.items) {
      if (g.hidden.has(it.feature.key) || g.flat.has(it.feature.key)) continue;
      if (hasParts && it.feature.kind === 'building') continue;
      // Срез должен пересекать стены, а не крышу (купол, скат выше стен — без обводки)
      const h = computeHeights(it.tags);
      if (h.min > top - 0.5 || h.wallTop < top) continue;
      const column = it.tags['building:part'] === 'column';
      for (const p of it.feature.polygons) {
        const outer = p.outer.map(g.toLocal);
        spans.push([outer, ...p.inners.map((r) => r.map(g.toLocal))].map((rp) => [...rp, rp[0]]));
        // Колонна или мелкая часть (столб, пилон) на срезе — сплошное сечение с крышкой, а не открытая коробка
        if (!column && Math.abs(THREE.ShapeUtils.area(outer.map(([x, y]) => new THREE.Vector2(x, y)))) >= SOLID_PART_AREA) continue;
        fill(outer, p.inners.map((h) => h.map(g.toLocal)), top);
      }
    }
    if (spans.length && this.map) {
      let union: ClipMulti = [];
      try { union = polygonClipping.union(spans[0], ...spans.slice(1)); } catch (err) { console.warn('[levels] периметр не построен', err); }
      const canvas = this.map.getCanvas();
      const dpr = canvas.width / Math.max(1, canvas.clientWidth);
      const mat = new LineMaterial({ color: 0x9ca3af, linewidth: PERIMETER_WIDTH_PX * dpr });
      mat.resolution.set(canvas.width, canvas.height);
      for (const poly of union) for (const ring of poly) {
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
    if (voids.length && this.level.below?.length) {
      const z = this.level.floor - 0.03;
      const holes: ClipMulti = voids.map((poly) => poly.map((r) => { const rp = r.map(g.toLocal); return [...rp, rp[0]]; }));
      let slab: ClipMulti = [];
      try { slab = spans.length ? polygonClipping.difference(polygonClipping.union(spans[0], ...spans.slice(1)), ...holes) : []; } catch (err) { console.warn('[levels] плита не построена', err); }
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
      // Обводка пустот на уровне пола — край перекрытия
      const edge: number[] = [];
      for (const poly of holes) for (const r of poly) for (let i = 0; i + 1 < r.length; i++) edge.push(r[i][0], r[i][1], this.level.floor + 0.01, r[i + 1][0], r[i + 1][1], this.level.floor + 0.01);
      const eg = new THREE.BufferGeometry();
      eg.setAttribute('position', new THREE.Float32BufferAttribute(edge, 3));
      const el = new THREE.LineSegments(eg, INDOOR_VOID_EDGE);
      el.frustumCulled = false;
      root.add(el);
      for (const b of this.level.below) this.drawPlan(root, g, b.items, b.doors ?? [], b.cut - CUT_BELOW_CEIL, true);
    }
    this.drawPlan(root, g, this.level.items, this.level.doors ?? [], top, false);
  }

  /** План этажа: стены помещений и стены-линии с проёмами, полы по видам, крышки колонн; pale — бледный (этаж под вторым светом). */
  private drawPlan(root: THREE.Group, g: MeshGroup, items: IndoorItem[], doorList: LonLat[], top: number, pale: boolean) {
    if (!items.length) return;
    const capPos: number[] = [], floorPos: number[] = [], floorCol: number[] = [];
    const white = new THREE.Color(0xffffff);
    const fill = (outer: Pt[], holes: Pt[][], z: number, colour?: number) => {
      const v2 = (r: Pt[]) => r.map(([x, y]) => new THREE.Vector2(x, y));
      const contour = v2(outer), hs = holes.map(v2);
      if (THREE.ShapeUtils.isClockWise(contour)) contour.reverse();
      for (const h of hs) if (!THREE.ShapeUtils.isClockWise(h)) h.reverse();
      const pts = [...contour, ...hs.flat()];
      const c = colour === undefined ? undefined : new THREE.Color(colour);
      if (c && pale) c.lerp(white, PALE_MIX);
      for (const tri of THREE.ShapeUtils.triangulateShape(contour, hs)) for (const i of tri) {
        (c ? floorPos : capPos).push(pts[i].x, pts[i].y, z);
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
    const order: IndoorKind[] = ['level', 'area', 'corridor', 'room', 'column', 'wall'];
    const lines: number[] = [];
    const walls: number[] = [];
    // Рёбра стен (опция «рёбра»): низ и вертикали в концах и на изломах — по направлениям стен в каждой точке
    const edges: number[] = [];
    const ends = new Map<string, { x: number; y: number; z0: number; z1: number; dirs: [number, number][] }>();
    const end = (x: number, y: number, z0: number, z1: number, dx: number, dy: number) => {
      const k = `${Math.round(x * 20)},${Math.round(y * 20)}`;
      const e = ends.get(k) ?? { x, y, z0, z1, dirs: [] };
      e.dirs.push([dx, dy]);
      ends.set(k, e);
    };
    const slab = (ax: number, ay: number, bx: number, by: number, z0: number, z1: number, ends = true) => {
      walls.push(ax, ay, z0, bx, by, z0, bx, by, z1, ax, ay, z0, bx, by, z1, ax, ay, z1);
      lines.push(ax, ay, z1, bx, by, z1);
      if (!this.graphics.edges) return;
      edges.push(ax, ay, z0, bx, by, z0);
      if (!ends) return; // перемычка над проёмом: вертикали дают откосы соседних кусков
      const l = Math.hypot(bx - ax, by - ay) || 1;
      end(ax, ay, z0, z1, (bx - ax) / l, (by - ay) / l);
      end(bx, by, z0, z1, (ax - bx) / l, (ay - by) / l);
    };
    const doors = doorList.map(g.toLocal);
    /** Стена с дверными проёмами (DOOR_WIDTH × DOOR_HEIGHT) там, где на ней стоит дверь. */
    const wall = (ax: number, ay: number, bx: number, by: number, z0: number, z1: number) => {
      const len = Math.hypot(bx - ax, by - ay);
      const gaps: [number, number][] = [];
      if (len > 1e-6) {
        const dx = (bx - ax) / len, dy = (by - ay) / len;
        for (const [px, py] of doors) {
          if (Math.abs((px - ax) * dy - (py - ay) * dx) > DOOR_SNAP) continue;
          const t = (px - ax) * dx + (py - ay) * dy;
          if (t < -DOOR_SNAP || t > len + DOOR_SNAP) continue;
          gaps.push([Math.max(0, t - DOOR_WIDTH / 2) / len, Math.min(len, t + DOOR_WIDTH / 2) / len]);
        }
      }
      if (!gaps.length) { slab(ax, ay, bx, by, z0, z1); return; }
      gaps.sort((p, q) => p[0] - q[0]);
      const at = (t: number): [number, number] => [ax + (bx - ax) * t, ay + (by - ay) * t];
      const lintel = Math.min(z0 + DOOR_HEIGHT, z1);
      let from = 0;
      const pieces: [number, number][] = [];
      for (const [lo, hi] of gaps) {
        if (lo > from) pieces.push([from, lo]);
        from = Math.max(from, hi);
      }
      if (from < 1) pieces.push([from, 1]);
      for (const [t0, t1] of pieces) slab(...at(t0), ...at(t1), z0, z1);
      // Перемычки над проёмами
      if (z1 - lintel > 0.01) {
        let lo = gaps[0][0], hi = gaps[0][1];
        for (const [g0, g1] of [...gaps.slice(1), [2, 2] as [number, number]]) {
          if (g0 <= hi) { hi = Math.max(hi, g1); continue; }
          slab(...at(lo), ...at(hi), lintel, z1, false);
          [lo, hi] = [g0, g1];
        }
      }
    };
    // Уже стоящие стены: периметр объектов здания и стены-линии; стены помещений, совпадающие с ними, — пропускаем
    // Сетка 4 м: стена сравнивается только со стенами из соседних ячеек (иначе тысячи × тысячи сравнений)
    type Seg = [number, number, number, number];
    const grid = new Map<string, Seg[]>();
    const CELL = 4;
    const cells = (x0: number, y0: number, x1: number, y1: number, pad: number) => {
      const out: string[] = [];
      for (let i = Math.floor((Math.min(x0, x1) - pad) / CELL); i <= Math.floor((Math.max(x0, x1) + pad) / CELL); i++)
        for (let j = Math.floor((Math.min(y0, y1) - pad) / CELL); j <= Math.floor((Math.max(y0, y1) + pad) / CELL); j++) out.push(`${i},${j}`);
      return out;
    };
    const taken = {
      push(sg: Seg) { for (const c of cells(...sg, 0)) (grid.get(c) ?? grid.set(c, []).get(c)!).push(sg); },
      near(x0: number, y0: number, x1: number, y1: number): Set<Seg> {
        const out = new Set<Seg>();
        for (const c of cells(x0, y0, x1, y1, WALL_MERGE_DIST)) for (const sg of grid.get(c) ?? []) out.add(sg);
        return out;
      },
    };
    for (const bi of g.items) {
      if (g.hidden.has(bi.feature.key)) continue;
      for (const p of bi.feature.polygons) for (const r of [p.outer, ...p.inners]) {
        const rp = r.map(g.toLocal);
        for (let i = 0; i < rp.length; i++) taken.push([...rp[i], ...rp[(i + 1) % rp.length]]);
      }
    }
    /** Участки ребра a→b (доли 0…1), не закрытые уже стоящими стенами, — стена ставится только на них. */
    const uncovered = (ax: number, ay: number, bx: number, by: number): [number, number][] => {
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 1e-6) return [];
      const dx = (bx - ax) / len, dy = (by - ay) / len;
      const cover: [number, number][] = [];
      for (const [px, py, qx, qy] of taken.near(ax, ay, bx, by)) {
        const l = Math.hypot(qx - px, qy - py);
        if (l < 1e-6 || Math.abs(((qx - px) * dx + (qy - py) * dy) / l) < WALL_MERGE_COS) continue;
        // Оба конца отрезка — близко к прямой ребра
        if (Math.abs((px - ax) * dy - (py - ay) * dx) > WALL_MERGE_DIST || Math.abs((qx - ax) * dy - (qy - ay) * dx) > WALL_MERGE_DIST) continue;
        const t0 = ((px - ax) * dx + (py - ay) * dy) / len, t1 = ((qx - ax) * dx + (qy - ay) * dy) / len;
        const lo = Math.max(0, Math.min(t0, t1)), hi = Math.min(1, Math.max(t0, t1));
        if (hi > lo) cover.push([lo, hi]);
      }
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
    };
    /** Стена на участках ребра, ещё не занятых другими стенами (совпадающие грани мерцали бы). */
    const wallFree = (ax: number, ay: number, bx: number, by: number, z0: number) => {
      for (const [t0, t1] of uncovered(ax, ay, bx, by)) {
        const x0 = ax + (bx - ax) * t0, y0 = ay + (by - ay) * t0, x1 = ax + (bx - ax) * t1, y1 = ay + (by - ay) * t1;
        wall(x0, y0, x1, y1, z0, top);
        taken.push([x0, y0, x1, y1]);
      }
    };
    // Сначала стены-линии (точная геометрия стен, без повторов между собой и с периметром), потом помещения
    for (const it of items) {
      if (!it.line) continue;
      for (const p of it.polygons) {
        const pts = p.outer.map(g.toLocal);
        for (let i = 0; i + 1 < pts.length; i++) wallFree(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], it.z);
        // Замкнутая стена (короб, шахта) — с крышкой сечения, а не открытой коробкой
        const [f0, fl] = [pts[0], pts[pts.length - 1]];
        if (pts.length >= 4 && Math.hypot(f0[0] - fl[0], f0[1] - fl[1]) < 1e-3) {
          fill(pts.slice(0, -1), [], top);
        }
      }
    }
    for (const it of [...items].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))) {
      const solid = it.kind === 'wall' || it.kind === 'column';
      const z = it.z + 0.02 + Math.min(order.indexOf(it.kind), 3) * 0.01;
      for (const p of it.polygons) {
        if (it.line) continue; // нарисованы выше
        // У колонны и стены-полигона — крышка сечения, у остальных — пол своего цвета
        fill(p.outer.map(g.toLocal), p.inners.map((h) => h.map(g.toLocal)), solid ? top : z, solid ? undefined : INDOOR_COLOURS[it.kind]);
        for (const r of [p.outer, ...p.inners]) {
          const rp = r.map(g.toLocal);
          for (let i = 0; i < rp.length; i++) {
            const [ax, ay] = rp[i], [bx, by] = rp[(i + 1) % rp.length];
            if (solid) wall(ax, ay, bx, by, it.z, top);
            else if (it.kind === 'room') {
              // Стена помещения — там, где её ещё нет (периметр, indoor=wall с проёмами, соседнее помещение)
              wallFree(ax, ay, bx, by, it.z);
            }
            if (!solid) lines.push(ax, ay, z + 0.005, bx, by, z + 0.005);
          }
        }
      }
    }
    if (walls.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(walls, 3));
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, pale ? INDOOR_PALE_WALL : INDOOR_WALL_MATERIAL);
      mesh.frustumCulled = false;
      root.add(mesh);
    }
    // Вертикаль — в конце стены или где стены сходятся не по прямой (продолжение стены — без шва)
    const edgeCos = Math.cos(THREE.MathUtils.degToRad(EDGE_ANGLE));
    for (const e of ends.values()) {
      const straight = e.dirs.length === 2 && e.dirs[0][0] * e.dirs[1][0] + e.dirs[0][1] * e.dirs[1][1] < -edgeCos;
      if (!straight) edges.push(e.x, e.y, e.z0, e.x, e.y, e.z1);
    }
    if (edges.length) {
      const eg = new THREE.BufferGeometry();
      eg.setAttribute('position', new THREE.Float32BufferAttribute(edges, 3));
      const es = new THREE.LineSegments(eg, pale ? INDOOR_PALE_LINE : EDGE_MATERIAL);
      es.frustumCulled = false;
      root.add(es);
    }
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
    const seg = new THREE.LineSegments(lineGeo, pale ? INDOOR_PALE_LINE : INDOOR_LINE_MATERIAL);
    seg.frustumCulled = false;
    root.add(seg);
    finish();
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
  /** Выключенные типы привязок (всплывашка у кнопки привязок). */
  snapKindsOff = new Set<SnapKind>();
  /** Alt зажат — привязки временно выключены. */
  snapsSuspended = false;

  /**
   * opts.from — последняя точка инструмента: от неё ищем основание перпендикуляра на ребре.
   * opts.noEdge — без точки на ребре (вытягиванию нужны высоты, а не произвольные точки вертикальных рёбер).
   */
  snapAt(point: [number, number], filter: (key: string) => boolean = () => true, radius = SNAP_RADIUS_PX,
    opts: { from?: THREE.Vector3; noEdge?: boolean } = {}): SnapHit | undefined {
    if (!this.snapsEnabled || this.snapsSuspended) return;
    const g = this.groups.get(FOCUS_GROUP);
    if (!this.focused || !g || !this.map || !this.lastMain) return;
    this.snaps ??= collectSnaps(g);
    const m = this.lastMain.clone().multiply(g.model);
    const canvas = this.map.getCanvas();
    const v = new THREE.Vector4();
    let best: { s: SnapPoint; d: number; px: [number, number]; along?: THREE.Vector3 } | undefined;
    const near: { s: SnapPoint; d: number; px: [number, number]; along?: THREE.Vector3 }[] = [];
    const off = this.snapKindsOff;
    for (const s of this.snaps.points) {
      if (off.has(s.kind) || !filter(s.key)) continue;
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
    if (ray) for (const e of this.snaps.edges) {
      if (!filter(e.key)) continue;
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
      if (this.snapHidden(c.s.p, c.px)) c.d += SNAP_HIDDEN_PENALTY_PX;
      if (!best || c.d < best.d) best = c;
    }
    if (!best) return;
    const { s, px, along } = best;
    const merc = new MercatorCoordinate(g.origin.x + s.p.x * g.metersToMerc, g.origin.y - s.p.y * g.metersToMerc, 0);
    return { kind: s.kind, key: s.key, local: s.p.clone(), lngLat: merc.toLngLat(), altitude: s.p.z, point: px, along, label: s.label };
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
    const ray = this.focusRay(px);
    const hit = this.focusRayHits(px)[0];
    if (!ray || !hit) return false;
    const toSnap = ray.origin.distanceTo(p);
    return ray.origin.distanceTo(hit.local) < toSnap - Math.max(0.05, toSnap * 0.002);
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
        if (this.level && p.z > this.level.cut - CUT_BELOW_CEIL + 1e-3) continue; // выше среза этажа — не видно
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
          if (inside && !(this.level && q.z > this.level.cut - CUT_BELOW_CEIL + 1e-3)) out.push({ key, t, local: q, face: 'bottom' });
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

  /** Контуры объекта сцены режима здания в метрах (для работы с рёбрами). */
  focusPolygons(key: string): { outer: Pt[]; inners: Pt[][] }[] | undefined {
    const g = this.groups.get(FOCUS_GROUP);
    const it = g?.byKey.get(key);
    if (!g || !it) return;
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

  /** Временно перестроить объект сцены режима здания по другим тегам (превью инструмента «Вытянуть»). */
  previewFocusFeature(f: Feature3D) {
    const g = this.groups.get(FOCUS_GROUP);
    if (!g?.byKey.has(f.key)) return;
    this.replaceItems(g, [f]);
    this.snaps = undefined;
    this.updateHiddenEdges();
  }

  /** Метры сцены режима → координаты. */
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
    this.setTransformPreview(keys, offset && new THREE.Matrix4().makeTranslation(offset.x, offset.y, offset.z));
  }

  /** Предпросмотр поворота keys на angle (радианы, против часовой) вокруг вертикали через pivot; undefined — сбросить. */
  setRotatePreview(keys: string[], pivot: THREE.Vector3 | undefined, angle: number) {
    this.setTransformPreview(keys, pivot && new THREE.Matrix4().makeTranslation(pivot.x, pivot.y, 0)
      .multiply(new THREE.Matrix4().makeRotationZ(angle)).multiply(new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, 0)));
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
      for (const [a, b] of glassRanges(it)) {
        pos.fill(0, o + a * 3, o + b * 3);
        if (gattr && it.glassStart >= 0) {
          const gp = gattr.array as Float32Array;
          for (let i = a * 3; i < b * 3; i += 3, go += 3) tx(base, i, gp, go);
          gattr.needsUpdate = true;
        }
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
    for (const obj of [this.movingEdges, this.hiddenEdges]) {
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

  private hiddenEdges?: THREE.LineSegments;
  private movingEdges?: THREE.LineSegments;

  /** Пунктир закрытых другими объектами рёбер выделенного и наведённого — только в режиме здания. */
  private updateHiddenEdges() {
    if (this.hiddenEdges) {
      this.hiddenEdges.parent?.remove(this.hiddenEdges);
      this.hiddenEdges.geometry.dispose();
      this.hiddenEdges = undefined;
    }
    const g = this.groups.get(FOCUS_GROUP);
    if (!this.focused || !g) return;
    const items = [...new Set([...this.selected, ...(this.hovered ? [this.hovered] : [])])].filter((k) => !g.hidden.has(k)).map((k) => g.byKey.get(k)).filter((it): it is Item => !!it && !strokeOnly(g, it));
    if (!items.length) return;
    this.hiddenEdges = edgeLines(items, HIDDEN_EDGE_MATERIAL);
    this.hiddenEdges.computeLineDistances();
    this.hiddenEdges.renderOrder = 999; // после зданий: глубина уже записана
    g.scene.add(this.hiddenEdges);
  }

  private snapLine?: THREE.Line;

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
  /** Значок осей в точке захвата и пунктир к курсору; axes — свои оси вместо осей здания (например, по ребру). */
  setMoveGuide(guide: { from: THREE.Vector3; to?: THREE.Vector3; axis?: 0 | 1 | 2; locked?: 0 | 1 | 2; axes?: { x: Pt; y: Pt } } | undefined) {
    const g = this.groups.get(FOCUS_GROUP);
    if (this.moveGuide) {
      this.moveGuide.parent?.remove(this.moveGuide);
      this.moveGuide.traverse((o) => { if (o instanceof THREE.Mesh || o instanceof THREE.Line) { o.geometry.dispose(); (o.material as THREE.Material).dispose(); } });
      this.moveGuide = undefined;
    }
    if (guide && g && this.focusAxes) {
      const root = new THREE.Group();
      const frame = { ...this.focusAxes, ...(guide.axes ?? {}), origin: [guide.from.x, guide.from.y] as Pt };
      const gizmo = axesGizmo(frame, guide.locked, TOOL_AXES_LENGTH);
      gizmo.matrix.elements[14] = guide.from.z; // значок на высоте точки захвата
      root.add(gizmo);
      if (guide.to) {
        const line = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([guide.from, guide.to]),
          new THREE.LineDashedMaterial({ color: guide.axis === undefined ? 0x333333 : AXIS_COLOURS[guide.axis], dashSize: 0.5, gapSize: 0.3,
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
  /** Начало сцены, размер земли и оси режима здания — с момента входа до выхода. */
  private focusLock?: { center: [number, number]; size: number; axes?: LocalFrame };

  /**
   * Контур в процессе рисования (метры сцены режима здания): сплошные стороны, пунктиром — замыкающая
   * (если closed) и полупрозрачная заливка, когда точек ≥ 3. Поверх геометрии.
   */
  private outline: Line2[] = [];
  /** Жирная обводка замкнутых контуров поверх всего — например, грань, от которой пойдёт отступ (с дворами). */
  setOutline(rings: THREE.Vector3[][] | undefined, widthPx = 3) {
    const g = this.groups.get(FOCUS_GROUP);
    for (const l of this.outline) { l.parent?.remove(l); l.geometry.dispose(); l.material.dispose(); }
    this.outline = [];
    if (rings && g && this.map) {
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

  /** Набросок контура; open — просто ломаная (без замыкания и заливки: стороны угла поворота). */
  setDrawPreview(points: THREE.Vector3[] | undefined, closed = false, open = false) {
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
      g.scene.add(root);
      this.drawPreview = root;
    }
    this.map?.triggerRepaint();
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
    g.contacts = buildContacts(g, todo);
    let i = 0;
    while (i < todo.length) {
      await new Promise(requestAnimationFrame);
      if (this.pending.get(key) !== token) return;
      const deadline = performance.now() + FRAME_BUDGET_MS;
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
        await new Promise(requestAnimationFrame);
        const deadline = performance.now() + FRAME_BUDGET_MS;
        while (done.length < todo.length && performance.now() < deadline) done.push(todo[done.length]);
        if (this.groups.get(key) !== g) break; // группу убрали или заменили, пока ждали кадр
      }
      if (this.groups.get(key) !== g || !done.length) continue;
      this.replaceItems(g, done);
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
  }

  setVisible(visible: boolean) {
    this.visible = visible;
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
    const depth = new Map<string, number>();
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
          const d = hitPoint.applyMatrix4(m).z;
          if (!(d >= (depth.get(key) ?? Infinity))) depth.set(key, d);
        }
      }
    }
    return [...depth.entries()].sort((p, q) => p[1] - q[1]).map(([k]) => k);
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
      if (!ray.intersectsBox(groupBox(g))) continue;
      // Сначала габариты зданий, треугольники — только у задетых
      let groupBest: { item: Item; dist: number; p: THREE.Vector3 } | undefined;
      for (const item of g.items) {
        if (g.hidden.has(item.feature.key) || !ray.intersectsBox(item.box)) continue;
        const pos = item.positions;
        for (let i = 0; i < pos.length; i += 9) {
          a.fromArray(pos, i); b.fromArray(pos, i + 3); c.fromArray(pos, i + 6);
          if (!ray.intersectTriangle(a, b, c, false, hitPoint)) continue;
          const dist = hitPoint.distanceTo(ray.origin);
          if (!groupBest || dist < groupBest.dist) groupBest = { item, dist, p: hitPoint.clone() };
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
    this.graphics = { ...o };
    // Стекло — отдельный меш: при переключении пересобираем слитую геометрию
    if (glassChanged) for (const g of this.groups.values()) if (g.mesh) this.rebuildGeometry(g);
    for (const g of this.groups.values()) {
      g.applyLighting(o);
      this.paintGroup(g);
      this.applyEdges(g);
    }
    this.applyLevel(); // рёбра внутренних стен
    this.map?.triggerRepaint();
  }

  setMonochrome(on: boolean) {
    this.monochrome = on;
    for (const g of this.groups.values()) this.paintGroup(g);
    this.map?.triggerRepaint();
  }

  private addItem(g: MeshGroup, f: Feature3D) {
    const item = timed('здание: треугольники', () => buildItem(g, f), () => describeFeature(f));
    // Контуры включены — считаем рёбра здесь, в порционной сборке, а не разом при слиянии
    if (this.graphics.edges) item.edges = itemEdges(item);
    g.byKey.set(f.key, item);
    g.items.push(item);
  }

  private replaceItems(g: MeshGroup, features: Feature3D[]) {
    const changed = new Set(features.filter((f) => g.byKey.has(f.key)).map((f) => f.key));
    this.refreshContacts(g, features, changed);
    for (const f of features) {
      const old = g.byKey.get(f.key);
      if (!old) continue;
      const item = timed('здание: треугольники', () => buildItem(g, f), () => describeFeature(f));
      g.items[g.items.indexOf(old)] = item;
      g.byKey.set(f.key, item);
    }
    this.rebuildGeometry(g);
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
  private rebuildGeometry(g: MeshGroup) {
    g.disposeMesh();
    let total = 0;
    for (const it of g.items) { it.start = total; total += it.positions.length / 3; }
    const positions = new Float32Array(total * 3);
    // Скрытые остаются нулями — вырожденные треугольники не видны. Контуры под частями в просмотре — тоже:
    // их рисует обводка, а выбор кликом идёт по треугольникам здания (pickHit), так что выделить можно
    let glassTotal = 0;
    for (const it of g.items) {
      it.glassStart = -1;
      if (g.hidden.has(it.feature.key) || strokeOnly(g, it)) continue;
      positions.set(it.positions, it.start * 3);
      // Стеклянные диапазоны — в отдельный буфер, в общем остаются нулями
      it.glassStart = glassTotal;
      for (const [a, b] of glassRanges(it)) { positions.fill(0, (it.start + a) * 3, (it.start + b) * 3); glassTotal += b - a; }
    }
    this.cutVoids(g, positions);
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
    if (glassTotal) {
      const gp = new Float32Array(glassTotal * 3);
      for (const it of g.items) {
        if (g.hidden.has(it.feature.key) || strokeOnly(g, it)) continue;
        let o = it.glassStart;
        for (const [a, b] of glassRanges(it)) { gp.set(it.positions.subarray(a * 3, b * 3), o * 3); o += b - a; }
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
    this.paintGroup(g);
    this.applyEdges(g);
    this.applyStrokes(g);
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
    for (let i = 0; i + 8 < pos.length; i += 9) {
      const z0 = pos[i + 2], z1 = pos[i + 5], z2 = pos[i + 8];
      if (Math.abs(z0 - z1) > 1e-3 || Math.abs(z0 - z2) > 1e-3 || !near(z0)) continue;
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
    for (const it of g.items) {
      if (!(strokeOnly(g, it) || thinItem(it)) || g.hidden.has(it.feature.key)) continue;
      const c = this.selected.has(it.feature.key) || this.hovered === it.feature.key ? STROKE_SELECTED : STROKE_COLOUR;
      const z = it.box.isEmpty() ? g.footprint : it.box.max.z;
      for (const p of it.feature.polygons) {
        for (const ring of [p.outer, ...p.inners]) {
          const pts = ring.map(g.toLocal);
          for (let i = 0; i < pts.length; i++) {
            const a = pts[i], b = pts[(i + 1) % pts.length];
            lines.push(a[0], a[1], z, b[0], b[1], z);
            colors.push(c.r, c.g, c.b, c.r, c.g, c.b);
          }
        }
      }
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
    if (!this.graphics.edges || !g.mesh) return;
    g.edges = edgeLines(g.items.filter((it) => !exclude?.has(it.feature.key) && !g.hidden.has(it.feature.key) && !strokeOnly(g, it)), EDGE_MATERIAL);
    g.scene.add(g.edges);
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
    for (const [a, b] of glassRanges(it)) for (let v = a; v < b; v++, o += 3) { gc[o] = c.r; gc[o + 1] = c.g; gc[o + 2] = c.b; }
  }
}

/** Рёбра нескольких объектов одним LineSegments. */
function edgeLines(items: Item[], material: THREE.LineBasicMaterial): THREE.LineSegments {
  for (const it of items) it.edges ??= itemEdges(it);
  const lines = new Float32Array(items.reduce((n, it) => n + it.edges!.length, 0));
  let o = 0;
  for (const it of items) { lines.set(it.edges!, o); o += it.edges!.length; }
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
const CURVED_ROOFS = new Set(['dome', 'onion', 'round', 'cone', 'conical', 'spherical']);
const PLANAR_ROOF_EDGE_ANGLE = 1;

function itemEdges(it: Item): Float32Array {
  const all = edgeSegments(it.positions, EDGE_ANGLE);
  if (it.wallVertices * 3 >= it.positions.length) return all;
  // Отдельно стены: их верхний край — граница (одна грань), EdgesGeometry отдаёт её при любом угле
  const walls = edgeSegments(it.positions.subarray(0, it.wallVertices * 3), EDGE_ANGLE);
  // Плоские скаты пологой крыши (hipped с roof:height 1 м) сходятся под малым углом — у всех крыш, кроме
  // кривых (купол, луковица, бочка), берём все изломы; у кривых — нет, иначе прорисуется каждая грань аппроксимации
  const roof = !CURVED_ROOFS.has(it.tags['roof:shape'] ?? 'flat')
    ? edgeSegments(it.positions.subarray(it.wallVertices * 3), PLANAR_ROOF_EDGE_ANGLE) : new Float32Array();
  const key = (a: Float32Array, i: number) => {
    const p = `${a[i].toFixed(2)},${a[i + 1].toFixed(2)},${a[i + 2].toFixed(2)}`;
    const q = `${a[i + 3].toFixed(2)},${a[i + 4].toFixed(2)},${a[i + 5].toFixed(2)}`;
    return p < q ? p + q : q + p;
  };
  // Стык стены с крышей и изломы скатов — только где грани не в одной плоскости: у вальмы и полувальмы
  // на неправильном контуре скат бывает вертикальным и продолжает стену — там ребра нет
  const creases = new Set<string>();
  const sharp = edgeSegments(it.positions, PLANAR_ROOF_EDGE_ANGLE);
  for (let i = 0; i < sharp.length; i += 6) creases.add(key(sharp, i));
  const seen = new Set<string>();
  for (let i = 0; i < all.length; i += 6) seen.add(key(all, i));
  const extra: number[] = [];
  for (const src of [walls, roof]) {
    for (let i = 0; i < src.length; i += 6) {
      if (seen.has(key(src, i)) || !creases.has(key(src, i))) continue;
      seen.add(key(src, i));
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
  const vkey = (arr: ArrayLike<number>, o: number) => `${arr[o].toFixed(2)},${arr[o + 1].toFixed(2)},${arr[o + 2].toFixed(2)}`;
  const ekey = (k1: string, k2: string) => (k1 < k2 ? k1 + '|' + k2 : k2 + '|' + k1);
  // Сколько треугольников делят сторону точно (по вершинам): у настоящего излома — два, такие не проверяем
  const shared = new Map<string, number>();
  const normals = new Float32Array(tris * 3);
  // Вырожденные треугольники (у фронтонов над карнизом — нулевой высоты) не в счёт: нормаль у них случайная
  const degenerate = new Uint8Array(tris);
  for (let t = 0; t < tris; t++) {
    const o = t * 9;
    const ux = P[o + 3] - P[o], uy = P[o + 4] - P[o + 1], uz = P[o + 5] - P[o + 2];
    const vx = P[o + 6] - P[o], vy = P[o + 7] - P[o + 1], vz = P[o + 8] - P[o + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    // Относительный порог: «щепки» с высотой в миллиметры (подъём фронтона на 1 мм) — тоже вырожденные
    if (l < 1e-3 * Math.max(ux * ux + uy * uy + uz * uz, vx * vx + vy * vy + vz * vz)) { degenerate[t] = 1; continue; }
    normals[t * 3] = nx / l; normals[t * 3 + 1] = ny / l; normals[t * 3 + 2] = nz / l;
    for (let k = 0; k < 3; k++) {
      const key = ekey(vkey(P, o + k * 3), vkey(P, o + ((k + 1) % 3) * 3));
      shared.set(key, (shared.get(key) ?? 0) + 1);
    }
  }
  const EPS = 0.02;
  const keep: number[] = [];
  for (let i = 0; i < segs.length; i += 6) {
    const px = segs[i], py = segs[i + 1], pz = segs[i + 2];
    let dx = segs[i + 3] - px, dy = segs[i + 4] - py, dz = segs[i + 5] - pz;
    const len = Math.hypot(dx, dy, dz);
    if (len < EPS) continue;
    if ((shared.get(ekey(vkey(segs, i), vkey(segs, i + 3))) ?? 0) >= 2) { for (let j = 0; j < 6; j++) keep.push(segs[i + j]); continue; }
    dx /= len; dy /= len; dz /= len;
    // Расстояние точки до прямой отрезка и её положение вдоль него
    const off = (o: number) => {
      const ex = P[o] - px, ey = P[o + 1] - py, ez = P[o + 2] - pz;
      return Math.hypot(ey * dz - ez * dy, ez * dx - ex * dz, ex * dy - ey * dx);
    };
    const along = (o: number) => (P[o] - px) * dx + (P[o + 1] - py) * dy + (P[o + 2] - pz) * dz;
    const tm = len / 2;
    let first = -1, flat = true, count = 0;
    for (let t = 0; t < tris && flat; t++) {
      if (degenerate[t]) continue;
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

function edgeSegments(positions: Float32Array, angle: number): Float32Array {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const edges = new THREE.EdgesGeometry(geom, angle);
  const out = edges.getAttribute('position').array as Float32Array;
  edges.dispose();
  geom.dispose();
  return out;
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

export type SnapKind = 'vertex' | 'midpoint' | 'center' | 'shape' | 'grid' | 'perpendicular' | 'edge' | 'extension';
/** Ключ привязки к узлу сетки основания: фильтр snapAt пропускает его, если инструменту нужна и сетка. */
export const GRID_SNAP_KEY = '@grid';
interface SnapPoint { kind: SnapKind; key: string; p: THREE.Vector3; label?: string }
interface SnapEdge { key: string; a: THREE.Vector3; b: THREE.Vector3 }
/** Привязка под курсором: тип, объект, точка (в метрах сцены режима и географически) и положение на экране. */
/** along — у продолжения ребра: конец ребра, от которого идёт продолжение (для пунктира). */
export interface SnapHit { kind: SnapKind; key: string; local: THREE.Vector3; lngLat: LngLat; altitude: number; point: [number, number]; along?: THREE.Vector3; label?: string }
const SNAP_RADIUS_PX = 12;
/** Длина стрелок осей в начале координат здания, м — одна клетка сетки. */
const AXES_LENGTH = 10;
/** Длина стрелок осей у точки захвата инструментов, м. */
const TOOL_AXES_LENGTH = 2;
/** Привязки выделенного объекта «ближе» на столько px. */
const SNAP_SELECTED_BONUS_PX = 8;
/** Заслонённые привязки «дальше» на столько px — выигрывают, только если видимых рядом нет. */
const SNAP_HIDDEN_PENALTY_PX = 100;
/** Точка на ребре — последней: курсор у ребра почти всегда, она не должна перебивать вершины и середины. */
const SNAP_PRIORITY: Record<SnapKind, number> = { vertex: 0, midpoint: 1, perpendicular: 1, shape: 1, grid: 2, center: 2, extension: 4, edge: 3 };
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
    // Общие рёбра соседних частей — одно (в любом направлении)
    const p = `${ax.toFixed(2)}:${ay.toFixed(2)}:${az.toFixed(2)}`, q = `${bx.toFixed(2)}:${by.toFixed(2)}:${bz.toFixed(2)}`;
    const id = `e:${p < q ? p + q : q + p}`;
    if (seen.has(id)) return;
    seen.add(id);
    edges.push({ key, a: new THREE.Vector3(ax, ay, az), b: new THREE.Vector3(bx, by, bz) });
  };
  const add = (kind: SnapKind, key: string, x: number, y: number, z: number, label?: string) => {
    // Общие вершины соседних частей — одна точка
    const id = `${kind}:${x.toFixed(2)}:${y.toFixed(2)}:${z.toFixed(2)}`;
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
const AXIS_COLOURS = [0xd43a3a, 0x3fa34d, 0x3a52b4]; // x, y, z — как в 3D-редакторах

/**
 * Обозначение начала координат: оси x/y/z стрелками в положительную сторону, отрицательные — тонкой линией.
 * Рисуется поверх геометрии (без проверки глубины), чтобы не терялось за стенами.
 */
function axesGizmo(frame: LocalFrame, locked?: number, len = AXES_LENGTH): THREE.Object3D {
  const r = len * 0.012, head = len * 0.12;
  const root = new THREE.Group();
  // Базис: x, y — оси здания на земле, z — вверх
  root.matrixAutoUpdate = false;
  root.matrix.makeBasis(
    new THREE.Vector3(frame.x[0], frame.x[1], 0), new THREE.Vector3(frame.y[0], frame.y[1], 0), new THREE.Vector3(0, 0, 1),
  ).setPosition(frame.origin[0], frame.origin[1], 0);
  const dirs = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
  const up = new THREE.Vector3(0, 1, 0); // цилиндр и конус в three.js вытянуты по y
  dirs.forEach((d, i) => {
    // Ось зафиксирована — остальные серые и бледные
    const dim = locked !== undefined && locked !== i;
    const colour = dim ? AXIS_DIM_COLOUR : AXIS_COLOURS[i];
    const mat = new THREE.MeshBasicMaterial({ color: colour, depthTest: false, depthWrite: false, transparent: true, opacity: dim ? 0.45 : 1 });
    const q = new THREE.Quaternion().setFromUnitVectors(up, d);
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len - head, 8), mat);
    shaft.quaternion.copy(q);
    shaft.position.copy(d).multiplyScalar((len - head) / 2);
    const tip = new THREE.Mesh(new THREE.ConeGeometry(head * 0.35, head, 12), mat);
    tip.quaternion.copy(q);
    tip.position.copy(d).multiplyScalar(len - head / 2);
    const neg = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), d.clone().multiplyScalar(-len * 0.6)]),
      new THREE.LineBasicMaterial({ color: colour, depthTest: false, depthWrite: false, transparent: true, opacity: dim ? 0.25 : 0.5 }),
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
    for (const o of [shaft, tip, neg]) { o.renderOrder = 1001; root.add(o); }
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
  if (f.tags.location === 'underground' && !S3D_TAGS.some((t) => f.tags[t] !== undefined)) return false;
  return true;
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
const GLASS_MATERIAL = new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: 0.45, depthWrite: false,
  side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });

/** Цвет перекрытий (срезов этажей) внутри здания. */
const FLOOR_SLAB = new THREE.Color(0xffffff);
/** Высота этажа, если число этажей не указано, м. */
const SLAB_LEVEL_HEIGHT = 3;

/** Отступ плиты от низа и верха стен, м: у самого края плита совпала бы с дном или крышей. */
const SLAB_MARGIN = 0.3;

/**
 * Высоты полов этажей здания (та же раскладка, что у планов этажей) — задаёт main; undefined — здание без
 * раскладки (одиночное), тогда плиты считаются по тегам самой части.
 */
/** Высота пола и пустоты второго света в перекрытии на ней (lon/lat). */
export interface SlabLevel { z: number; holes: LonLat[][][]; mask?: LonLat[][][] }
let levelGridFor: (f: Feature3D) => SlabLevel[] | undefined = () => undefined;
export function setLevelGrid(fn: (f: Feature3D) => SlabLevel[] | undefined) { levelGridFor = fn; }

/** Плиты перекрытий между этажами: по раскладке этажей здания, иначе по building:levels (с min_level) или через 3 м. */
function floorSlabs(polys: LocalPolygon[], h: Heights, tags: Record<string, string>, grid?: { z: number; holes: Pt[][][]; mask?: Pt[][][] }[]): number[] {
  if (grid?.length) {
    const out: number[] = [];
    for (const { z, holes, mask } of grid) {
      if (z <= h.min + SLAB_MARGIN || z >= h.wallTop - SLAB_MARGIN) continue;
      // Второй свет: пустоты этажа в плите вырезаем — объём над атриумом не режется перекрытиями
      let slab = polys;
      const ring = (p: Pt[][]) => p.map((r) => [...r, r[0]] as [number, number][]);
      try {
        if (mask) slab = fromClip(polygonClipping.intersection(toClip(slab), mask.map(ring)));
        if (holes.length) slab = fromClip(polygonClipping.difference(toClip(slab), ...holes.map(ring)));
      } catch { /* вырожденная геометрия — плита целиком */ }
      out.push(...bottomTriangles(slab, z));
    }
    return out;
  }
  const span = h.wallTop - h.min;
  const levels = Number(tags['building:levels']), minLevel = Number(tags['building:min_level'] ?? 0) || 0;
  // Этажи указаны, но с ошибкой (building:levels не больше building:min_level) — не угадываем, плит нет
  if (Number.isFinite(levels) && tags['building:levels'] !== undefined && levels - minLevel < 1) return [];
  const count = Number.isFinite(levels) && tags['building:levels'] !== undefined
    ? Math.round(levels - minLevel) : Math.round(span / SLAB_LEVEL_HEIGHT);
  if (count < 2 || span / count < 1.5) return [];
  const out: number[] = [];
  for (let i = 1; i < count; i++) out.push(...bottomTriangles(polys, h.min + span * i / count));
  return out;
}

const isGlass = (v: string | undefined) => !!v && v.split(';')[0].trim().toLowerCase() === 'glass';

/** Выключатель стекла в настройках графики (одна сцена на страницу — достаточно модульного флага). */
let glassEnabled = true;

/** Диапазоны вершин здания, рисуемые стеклом: [от, до). */
function glassRanges(it: Item): [number, number][] {
  const n = it.positions.length / 3, out: [number, number][] = [];
  if (!glassEnabled) return out;
  if (it.glassWalls && it.wallVertices) out.push([0, it.wallVertices]);
  if (it.glassRoof && n - it.floorVertices > it.wallVertices) out.push([it.wallVertices, n - it.floorVertices]);
  return out;
}

/** Контур под частями (и голый контур в режиме здания): только обводка — заливку всё равно закрывают части. */
function strokeOnly(g: MeshGroup, it: Item): boolean {
  return it.feature.hasParts || g.flat.has(it.feature.key);
}
/** Объект нулевой толщины (нарисованная часть до выдавливания): рёбер у него нет — обводим контур. */
function thinItem(it: Item): boolean {
  return !it.box.isEmpty() && it.box.max.z - it.box.min.z < 1e-3;
}
const STROKE_COLOUR = new THREE.Color(0x8a8a8a);
const STROKE_SELECTED = new THREE.Color('#2f7cff');
const STROKE_MATERIAL = new THREE.LineBasicMaterial({ vertexColors: true });

/** Высота плоского следа на земле, м: чуть выше земли, чтобы не мерцать с подложкой. */
const FOOTPRINT_HEIGHT = 0.1;
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
  const polys = f.polygons.map((p) => ({ outer: p.outer.map(g.toLocal), inners: p.inners.map((r) => r.map(g.toLocal)) }));
  let heights = computeHeights(tags);
  // Контур под частями и здания нулевой высоты — плоский след на земле: видно и можно выделить;
  // без высоты и этажей — тоже, если высоту по умолчанию выключили в настройках
  const flat = f.hasParts || g.flat.has(f.key);
  const unraised = !raiseDefault && heights.source === 'default';
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
  return !flat && tags['building:part'] !== 'roof' && heights.min > 0.01 && heights.top - heights.min >= MIN_THICKNESS;
}
function hasFlatTop(prep: ReturnType<typeof prepItem>): boolean {
  return !prep.flat && prep.heights.roofShape === 'flat';
}

/** Индекс плоских верхов и дон группы: по нему разбираются соприкасающиеся грани соседних частей. */
function buildContacts(g: MeshGroup, features: Iterable<Feature3D>): Contacts {
  const c: Contacts = { tops: new Map(), bottoms: new Map() };
  const add = (m: Map<number, ContactFace[]>, face: ContactFace) => {
    const k = Math.round(face.z / CONTACT_DZ);
    (m.get(k) ?? m.set(k, []).get(k)!).push(face);
  };
  for (const f of features) {
    if (!shouldRender(f)) continue;
    const prep = prepItem(g, f);
    const top = hasFlatTop(prep), bottom = hasBottom(prep);
    if (!top && !bottom) continue;
    const box = new THREE.Box2();
    for (const p of prep.polys) for (const [x, y] of p.outer) box.expandByPoint(new THREE.Vector2(x, y));
    if (top) add(c.tops, { key: f.key, z: prep.heights.wallTop, polys: prep.polys, box });
    if (bottom) add(c.bottoms, { key: f.key, z: prep.heights.min, polys: prep.polys, box });
  }
  return c;
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
  return keys.sort().join(',');
}

function buildItem(g: MeshGroup, f: Feature3D): Item {
  const prep = prepItem(g, f);
  const { tags, polys, heights, flat } = prep;
  const box2 = new THREE.Box2();
  for (const p of polys) for (const [x, y] of p.outer) box2.expandByPoint(new THREE.Vector2(x, y));
  const tri = buildTriangles(polys, heights, tags);
  // Плоская крыша, на которой стоят другие части: закрытый ими участок — уже не крыша, а перекрытие между
  // частями (видно сквозь стекло) — рисуем его плитой перекрытия, остальное — крышей
  let joint: number[] = [];
  if (g.contacts && hasFlatTop(prep) && tri.roof.length) {
    const faces = contactFaces(g.contacts.bottoms, f.key, heights.wallTop, box2);
    const rest = subtractFaces(polys, faces), covered = rest && coveredBy(polys, faces);
    if (rest && covered) { tri.roof = bottomTriangles(rest, heights.wallTop); joint = bottomTriangles(covered, heights.wallTop); }
  }
  // building:part=roof принято рисовать одной крышей: без фасада и дна (навесы, крыши над пустотой);
  // фронтоны (торцы двускатной) — часть крыши, их оставляем
  const roofOnly = !flat && tags['building:part'] === 'roof' && tri.roof.length > 0;
  if (roofOnly) tri.walls = tri.gableStart === undefined ? [] : tri.walls.slice(tri.gableStart);
  // Дно — у объектов с объёмом над землёй (видно снизу); на земле его не видно — треугольники не тратим. Цвет — как у стен.
  // Участки, лежащие на плоских крышах других частей, вырезаем: совпадающие грани мерцают, а дно стеклянной части
  // просвечивает поверх крыши. Крышу оставляем — она и есть перекрытие между частями (видна сквозь стекло)
  else if (hasBottom(prep)) {
    const rest = g.contacts && subtractFaces(polys, contactFaces(g.contacts.tops, f.key, heights.min, box2));
    tri.walls.push(...bottomTriangles(rest ?? polys, heights.min));
  }
  // Стеклянный фасад: внутри видны перекрытия — плиты на границах этажей (непрозрачные, после крыши)
  const glassWalls = isGlass(tags['building:material'] ?? tags.material);
  const floors = [...joint, ...(glassWalls && !flat && !roofOnly ? floorSlabs(polys, heights, tags, levelGridFor(f)?.map((l) => ({ z: l.z, holes: l.holes.map((p) => p.map((r) => r.map(g.toLocal))), mask: l.mask?.map((p) => p.map((r) => r.map(g.toLocal))) }))) : [])];
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

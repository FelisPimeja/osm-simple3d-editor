import * as THREE from 'three';
import { MercatorCoordinate, type LngLat, type CustomLayerInterface, type CustomRenderMethodInput, type Map as MlMap, type PointLike } from 'maplibre-gl';
import { computeHeights } from '../osm/heights';
import type { Feature3D, LonLat } from '../osm/model';
import { buildTriangles, type Pt } from './building-geometry';
import { timed } from '../perf';
import { orientedFrame, type LocalFrame } from './oriented-box';

const DEFAULT_WALL = '#ffffff';
const DEFAULT_ROOF = '#ffffff';
/** Подсветка поверх всего (выбор контура) — яркий оранжевый, чтобы отличалась от выделения. */
const OVERLAY_COLOUR = new THREE.Color('#ff6a00');
const HIGHLIGHT = new THREE.Color('#97beff'); // #2f7cff, смешанный с белым пополам
const MONOCHROME = new THREE.Color('#ffffff');

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
/** Бюджет асинхронной сборки группы на кадр, мс. */
const FRAME_BUDGET_MS = 8;

/** Здание внутри группы: треугольники в локальных метрах и всё, что нужно для раскраски и выбора. */
interface Item {
  feature: Feature3D;
  /** Теги для рисования: свои + унаследованные от контура/отношения. */
  tags: Record<string, string>;
  roofApproximated: boolean;
  /** Ждёт скелет из воркера. */
  pending: boolean;
  /** Треугольники: сначала стены, потом крыша, xyz. */
  positions: Float32Array;
  wallVertices: number;
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
 * Здания разбиты на группы (область редактирования, тайлы Overpass), у каждой свой origin —
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
    if (!features?.length) { this.focusAxes = undefined; this.focusLock = undefined; this.map?.triggerRepaint(); return; }
    const box = new THREE.Box2();
    for (const f of features) for (const p of f.polygons) for (const [lng, lat] of p.outer) box.expandByPoint(new THREE.Vector2(lng, lat));
    // Начало сцены, оси и сетка фиксируются при входе в режим и не меняются от правок до выхода
    const lock = this.focusLock;
    const c = lock ? new THREE.Vector2(...lock.center) : box.getCenter(new THREE.Vector2());
    const g = new MeshGroup([c.x, c.y]);
    g.footprint = 0; // объекты нулевой высоты — точно на своём уровне: к ним привязываются следующие
    for (const k of flat) g.flat.add(k);
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
  /** Сетка 10 м под зданием в режиме здания (G); выключенная — и без привязки к ней. */
  gridVisible = true;
  private gridFrame?: THREE.Object3D;

  setGridVisible(on: boolean) {
    this.gridVisible = on;
    if (this.gridFrame) this.gridFrame.visible = on;
    this.map?.triggerRepaint();
  }
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
    for (const s of this.snaps.points) {
      if (!filter(s.key)) continue;
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
    if (ray) for (const e of this.snaps.edges) {
      if (!filter(e.key)) continue;
      if (opts.from) {
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
      if (len > 0.05) {
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
          }
        }
      }
      ray.distanceSqToSegment(e.a, e.b, undefined, onSeg);
      const px = toPx(onSeg);
      const d = px ? Math.hypot(px[0] - point[0], px[1] - point[1]) : Infinity;
      if (px && d <= radius) near.push({ s: { kind: 'edge', key: e.key, p: onSeg.clone() }, d: d + SNAP_PRIORITY.edge * 6 - bonus(e.key), px });
    }
    // Узел сетки основания (земля, вдоль осей здания) под курсором
    const grid = filter(GRID_SNAP_KEY) && !this.sketching && this.gridVisible ? this.gridSnap(point) : undefined; // в наброске сетки не видно
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
    return { kind: s.kind, key: s.key, local: s.p.clone(), lngLat: merc.toLngLat(), altitude: s.p.z, point: px, along };
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
        n.subVectors(c, b).cross(a.clone().sub(b));
        if (n.lengthSq() < 1e-10) continue;
        n.normalize();
        out.push({ key, t: p.distanceTo(ray.origin), local: p.clone(), face: Math.abs(n.z) < 0.3 ? 'wall' : 'roof' });
      }
      // Дно: плоскость низа, точка внутри контура
      const z = it.box.min.z;
      if (Math.abs(ray.direction.z) > 1e-6) {
        const t = (z - ray.origin.z) / ray.direction.z;
        if (t > 0) {
          const q = ray.at(t, new THREE.Vector3());
          const inside = it.feature.polygons.some((poly) => pointInLocalRing([q.x, q.y], poly.outer.map(g.toLocal))
            && !poly.inners.some((r) => pointInLocalRing([q.x, q.y], r.map(g.toLocal))));
          if (inside) out.push({ key, t, local: q, face: 'bottom' });
        }
      }
    }
    return out.sort((x, y) => x.t - y.t);
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
    const g = this.groups.get(FOCUS_GROUP);
    const attr = g?.mesh?.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!g || !attr) return;
    const pos = attr.array as Float32Array;
    const [dx, dy, dz] = offset ? [offset.x, offset.y, offset.z] : [0, 0, 0];
    for (const k of keys) {
      const it = g.byKey.get(k);
      if (!it || g.hidden.has(k)) continue;
      const base = it.positions, o = it.start * 3;
      for (let i = 0; i < base.length; i += 3) {
        pos[o + i] = base[i] + dx; pos[o + i + 1] = base[i + 1] + dy; pos[o + i + 2] = base[i + 2] + dz;
      }
      // Стекло — в своём буфере, в общем его диапазоны нулевые
      const gattr = g.glass?.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
      let go = it.glassStart * 3;
      for (const [a, b] of glassRanges(it)) {
        pos.fill(0, o + a * 3, o + b * 3);
        if (gattr && it.glassStart >= 0) {
          const gp = gattr.array as Float32Array;
          for (let i = a * 3; i < b * 3; i += 3, go += 3) { gp[go] = base[i] + dx; gp[go + 1] = base[i + 1] + dy; gp[go + 2] = base[i + 2] + dz; }
          gattr.needsUpdate = true;
        }
      }
    }
    attr.needsUpdate = true;
    // Рёбра перемещаемых — отдельным объектом, сдвигаемым целиком; остальные остаются на месте
    if (offset && !this.movingEdges && this.graphics.edges && g.mesh) {
      this.applyEdges(g, new Set(keys));
      this.movingEdges = edgeLines(keys.filter((k) => !g.hidden.has(k)).map((k) => g.byKey.get(k)).filter((it): it is Item => !!it), EDGE_MATERIAL);
      g.scene.add(this.movingEdges);
    } else if (!offset && this.movingEdges) {
      this.movingEdges.parent?.remove(this.movingEdges);
      this.movingEdges.geometry.dispose();
      this.movingEdges = undefined;
      this.applyEdges(g);
    }
    this.movingEdges?.position.set(dx, dy, dz);
    if (this.hiddenEdges) this.hiddenEdges.position.set(dx, dy, dz);
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
  setMoveGuide(guide: { from: THREE.Vector3; to?: THREE.Vector3; axis?: 0 | 1 | 2; locked?: 0 | 1 | 2 } | undefined) {
    const g = this.groups.get(FOCUS_GROUP);
    if (this.moveGuide) {
      this.moveGuide.parent?.remove(this.moveGuide);
      this.moveGuide.traverse((o) => { if (o instanceof THREE.Mesh || o instanceof THREE.Line) { o.geometry.dispose(); (o.material as THREE.Material).dispose(); } });
      this.moveGuide = undefined;
    }
    if (guide && g && this.focusAxes) {
      const root = new THREE.Group();
      const frame = { ...this.focusAxes, origin: [guide.from.x, guide.from.y] as Pt };
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
  setDrawPreview(points: THREE.Vector3[] | undefined, closed = false) {
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
      if (points.length >= 3) {
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
  updateFeature(groupKey: string, f: Feature3D): RenderedFeature | undefined {
    const g = this.groups.get(groupKey);
    const focus = this.groups.get(FOCUS_GROUP);
    if (focus?.byKey.has(f.key)) { this.replaceItems(focus, [f]); this.snaps = undefined; this.updateHiddenEdges(); }
    if (!g || !g.byKey.has(f.key)) return;
    this.replaceItems(g, [f]);
    return rendered(g.byKey.get(f.key)!);
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
    this.graphics = { ...o };
    // Стекло — отдельный меш: при переключении пересобираем слитую геометрию
    if (glassChanged) for (const g of this.groups.values()) if (g.mesh) this.rebuildGeometry(g);
    for (const g of this.groups.values()) {
      g.applyLighting(o);
      this.paintGroup(g);
      this.applyEdges(g);
    }
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
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(total * 3), 3));
    geom.computeVertexNormals(); // без индексов — нормаль на треугольник
    g.mesh = new THREE.Mesh(geom, MATERIAL);
    g.mesh.frustumCulled = false; // своя матрица проекции — штатный culling не годится
    g.scene.add(g.mesh);
    if (glassTotal) {
      const gp = new Float32Array(glassTotal * 3);
      for (const it of g.items) {
        if (g.hidden.has(it.feature.key) || strokeOnly(g, it)) continue;
        let o = it.glassStart;
        for (const [a, b] of glassRanges(it)) { gp.set(it.positions.subarray(a * 3, b * 3), o * 3); o += b - a; }
      }
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
      const base = selected ? HIGHLIGHT : this.monochrome ? MONOCHROME : v < it.wallVertices ? it.wall : it.roof;
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

function pointInLocalRing([x, y]: Pt, ring: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export type SnapKind = 'vertex' | 'midpoint' | 'center' | 'grid' | 'perpendicular' | 'edge' | 'extension';
/** Ключ привязки к узлу сетки основания: фильтр snapAt пропускает его, если инструменту нужна и сетка. */
export const GRID_SNAP_KEY = '@grid';
interface SnapPoint { kind: SnapKind; key: string; p: THREE.Vector3 }
interface SnapEdge { key: string; a: THREE.Vector3; b: THREE.Vector3 }
/** Привязка под курсором: тип, объект, точка (в метрах сцены режима и географически) и положение на экране. */
/** along — у продолжения ребра: конец ребра, от которого идёт продолжение (для пунктира). */
export interface SnapHit { kind: SnapKind; key: string; local: THREE.Vector3; lngLat: LngLat; altitude: number; point: [number, number]; along?: THREE.Vector3 }
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
const SNAP_PRIORITY: Record<SnapKind, number> = { vertex: 0, midpoint: 1, perpendicular: 1, grid: 2, center: 2, extension: 4, edge: 3 };
/** Как далеко за конец ребра тянется его продолжение, м. */
const EXTENSION_M = 30;
/** Продолжение ловит курсор ближе обычного (px): иначе срабатывает почти везде вокруг здания. */
const EXTENSION_RADIUS_PX = 6;
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
  const add = (kind: SnapKind, key: string, x: number, y: number, z: number) => {
    // Общие вершины соседних частей — одна точка
    const id = `${kind}:${x.toFixed(2)}:${y.toFixed(2)}:${z.toFixed(2)}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ kind, key, p: new THREE.Vector3(x, y, z) });
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

const isGlass = (v: string | undefined) => !!v && v.split(';')[0].trim().toLowerCase() === 'glass';

/** Выключатель стекла в настройках графики (одна сцена на страницу — достаточно модульного флага). */
let glassEnabled = true;

/** Диапазоны вершин здания, рисуемые стеклом: [от, до). */
function glassRanges(it: Item): [number, number][] {
  const n = it.positions.length / 3, out: [number, number][] = [];
  if (!glassEnabled) return out;
  if (it.glassWalls && it.wallVertices) out.push([0, it.wallVertices]);
  if (it.glassRoof && n > it.wallVertices) out.push([it.wallVertices, n]);
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

/** Унаследованные частью теги (цвета, форма крыши, материалы контура/отношения) — задаёт main. */
let inheritFor: (f: Feature3D) => Record<string, string> | undefined = () => undefined;
export function setInheritance(fn: (f: Feature3D) => Record<string, string> | undefined) { inheritFor = fn; }

function buildItem(g: MeshGroup, f: Feature3D): Item {
  // Свои теги главнее унаследованных; в данных объекта ничего не меняется — только для рисования
  const inherited = inheritFor(f);
  const tags = inherited && Object.keys(inherited).length ? { ...inherited, ...f.tags } : f.tags;
  const polys = f.polygons.map((p) => ({ outer: p.outer.map(g.toLocal), inners: p.inners.map((r) => r.map(g.toLocal)) }));
  let heights = computeHeights(tags);
  // Контур под частями и здания нулевой высоты — плоский след на земле: видно и можно выделить
  const flat = f.hasParts || g.flat.has(f.key);
  if (flat || heights.top - heights.min < FOOTPRINT_HEIGHT) {
    const min = flat ? 0 : heights.min;
    heights = { ...heights, min, wallTop: min + g.footprint, top: min + g.footprint, roofShape: 'flat', roofHeight: 0 };
  }
  const tri = buildTriangles(polys, heights, tags);
  const positions = new Float32Array(tri.walls.length + tri.roof.length);
  positions.set(tri.walls, 0);
  positions.set(tri.roof, tri.walls.length);
  const wall = tags['building:colour'] ?? tags.colour ?? DEFAULT_WALL;
  const roof = tags['roof:colour'] ?? (tags['roof:shape'] && tags['roof:shape'] !== 'flat' ? DEFAULT_ROOF : wall);
  const box = new THREE.Box3();
  if (positions.length) box.setFromArray(positions);
  return {
    feature: f,
    tags,
    roofApproximated: tri.roofApproximated,
    pending: !!tri.pending,
    positions,
    wallVertices: tri.walls.length / 3,
    wall: parseColour(wall),
    roof: parseColour(roof),
    top: heights.top,
    box,
    start: 0,
    // material на здании — устаревший вариант building:material: только фасад
    glassWalls: isGlass(tags['building:material'] ?? tags.material),
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

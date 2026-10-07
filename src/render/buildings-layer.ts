import * as THREE from 'three';
import { MercatorCoordinate, type LngLat, type CustomLayerInterface, type CustomRenderMethodInput, type Map as MlMap, type PointLike } from 'maplibre-gl';
import { computeHeights } from '../osm/heights';
import type { Feature3D, LonLat } from '../osm/model';
import { buildTriangles, type Pt } from './building-geometry';
import { timed } from '../perf';

const DEFAULT_WALL = '#d9d0c9';
const DEFAULT_ROOF = '#a89c94';
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
/** Цвет берётся из вершин (стены/крыша, подсветка, затемнение) — один материал на всё. */
const MATERIAL = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
/** Бюджет асинхронной сборки группы на кадр, мс. */
const FRAME_BUDGET_MS = 8;

/** Здание внутри группы: треугольники в локальных метрах и всё, что нужно для раскраски и выбора. */
interface Item {
  feature: Feature3D;
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

  disposeMesh() {
    this.disposeEdges();
    if (!this.mesh) return;
    this.mesh.geometry.dispose();
    this.scene.remove(this.mesh);
    this.mesh = undefined;
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
    if (!this.focused) return [...this.groups].filter(([k]) => k !== FOCUS_GROUP).map(([, g]) => g);
    const g = this.groups.get(FOCUS_GROUP);
    return g ? [g] : [];
  }

  /**
   * Режим одного здания: только эти объекты и плоскость земли с сеткой под ними, остальное не рисуется.
   * undefined — выйти. Пока режим включён, правки объектов обновляют и его копию (updateFeature).
   */
  setFocus(features: Feature3D[] | undefined) {
    this.removeGroup(FOCUS_GROUP);
    this.focused = !!features;
    if (!features?.length) { this.map?.triggerRepaint(); return; }
    const box = new THREE.Box2();
    for (const f of features) for (const p of f.polygons) for (const [lng, lat] of p.outer) box.expandByPoint(new THREE.Vector2(lng, lat));
    const c = box.getCenter(new THREE.Vector2());
    const g = new MeshGroup([c.x, c.y]);
    for (const f of features) if (shouldRender(f)) this.addItem(g, f);
    // Земля: квадрат с запасом вокруг здания, сетка 10 м
    const [x0, y0] = g.toLocal([box.min.x, box.min.y]), [x1, y1] = g.toLocal([box.max.x, box.max.y]);
    const size = Math.ceil((Math.max(x1 - x0, y1 - y0) * 3 + 60) / 20) * 20;
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ color: GROUND_COLOUR }));
    ground.position.z = -0.02;
    const grid = new THREE.GridHelper(size, size / 10, GRID_COLOUR, GRID_COLOUR);
    grid.rotation.x = Math.PI / 2; // GridHelper лежит в XZ, у нас земля — XY
    grid.position.z = -0.01;
    g.scene.add(ground, grid);
    this.install(FOCUS_GROUP, g);
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
    g.applyLighting(this.graphics);
    timed(`${this.id}: слияние геометрии`, () => this.rebuildGeometry(g), () => `${key}, ${g.items.length} зданий`);
    this.groups.set(key, g);
    this.map?.triggerRepaint();
  }

  /** Пересобирает одно здание группы (после правки тегов). Выделение сохраняется. */
  updateFeature(groupKey: string, f: Feature3D): RenderedFeature | undefined {
    const g = this.groups.get(groupKey);
    const focus = this.groups.get(FOCUS_GROUP);
    if (focus?.byKey.has(f.key)) this.replaceItems(focus, [f]);
    if (!g || !g.byKey.has(f.key)) return;
    this.replaceItems(g, [f]);
    return rendered(g.byKey.get(f.key)!);
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
  setOverlay(keys: string | string[] | undefined) {
    for (const { scene, obj } of this.overlay) {
      scene.remove(obj);
      obj.traverse((o) => { if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) { o.geometry.dispose(); (o.material as THREE.Material).dispose(); } });
    }
    this.overlay = [];
    for (const key of keys === undefined ? [] : typeof keys === 'string' ? [keys] : keys) {
      const g = this.activeGroups().find((x) => x.byKey.has(key));
      const it = g?.byKey.get(key);
      if (!g || !it) continue;
      const z = it.box.isEmpty() ? 0 : it.box.max.z + 0.05;
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
      obj.add(fillMesh, lineMesh);
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
  pickHit(point: PointLike): { key: string; lngLat: LngLat; altitude: number } | undefined {
    return timed(`${this.id}: выбор под курсором`, () => this.pickHitImpl(point));
  }

  private pickHitImpl(point: PointLike): { key: string; lngLat: LngLat; altitude: number } | undefined {
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
        if (!ray.intersectsBox(item.box)) continue;
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
    return { key: best.key, lngLat: merc.toLngLat(), altitude: p.z };
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
    }
    this.map?.triggerRepaint();
  }

  setGraphics(o: GraphicsOptions) {
    this.graphics = { ...o };
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
    for (const it of g.items) positions.set(it.positions, it.start * 3);
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(total * 3), 3));
    geom.computeVertexNormals(); // без индексов — нормаль на треугольник
    g.mesh = new THREE.Mesh(geom, MATERIAL);
    g.mesh.frustumCulled = false; // своя матрица проекции — штатный culling не годится
    g.scene.add(g.mesh);
    this.paintGroup(g);
    this.applyEdges(g);
  }

  /**
   * Контуры рёбер: считаются по зданиям и кешируются на них (EdgesGeometry на весь тайл — ~150 мс,
   * а тайл пересобирается при каждой порции крыш), при слиянии только склеиваются.
   */
  private applyEdges(g: MeshGroup) {
    g.disposeEdges();
    if (!this.graphics.edges || !g.mesh) return;
    let total = 0;
    for (const it of g.items) {
      it.edges ??= itemEdges(it);
      total += it.edges.length;
    }
    const lines = new Float32Array(total);
    let o = 0;
    for (const it of g.items) { lines.set(it.edges!, o); o += it.edges!.length; }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(lines, 3));
    g.edges = new THREE.LineSegments(geom, EDGE_MATERIAL);
    g.edges.frustumCulled = false;
    g.scene.add(g.edges);
  }

  private paintGroup(g: MeshGroup) {
    for (const it of g.items) this.writeColors(g, it);
    const attr = g.mesh?.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
    if (attr) attr.needsUpdate = true;
  }

  private paintItem(g: MeshGroup, it: Item) {
    this.writeColors(g, it);
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
    const selected = this.selected.has(it.feature.key);
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
  }
}

function itemEdges(it: Item): Float32Array {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(it.positions, 3));
  const edges = new THREE.EdgesGeometry(geom, EDGE_ANGLE);
  const out = edges.getAttribute('position').array as Float32Array;
  edges.dispose();
  geom.dispose();
  return out;
}

/** Габариты всей группы — чтобы не перебирать здания тайлов, мимо которых луч проходит. */
const FOCUS_GROUP = '@focus';
const GROUND_COLOUR = 0xe8e6e1;
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

/** Высота плоского следа на земле, м: чуть выше земли, чтобы не мерцать с подложкой. */
const FOOTPRINT_HEIGHT = 0.1;

function buildItem(g: MeshGroup, f: Feature3D): Item {
  const polys = f.polygons.map((p) => ({ outer: p.outer.map(g.toLocal), inners: p.inners.map((r) => r.map(g.toLocal)) }));
  let heights = computeHeights(f.tags);
  // Контур под частями и здания нулевой высоты — плоский след на земле: видно и можно выделить
  if (f.hasParts || heights.top - heights.min < FOOTPRINT_HEIGHT) {
    const min = f.hasParts ? 0 : heights.min;
    heights = { ...heights, min, wallTop: min + FOOTPRINT_HEIGHT, top: min + FOOTPRINT_HEIGHT, roofShape: 'flat', roofHeight: 0 };
  }
  const tri = buildTriangles(polys, heights, f.tags);
  const positions = new Float32Array(tri.walls.length + tri.roof.length);
  positions.set(tri.walls, 0);
  positions.set(tri.roof, tri.walls.length);
  const wall = f.tags['building:colour'] ?? f.tags.colour ?? DEFAULT_WALL;
  const roof = f.tags['roof:colour'] ?? (f.tags['roof:shape'] && f.tags['roof:shape'] !== 'flat' ? DEFAULT_ROOF : wall);
  const box = new THREE.Box3();
  if (positions.length) box.setFromArray(positions);
  return {
    feature: f,
    roofApproximated: tri.roofApproximated,
    pending: !!tri.pending,
    positions,
    wallVertices: tri.walls.length / 3,
    wall: parseColour(wall),
    roof: parseColour(roof),
    top: heights.top,
    box,
    start: 0,
  };
}

/** Разобранные цвета: одинаковых значений тегов мало, а зданий — тысячи. */
const colourCache = new Map<string, THREE.Color>();
const unknownColours = new Set<string>();

/**
 * Цвет из тега; в OSM бывает несколько через ';' — берём первый. Вершинные цвета — в линейном пространстве.
 * Опечатки в тегах (lightgre, rgey) — частое дело: проверяем через CSS.supports, чтобы three.js
 * не писал предупреждение в консоль на каждое здание, и сообщаем о каждом значении один раз.
 */
function parseColour(colour: string): THREE.Color {
  const value = colour.split(';')[0].trim();
  let color = colourCache.get(value);
  if (!color) {
    color = new THREE.Color(DEFAULT_WALL);
    const valid = typeof CSS === 'undefined' ? /^#[0-9a-f]{3,8}$/i.test(value) : CSS.supports('color', value);
    if (valid) color.setStyle(value);
    else if (!unknownColours.has(value)) {
      unknownColours.add(value);
      console.debug(`Неизвестный цвет в теге: «${value}» — рисуем цветом по умолчанию`);
    }
    colourCache.set(value, color);
  }
  return color;
}

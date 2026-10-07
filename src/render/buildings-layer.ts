import * as THREE from 'three';
import { MercatorCoordinate, type LngLat, type CustomLayerInterface, type CustomRenderMethodInput, type Map as MlMap, type PointLike } from 'maplibre-gl';
import { computeHeights } from '../osm/heights';
import type { Feature3D, LonLat } from '../osm/model';
import { buildTriangles, type Pt } from './building-geometry';

const DEFAULT_WALL = '#d9d0c9';
const DEFAULT_ROOF = '#a89c94';
const HIGHLIGHT = new THREE.Color('#2f7cff');
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

/** Группа зданий со своей локальной системой координат (метры от origin). */
class MeshGroup {
  readonly scene = new THREE.Scene();
  readonly root = new THREE.Group();
  readonly origin: MercatorCoordinate;
  readonly metersToMerc: number;
  readonly model: THREE.Matrix4;
  readonly camera = new THREE.Camera();
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
    this.scene.add(this.ambient, this.hemi, sun, this.root);
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

  dispose() {
    for (const o of [...this.root.children] as THREE.Mesh[]) {
      disposeEdges(o);
      o.geometry.dispose();
      for (const m of o.material as THREE.Material[]) m.dispose();
      this.root.remove(o);
    }
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
  private selected?: THREE.Mesh;
  /** Все здания белым, без цветов из тегов. */
  private monochrome = false;
  private graphics: GraphicsOptions = { hemisphere: false, groundAO: false, edges: false };
  /** Треугольников в последнем кадре — для оценки производительности. */
  lastTriangles = 0;
  visible = true;

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
    const main = new THREE.Matrix4().fromArray(options.defaultProjectionData.mainMatrix as unknown as number[]);
    let triangles = 0;
    for (const g of this.groups.values()) {
      g.camera.projectionMatrix = main.clone().multiply(g.model);
      this.renderer.resetState();
      this.renderer.render(g.scene, g.camera);
      triangles += this.renderer.info.render.triangles;
    }
    this.lastTriangles = triangles;
  }

  /** Заменяет содержимое группы (или создаёт её). */
  setGroup(key: string, features: Feature3D[], center: LonLat): RenderedFeature[] {
    this.removeGroup(key);
    const g = new MeshGroup(center);
    const rendered: RenderedFeature[] = [];
    for (const f of features) {
      if (f.hasParts) continue;
      const { mesh, roofApproximated } = this.buildMesh(g, f);
      g.root.add(mesh);
      rendered.push({ feature: f, roofApproximated });
    }
    g.applyLighting(this.graphics);
    this.groups.set(key, g);
    this.map?.triggerRepaint();
    return rendered;
  }

  /** Пересобирает одно здание группы (после правки тегов). Выделение сохраняется. */
  updateFeature(groupKey: string, f: Feature3D): RenderedFeature | undefined {
    const g = this.groups.get(groupKey);
    const old = g?.root.children.find((o) => o.userData.key === f.key) as THREE.Mesh | undefined;
    if (!g || !old) return;
    const wasSelected = old === this.selected;
    const { mesh, roofApproximated } = this.buildMesh(g, f);
    disposeEdges(old);
    old.geometry.dispose();
    for (const m of old.material as THREE.Material[]) m.dispose();
    g.root.remove(old);
    g.root.add(mesh);
    if (wasSelected) {
      this.selected = mesh;
      this.paint(mesh);
    }
    this.map?.triggerRepaint();
    return { feature: f, roofApproximated };
  }

  /**
   * Пересобирает здания, подходящие под условие (например, когда догрузился straight skeleton).
   * Работа делится на порции по ~8 мс за кадр, чтобы не подвешивать страницу на тысячах зданий.
   */
  async rebuildWhere(pred: (f: Feature3D) => boolean, onRebuilt: (r: RenderedFeature) => void = () => {}) {
    const todo: [string, Feature3D][] = [];
    for (const [key, g] of this.groups) {
      for (const o of g.root.children) {
        const f = o.userData.feature as Feature3D;
        if (pred(f)) todo.push([key, f]);
      }
    }
    let i = 0;
    while (i < todo.length) {
      await new Promise(requestAnimationFrame);
      const deadline = performance.now() + 8;
      while (i < todo.length && performance.now() < deadline) {
        const [key, f] = todo[i++];
        const r = this.updateFeature(key, f); // группа могла исчезнуть, пока ждали кадр
        if (r) onRebuilt(r);
      }
    }
  }

  private buildMesh(g: MeshGroup, f: Feature3D): { mesh: THREE.Mesh; roofApproximated: boolean } {
    const polys = f.polygons.map((p) => ({ outer: p.outer.map(g.toLocal), inners: p.inners.map((r) => r.map(g.toLocal)) }));
    const heights = computeHeights(f.tags);
    const tri = buildTriangles(polys, heights, f.tags);
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute([...tri.walls, ...tri.roof], 3));
    geom.addGroup(0, tri.walls.length / 3, 0);
    geom.addGroup(tri.walls.length / 3, tri.roof.length / 3, 1);
    geom.computeVertexNormals();
    geom.setAttribute('color', groundAOColors(geom, heights.top));
    const wall = f.tags['building:colour'] ?? f.tags.colour ?? DEFAULT_WALL;
    const roof = f.tags['roof:colour'] ?? (f.tags['roof:shape'] && f.tags['roof:shape'] !== 'flat' ? DEFAULT_ROOF : wall);
    const mesh = new THREE.Mesh(geom, [material(wall), material(roof)]);
    mesh.userData.key = f.key;
    mesh.userData.feature = f;
    this.paint(mesh);
    this.applyMeshGraphics(mesh);
    return { mesh, roofApproximated: tri.roofApproximated };
  }

  hasGroup(key: string): boolean {
    return this.groups.has(key);
  }

  groupKeys(): string[] {
    return [...this.groups.keys()];
  }

  removeGroup(key: string) {
    const g = this.groups.get(key);
    if (!g) return;
    if (this.selected && g.root.children.includes(this.selected)) this.selected = undefined;
    g.dispose();
    this.groups.delete(key);
    this.map?.triggerRepaint();
  }

  clear() {
    this.lastTriangles = 0;
    for (const key of [...this.groups.keys()]) this.removeGroup(key);
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
    if (!this.visible || !this.map) return;
    const [px, py] = Array.isArray(point) ? point : [point.x, point.y];
    const canvas = this.map.getCanvas();
    const x = (px / canvas.clientWidth) * 2 - 1;
    const y = 1 - (py / canvas.clientHeight) * 2;
    let best: { key: string; depth: number; g: MeshGroup; p: THREE.Vector3 } | undefined;
    for (const g of this.groups.values()) {
      const m = g.camera.projectionMatrix;
      const inv = m.clone().invert();
      const near = new THREE.Vector3(x, y, -1).applyMatrix4(inv);
      const far = new THREE.Vector3(x, y, 1).applyMatrix4(inv);
      const hit = new THREE.Raycaster(near, far.sub(near).normalize()).intersectObjects(g.root.children, false)[0];
      if (!hit) continue;
      // Группы в разных локальных системах — сравниваем по глубине в clip space
      const depth = hit.point.clone().applyMatrix4(m).z;
      if (!best || depth < best.depth) best = { key: hit.object.userData.key, depth, g, p: hit.point };
    }
    if (!best) return;
    const { g, p } = best;
    const merc = new MercatorCoordinate(g.origin.x + p.x * g.metersToMerc, g.origin.y - p.y * g.metersToMerc, 0);
    return { key: best.key, lngLat: merc.toLngLat(), altitude: p.z };
  }

  select(key: string | undefined) {
    const prev = this.selected;
    this.selected = undefined;
    if (key) {
      for (const g of this.groups.values()) {
        this.selected = g.root.children.find((o) => o.userData.key === key) as THREE.Mesh | undefined;
        if (this.selected) break;
      }
    }
    if (prev) this.paint(prev);
    if (this.selected) this.paint(this.selected);
    this.map?.triggerRepaint();
  }

  setGraphics(o: GraphicsOptions) {
    this.graphics = { ...o };
    for (const g of this.groups.values()) {
      g.applyLighting(o);
      for (const m of g.root.children) this.applyMeshGraphics(m as THREE.Mesh);
    }
    this.map?.triggerRepaint();
  }

  private applyMeshGraphics(mesh: THREE.Mesh) {
    for (const m of mesh.material as THREE.MeshLambertMaterial[]) {
      if (m.vertexColors !== this.graphics.groundAO) {
        m.vertexColors = this.graphics.groundAO;
        m.needsUpdate = true; // смена define в шейдере
      }
    }
    // Контуры создаём лениво: выключенные ничего не стоят
    if (this.graphics.edges && !mesh.userData.edges) {
      const lines = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, EDGE_ANGLE), EDGE_MATERIAL);
      mesh.add(lines);
      mesh.userData.edges = lines;
    } else if (!this.graphics.edges && mesh.userData.edges) {
      disposeEdges(mesh);
    }
  }

  setMonochrome(on: boolean) {
    this.monochrome = on;
    for (const g of this.groups.values()) for (const o of g.root.children) this.paint(o as THREE.Mesh);
    this.map?.triggerRepaint();
  }

  /** Цвет материалов меша: выбранное — подсветка целиком (поверх цвета теряется на рыжем кирпиче). */
  private paint(mesh: THREE.Mesh) {
    for (const m of mesh.material as THREE.MeshLambertMaterial[]) {
      m.color.copy(mesh === this.selected ? HIGHLIGHT : this.monochrome ? MONOCHROME : m.userData.color);
    }
  }
}

function material(colour: string): THREE.MeshLambertMaterial {
  const color = new THREE.Color(DEFAULT_WALL);
  // В OSM бывает несколько цветов через ';' — берём первый
  try { color.setStyle(colour.split(';')[0].trim()); } catch { /* невалидный цвет — оставляем дефолт */ }
  const m = new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide });
  m.userData.color = color.clone();
  return m;
}

function disposeEdges(mesh: THREE.Mesh) {
  const lines = mesh.userData.edges as THREE.LineSegments | undefined;
  if (!lines) return;
  lines.geometry.dispose();
  mesh.remove(lines);
  delete mesh.userData.edges;
}

/**
 * Цвет вершин для затемнения у земли, относительно высоты здания:
 * - затемнение сходит на нет на min(AO_HEIGHT, AO_FADE_SHARE · высота) — у низких зданий только самый низ;
 * - глубина пропорциональна высоте до AO_HEIGHT — сарай в 2 м темнеет у земли лишь до ~85%.
 */
function groundAOColors(geom: THREE.BufferGeometry, top: number): THREE.BufferAttribute {
  const fade = Math.max(0.5, Math.min(AO_HEIGHT, AO_FADE_SHARE * top));
  const depth = (1 - AO_MIN) * Math.min(1, top / AO_HEIGHT);
  const pos = geom.getAttribute('position');
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const t = Math.min(1, Math.max(0, pos.getZ(i) / fade));
    const k = 1 - depth * (1 - t * t * (3 - 2 * t));
    colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = k;
  }
  return new THREE.BufferAttribute(colors, 3);
}

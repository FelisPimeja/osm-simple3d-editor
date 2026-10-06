import * as THREE from 'three';
import { MercatorCoordinate, type CustomLayerInterface, type CustomRenderMethodInput, type Map as MlMap, type PointLike } from 'maplibre-gl';
import { computeHeights } from '../osm/heights';
import type { Feature3D, LonLat } from '../osm/model';
import { buildTriangles, type Pt } from './building-geometry';

const DEFAULT_WALL = '#d9d0c9';
const DEFAULT_ROOF = '#a89c94';
const HIGHLIGHT = new THREE.Color('#2f7cff');

export interface RenderedFeature { feature: Feature3D; roofApproximated: boolean }

/** Группа зданий со своей локальной системой координат (метры от origin). */
class MeshGroup {
  readonly scene = new THREE.Scene();
  readonly root = new THREE.Group();
  readonly origin: MercatorCoordinate;
  readonly metersToMerc: number;
  readonly model: THREE.Matrix4;
  readonly camera = new THREE.Camera();

  constructor(center: LonLat) {
    this.origin = MercatorCoordinate.fromLngLat({ lng: center[0], lat: center[1] }, 0);
    this.metersToMerc = this.origin.meterInMercatorCoordinateUnits();
    const s = this.metersToMerc;
    // Локальная система в метрах: x — восток, y — север, z — вверх
    this.model = new THREE.Matrix4().makeTranslation(this.origin.x, this.origin.y, 0).scale(new THREE.Vector3(s, -s, s));
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.8);
    sun.position.set(-0.5, -1, 1.5);
    this.scene.add(sun, this.root);
  }

  toLocal = ([lng, lat]: LonLat): Pt => {
    const c = MercatorCoordinate.fromLngLat({ lng, lat }, 0);
    return [(c.x - this.origin.x) / this.metersToMerc, -(c.y - this.origin.y) / this.metersToMerc];
  };

  dispose() {
    for (const o of [...this.root.children] as THREE.Mesh[]) {
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
    for (const g of this.groups.values()) {
      g.camera.projectionMatrix = main.clone().multiply(g.model);
      this.renderer.resetState();
      this.renderer.render(g.scene, g.camera);
    }
  }

  /** Заменяет содержимое группы (или создаёт её). */
  setGroup(key: string, features: Feature3D[], center: LonLat): RenderedFeature[] {
    this.removeGroup(key);
    const g = new MeshGroup(center);
    const rendered: RenderedFeature[] = [];
    for (const f of features) {
      if (f.hasParts) continue;
      const polys = f.polygons.map((p) => ({ outer: p.outer.map(g.toLocal), inners: p.inners.map((r) => r.map(g.toLocal)) }));
      const tri = buildTriangles(polys, computeHeights(f.tags), f.tags);
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.Float32BufferAttribute([...tri.walls, ...tri.roof], 3));
      geom.addGroup(0, tri.walls.length / 3, 0);
      geom.addGroup(tri.walls.length / 3, tri.roof.length / 3, 1);
      geom.computeVertexNormals();
      const wall = f.tags['building:colour'] ?? f.tags.colour ?? DEFAULT_WALL;
      const roof = f.tags['roof:colour'] ?? (f.tags['roof:shape'] && f.tags['roof:shape'] !== 'flat' ? DEFAULT_ROOF : wall);
      const mesh = new THREE.Mesh(geom, [material(wall), material(roof)]);
      mesh.userData.key = f.key;
      g.root.add(mesh);
      rendered.push({ feature: f, roofApproximated: tri.roofApproximated });
    }
    this.groups.set(key, g);
    this.map?.triggerRepaint();
    return rendered;
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
    for (const key of [...this.groups.keys()]) this.removeGroup(key);
  }

  setVisible(visible: boolean) {
    this.visible = visible;
    this.map?.triggerRepaint();
  }

  /** Возвращает ключ ближайшего здания под точкой экрана (CSS px). */
  pick(point: PointLike): string | undefined {
    if (!this.visible || !this.map) return;
    const [px, py] = Array.isArray(point) ? point : [point.x, point.y];
    const canvas = this.map.getCanvas();
    const x = (px / canvas.clientWidth) * 2 - 1;
    const y = 1 - (py / canvas.clientHeight) * 2;
    let best: { key: string; depth: number } | undefined;
    for (const g of this.groups.values()) {
      const m = g.camera.projectionMatrix;
      const inv = m.clone().invert();
      const near = new THREE.Vector3(x, y, -1).applyMatrix4(inv);
      const far = new THREE.Vector3(x, y, 1).applyMatrix4(inv);
      const hit = new THREE.Raycaster(near, far.sub(near).normalize()).intersectObjects(g.root.children, false)[0];
      if (!hit) continue;
      // Группы в разных локальных системах — сравниваем по глубине в clip space
      const depth = hit.point.clone().applyMatrix4(m).z;
      if (!best || depth < best.depth) best = { key: hit.object.userData.key, depth };
    }
    return best?.key;
  }

  select(key: string | undefined) {
    // Выбранное здание перекрашиваем целиком: подсветка поверх цвета теряется на рыжем кирпиче
    const paint = (mesh: THREE.Mesh | undefined, selected: boolean) => {
      for (const m of (mesh?.material ?? []) as THREE.MeshLambertMaterial[]) {
        m.color.copy(selected ? HIGHLIGHT : m.userData.color);
      }
    };
    paint(this.selected, false);
    this.selected = undefined;
    if (key) {
      for (const g of this.groups.values()) {
        this.selected = g.root.children.find((o) => o.userData.key === key) as THREE.Mesh | undefined;
        if (this.selected) break;
      }
    }
    paint(this.selected, true);
    this.map?.triggerRepaint();
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

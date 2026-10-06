import * as THREE from 'three';
import { MercatorCoordinate, type CustomLayerInterface, type CustomRenderMethodInput, type Map as MlMap, type PointLike } from 'maplibre-gl';
import { computeHeights } from '../osm/heights';
import type { Feature3D, LonLat } from '../osm/model';
import { buildTriangles, type Pt } from './building-geometry';

const DEFAULT_WALL = '#d9d0c9';
const DEFAULT_ROOF = '#a89c94';
const HIGHLIGHT = new THREE.Color('#2f7cff');

export interface RenderedFeature { feature: Feature3D; roofApproximated: boolean }

/** Custom layer MapLibre, рисующий здания из OSM API через three.js. */
export class BuildingsLayer implements CustomLayerInterface {
  readonly id = 'osm-edit-buildings';
  readonly type = 'custom' as const;
  readonly renderingMode = '3d' as const;

  private map!: MlMap;
  private renderer!: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.Camera();
  private readonly group = new THREE.Group();
  private origin = new MercatorCoordinate(0, 0, 0);
  private metersToMerc = 1;
  private model = new THREE.Matrix4();
  private selected?: THREE.Mesh;

  constructor() {
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.8);
    sun.position.set(-0.5, -1, 1.5); // в локальных координатах: z вверх
    this.scene.add(sun, this.group);
  }

  onAdd(map: MlMap, gl: WebGL2RenderingContext) {
    this.map = map;
    this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
    this.renderer.autoClear = false;
  }

  onRemove() {
    this.clear();
    this.renderer.dispose();
  }

  render(_gl: WebGL2RenderingContext, options: CustomRenderMethodInput) {
    const m = new THREE.Matrix4().fromArray(options.defaultProjectionData.mainMatrix as unknown as number[]);
    this.camera.projectionMatrix = m.multiply(this.model);
    this.renderer.resetState();
    this.renderer.render(this.scene, this.camera);
  }

  setFeatures(features: Feature3D[], center: LonLat): RenderedFeature[] {
    this.clear();
    this.origin = MercatorCoordinate.fromLngLat({ lng: center[0], lat: center[1] }, 0);
    this.metersToMerc = this.origin.meterInMercatorCoordinateUnits();
    const s = this.metersToMerc;
    // Локальная система в метрах: x — восток, y — север, z — вверх
    this.model = new THREE.Matrix4().makeTranslation(this.origin.x, this.origin.y, 0).scale(new THREE.Vector3(s, -s, s));

    const rendered: RenderedFeature[] = [];
    for (const f of features) {
      if (f.hasParts) continue;
      const polys = f.polygons.map((p) => ({ outer: p.outer.map(this.toLocal), inners: p.inners.map((r) => r.map(this.toLocal)) }));
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
      this.group.add(mesh);
      rendered.push({ feature: f, roofApproximated: tri.roofApproximated });
    }
    this.map?.triggerRepaint();
    return rendered;
  }

  /** Возвращает ключ здания под точкой экрана (CSS px). */
  pick(point: PointLike): string | undefined {
    const [px, py] = Array.isArray(point) ? point : [point.x, point.y];
    const canvas = this.map.getCanvas();
    const x = (px / canvas.clientWidth) * 2 - 1;
    const y = 1 - (py / canvas.clientHeight) * 2;
    const inv = this.camera.projectionMatrix.clone().invert();
    const near = new THREE.Vector3(x, y, -1).applyMatrix4(inv);
    const far = new THREE.Vector3(x, y, 1).applyMatrix4(inv);
    const ray = new THREE.Raycaster(near, far.sub(near).normalize());
    return ray.intersectObjects(this.group.children, false)[0]?.object.userData.key;
  }

  select(key: string | undefined) {
    // Выбранное здание перекрашиваем целиком: подсветка поверх цвета теряется на рыжем кирпиче
    const paint = (mesh: THREE.Mesh | undefined, selected: boolean) => {
      for (const m of (mesh?.material ?? []) as THREE.MeshLambertMaterial[]) {
        m.color.copy(selected ? HIGHLIGHT : m.userData.color);
      }
    };
    paint(this.selected, false);
    this.selected = this.group.children.find((o) => o.userData.key === key) as THREE.Mesh | undefined;
    paint(this.selected, true);
    this.map?.triggerRepaint();
  }

  private toLocal = ([lng, lat]: LonLat): Pt => {
    const c = MercatorCoordinate.fromLngLat({ lng, lat }, 0);
    return [(c.x - this.origin.x) / this.metersToMerc, -(c.y - this.origin.y) / this.metersToMerc];
  };

  private clear() {
    this.selected = undefined;
    for (const o of [...this.group.children] as THREE.Mesh[]) {
      o.geometry.dispose();
      for (const m of o.material as THREE.Material[]) m.dispose();
      this.group.remove(o);
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

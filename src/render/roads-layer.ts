import * as THREE from 'three';
import { MercatorCoordinate, type CustomLayerInterface, type CustomRenderMethodInput, type Map as MlMap } from 'maplibre-gl';
import type { LonLat } from '../osm/model';
import type { RoadWay } from '../osm/roads';
import { timed } from '../perf';
import { buildRoadMesh } from './road-geometry';

const SOLID = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
const GLASS = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity: 0.45, depthWrite: false });

/**
 * Custom layer MapLibre: мосты, тоннели и развязки из дорог загруженных тайлов (эксперимент).
 * Вся сеть — одна сцена с началом в центре её охвата: пандус и его мост могут лежать в разных тайлах.
 */
export class RoadsLayer implements CustomLayerInterface {
  readonly type = 'custom' as const;
  readonly renderingMode = '3d' as const;
  private map?: MlMap;
  private renderer?: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.Camera();
  private model = new THREE.Matrix4();
  private meshes: THREE.Mesh[] = [];
  /** Набор путей последней сборки — чтобы не пересобирать то же самое. */
  private signature = '';
  /** Сколько путей нарисовано. */
  drawnWays = 0;
  private enabled = false;

  constructor(readonly id: string) {
    const hemi = new THREE.HemisphereLight(0xffffff, 0xc4c2bc, 1.6);
    hemi.position.set(0, 0, 1);
    const sun = new THREE.DirectionalLight(0xffffff, 1.8);
    sun.position.set(-0.5, -1, 1.5);
    this.scene.add(hemi, sun);
  }

  onAdd(map: MlMap, gl: WebGL2RenderingContext) {
    this.map = map;
    this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
    this.renderer.autoClear = false;
  }

  onRemove() {
    this.clear();
    this.renderer?.dispose();
    this.renderer = undefined;
  }

  render(_gl: WebGL2RenderingContext, options: CustomRenderMethodInput) {
    if (!this.enabled || !this.renderer || !this.meshes.length) return;
    const main = new THREE.Matrix4().fromArray(options.defaultProjectionData.mainMatrix as unknown as number[]);
    this.camera.projectionMatrix = main.multiply(this.model);
    this.renderer.resetState();
    this.renderer.render(this.scene, this.camera);
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    if (!on) this.clear();
    this.map?.triggerRepaint();
  }

  get isEnabled() { return this.enabled; }

  /** Пути всех показанных тайлов (с повторами — пути на границе приходят в обоих). */
  setRoads(all: RoadWay[]) {
    if (!this.enabled) return;
    const byId = new Map<number, RoadWay>();
    for (const w of all) byId.set(w.id, w);
    const ways = [...byId.values()];
    const signature = ways.map((w) => w.id).sort((a, b) => a - b).join(',');
    if (signature === this.signature) return;
    this.clear();
    this.signature = signature;
    if (!ways.length) return;
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const r of ways) for (const [x, y] of r.coords) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }
    const origin = MercatorCoordinate.fromLngLat({ lng: (w + e) / 2, lat: (s + n) / 2 }, 0);
    const m = origin.meterInMercatorCoordinateUnits();
    // Локальная система в метрах: x — восток, y — север, z — вверх (как у групп BuildingsLayer)
    this.model = new THREE.Matrix4().makeTranslation(origin.x, origin.y, 0).scale(new THREE.Vector3(m, -m, m));
    const toLocal = ([lng, lat]: LonLat): [number, number] => {
      const c = MercatorCoordinate.fromLngLat({ lng, lat }, 0);
      return [(c.x - origin.x) / m, -(c.y - origin.y) / m];
    };
    const data = timed('дороги: сборка', () => buildRoadMesh(ways, toLocal), (d) => `${d.ways} путей из ${ways.length}`);
    this.drawnWays = data.ways;
    for (const [part, material, order] of [[data.solid, SOLID, 0], [data.glass, GLASS, 1]] as const) {
      if (!part.positions.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(part.positions, 3));
      g.setAttribute('color', new THREE.BufferAttribute(part.colors, 3));
      g.computeVertexNormals();
      const mesh = new THREE.Mesh(g, material);
      mesh.renderOrder = order;
      mesh.frustumCulled = false;
      this.meshes.push(mesh);
      this.scene.add(mesh);
    }
    this.map?.triggerRepaint();
  }

  clear() {
    for (const mesh of this.meshes) { mesh.geometry.dispose(); this.scene.remove(mesh); }
    this.meshes = [];
    this.signature = '';
    this.drawnWays = 0;
  }
}

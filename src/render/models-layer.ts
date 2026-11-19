import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MercatorCoordinate, type Map as MlMap } from 'maplibre-gl';
import type { LonLat } from '../osm/model';

/** Репозиторий 3D-моделей OSM: .glb по id (CORS открыт). */
const API = 'https://3dmr.eu/api/model/';
/** Сколько моделей грузить одновременно. */
const PARALLEL = 3;

/** Объект с тегом 3dmr=<id>: куда ставить модель. */
/** hides — объекты, которых заменяет модель: сам объект и части здания внутри его контура. */
export interface ModelPlacement { key: string; id: number; at: LonLat; z: number; rotation: number; hides: string[] }

/** id модели из тега 3dmr (бывает «12» или «12;34» — берём первый). */
export function modelIdOf(tags: Record<string, string>): number | undefined {
  const id = Number((tags['3dmr'] ?? '').split(';')[0].trim());
  return Number.isInteger(id) && id > 0 ? id : undefined;
}

/**
 * Модели из 3dmr.eu вместо процедурной геометрии объектов с тегом 3dmr. Модель в метрах, ось Y вверх,
 * -Z на север, начало координат — точка привязки; ставится в центр контура на его min_height.
 * Рисует слой зданий в своём проходе (drawExtra) — общая глубина со зданиями.
 */
export class ModelsLayer {
  private map?: MlMap;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.Camera();
  private readonly loader = new GLTFLoader();
  /** Загруженные (или не загрузившиеся — null) модели по id. */
  private readonly models = new Map<number, THREE.Object3D | null>();
  private readonly queue: number[] = [];
  private loading = 0;
  private placements: ModelPlacement[] = [];
  private enabled = false;
  /** Модель объекта появилась (или пропала) — перерисовать его процедурную геометрию. */
  onShown?: (keys: string[]) => void;
  hidden: () => boolean = () => false;

  constructor() {
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x888888, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.2);
    sun.position.set(0.5, -0.7, 1);
    this.scene.add(sun);
  }

  attach(map: MlMap) { this.map = map; }

  get isEnabled() { return this.enabled; }

  setEnabled(on: boolean) {
    if (on === this.enabled) return;
    this.enabled = on;
    const keys = this.placements.filter((p) => this.models.get(p.id)).flatMap((p) => p.hides);
    if (!on) this.setPlacements([]);
    if (keys.length) this.onShown?.(keys);
    this.map?.triggerRepaint();
  }

  /** Модель объекта показана — его собственную геометрию не рисовать. */
  shows(key: string): boolean {
    return this.enabled && this.placements.some((p) => p.hides.includes(key) && !!this.models.get(p.id));
  }

  setPlacements(list: ModelPlacement[]) {
    this.placements = this.enabled ? list : [];
    for (const p of this.placements) if (!this.models.has(p.id) && !this.queue.includes(p.id)) this.queue.push(p.id);
    this.pump();
    this.rebuild();
  }

  private pump() {
    while (this.loading < PARALLEL && this.queue.length) {
      const id = this.queue.shift()!;
      this.loading++;
      this.loader.loadAsync(API + id).then((gltf) => {
        const root = new THREE.Group();
        gltf.scene.rotation.x = Math.PI / 2; // Y вверх → Z вверх, -Z (север) → +Y
        root.add(gltf.scene);
        this.models.set(id, root);
      }).catch((err) => {
        console.warn(`3dmr: модель ${id} не загрузилась`, err);
        this.models.set(id, null);
      }).finally(() => {
        this.loading--;
        const keys = this.placements.filter((p) => p.id === id).flatMap((p) => p.hides);
        this.rebuild();
        if (keys.length && this.models.get(id)) this.onShown?.(keys);
        this.pump();
      });
    }
  }

  private origin = new MercatorCoordinate(0, 0, 0);
  private model = new THREE.Matrix4();

  private rebuild() {
    for (const c of [...this.scene.children]) if (c.userData.placed) this.scene.remove(c);
    const shown = this.placements.filter((p) => this.models.get(p.id));
    if (shown.length) {
      const [lng, lat] = shown[0].at;
      const origin = MercatorCoordinate.fromLngLat({ lng, lat }, 0);
      const m = origin.meterInMercatorCoordinateUnits();
      this.origin = origin;
      // Локальная система в метрах: x — восток, y — север, z — вверх (как у слоя зданий)
      this.model = new THREE.Matrix4().makeTranslation(origin.x, origin.y, 0).scale(new THREE.Vector3(m, -m, m));
      for (const p of shown) {
        const c = MercatorCoordinate.fromLngLat({ lng: p.at[0], lat: p.at[1] }, 0);
        const inst = this.models.get(p.id)!.clone();
        inst.position.set((c.x - this.origin.x) / m, -(c.y - this.origin.y) / m, p.z);
        inst.rotation.z = (-p.rotation * Math.PI) / 180; // по часовой от севера
        inst.userData.placed = true;
        this.scene.add(inst);
      }
    }
    this.map?.triggerRepaint();
  }

  draw(renderer: THREE.WebGLRenderer, main: THREE.Matrix4): number {
    if (!this.enabled || !this.scene.children.some((c) => c.userData.placed) || this.hidden()) return 0;
    this.camera.projectionMatrix = main.clone().multiply(this.model);
    renderer.render(this.scene, this.camera);
    return renderer.info.render.triangles;
  }
}

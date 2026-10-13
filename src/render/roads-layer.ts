import * as THREE from 'three';
import { MercatorCoordinate, type CustomLayerInterface, type CustomRenderMethodInput, type Map as MlMap } from 'maplibre-gl';
import type { LonLat } from '../osm/model';
import { isBridge, isTunnel, roadLevel, type RoadWay } from '../osm/roads';
import { timed } from '../perf';
import { buildRoadMesh, type Obstacle, type RoadMeshData, type RoadPart } from './road-geometry';

const SOLID = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
const GLASS = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity: 0.45, depthWrite: false });
/** Цвета как у зданий: выделенное, монохром непрозрачного и стекла. */
const HIGHLIGHT = new THREE.Color('#97beff');
const MONO = new THREE.Color('#ffffff');
const GLASS_MONO = new THREE.Color('#bfe3e6');

let worker: Worker | undefined;
let nextJob = 1;
const jobs = new Map<number, (data: RoadMeshData) => void>();

/** Сборка в воркере (без воркера или при его ошибке — в главном потоке). ox, oy — начало, m — метр (Меркатор). */
function buildAsync(ways: RoadWay[], obstacles: Obstacle[], ox: number, oy: number, m: number): Promise<RoadMeshData> {
  const local = () => buildRoadMesh(ways, ([lng, lat]: LonLat): [number, number] => {
    const c = MercatorCoordinate.fromLngLat({ lng, lat }, 0);
    return [(c.x - ox) / m, -(c.y - oy) / m];
  }, obstacles);
  if (typeof Worker === 'undefined') return Promise.resolve(local());
  if (!worker) {
    worker = new Worker(new URL('./road-geometry-worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ id: number; data: RoadMeshData }>) => {
      jobs.get(e.data.id)?.(e.data.data);
      jobs.delete(e.data.id);
    };
    worker.onerror = (e) => {
      console.warn('дороги: ошибка воркера — сборка в главном потоке:', e.message);
      worker?.terminate();
      worker = undefined;
      jobs.clear();
    };
  }
  const id = nextJob++;
  return new Promise((resolve) => {
    jobs.set(id, resolve);
    worker!.postMessage({ id, ways, obstacles, ox, oy, m });
  });
}

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
  /** Начало локальной системы сборки и метр в единицах Меркатора. */
  private origin = new MercatorCoordinate(0, 0, 0);
  private metre = 1;
  private meshes: THREE.Mesh[] = [];
  /** Для клика: части сборки и пути, на которые ссылаются их треугольники. */
  private parts: RoadPart[] = [];
  private ways: RoadWay[] = [];
  /** Набор путей последней сборки — чтобы не пересобирать то же самое. */
  private signature = '';
  /** Сколько путей нарисовано. */
  drawnWays = 0;
  /** Полосы поднятого полотна в координатах Меркатора: ax, ay, bx, by, полуширина — для вырубки деревьев. */
  treeCuts: Float64Array = new Float64Array(0);
  /** Вызывается, когда собрана новая сеть (например, чтобы вырубить деревья под мостами). */
  onBuilt?: () => void;
  /** Скрыт ли слой сейчас (например, в режиме здания карта убрана): не рисуется и не кликается. */
  hidden: () => boolean = () => false;
  private enabled = false;
  private bridges = true;
  private tunnels = true;
  private monochrome = false;
  /** id выделенных путей (клик, Shift+клик) — подсвечены, как выделенное здание. */
  private selectedIds = new Set<number>();

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
    if (!this.enabled || !this.renderer || !this.meshes.length || this.hidden()) return;
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

  /** «Убрать цвета»: всё непрозрачное белое, тоннели — светлое стекло (как у зданий). */
  setMonochrome(on: boolean) {
    this.monochrome = on;
    this.paint();
  }

  /** Подсветить пути (id); пустой список — снять подсветку. */
  select(ids: number[]) {
    if (ids.length === this.selectedIds.size && ids.every((id) => this.selectedIds.has(id))) return;
    this.selectedIds = new Set(ids);
    this.paint();
  }

  /** Цвета вершин: исходные, монохром и подсветка выделенного пути. */
  private paint() {
    const sel = new Set(this.ways.flatMap((w, i) => (this.selectedIds.has(w.id) ? [i] : [])));
    this.parts.forEach((part, pi) => {
      const attr = this.meshes.find((m) => m.userData.part === pi)?.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
      if (!attr) return;
      const out = attr.array as Float32Array;
      const mono = pi === 0 ? MONO : GLASS_MONO;
      for (let t = 0; t < part.ways.length; t++) {
        const c = sel.has(part.ways[t]) ? HIGHLIGHT : this.monochrome ? mono : undefined;
        for (let k = t * 9; k < t * 9 + 9; k += 3) {
          if (c) { out[k] = c.r; out[k + 1] = c.g; out[k + 2] = c.b; }
          else { out[k] = part.colors[k]; out[k + 1] = part.colors[k + 1]; out[k + 2] = part.colors[k + 2]; }
        }
      }
      attr.needsUpdate = true;
    });
    this.map?.triggerRepaint();
  }

  /** Что показывать: мосты (и пути выше земли), тоннели (и пути ниже). Меняется — пересоберём при следующем setRoads. */
  setKinds(bridges: boolean, tunnels: boolean) {
    if (bridges === this.bridges && tunnels === this.tunnels) return;
    this.bridges = bridges;
    this.tunnels = tunnels;
    this.signature = '';
  }

  /** Пути всех показанных тайлов (с повторами — пути на границе приходят в обоих). */
  setRoads(all: RoadWay[], obstacles: Obstacle[] = []) {
    if (!this.enabled) return;
    const byId = new Map<string, RoadWay>();
    for (const w of all) {
      // Выключенный вид убираем целиком: без него и подходы к нему не поднимаются (не опускаются)
      const level = roadLevel(w.tags);
      if (!this.bridges && (isBridge(w.tags) || level > 0)) continue;
      if (!this.tunnels && (isTunnel(w.tags) || level < 0)) continue;
      byId.set(String(w.id), w);
    }
    const keys = [...byId.keys()].sort();
    const signature = `${+this.bridges}${+this.tunnels}:${obstacles.length}:` + keys.join(',');
    const ways = [...byId.values()];
    if (signature === this.signature) return;
    this.signature = signature;
    if (!ways.length) { this.clearMeshes(); this.onBuilt?.(); return; }
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const r of ways) for (const [x, y] of r.coords) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }
    const origin = MercatorCoordinate.fromLngLat({ lng: (w + e) / 2, lat: (s + n) / 2 }, 0);
    const m = origin.meterInMercatorCoordinateUnits();
    const started = performance.now();
    // Сборка — в воркере; старые мосты остаются на экране, пока не придут новые
    void buildAsync(ways, obstacles, origin.x, origin.y, m).then((data) => {
      if (this.signature !== signature || !this.enabled) return; // за это время набор путей сменился
      timed('дороги: сборка (воркер)', () => this.install(ways, data, origin, m), () => `${data.ways} путей из ${ways.length}, ${Math.round(performance.now() - started)} мс всего`);
    });
  }

  /** Поставить собранные меши (вместо прежних). */
  private install(ways: RoadWay[], data: RoadMeshData, origin: MercatorCoordinate, m: number) {
    this.clearMeshes();
    this.origin = origin;
    this.metre = m;
    // Локальная система в метрах: x — восток, y — север, z — вверх (как у групп BuildingsLayer)
    this.model = new THREE.Matrix4().makeTranslation(origin.x, origin.y, 0).scale(new THREE.Vector3(m, -m, m));
    this.drawnWays = data.ways;
    this.treeCuts = Float64Array.from(data.cuts, (v, i) => (i % 5 === 0 || i % 5 === 2 ? origin.x + v * m : i % 5 === 1 || i % 5 === 3 ? origin.y - v * m : v * m));
    this.ways = ways;
    this.parts = [data.solid, data.glass];
    for (const [part, material, order] of [[data.solid, SOLID, 0], [data.glass, GLASS, 1]] as const) {
      if (!part.positions.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(part.positions, 3));
      // Своя копия цветов: исходные (part.colors) нужны, чтобы снимать монохром и подсветку
      g.setAttribute('color', new THREE.BufferAttribute(part.colors.slice(), 3));
      g.computeVertexNormals();
      const mesh = new THREE.Mesh(g, material);
      mesh.renderOrder = order;
      mesh.userData.part = order;
      mesh.frustumCulled = false;
      this.meshes.push(mesh);
      this.scene.add(mesh);
    }
    this.paint();
    this.onBuilt?.();
  }

  /** Путь под курсором (ближайший треугольник) и глубина попадания в clip space — для сравнения со зданиями. */
  pick(px: number, py: number): { way: RoadWay; depth: number } | undefined {
    if (!this.enabled || !this.map || !this.parts.length || this.hidden()) return;
    const canvas = this.map.getCanvas();
    const x = (px / canvas.clientWidth) * 2 - 1;
    const y = 1 - (py / canvas.clientHeight) * 2;
    const m = this.camera.projectionMatrix;
    const inv = m.clone().invert();
    const near = new THREE.Vector3(x, y, -1).applyMatrix4(inv);
    const far = new THREE.Vector3(x, y, 1).applyMatrix4(inv);
    const ray = new THREE.Ray(near, far.sub(near).normalize());
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), hit = new THREE.Vector3();
    let best: { wi: number; dist: number; p: THREE.Vector3 } | undefined;
    for (const part of this.parts) {
      const pos = part.positions;
      for (let i = 0, t = 0; i < pos.length; i += 9, t++) {
        a.fromArray(pos, i); b.fromArray(pos, i + 3); c.fromArray(pos, i + 6);
        if (!ray.intersectTriangle(a, b, c, false, hit)) continue;
        const dist = hit.distanceTo(ray.origin);
        if (!best || dist < best.dist) best = { wi: part.ways[t], dist, p: hit.clone() };
      }
    }
    if (!best) return;
    return { way: this.ways[best.wi], depth: best.p.applyMatrix4(m).z };
  }

  /** Глубина точки (lngLat, высота над землёй) в clip space той же камеры, что у pick. */
  depthOf(lngLat: { lng: number; lat: number }, altitude: number): number {
    const c = MercatorCoordinate.fromLngLat(lngLat, 0);
    const p = new THREE.Vector3((c.x - this.origin.x) / this.metre, -(c.y - this.origin.y) / this.metre, altitude);
    return p.applyMatrix4(this.camera.projectionMatrix).z;
  }

  clear() {
    this.clearMeshes();
    this.signature = '';
  }

  private clearMeshes() {
    for (const mesh of this.meshes) { mesh.geometry.dispose(); this.scene.remove(mesh); }
    this.meshes = [];
    this.parts = [];
    this.ways = [];
    this.drawnWays = 0;
    this.treeCuts = new Float64Array(0);
  }
}

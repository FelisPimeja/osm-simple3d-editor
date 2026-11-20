import * as THREE from 'three';
import { type CustomLayerInterface, type CustomRenderMethodInput, type Map as MlMap } from 'maplibre-gl';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type { ContourJob, ContourResult } from './contours-worker';

/** Шаг горизонталей по зуму карты: [основной, утолщённый], м (как у 2D-слоя). */
export type ContourThresholds = Record<number, [number, number]>;

/** Сколько тайлов держать собранными, сколько брать в кадр и сколько считать одновременно. */
const KEEP = 60;
const IN_VIEW = 30;
const PARALLEL = 4;
/**
 * Подтяжка к камере, экранные пиксели: сетка рельефа MapLibre грубее тайла высот — на обрыве линия уходила бы под
 * неё. В пикселях (а не постоянной глубиной): при отдалении линии за хребтом не выходят вперёд.
 */
const PULL_PX = 3;
/**
 * …но не меньше этого, м, на z17 (вдвое больше на каждый уровень отдаления): сетка рельефа MapLibre расходится с
 * точными отметками на метры, а при отдалении она грубее — без этого линии вдали рвутся в пунктир.
 */
const PULL_M = 4;

/** Трансформ камеры MapLibre (в 6.x — у map._camera; публичного доступа к положению камеры нет). */
function mapTransform(map: MlMap): { fov?: number; getCameraLngLat?(): { lng: number; lat: number } } | undefined {
  const m = map as unknown as { _camera?: { transform?: object }; transform?: object };
  return (m._camera?.transform ?? m.transform) as ReturnType<typeof mapTransform>;
}

interface TileLines { key: string; model: THREE.Matrix4; group: THREE.Group; used: number; labels: Float64Array }

/** Положение камеры в координатах модели по матрице модель→клип: точка, где x, y и w клипа равны нулю. */
function cameraEye(m: THREE.Matrix4, out: THREE.Vector3): THREE.Vector3 {
  const e = m.elements;
  const row = (r: number) => [e[r], e[4 + r], e[8 + r], e[12 + r]];
  const [x, y, w] = [row(0), row(1), row(3)];
  const a = new THREE.Matrix3().set(x[0], x[1], x[2], y[0], y[1], y[2], w[0], w[1], w[2]);
  if (Math.abs(a.determinant()) < 1e-30) return out;
  return out.set(-x[3], -y[3], -w[3]).applyMatrix3(a.invert());
}

/** Линии с подтяжкой к камере на долю расстояния до неё (eye, pull — uniforms). */
function pulledMaterial(colour: number, opacity: number, uniforms: { eye: { value: THREE.Vector3 }; pull: { value: number }; pullM: { value: number } }) {
  const m = new LineMaterial({ color: colour, linewidth: 1, worldUnits: false, transparent: true, opacity, depthWrite: false });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.eye = uniforms.eye;
    shader.uniforms.pull = uniforms.pull;
    shader.uniforms.pullM = uniforms.pullM;
    // Доля пути к камере: pull (экранные пиксели) или pullM метров — что больше; локальные единицы — метры
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', 'uniform vec3 eye;\nuniform float pull;\nuniform float pullM;\nvec3 pulled( vec3 p ) { vec3 d = eye - p; return p + d * min( 0.5, max( pull, pullM / max( length( d ), 1.0 ) ) ); }\nvoid main() {')
      .replace('vec4 start = modelViewMatrix * vec4( instanceStart, 1.0 );', 'vec4 start = modelViewMatrix * vec4( pulled( instanceStart ), 1.0 );')
      .replace('vec4 end = modelViewMatrix * vec4( instanceEnd, 1.0 );', 'vec4 end = modelViewMatrix * vec4( pulled( instanceEnd ), 1.0 );');
  };
  m.customProgramCacheKey = () => 'contour-pull';
  return m;
}

let worker: Worker | undefined;
let nextJob = 1;
const jobs = new Map<number, (r: ContourResult) => void>();
function contourJob(job: Omit<ContourJob, 'id'>): Promise<ContourResult> {
  if (!worker) {
    worker = new Worker(new URL('./contours-worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (ev: MessageEvent<ContourResult>) => { jobs.get(ev.data.id)?.(ev.data); jobs.delete(ev.data.id); };
  }
  const id = nextJob++;
  return new Promise((resolve) => { jobs.set(id, resolve); worker!.postMessage({ ...job, id }); });
}

/**
 * Горизонтали 3D-линиями (рельеф, эксперимент): изолинии считаются в воркере из тех же тайлов высот
 * (maplibre-contour) и рисуются на своей высоте линией постоянной экранной толщины. Натянутые на рельеф текстурой
 * (2D-слой MapLibre) на обрывах растягивались в широкие размытые полосы.
 */
export class ContoursLayer implements CustomLayerInterface {
  readonly type = 'custom' as const;
  readonly renderingMode = '3d' as const;
  private map?: MlMap;
  private renderer?: THREE.WebGLRenderer;
  private readonly camera = new THREE.Camera();
  private readonly tiles = new Map<string, TileLines>();
  private readonly loading = new Set<string>();
  private enabled = false;
  private readonly uniforms = { eye: { value: new THREE.Vector3() }, pull: { value: 0 }, pullM: { value: PULL_M } };
  private readonly minor = pulledMaterial(0x9a6b3f, 0.55, this.uniforms);
  private readonly major = pulledMaterial(0x9a6b3f, 0.85, this.uniforms);
  private readonly onMove = () => this.update();
  /** Подписи тайлов кадра изменились: точки (долгота, широта) с отметкой и поворотом — в разрывах линий. */
  onLabels?: (labels: { lon: number; lat: number; ele: number; angle: number }[]) => void;
  private labelsSig = '';

  constructor(readonly id: string, private readonly thresholds: ContourThresholds, private readonly maxZoom: number) {}

  onAdd(map: MlMap, gl: WebGL2RenderingContext) {
    this.map = map;
    this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
    this.renderer.autoClear = false;
    map.on('moveend', this.onMove);
    this.update();
  }

  onRemove() {
    this.map?.off('moveend', this.onMove);
    this.clear();
    this.renderer?.dispose();
    this.renderer = undefined;
  }

  setEnabled(on: boolean) {
    if (on === this.enabled) return;
    this.enabled = on;
    if (!on) { this.clear(); this.emitLabels([]); }
    else this.update();
    this.map?.triggerRepaint();
  }

  render(_gl: WebGL2RenderingContext, options: CustomRenderMethodInput) {
    if (!this.enabled || !this.renderer || !this.map || !this.tiles.size) return;
    const main = new THREE.Matrix4().fromArray(options.defaultProjectionData.mainMatrix as unknown as number[]);
    const canvas = this.map.getCanvas(), dpr = window.devicePixelRatio || 1;
    for (const m of [this.minor, this.major]) m.resolution.set(canvas.width, canvas.height);
    this.minor.linewidth = 1 * dpr;
    this.major.linewidth = 1.6 * dpr;
    // Доля расстояния до камеры, равная PULL_PX пикселям экрана (вертикальный угол обзора MapLibre)
    const fov = mapTransform(this.map)?.fov ?? 36.87;
    this.uniforms.pull.value = (PULL_PX * 2 * Math.tan((fov * Math.PI) / 360)) / canvas.clientHeight;
    this.uniforms.pullM.value = PULL_M * 2 ** Math.max(0, 17 - this.map.getZoom());
    this.renderer.resetState();
    for (const key of this.wanted()) {
      const t = this.tiles.get(key);
      if (!t) continue;
      const pm = main.clone().multiply(t.model);
      this.camera.projectionMatrix = pm;
      this.camera.projectionMatrixInverse.copy(pm).invert();
      cameraEye(pm, this.uniforms.eye.value);
      this.renderer.render(t.group, this.camera);
    }
  }

  /** Шаг [основной, утолщённый] для зума карты. */
  private step(zoom: number): [number, number] | undefined {
    let best: [number, number] | undefined;
    for (const [z, v] of Object.entries(this.thresholds)) if (Number(z) <= zoom) best = v;
    return best;
  }

  /** Ключи тайлов кадра (ближние к центру — первыми): z/x/y/шаг/утолщённый шаг. */
  private wanted(): string[] {
    const map = this.map!;
    const st = this.step(map.getZoom());
    if (!st) return [];
    // Тайлы высот на зум ниже карты: пиксель высот ≈ 2 экранных — для линий достаточно, тайлов и отрезков вчетверо меньше
    const z = Math.max(8, Math.min(this.maxZoom, Math.floor(map.getZoom()) - 1)), n = 2 ** z;
    const b = map.getBounds();
    const tx = (lon: number) => Math.floor(((lon + 180) / 360) * n);
    const ty = (lat: number) => { const s = Math.sin((lat * Math.PI) / 180); return Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n); };
    const x0 = tx(b.getWest()), x1 = tx(b.getEast()), y0 = Math.max(0, ty(b.getNorth())), y1 = Math.min(n - 1, ty(b.getSouth()));
    // Ближние к камере — первыми (при наклоне центр карты далеко впереди, а передний план важнее)
    const c = mapTransform(map)?.getCameraLngLat?.() ?? map.getCenter(), cx = tx(c.lng) + 0.5, cy = ty(c.lat) + 0.5;
    const out: { key: string; d: number }[] = [];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push({ key: `${z}/${x}/${y}/${st[0]}/${st[1]}`, d: Math.hypot(x + 0.5 - cx, y + 0.5 - cy) });
    return out.sort((a, b) => a.d - b.d).slice(0, IN_VIEW).map((o) => o.key);
  }

  private update() {
    if (!this.enabled || !this.map) return;
    const want = this.wanted();
    const now = performance.now();
    for (const key of want) { const t = this.tiles.get(key); if (t) t.used = now; }
    // Не больше PARALLEL заданий: воркер не копит очередь из тайлов, мимо которых уже прокрутили
    for (const key of want) {
      if (this.loading.size >= PARALLEL) break;
      if (!this.tiles.has(key) && !this.loading.has(key)) void this.load(key);
    }
    if (this.tiles.size > KEEP) {
      for (const t of [...this.tiles.values()].sort((a, b) => a.used - b.used).slice(0, this.tiles.size - KEEP)) this.drop(t.key);
    }
    this.emitLabels(want);
  }

  /** Подписи нарисованных тайлов кадра — наружу (слой символов MapLibre), только если набор поменялся. */
  private emitLabels(want: string[]) {
    const drawn = want.filter((k) => this.tiles.has(k));
    const sig = this.enabled ? drawn.join(',') : '';
    if (sig === this.labelsSig) return;
    this.labelsSig = sig;
    const out: { lon: number; lat: number; ele: number; angle: number }[] = [];
    if (this.enabled) for (const k of drawn) {
      const l = this.tiles.get(k)!.labels;
      for (let i = 0; i + 3 < l.length; i += 4) out.push({ lon: l[i], lat: l[i + 1], ele: l[i + 2], angle: l[i + 3] });
    }
    this.onLabels?.(out);
  }

  private async load(key: string) {
    this.loading.add(key);
    try {
      const [z, x, y, minor, major] = key.split('/').map(Number);
      const res = await contourJob({ z, x, y, minor, major });
      if (!this.enabled) return;
      const group = new THREE.Group();
      for (const [pos, mat] of [[res.minor, this.minor], [res.major, this.major]] as const) {
        if (!pos.length) continue;
        const geo = new LineSegmentsGeometry();
        geo.setPositions(pos);
        const line = new LineSegments2(geo, mat);
        line.frustumCulled = false;
        group.add(line);
      }
      const n = 2 ** z, m = res.metre;
      const model = new THREE.Matrix4().makeTranslation(x / n, y / n, 0).scale(new THREE.Vector3(m, -m, m));
      this.drop(key);
      this.tiles.set(key, { key, model, group, used: performance.now(), labels: res.labels });
      this.map?.triggerRepaint();
    } finally {
      this.loading.delete(key);
      this.update(); // следующие тайлы кадра
    }
  }

  private drop(key: string) {
    const t = this.tiles.get(key);
    if (!t) return;
    for (const o of t.group.children) (o as LineSegments2).geometry.dispose();
    this.tiles.delete(key);
  }

  private clear() {
    for (const key of [...this.tiles.keys()]) this.drop(key);
  }
}

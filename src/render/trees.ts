import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MercatorCoordinate } from 'maplibre-gl';
import type { LonLat } from '../osm/model';
import type { TreeData } from '../osm/trees';
import { hash, NEEDLE_FLAG, scatterTrees, TREE_STRIDE, TreeField as F, WOOD_FLAG } from './tree-scatter';

/** Дерево в 15 м ниже этого на экране (во всём тайле) — упрощённые модели, px. */
const FAR_PX = 30;
const PROBE_HEIGHT = 15;

let worker: Worker | undefined;
let nextJob = 1;
const jobs = new Map<number, (trees: Float64Array) => void>();

/** Разброс деревьев тайла в воркере (без воркера — в главном потоке). */
export function scatterTreesAsync(own: TreeData, woods: TreeData['woods'], buildings: LonLat[][], bbox: [number, number, number, number]): Promise<Float64Array> {
  if (typeof Worker === 'undefined') return Promise.resolve(scatterTrees(own, woods, buildings, bbox));
  if (!worker) {
    worker = new Worker(new URL('./tree-scatter-worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ id: number; trees: Float64Array }>) => {
      jobs.get(e.data.id)?.(e.data.trees);
      jobs.delete(e.data.id);
    };
    worker.onerror = (e) => {
      console.warn('деревья: ошибка воркера — разброс в главном потоке:', e.message);
      worker?.terminate();
      worker = undefined;
      for (const done of jobs.values()) done(new Float64Array(0));
      jobs.clear();
    };
  }
  const id = nextJob++;
  return new Promise((resolve) => {
    jobs.set(id, resolve);
    worker!.postMessage({ id, own, woods, buildings, bbox });
  });
}

// Модели: ось z вверх, основание в z = 0, высота и радиус 1 (масштабируются на дерево)
const Z_UP = new THREE.Matrix4().makeRotationX(Math.PI / 2);

/** Ствол — пятигранная призма без торцов. */
const TRUNK_GEO = new THREE.CylinderGeometry(1, 1, 1, 5, 1, true).applyMatrix4(Z_UP).translate(0, 0, 0.5);

/** Лиственная крона — икосаэдр со сдвинутыми вершинами: гранёный «лоу-поли» шар от z = 0 до z = 1. */
const broadCrown = (detail: number) => {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const p = g.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    // Сдвиг зависит от положения вершины — у совпадающих вершин соседних граней он один и тот же
    const k = 0.85 + 0.3 * hash(Math.round(v.x * 1000), Math.round(v.y * 1000), Math.round(v.z * 1000));
    p.setXYZ(i, v.x * k, v.y * k, v.z * k);
  }
  g.computeVertexNormals();
  return g.applyMatrix4(Z_UP).scale(1, 1, 0.5).translate(0, 0, 0.5);
};
const BROAD_GEO = broadCrown(1);
/** Дальний план: 20 граней вместо 80. */
const BROAD_FAR_GEO = broadCrown(0);

/** Хвойная крона — три яруса конусов от z = 0 до z = 1; донья не нужны — снизу (pitch ≤ 85°) их не видно. */
const NEEDLE_GEO = (() => {
  const tiers = [[1, 0, 0.5], [0.78, 0.28, 0.45], [0.55, 0.55, 0.45]].map(([r, z, h]) =>
    new THREE.ConeGeometry(r, h, 7, 1, true).applyMatrix4(Z_UP).translate(0, 0, z + h / 2));
  const g = mergeGeometries(tiers.map((t) => t.toNonIndexed()))!;
  g.computeVertexNormals();
  return g;
})();
/** Дальний план: один конус на всю крону. */
const NEEDLE_FAR_GEO = new THREE.ConeGeometry(0.85, 1, 6, 1, true).applyMatrix4(Z_UP).translate(0, 0, 0.5);

const COLOURS = { trunk: new THREE.Color('#7a5c43'), broad: new THREE.Color('#79a356'), needle: new THREE.Color('#3f7650') };
/** «Убрать цвета»: деревья вполовину бледнее (смешаны с белым), но не белые. */
const PALE = 0.5;
const WHITE = new THREE.Color(0xffffff);
const TRUNK_MATERIAL = new THREE.MeshLambertMaterial({ color: COLOURS.trunk, flatShading: true });
const BROAD_MATERIAL = new THREE.MeshLambertMaterial({ color: COLOURS.broad, flatShading: true });
const NEEDLE_MATERIAL = new THREE.MeshLambertMaterial({ color: COLOURS.needle, flatShading: true });

export function setTreesMonochrome(on: boolean) {
  const t = on ? PALE : 0;
  TRUNK_MATERIAL.color.copy(COLOURS.trunk).lerp(WHITE, t);
  BROAD_MATERIAL.color.copy(COLOURS.broad).lerp(WHITE, t);
  NEEDLE_MATERIAL.color.copy(COLOURS.needle).lerp(WHITE, t);
}

/**
 * Деревья одного тайла: стволы, лиственные и хвойные кроны — инстансированные меши (по draw call на каждый).
 * Для дальнего плана — те же инстансы с упрощёнными кронами.
 */
export class TreeGroup {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.Camera();
  readonly model: THREE.Matrix4;
  readonly count: number;
  private readonly trunks: THREE.InstancedMesh;
  private readonly near: THREE.InstancedMesh[] = [];
  private readonly far: THREE.InstancedMesh[] = [];
  /** Углы и центр тайла (локальные метры) — по ним выбирается детализация. */
  private readonly probes: THREE.Vector3[];
  private isFar?: boolean;
  // Свет — как у зданий (MeshGroup)
  private readonly ambient = new THREE.AmbientLight(0xffffff, 1.6);
  private readonly hemi = new THREE.HemisphereLight(0xffffff, 0xc4c2bc, 1.6);

  /** signature — подпись набора лесов и данных тайла: пересобираем, только если она поменялась. */
  constructor(bbox: [number, number, number, number], trees: Float64Array, readonly signature: string) {
    const [w, s, e, n] = bbox;
    const origin = MercatorCoordinate.fromLngLat({ lng: (w + e) / 2, lat: (s + n) / 2 }, 0);
    const unit = origin.meterInMercatorCoordinateUnits();
    this.model = new THREE.Matrix4().makeTranslation(origin.x, origin.y, 0).scale(new THREE.Vector3(unit, -unit, unit));
    const local = (lng: number, lat: number) => {
      const c = MercatorCoordinate.fromLngLat({ lng, lat }, 0);
      return new THREE.Vector3((c.x - origin.x) / unit, -(c.y - origin.y) / unit, 0);
    };
    this.probes = [local(w, s), local(e, s), local(w, n), local(e, n), new THREE.Vector3()];

    const total = trees.length / TREE_STRIDE;
    this.count = total;
    let needles = 0, trunked = 0;
    for (let i = 0; i < total; i++) {
      const flags = trees[i * TREE_STRIDE + F.FLAGS];
      if (flags & NEEDLE_FLAG) needles++;
      if (!(flags & WOOD_FLAG)) trunked++;
    }
    const trunks = new THREE.InstancedMesh(TRUNK_GEO, TRUNK_MATERIAL, trunked);
    const broad = new THREE.InstancedMesh(BROAD_GEO, BROAD_MATERIAL, total - needles);
    const needle = new THREE.InstancedMesh(NEEDLE_GEO, NEEDLE_MATERIAL, needles);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const zAxis = new THREE.Vector3(0, 0, 1);
    const pos = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const colour = new THREE.Color();
    let b = 0, nd = 0, tr = 0;
    for (let i = 0; i < total; i++) {
      const o = i * TREE_STRIDE;
      const height = trees[o + F.HEIGHT], crown = trees[o + F.CROWN], seed = trees[o + F.SEED], flags = trees[o + F.FLAGS];
      const isNeedle = (flags & NEEDLE_FLAG) !== 0;
      const x = (trees[o + F.MX] - origin.x) / unit, y = -(trees[o + F.MY] - origin.y) / unit;
      // Крона: у лиственного — верхние 65 % высоты, у хвойного — от 15 % до верха; ствол уходит в крону
      const base = height * (isNeedle ? 0.15 : 0.35);
      q.setFromAxisAngle(zAxis, seed * Math.PI * 2);
      if (!(flags & WOOD_FLAG)) {
        const trunk = trees[o + F.TRUNK];
        m.compose(pos.set(x, y, 0), q, scale.set(trunk, trunk, base + (height - base) * 0.3));
        trunks.setMatrixAt(tr++, m);
      }
      m.compose(pos.set(x, y, base), q, scale.set(crown / 2, crown / 2, height - base));
      // Разброс оттенка: светлее/темнее и чуть теплее/холоднее — множитель к цвету материала
      const l = 0.85 + 0.3 * seed, warm = 0.06 * (hash(i, Math.round(seed * 1e6)) - 0.5);
      colour.setRGB(l * (1 + warm), l, l * (1 - warm));
      if (isNeedle) { needle.setMatrixAt(nd, m); needle.setColorAt(nd++, colour); }
      else { broad.setMatrixAt(b, m); broad.setColorAt(b++, colour); }
    }
    // Дальний план — те же матрицы и цвета (общие буферы), другие модели
    const farOf = (mesh: THREE.InstancedMesh, geo: THREE.BufferGeometry) => {
      const f = new THREE.InstancedMesh(geo, mesh.material, mesh.count);
      f.instanceMatrix = mesh.instanceMatrix;
      f.instanceColor = mesh.instanceColor;
      return f;
    };
    // Стволы — только у отдельных деревьев и рядов, их немного: остаются и на дальнем плане (иначе кроны висят в воздухе)
    this.trunks = trunks;
    this.near.push(broad, needle);
    this.far.push(farOf(broad, BROAD_FAR_GEO), farOf(needle, NEEDLE_FAR_GEO));
    for (const mesh of [trunks, ...this.near, ...this.far]) {
      mesh.frustumCulled = false;
      if (mesh.count) this.scene.add(mesh);
    }
    this.ambient.position.set(0, 0, 1);
    this.hemi.position.set(0, 0, 1);
    const sun = new THREE.DirectionalLight(0xffffff, 1.8);
    sun.position.set(-0.5, -1, 1.5);
    this.scene.add(this.ambient, this.hemi, sun);
    this.setFar(false);
  }

  applyLighting(hemisphere: boolean) {
    this.ambient.visible = !hemisphere;
    this.hemi.visible = hemisphere;
  }

  private readonly a = new THREE.Vector4();
  private readonly b = new THREE.Vector4();

  /**
   * Перед кадром (camera.projectionMatrix уже выставлена, viewportHeight — в px): false — тайл целиком вне
   * кадра, не рисовать. Иначе выбирается детализация: если 15-метровое дерево хоть где-то в тайле (углы,
   * центр) крупнее FAR_PX — подробные модели.
   */
  prepare(viewportHeight: number): boolean {
    const pm = this.camera.projectionMatrix;
    let far = true;
    // Отсечение: все углы тайла (на земле и на высоте деревьев) по одну сторону одной плоскости кадра
    let left = 0, right = 0, below = 0, above = 0, behind = 0;
    for (const p of this.probes) {
      this.a.set(p.x, p.y, 0, 1).applyMatrix4(pm);
      this.b.set(p.x, p.y, PROBE_HEIGHT, 1).applyMatrix4(pm);
      for (const v of [this.a, this.b]) {
        if (v.x < -v.w) left++;
        if (v.x > v.w) right++;
        if (v.y < -v.w) below++;
        if (v.y > v.w) above++;
        if (v.w <= 0) behind++;
      }
      // Точка за камерой — тайл тянется прямо под неё, значит рядом
      if (this.a.w <= 0 || this.b.w <= 0) far = false;
      else if (Math.abs(this.b.y / this.b.w - this.a.y / this.a.w) * viewportHeight / 2 > FAR_PX) far = false;
    }
    const all = this.probes.length * 2;
    if (left === all || right === all || below === all || above === all || behind === all) return false;
    this.setFar(far);
    return true;
  }

  private setFar(far: boolean) {
    if (this.isFar === far) return;
    this.isFar = far;
    for (const mesh of this.near) mesh.visible = !far;
    for (const mesh of this.far) mesh.visible = far;
  }

  dispose() {
    this.trunks.dispose();
    for (const mesh of this.near) mesh.dispose();
    for (const mesh of this.far) mesh.dispose();
    this.scene.clear();
  }
}

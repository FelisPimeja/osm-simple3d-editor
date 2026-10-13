import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MercatorCoordinate } from 'maplibre-gl';
import type { LonLat } from '../osm/model';
import type { TreeData } from '../osm/trees';
import { hash, NEEDLE_FLAG, scatterTrees, TREE_STRIDE, TreeField as F, WOOD_FLAG } from './tree-scatter';

/** Дерево в 15 м ниже этого на экране (во всём тайле) — упрощённые модели, px. */
const FAR_PX = 30;
const PROBE_HEIGHT = 15;
/** Стволы леса — только если 15-метровое дерево где-то в тайле крупнее этого, px (ближе, чем подробные кроны). */
const WOOD_TRUNK_PX = 90;

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
/** «Убрать цвета»: деревья на 25 % бледнее (смешаны с белым), но не белые. */
const PALE = 0.25;
const WHITE = new THREE.Color(0xffffff);
const TRUNK_MATERIAL = new THREE.MeshLambertMaterial({ color: COLOURS.trunk, flatShading: true });
/** Цвет лиственных крон целиком в цвете инстанса (сезон, разброс, бледность) — материал белый. */
const BROAD_MATERIAL = new THREE.MeshLambertMaterial({ color: WHITE, flatShading: true });
const NEEDLE_MATERIAL = new THREE.MeshLambertMaterial({ color: COLOURS.needle, flatShading: true });

let monochrome = false;
/** Лиственные по времени года (сегодняшняя дата, южное полушарие — со сдвигом на полгода). */
let seasonal = false;

export function setTreesMonochrome(on: boolean) {
  monochrome = on;
  const t = on ? PALE : 0;
  TRUNK_MATERIAL.color.copy(COLOURS.trunk).lerp(WHITE, t);
  NEEDLE_MATERIAL.color.copy(COLOURS.needle).lerp(WHITE, t);
}

export function setTreesSeasonal(on: boolean) {
  seasonal = on;
}

/** День года (0–365) без учёта високосных — для календаря листвы. */
const dayOf = (month: number, day: number) => [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334][month - 1] + day - 1;
const BARE = new THREE.Color('#8f8578');
const SPRING = new THREE.Color('#a6cc64');
const SUMMER = COLOURS.broad;
const AUTUMN = ['#e0b83a', '#d98a2b', '#c4532c', '#a9b043'].map((c) => new THREE.Color(c));
const LATE = new THREE.Color('#9c7a4c');
/** Календарь листвы умеренного пояса (северное полушарие): опорные дни и цвет кроны в них (r — свой у дерева). */
const SEASON_KEYS: { day: number; colour: (r: number) => THREE.Color }[] = [
  { day: dayOf(4, 5), colour: () => BARE },
  { day: dayOf(5, 5), colour: () => SPRING },
  { day: dayOf(6, 15), colour: () => SUMMER },
  { day: dayOf(9, 5), colour: () => SUMMER },
  { day: dayOf(10, 5), colour: (r) => AUTUMN[Math.floor(r * AUTUMN.length)] },
  { day: dayOf(11, 1), colour: () => LATE },
  { day: dayOf(11, 20), colour: () => BARE },
];
/** Ближе к экватору — вечнозелёные, м. широты. */
const TROPICS = 23.5;

/** Цвет лиственной кроны в день года day на широте lat; seed — разброс по деревьям (сроки ±1 неделя, оттенок осени). */
function seasonColour(out: THREE.Color, day: number, lat: number, seed: number): THREE.Color {
  if (Math.abs(lat) < TROPICS) return out.copy(SUMMER);
  const r1 = hash(Math.round(seed * 1e6), 11), r2 = hash(Math.round(seed * 1e6), 12);
  let d = day + (lat < 0 ? 182 : 0) + (r1 - 0.5) * 14;
  d = ((d % 365) + 365) % 365;
  const n = SEASON_KEYS.length;
  let i = SEASON_KEYS.findIndex((k) => k.day > d) - 1;
  if (i === -2) i = n - 1; // после последней опорной точки
  const a = SEASON_KEYS[(i + n) % n], b = SEASON_KEYS[(i + 1) % n];
  const span = (b.day - a.day + 365) % 365 || 365;
  const t = ((d - a.day + 365) % 365) / span;
  return out.copy(a.colour(r2)).lerp(b.colour(r2), t);
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
  /** Стволы деревьев леса: их много и под пологом их не видно издалека — только совсем вблизи (WOOD_TRUNK_PX). */
  private readonly woodTrunks: THREE.InstancedMesh;
  private readonly broad: THREE.InstancedMesh;
  private readonly broadSeeds: Float32Array;
  private readonly lat: number;
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
    let needles = 0, trunked = 0, woodTrunked = 0;
    for (let i = 0; i < total; i++) {
      const flags = trees[i * TREE_STRIDE + F.FLAGS];
      if (flags & NEEDLE_FLAG) needles++;
      if (!(flags & WOOD_FLAG)) trunked++;
      else if (trees[i * TREE_STRIDE + F.TRUNK] > 0) woodTrunked++;
    }
    const trunks = new THREE.InstancedMesh(TRUNK_GEO, TRUNK_MATERIAL, trunked);
    const woodTrunks = new THREE.InstancedMesh(TRUNK_GEO, TRUNK_MATERIAL, woodTrunked);
    const broad = new THREE.InstancedMesh(BROAD_GEO, BROAD_MATERIAL, total - needles);
    const needle = new THREE.InstancedMesh(NEEDLE_GEO, NEEDLE_MATERIAL, needles);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const zAxis = new THREE.Vector3(0, 0, 1);
    const pos = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const colour = new THREE.Color();
    let b = 0, nd = 0, tr = 0, wtr = 0;
    this.broadSeeds = new Float32Array(total - needles);
    this.lat = (s + n) / 2;
    for (let i = 0; i < total; i++) {
      const o = i * TREE_STRIDE;
      const height = trees[o + F.HEIGHT], crown = trees[o + F.CROWN], seed = trees[o + F.SEED], flags = trees[o + F.FLAGS];
      const isNeedle = (flags & NEEDLE_FLAG) !== 0;
      const x = (trees[o + F.MX] - origin.x) / unit, y = -(trees[o + F.MY] - origin.y) / unit;
      // Крона: у лиственного — верхние 65 % высоты, у хвойного — от 15 % до верха; ствол уходит в крону
      const base = height * (isNeedle ? 0.15 : 0.35);
      q.setFromAxisAngle(zAxis, seed * Math.PI * 2);
      const trunk = trees[o + F.TRUNK];
      if (trunk > 0) {
        m.compose(pos.set(x, y, 0), q, scale.set(trunk, trunk, base + (height - base) * 0.3));
        if (!(flags & WOOD_FLAG)) trunks.setMatrixAt(tr++, m);
        else woodTrunks.setMatrixAt(wtr++, m);
      }
      m.compose(pos.set(x, y, base), q, scale.set(crown / 2, crown / 2, height - base));
      // Разброс оттенка: светлее/темнее и чуть теплее/холоднее — множитель к цвету материала
      const l = 0.85 + 0.3 * seed, warm = 0.06 * (hash(i, Math.round(seed * 1e6)) - 0.5);
      colour.setRGB(l * (1 + warm), l, l * (1 - warm));
      if (isNeedle) { needle.setMatrixAt(nd, m); needle.setColorAt(nd++, colour); }
      else { broad.setMatrixAt(b, m); broad.setColorAt(b, colour); this.broadSeeds[b++] = seed; }
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
    this.woodTrunks = woodTrunks;
    this.broad = broad;
    this.recolour();
    this.near.push(broad, needle);
    this.far.push(farOf(broad, BROAD_FAR_GEO), farOf(needle, NEEDLE_FAR_GEO));
    for (const mesh of [trunks, woodTrunks, ...this.near, ...this.far]) {
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

  /** Цвета лиственных крон: лето или сегодняшний сезон, разброс оттенка, бледность «Убрать цвета». */
  recolour() {
    const now = new Date();
    const day = dayOf(now.getMonth() + 1, now.getDate());
    const base = new THREE.Color();
    const colour = new THREE.Color();
    this.broadSeeds.forEach((seed, i) => {
      if (seasonal) seasonColour(base, day, this.lat, seed); else base.copy(SUMMER);
      const l = 0.85 + 0.3 * seed, warm = 0.06 * (hash(Math.round(seed * 1e6), 7) - 0.5);
      colour.setRGB(base.r * l * (1 + warm), base.g * l, base.b * l * (1 - warm));
      if (monochrome) colour.lerp(WHITE, PALE);
      this.broad.setColorAt(i, colour);
    });
    if (this.broad.instanceColor) this.broad.instanceColor.needsUpdate = true;
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
    let far = true, trunks = false;
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
      if (this.a.w <= 0 || this.b.w <= 0) { far = false; trunks = true; } else {
        const px = Math.abs(this.b.y / this.b.w - this.a.y / this.a.w) * viewportHeight / 2;
        if (px > FAR_PX) far = false;
        if (px > WOOD_TRUNK_PX) trunks = true;
      }
    }
    const all = this.probes.length * 2;
    if (left === all || right === all || below === all || above === all || behind === all) return false;
    this.setFar(far);
    this.woodTrunks.visible = trunks;
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
    this.woodTrunks.dispose();
    for (const mesh of this.near) mesh.dispose();
    for (const mesh of this.far) mesh.dispose();
    this.scene.clear();
  }
}

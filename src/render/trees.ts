import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MercatorCoordinate } from 'maplibre-gl';
import type { LonLat } from '../osm/model';
import type { LeafType, TreeData } from '../osm/trees';

/** Шаг разброса деревьев в лесу, м (сетка общая для всех тайлов — на стыках нет повторов и пустот). */
const WOOD_STEP = 9;
/** Больше деревьев леса на тайл не ставим: шаг растёт (кроны — шире, чтобы полог оставался сомкнутым). */
const MAX_WOOD_TREES = 8000;
/** Шаг деревьев в ряду (natural=tree_row), м. */
const ROW_STEP = 7;
/** Ячейка индекса зданий (деревья леса внутри зданий не ставим), м. */
const BUILDING_CELL = 40;

/** Дерево в мировых координатах Меркатора: размеры в метрах, seed — для разброса цвета и поворота. */
export interface TreeInstance { mx: number; my: number; needle: boolean; height: number; crown: number; trunk: number; seed: number }

/** Детерминированный шум [0, 1) по целым числам. */
function hash(a: number, b: number, c = 0): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x2545f491);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const merc = ([lng, lat]: LonLat): [number, number] => {
  const c = MercatorCoordinate.fromLngLat({ lng, lat }, 0);
  return [c.x, c.y];
};

function isNeedle(leaf: LeafType | undefined, r: number, mixedDefault: boolean): boolean {
  if (leaf === 'needleleaved') return true;
  if (leaf === 'broadleaved') return false;
  return (leaf === 'mixed' || mixedDefault) && r < 0.5;
}

/** Размеры одиночного дерева: теги, иначе типичные с разбросом ±20 %. */
function single(needle: boolean, r: number, height?: number, crown?: number, trunk?: number) {
  const h = height ?? (needle ? 12 : 10) * (0.8 + 0.4 * r);
  const c = crown ?? h * (needle ? 0.4 : 0.6);
  return { height: h, crown: c, trunk: trunk ?? Math.min(0.6, Math.max(0.12, h * 0.022)) };
}

function pointInRings(x: number, y: number, rings: number[][]): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
      const xi = ring[i], yi = ring[i + 1], xj = ring[j], yj = ring[j + 1];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/**
 * Деревья тайла bbox [w, s, e, n]: отдельные и ряды — свои (по положению в тайле), леса (woods — из всех
 * загруженных тайлов) разбрасываются по общей сетке. В зданиях (buildings — внешние кольца) лес не растёт.
 */
export function scatterTrees(own: TreeData, woods: TreeData['woods'], buildings: LonLat[][], [w, s, e, n]: [number, number, number, number]): TreeInstance[] {
  const [x0, y0] = merc([w, n]);
  const [x1, y1] = merc([e, s]);
  const inTile = (x: number, y: number) => x >= x0 && x < x1 && y >= y0 && y < y1;
  // Метр в единицах Меркатора — по широте, округлённой до градуса: соседние тайлы получают одну и ту же сетку
  const meter = MercatorCoordinate.fromLngLat({ lng: 0, lat: Math.round((s + n) / 2) }, 0).meterInMercatorCoordinateUnits();
  const out: TreeInstance[] = [];

  for (const t of own.points) {
    const [x, y] = merc(t.p);
    if (!inTile(x, y)) continue;
    const r = hash(Math.round(x * 1e9), Math.round(y * 1e9));
    const needle = isNeedle(t.leaf, r, false);
    out.push({ mx: x, my: y, needle, seed: r, ...single(needle, hash(Math.round(x * 1e9), 3, 1), t.height, t.crown, t.trunk) });
  }

  for (const row of own.rows) {
    const pts = row.line.map(merc);
    let next = ROW_STEP / 2, walked = 0; // первое дерево — в полушаге от начала ряда
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
      const len = Math.hypot(bx - ax, by - ay) / meter;
      for (; next <= walked + len; next += ROW_STEP) {
        const f = (next - walked) / len;
        const x = ax + (bx - ax) * f, y = ay + (by - ay) * f;
        if (!inTile(x, y)) continue;
        const r = hash(Math.round(x * 1e9), Math.round(y * 1e9));
        const needle = isNeedle(row.leaf, r, false);
        out.push({ mx: x, my: y, needle, seed: r, ...single(needle, hash(Math.round(y * 1e9), 5, 2), row.height, row.crown) });
      }
      walked += len;
    }
  }

  // Леса: кольца в Меркаторе, обрезанные bbox тайла
  const areas = woods.map((wood) => {
    const rings = wood.polygons.flatMap((p) => [p.outer, ...p.inners]).map((ring) => ring.flatMap(merc));
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (const ring of rings) for (let i = 0; i < ring.length; i += 2) {
      bx0 = Math.min(bx0, ring[i]); bx1 = Math.max(bx1, ring[i]); by0 = Math.min(by0, ring[i + 1]); by1 = Math.max(by1, ring[i + 1]);
    }
    return { wood, rings, box: [Math.max(bx0, x0), Math.max(by0, y0), Math.min(bx1, x1), Math.min(by1, y1)] };
  }).filter((a) => a.box[0] < a.box[2] && a.box[1] < a.box[3]);
  if (!areas.length) return out;

  let step = WOOD_STEP * meter;
  const estimate = areas.reduce((sum, a) => sum + (a.box[2] - a.box[0]) * (a.box[3] - a.box[1]), 0) / (step * step);
  if (estimate > MAX_WOOD_TREES) step *= Math.sqrt(estimate / MAX_WOOD_TREES);
  const stepM = step / meter;

  // Индекс зданий: ячейка → кольца (Меркатор)
  const cell = BUILDING_CELL * meter;
  const index = new Map<string, number[][]>();
  for (const b of buildings) {
    const ring = b.flatMap(merc);
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (let i = 0; i < ring.length; i += 2) {
      bx0 = Math.min(bx0, ring[i]); bx1 = Math.max(bx1, ring[i]); by0 = Math.min(by0, ring[i + 1]); by1 = Math.max(by1, ring[i + 1]);
    }
    if (bx1 < x0 || bx0 > x1 || by1 < y0 || by0 > y1) continue;
    for (let i = Math.floor(bx0 / cell); i <= Math.floor(bx1 / cell); i++) {
      for (let j = Math.floor(by0 / cell); j <= Math.floor(by1 / cell); j++) {
        const k = `${i},${j}`;
        const list = index.get(k);
        if (list) list.push(ring); else index.set(k, [ring]);
      }
    }
  }
  const inBuilding = (x: number, y: number) => (index.get(`${Math.floor(x / cell)},${Math.floor(y / cell)}`) ?? []).some((r) => pointInRings(x, y, [r]));

  const taken = new Set<string>();
  for (const { wood, rings, box } of areas) {
    // Построчно: пересечения строки сетки с рёбрами колец (чёт-нечет — дыры тоже), затем ячейки в промежутках
    for (let j = Math.floor(box[1] / step); j * step <= box[3]; j++) {
      const yc = (j + 0.5) * step;
      const xs: number[] = [];
      for (const ring of rings) {
        for (let a = 0, b = ring.length - 2; a < ring.length; b = a, a += 2) {
          const ya = ring[a + 1], yb = ring[b + 1];
          if (ya > yc !== yb > yc) xs.push(ring[a] + ((yc - ya) * (ring[b] - ring[a])) / (yb - ya));
        }
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const from = Math.max(xs[k], box[0]), to = Math.min(xs[k + 1], box[2]);
        for (let i = Math.ceil(from / step - 0.5); (i + 0.5) * step <= to; i++) {
          const id = `${i},${j}`;
          if (taken.has(id)) continue;
          const x = (i + 0.15 + 0.7 * hash(i, j, 1)) * step;
          const y = (j + 0.15 + 0.7 * hash(i, j, 2)) * step;
          if (!inTile(x, y) || inBuilding(x, y)) continue;
          taken.add(id);
          const r = hash(i, j, 3);
          const needle = isNeedle(wood.leaf, hash(i, j, 4), true);
          const height = (needle ? 19 : 16) * (0.8 + 0.4 * r);
          // Кроны — по шагу сетки: полог почти сомкнут, сколько бы деревьев ни уместилось в тайл
          const crown = needle ? Math.min(height * 0.45, Math.max(height * 0.25, stepM * 0.95)) : Math.min(height * 0.8, Math.max(height * 0.4, stepM * 1.2));
          out.push({ mx: x, my: y, needle, height, crown, trunk: Math.min(0.5, height * 0.02), seed: hash(i, j, 5) });
        }
      }
    }
  }
  return out;
}

// Модели: ось z вверх, основание в z = 0, высота и радиус 1 (масштабируются на дерево)
const Z_UP = new THREE.Matrix4().makeRotationX(Math.PI / 2);

/** Ствол — пятигранная призма без торцов. */
const TRUNK_GEO = new THREE.CylinderGeometry(1, 1, 1, 5, 1, true).applyMatrix4(Z_UP).translate(0, 0, 0.5);

/** Лиственная крона — икосаэдр со сдвинутыми вершинами: гранёный «лоу-поли» шар от z = 0 до z = 1. */
const BROAD_GEO = (() => {
  const g = new THREE.IcosahedronGeometry(1, 1);
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
})();

/** Хвойная крона — три яруса конусов от z = 0 до z = 1. */
const NEEDLE_GEO = (() => {
  const tiers = [[1, 0, 0.5], [0.78, 0.28, 0.45], [0.55, 0.55, 0.45]].map(([r, z, h]) =>
    new THREE.ConeGeometry(r, h, 7, 1).applyMatrix4(Z_UP).translate(0, 0, z + h / 2));
  const g = mergeGeometries(tiers.map((t) => t.toNonIndexed()))!;
  g.computeVertexNormals();
  return g;
})();

const COLOURS = {
  trunk: new THREE.Color('#7a5c43'), broad: new THREE.Color('#79a356'), needle: new THREE.Color('#3f7650'),
  mono: new THREE.Color('#f2f2f2'), monoTrunk: new THREE.Color('#d9d9d9'),
};
const TRUNK_MATERIAL = new THREE.MeshLambertMaterial({ color: COLOURS.trunk, flatShading: true });
const BROAD_MATERIAL = new THREE.MeshLambertMaterial({ color: COLOURS.broad, flatShading: true });
const NEEDLE_MATERIAL = new THREE.MeshLambertMaterial({ color: COLOURS.needle, flatShading: true });

/** Белые деревья — в монохромном режиме, как макет. */
export function setTreesMonochrome(on: boolean) {
  TRUNK_MATERIAL.color.copy(on ? COLOURS.monoTrunk : COLOURS.trunk);
  BROAD_MATERIAL.color.copy(on ? COLOURS.mono : COLOURS.broad);
  NEEDLE_MATERIAL.color.copy(on ? COLOURS.mono : COLOURS.needle);
}

/** Деревья одного тайла: три инстансированных меша (стволы, лиственные и хвойные кроны) — три draw call. */
export class TreeGroup {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.Camera();
  readonly model: THREE.Matrix4;
  readonly count: number;
  /** Подпись набора лесов, из которого собран тайл: пересобираем, только если она поменялась. */
  constructor(center: LonLat, trees: TreeInstance[], readonly signature: string) {
    const origin = MercatorCoordinate.fromLngLat({ lng: center[0], lat: center[1] }, 0);
    const s = origin.meterInMercatorCoordinateUnits();
    this.model = new THREE.Matrix4().makeTranslation(origin.x, origin.y, 0).scale(new THREE.Vector3(s, -s, s));
    this.count = trees.length;

    const needles = trees.filter((t) => t.needle).length;
    const trunks = new THREE.InstancedMesh(TRUNK_GEO, TRUNK_MATERIAL, trees.length);
    const broad = new THREE.InstancedMesh(BROAD_GEO, BROAD_MATERIAL, trees.length - needles);
    const needle = new THREE.InstancedMesh(NEEDLE_GEO, NEEDLE_MATERIAL, needles);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const zAxis = new THREE.Vector3(0, 0, 1);
    const pos = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const colour = new THREE.Color();
    let b = 0, n = 0;
    trees.forEach((t, i) => {
      const x = (t.mx - origin.x) / s, y = -(t.my - origin.y) / s;
      // Крона: у лиственного — верхние 65 % высоты, у хвойного — от 15 % до верха; ствол уходит в крону
      const base = t.height * (t.needle ? 0.15 : 0.35);
      q.setFromAxisAngle(zAxis, t.seed * Math.PI * 2);
      m.compose(pos.set(x, y, 0), q, scale.set(t.trunk, t.trunk, base + (t.height - base) * 0.3));
      trunks.setMatrixAt(i, m);
      m.compose(pos.set(x, y, base), q, scale.set(t.crown / 2, t.crown / 2, t.height - base));
      // Разброс оттенка: светлее/темнее и чуть теплее/холоднее — множитель к цвету материала
      const l = 0.85 + 0.3 * t.seed, warm = 0.06 * (hash(i, Math.round(t.seed * 1e6)) - 0.5);
      colour.setRGB(l * (1 + warm), l, l * (1 - warm));
      if (t.needle) { needle.setMatrixAt(n, m); needle.setColorAt(n++, colour); }
      else { broad.setMatrixAt(b, m); broad.setColorAt(b++, colour); }
    });
    for (const mesh of [trunks, broad, needle]) {
      mesh.frustumCulled = false;
      if (mesh.count) this.scene.add(mesh);
    }
    this.ambient.position.set(0, 0, 1);
    this.hemi.position.set(0, 0, 1);
    const sun = new THREE.DirectionalLight(0xffffff, 1.8);
    sun.position.set(-0.5, -1, 1.5);
    this.scene.add(this.ambient, this.hemi, sun);
  }

  // Свет — как у зданий (MeshGroup)
  private readonly ambient = new THREE.AmbientLight(0xffffff, 1.6);
  private readonly hemi = new THREE.HemisphereLight(0xffffff, 0xc4c2bc, 1.6);

  applyLighting(hemisphere: boolean) {
    this.ambient.visible = !hemisphere;
    this.hemi.visible = hemisphere;
  }

  dispose() {
    for (const o of this.scene.children) if (o instanceof THREE.InstancedMesh) o.dispose();
    this.scene.clear();
  }
}

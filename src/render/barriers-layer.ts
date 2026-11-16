import * as THREE from 'three';
import { MercatorCoordinate, type Map as MlMap } from 'maplibre-gl';
import { barrierShape, gateWidth, type BarrierGate, type BarrierWay } from '../osm/barriers';
import { parseLength } from '../osm/heights';
import { DOOR_GEO, DOOR_MATERIAL, DOOR_SELECTED_MATERIAL, EDGE_MATERIAL, parseColour } from './buildings-layer';

const SOLID = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
const SEE = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity: 0.5, depthWrite: false });
const MONO = new THREE.Color('#ffffff');
/** Створки ворот — тёмный металл. */
const GATE_COLOUR = new THREE.Color('#5b6166');
/** Подсветка выбранного прохода — полупрозрачная плоскость проёма. */
const OPENING = new THREE.MeshBasicMaterial({ color: 0x97beff, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false });
/** Выделенное — как у зданий. */
const HIGHLIGHT = new THREE.Color('#97beff');
/** Излом оси больше этого угла — вертикальное ребро в вершине. */
const CORNER_COS = Math.cos((20 * Math.PI) / 180);

type Pt = [number, number];

/** Вершины ломаной, сдвинутые на ±half влево (стык — по биссектрисе, острый угол ограничен). */
function offsets(pts: Pt[], half: number, closed: boolean): { l: Pt[]; r: Pt[] } {
  const n = pts.length, l: Pt[] = [], r: Pt[] = [];
  const dir = (a: Pt, b: Pt): Pt => { const dx = b[0] - a[0], dy = b[1] - a[1], d = Math.hypot(dx, dy) || 1; return [dx / d, dy / d]; };
  for (let i = 0; i < n; i++) {
    const prev = i > 0 ? pts[i - 1] : closed ? pts[n - 1] : undefined;
    const next = i < n - 1 ? pts[i + 1] : closed ? pts[0] : undefined;
    const d0 = prev ? dir(prev, pts[i]) : undefined, d1 = next ? dir(pts[i], next) : undefined;
    const a = d0 ?? d1!, b = d1 ?? d0!;
    let nx = -(a[1] + b[1]), ny = a[0] + b[0];
    const len = Math.hypot(nx, ny);
    if (len < 1e-6) { nx = -a[1]; ny = a[0]; } else { nx /= len; ny /= len; }
    // Сдвиг вдоль биссектрисы: half / cos(половины угла), не больше 3·half
    const cos = Math.max(1 / 3, nx * -a[1] + ny * a[0]);
    const k = half / cos;
    l.push([pts[i][0] + nx * k, pts[i][1] + ny * k]);
    r.push([pts[i][0] - nx * k, pts[i][1] - ny * k]);
  }
  return { l, r };
}

/** Вершина i — излом оси (или конец открытой линии): там вертикальное ребро. */
function isCorner(pts: Pt[], i: number, closed: boolean): boolean {
  const n = pts.length;
  if (!closed && (i === 0 || i === n - 1)) return true;
  const p = pts[(i - 1 + n) % n], q = pts[i], r = pts[(i + 1) % n];
  const ax = q[0] - p[0], ay = q[1] - p[1], bx = r[0] - q[0], by = r[1] - q[1];
  const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
  return !la || !lb || (ax * bx + ay * by) / (la * lb) < CORNER_COS;
}

/**
 * Отдельностоящие стены, заборы и живые изгороди (barrier=wall/fence/hedge): лента по оси пути от min_height до
 * height толщиной width (забор без width — плоскость), с рёбрами как у зданий. Рисует слой зданий в своём проходе
 * (drawExtra) — общая глубина, ограждения и здания честно перекрывают друг друга.
 */
export class BarriersLayer {
  private map?: MlMap;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.Camera();
  private model = new THREE.Matrix4();
  /** Проекция без сжатия глубины — для луча клика и глубины попадания (сравнение с pickHit зданий). */
  private pickMatrix = new THREE.Matrix4();
  private origin = new MercatorCoordinate(0, 0, 0);
  private metre = 1;
  private meshes: THREE.Mesh[] = [];
  private edges?: THREE.LineSegments;
  /** Исходные цвета вершин каждого меша — чтобы снимать монохром. */
  private colours: Float32Array[] = [];
  /** Для клика: позиции и номер пути каждого треугольника, по мешам. */
  private tris: { pos: Float32Array; way: Int32Array; gate: Int32Array }[] = [];
  /** Створки ворот: путь и узел ворот (номер — в tris[].gate). */
  private gates: { way: number; gate: BarrierGate; at: Pt; z: number }[] = [];
  /** Точка узла под выбранными воротами — как у выбранной двери или входа. */
  private gateDots: THREE.Object3D[] = [];
  private selectedGates = new Set<number>();
  /** Плоскости проёмов проходов (entrance): выбираются, видны только выбранные. */
  private openings?: { pos: Float32Array; way: Int32Array; gate: Int32Array };
  private openingMesh?: THREE.Mesh;
  private ways: BarrierWay[] = [];
  private selectedIds = new Set<number>();
  private signature = '';
  private enabled = true;
  private monochrome = false;
  /** Скрыт ли слой сейчас (режим здания без окружения): не рисуется и не кликается. */
  hidden: () => boolean = () => false;
  drawnWays = 0;

  constructor() {
    const hemi = new THREE.HemisphereLight(0xffffff, 0xc4c2bc, 1.6);
    hemi.position.set(0, 0, 1);
    const sun = new THREE.DirectionalLight(0xffffff, 1.8);
    sun.position.set(-0.5, -1, 1.5);
    this.scene.add(hemi, sun);
  }

  attach(map: MlMap) { this.map = map; }

  /** Отрисовка в проходе слоя зданий: main — его матрица (глубина как у зданий), plain — матрица MapLibre. */
  draw(renderer: THREE.WebGLRenderer, main: THREE.Matrix4, plain: THREE.Matrix4): number {
    if (!this.enabled || (!this.meshes.length && !this.openingMesh && !this.gateDots.length) || this.hidden()) return 0;
    this.pickMatrix = plain.clone().multiply(this.model);
    this.camera.projectionMatrix = main.clone().multiply(this.model);
    renderer.render(this.scene, this.camera);
    return renderer.info.render.triangles;
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    if (!on) this.clear();
    this.map?.triggerRepaint();
  }

  get isEnabled() { return this.enabled; }

  setMonochrome(on: boolean) {
    this.monochrome = on;
    this.paint();
  }

  /** Подсветить ограждения (id путей) и ворота (id узлов); пустые списки — снять. */
  select(ids: number[], gates: number[] = []) {
    if (ids.length === this.selectedIds.size && ids.every((id) => this.selectedIds.has(id))
      && gates.length === this.selectedGates.size && gates.every((id) => this.selectedGates.has(id))) return;
    this.selectedIds = new Set(ids);
    this.selectedGates = new Set(gates);
    this.paint();
  }

  /** Цвета вершин: исходные, монохром, подсветка выделенного. */
  private paint() {
    this.meshes.forEach((m, i) => {
      const attr = m.geometry.getAttribute('color') as THREE.BufferAttribute, out = attr.array as Float32Array, src = this.colours[i], { way, gate } = this.tris[i];
      for (let t = 0; t < way.length; t++) {
        const sel = gate[t] >= 0 ? this.selectedGates.has(this.gates[gate[t]].gate.id) : this.selectedIds.has(this.ways[way[t]].id);
        const c = sel ? HIGHLIGHT : this.monochrome ? MONO : undefined;
        for (let k = t * 9; k < t * 9 + 9; k += 3) {
          if (c) { out[k] = c.r; out[k + 1] = c.g; out[k + 2] = c.b; } else { out[k] = src[k]; out[k + 1] = src[k + 1]; out[k + 2] = src[k + 2]; }
        }
      }
      attr.needsUpdate = true;
    });
    if (this.openingMesh) { this.openingMesh.geometry.dispose(); this.scene.remove(this.openingMesh); this.openingMesh = undefined; }
    for (const d of this.gateDots) { this.scene.remove(d); if (d instanceof THREE.Mesh && d.geometry !== DOOR_GEO) d.geometry.dispose(); }
    this.gateDots = [];
    const seen = new Set<number>();
    for (const g of this.gates) {
      if (!this.selectedGates.has(g.gate.id) || seen.has(g.gate.id)) continue;
      seen.add(g.gate.id);
      const dot = new THREE.Mesh(DOOR_GEO, DOOR_MATERIAL), ring = new THREE.Mesh(new THREE.TorusGeometry(0.28, 0.025, 8, 24), DOOR_SELECTED_MATERIAL);
      dot.position.set(g.at[0], g.at[1], g.z + 0.04);
      ring.position.set(g.at[0], g.at[1], g.z + 0.08);
      for (const m of [dot, ring]) { m.renderOrder = 5; m.frustumCulled = false; this.scene.add(m); this.gateDots.push(m); }
    }
    const o = this.openings;
    if (o && this.selectedGates.size) {
      const p: number[] = [];
      for (let t = 0; t < o.gate.length; t++) if (this.selectedGates.has(this.gates[o.gate[t]].gate.id)) for (let k = t * 9; k < t * 9 + 9; k++) p.push(o.pos[k]);
      if (p.length) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
        this.openingMesh = new THREE.Mesh(g, OPENING);
        this.openingMesh.renderOrder = 3;
        this.openingMesh.frustumCulled = false;
        this.scene.add(this.openingMesh);
      }
    }
    this.map?.triggerRepaint();
  }

  /** Ограждение под курсором (ближайший треугольник) и глубина попадания в clip space — для сравнения со зданиями. */
  pick(px: number, py: number): { way: BarrierWay; gate?: BarrierGate; depth: number } | undefined {
    if (!this.enabled || !this.map || (!this.meshes.length && !this.openings) || this.hidden()) return;
    const canvas = this.map.getCanvas();
    const x = (px / canvas.clientWidth) * 2 - 1, y = 1 - (py / canvas.clientHeight) * 2;
    const m = this.pickMatrix, inv = m.clone().invert();
    const near = new THREE.Vector3(x, y, -1).applyMatrix4(inv), far = new THREE.Vector3(x, y, 1).applyMatrix4(inv);
    const ray = new THREE.Ray(near, far.sub(near).normalize());
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), hit = new THREE.Vector3();
    let best: { wi: number; gi: number; dist: number; p: THREE.Vector3 } | undefined;
    for (const { pos, way, gate } of this.openings ? [...this.tris, this.openings] : this.tris) {
      for (let i = 0, t = 0; i < pos.length; i += 9, t++) {
        a.fromArray(pos, i); b.fromArray(pos, i + 3); c.fromArray(pos, i + 6);
        if (!ray.intersectTriangle(a, b, c, false, hit)) continue;
        const dist = hit.distanceTo(ray.origin);
        if (!best || dist < best.dist) best = { wi: way[t], gi: gate[t], dist, p: hit.clone() };
      }
    }
    if (!best) return;
    return { way: this.ways[best.wi], gate: best.gi >= 0 ? this.gates[best.gi].gate : undefined, depth: best.p.applyMatrix4(m).z };
  }

  /** Глубина точки (lngLat, высота над землёй) в clip space той же камеры, что у pick. */
  depthOf(lngLat: { lng: number; lat: number }, altitude: number): number {
    const c = MercatorCoordinate.fromLngLat(lngLat, 0);
    return new THREE.Vector3((c.x - this.origin.x) / this.metre, -(c.y - this.origin.y) / this.metre, altitude).applyMatrix4(this.pickMatrix).z;
  }

  /** Ограждения показанных тайлов (с повторами на границе тайлов). */
  setBarriers(all: BarrierWay[]) {
    if (!this.enabled) return;
    const byId = new Map<number, BarrierWay>();
    for (const w of all) byId.set(w.id, w);
    const ways = [...byId.values()];
    const signature = ways.map((w) => `${w.id}:${w.coords.map((c) => c.join(',')).join(';')}:${JSON.stringify(w.tags)}:${JSON.stringify(w.gates ?? [])}`).sort().join('|');
    if (signature === this.signature) return;
    this.signature = signature;
    this.clearMeshes();
    if (!ways.length) { this.map?.triggerRepaint(); return; }
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const r of ways) for (const [x, y] of r.coords) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }
    const origin = MercatorCoordinate.fromLngLat({ lng: (w + e) / 2, lat: (s + n) / 2 }, 0);
    const m = origin.meterInMercatorCoordinateUnits();
    this.origin = origin;
    this.metre = m;
    // Локальная система в метрах: x — восток, y — север, z — вверх (как у групп слоя зданий)
    this.model = new THREE.Matrix4().makeTranslation(origin.x, origin.y, 0).scale(new THREE.Vector3(m, -m, m));
    const local = ([lng, lat]: [number, number]): Pt => { const c = MercatorCoordinate.fromLngLat({ lng, lat }, 0); return [(c.x - origin.x) / m, -(c.y - origin.y) / m]; };
    const part = () => ({ p: [] as number[], c: [] as number[], w: [] as number[], g: [] as number[] });
    const buf = { solid: part(), see: part() }, gateBuf = part(), openBuf = part();
    const gateList: { way: number; gate: BarrierGate; at: Pt; z: number }[] = [];
    const lines: number[] = [];
    this.ways = ways;
    for (const [wi, way] of ways.entries()) {
      const sh = barrierShape(way.tags);
      const closedWay = way.nodes.length > 3 && way.nodes[0] === way.nodes[way.nodes.length - 1];
      let ids = way.nodes.slice(), pts = way.coords.map(local);
      if (closedWay) { ids = ids.slice(0, -1); pts = pts.slice(0, -1); }
      if (pts.length < 2) continue;
      const col = parseColour(sh.colour), out = sh.seeThrough ? buf.see : buf.solid;
      const z0 = sh.min, z1 = sh.top;
      const put = (o: typeof out, c: THREE.Color, gate: number) => (a: number[], b: number[], d: number[]) => { o.p.push(...a, ...b, ...d); o.w.push(wi); o.g.push(gate); for (let k = 0; k < 3; k++) o.c.push(c.r, c.g, c.b); };
      const seg = (a: Pt, b: Pt, za: number, zb = za) => lines.push(a[0], a[1], za, b[0], b[1], zb);
      // Ворота: узлы линии; замкнутое ограждение с воротами — разрезаем по первым из них (дальше — открытая линия)
      const gates = (way.gates ?? []).map((g) => ({ g, i: ids.indexOf(g.id) })).filter((x) => x.i >= 0);
      let closed = closedWay;
      if (closedWay && gates.length) {
        const k = gates[0].i;
        ids = [...ids.slice(k), ...ids.slice(0, k), ids[k]];
        pts = [...pts.slice(k), ...pts.slice(0, k), pts[k]];
        closed = false;
      }
      // Длина по оси до каждой вершины; проёмы — отрезки длины вокруг узлов ворот
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
      const L = cum[cum.length - 1];
      const gaps: { s0: number; s1: number; gate: BarrierGate }[] = [];
      for (const { g } of gates) {
        const at = ids.map((n, k) => (n === g.id ? k : -1)).filter((k) => k >= 0);
        for (const k of at) {
          const half = gateWidth(g.tags) / 2;
          gaps.push({ s0: Math.max(0, cum[k] - half), s1: Math.min(L, cum[k] + half), gate: g });
        }
      }
      gaps.sort((a, b) => a.s0 - b.s0);
      const at = (s: number): Pt => {
        let i = 1;
        while (i < cum.length - 1 && cum[i] < s) i++;
        const t = cum[i] > cum[i - 1] ? (s - cum[i - 1]) / (cum[i] - cum[i - 1]) : 0;
        return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
      };
      const slice = (s0: number, s1: number): Pt[] => [at(s0), ...pts.filter((_, k) => cum[k] > s0 + 1e-6 && cum[k] < s1 - 1e-6), at(s1)];
      const runs: Pt[][] = [];
      if (!gaps.length) runs.push(pts);
      else {
        let s = 0;
        for (const gp of gaps) { if (gp.s0 - s > 0.05) runs.push(slice(s, gp.s0)); s = Math.max(s, gp.s1); }
        if (L - s > 0.05) runs.push(slice(s, L));
      }
      const quadOf = (tri: ReturnType<typeof put>) => (a: number[], b: number[], c: number[], d: number[]) => { tri(a, b, c); tri(a, c, d); };
      const quad = quadOf(put(out, col, -1));
      for (const run of runs) {
        const rc = closed && !gaps.length;
        const segs = rc ? run.length : run.length - 1;
        if (sh.width <= 0) {
          // Плоскость по оси: низ, верх и вертикали в изломах и на концах
          for (let i = 0; i < segs; i++) {
            const j = (i + 1) % run.length;
            quad([...run[i], z0], [...run[j], z0], [...run[j], z1], [...run[i], z1]);
            seg(run[i], run[j], z0); seg(run[i], run[j], z1);
          }
          run.forEach((p, i) => { if (isCorner(run, i, rc)) seg(p, p, z0, z1); });
          continue;
        }
        const { l, r } = offsets(run, sh.width / 2, rc);
        for (let i = 0; i < segs; i++) {
          const j = (i + 1) % run.length;
          quad([...l[i], z0], [...l[j], z0], [...l[j], z1], [...l[i], z1]);
          quad([...r[j], z0], [...r[i], z0], [...r[i], z1], [...r[j], z1]);
          quad([...l[i], z1], [...l[j], z1], [...r[j], z1], [...r[i], z1]);
          if (z0 > 0.01) quad([...r[i], z0], [...r[j], z0], [...l[j], z0], [...l[i], z0]);
          for (const side of [l, r]) { seg(side[i], side[j], z0); seg(side[i], side[j], z1); }
        }
        run.forEach((_, i) => { if (isCorner(run, i, rc)) { seg(l[i], l[i], z0, z1); seg(r[i], r[i], z0, z1); } });
        if (!rc) {
          const k = run.length - 1;
          quad([...r[0], z0], [...l[0], z0], [...l[0], z1], [...r[0], z1]);
          quad([...l[k], z0], [...r[k], z0], [...r[k], z1], [...l[k], z1]);
          for (const q of [0, k]) { seg(l[q], r[q], z0); seg(l[q], r[q], z1); }
        }
      }
      // Створка в проёме: ворота и калитки — полотно по оси (чуть ниже ограждения), шлагбаум и цепь — перекладина;
      // проход (entrance) — пустой
      for (const gp of gaps) {
        const b = gp.gate.tags.barrier;
        const gi = gateList.push({ way: wi, gate: gp.gate, at: at((gp.s0 + gp.s1) / 2), z: z0 }) - 1;
        const leaf = slice(gp.s0, gp.s1);
        if (b === 'entrance' || b === 'stile') {
          // Проход — пустой проём, как дверь в стене: плоскость по оси только для выбора и подсветки
          const pq = quadOf(put(openBuf, HIGHLIGHT, gi));
          for (let i = 0; i + 1 < leaf.length; i++) pq([...leaf[i], z0], [...leaf[i + 1], z0], [...leaf[i + 1], z1], [...leaf[i], z1]);
          continue;
        }
        const gh = parseLength(gp.gate.tags.height);
        const bar = b === 'lift_gate' || b === 'chain' || b === 'rope';
        const lo = bar ? 0.9 : 0.05, hi = bar ? 1.0 : Math.max(0.8, gh ?? Math.min(z1, 2));
        const gq = quadOf(put(gateBuf, GATE_COLOUR, gi));
        for (let i = 0; i + 1 < leaf.length; i++) {
          gq([...leaf[i], lo], [...leaf[i + 1], lo], [...leaf[i + 1], hi], [...leaf[i], hi]);
          seg(leaf[i], leaf[i + 1], lo); seg(leaf[i], leaf[i + 1], hi);
        }
        seg(leaf[0], leaf[0], lo, hi); seg(leaf[leaf.length - 1], leaf[leaf.length - 1], lo, hi);
      }
    }
    this.gates = gateList;
    // Проёмы проходов: в выборе — как треугольники, на экране — только выбранные (подсветка)
    if (openBuf.p.length) this.openings = { pos: new Float32Array(openBuf.p), way: Int32Array.from(openBuf.w), gate: Int32Array.from(openBuf.g) };
    for (const [part, material, order] of [[buf.solid, SOLID, 0], [buf.see, SEE, 1], [gateBuf, SOLID, 0]] as const) {
      if (!part.p.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(part.p, 3));
      const colours = new Float32Array(part.c);
      g.setAttribute('color', new THREE.BufferAttribute(colours.slice(), 3));
      g.computeVertexNormals();
      const mesh = new THREE.Mesh(g, material);
      mesh.renderOrder = order;
      mesh.frustumCulled = false;
      this.meshes.push(mesh);
      this.colours.push(colours);
      this.tris.push({ pos: new Float32Array(part.p), way: Int32Array.from(part.w), gate: Int32Array.from(part.g) });
      this.scene.add(mesh);
    }
    if (lines.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
      this.edges = new THREE.LineSegments(g, EDGE_MATERIAL);
      this.edges.renderOrder = 2;
      this.edges.frustumCulled = false;
      this.scene.add(this.edges);
    }
    this.drawnWays = ways.length;
    this.paint();
  }

  clear() {
    this.clearMeshes();
    this.signature = '';
  }

  private clearMeshes() {
    for (const mesh of this.meshes) { mesh.geometry.dispose(); this.scene.remove(mesh); }
    if (this.edges) { this.edges.geometry.dispose(); this.scene.remove(this.edges); this.edges = undefined; }
    this.meshes = [];
    this.colours = [];
    this.tris = [];
    this.gates = [];
    this.openings = undefined;
    for (const d of this.gateDots) { this.scene.remove(d); if (d instanceof THREE.Mesh && d.geometry !== DOOR_GEO) d.geometry.dispose(); }
    this.gateDots = [];
    if (this.openingMesh) { this.openingMesh.geometry.dispose(); this.scene.remove(this.openingMesh); this.openingMesh = undefined; }
    this.ways = [];
    this.drawnWays = 0;
  }
}

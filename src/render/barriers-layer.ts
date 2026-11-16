import * as THREE from 'three';
import { MercatorCoordinate, type Map as MlMap } from 'maplibre-gl';
import { barrierShape, type BarrierWay } from '../osm/barriers';
import { EDGE_MATERIAL, parseColour } from './buildings-layer';

const SOLID = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
const SEE = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity: 0.5, depthWrite: false });
const MONO = new THREE.Color('#ffffff');
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
  private tris: { pos: Float32Array; way: Int32Array }[] = [];
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
    if (!this.enabled || !this.meshes.length || this.hidden()) return 0;
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

  /** Подсветить ограждения (id путей); пустой список — снять. */
  select(ids: number[]) {
    if (ids.length === this.selectedIds.size && ids.every((id) => this.selectedIds.has(id))) return;
    this.selectedIds = new Set(ids);
    this.paint();
  }

  /** Цвета вершин: исходные, монохром, подсветка выделенного. */
  private paint() {
    this.meshes.forEach((m, i) => {
      const attr = m.geometry.getAttribute('color') as THREE.BufferAttribute, out = attr.array as Float32Array, src = this.colours[i], way = this.tris[i].way;
      for (let t = 0; t < way.length; t++) {
        const c = this.selectedIds.has(this.ways[way[t]].id) ? HIGHLIGHT : this.monochrome ? MONO : undefined;
        for (let k = t * 9; k < t * 9 + 9; k += 3) {
          if (c) { out[k] = c.r; out[k + 1] = c.g; out[k + 2] = c.b; } else { out[k] = src[k]; out[k + 1] = src[k + 1]; out[k + 2] = src[k + 2]; }
        }
      }
      attr.needsUpdate = true;
    });
    this.map?.triggerRepaint();
  }

  /** Ограждение под курсором (ближайший треугольник) и глубина попадания в clip space — для сравнения со зданиями. */
  pick(px: number, py: number): { way: BarrierWay; depth: number } | undefined {
    if (!this.enabled || !this.map || !this.meshes.length || this.hidden()) return;
    const canvas = this.map.getCanvas();
    const x = (px / canvas.clientWidth) * 2 - 1, y = 1 - (py / canvas.clientHeight) * 2;
    const m = this.pickMatrix, inv = m.clone().invert();
    const near = new THREE.Vector3(x, y, -1).applyMatrix4(inv), far = new THREE.Vector3(x, y, 1).applyMatrix4(inv);
    const ray = new THREE.Ray(near, far.sub(near).normalize());
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), hit = new THREE.Vector3();
    let best: { wi: number; dist: number; p: THREE.Vector3 } | undefined;
    for (const { pos, way } of this.tris) {
      for (let i = 0, t = 0; i < pos.length; i += 9, t++) {
        a.fromArray(pos, i); b.fromArray(pos, i + 3); c.fromArray(pos, i + 6);
        if (!ray.intersectTriangle(a, b, c, false, hit)) continue;
        const dist = hit.distanceTo(ray.origin);
        if (!best || dist < best.dist) best = { wi: way[t], dist, p: hit.clone() };
      }
    }
    if (!best) return;
    return { way: this.ways[best.wi], depth: best.p.applyMatrix4(m).z };
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
    const signature = ways.map((w) => `${w.id}:${w.coords.map((c) => c.join(',')).join(';')}:${JSON.stringify(w.tags)}`).sort().join('|');
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
    const buf = { solid: { p: [] as number[], c: [] as number[], w: [] as number[] }, see: { p: [] as number[], c: [] as number[], w: [] as number[] } };
    const lines: number[] = [];
    this.ways = ways;
    for (const [wi, way] of ways.entries()) {
      const sh = barrierShape(way.tags);
      const closed = way.nodes.length > 3 && way.nodes[0] === way.nodes[way.nodes.length - 1];
      let pts = way.coords.map(local);
      if (closed) pts = pts.slice(0, -1);
      if (pts.length < 2) continue;
      const col = parseColour(sh.colour), out = sh.seeThrough ? buf.see : buf.solid;
      const z0 = sh.min, z1 = sh.top;
      const tri = (a: number[], b: number[], c: number[]) => { out.p.push(...a, ...b, ...c); out.w.push(wi); for (let k = 0; k < 3; k++) out.c.push(col.r, col.g, col.b); };
      const quad = (a: number[], b: number[], c: number[], d: number[]) => { tri(a, b, c); tri(a, c, d); };
      const seg = (a: Pt, b: Pt, za: number, zb = za) => lines.push(a[0], a[1], za, b[0], b[1], zb);
      const segs = closed ? pts.length : pts.length - 1;
      if (sh.width <= 0) {
        // Плоскость по оси: низ, верх и вертикали в изломах и на концах
        for (let i = 0; i < segs; i++) {
          const j = (i + 1) % pts.length;
          quad([...pts[i], z0], [...pts[j], z0], [...pts[j], z1], [...pts[i], z1]);
          seg(pts[i], pts[j], z0); seg(pts[i], pts[j], z1);
        }
        pts.forEach((p, i) => { if (isCorner(pts, i, closed)) seg(p, p, z0, z1); });
        continue;
      }
      const { l, r } = offsets(pts, sh.width / 2, closed);
      for (let i = 0; i < segs; i++) {
        const j = (i + 1) % pts.length;
        quad([...l[i], z0], [...l[j], z0], [...l[j], z1], [...l[i], z1]);
        quad([...r[j], z0], [...r[i], z0], [...r[i], z1], [...r[j], z1]);
        quad([...l[i], z1], [...l[j], z1], [...r[j], z1], [...r[i], z1]);
        if (z0 > 0.01) quad([...r[i], z0], [...r[j], z0], [...l[j], z0], [...l[i], z0]);
        for (const side of [l, r]) { seg(side[i], side[j], z0); seg(side[i], side[j], z1); }
      }
      pts.forEach((_, i) => { if (isCorner(pts, i, closed)) { seg(l[i], l[i], z0, z1); seg(r[i], r[i], z0, z1); } });
      if (!closed) {
        const k = pts.length - 1;
        quad([...r[0], z0], [...l[0], z0], [...l[0], z1], [...r[0], z1]);
        quad([...l[k], z0], [...r[k], z0], [...r[k], z1], [...l[k], z1]);
        for (const q of [0, k]) { seg(l[q], r[q], z0); seg(l[q], r[q], z1); }
      }
    }
    for (const [part, material, order] of [[buf.solid, SOLID, 0], [buf.see, SEE, 1]] as const) {
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
      this.tris.push({ pos: new Float32Array(part.p), way: Int32Array.from(part.w) });
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
    this.ways = [];
    this.drawnWays = 0;
  }
}

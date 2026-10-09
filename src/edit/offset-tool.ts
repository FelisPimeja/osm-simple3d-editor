import * as THREE from 'three';
import type { BuildingsLayer } from '../render/buildings-layer';
import polygonClipping from 'polygon-clipping';

type Pt = [number, number];

/** Плоская грань, от контура которой откладываем: объект, верх или низ, высота и контур (метры сцены). */
export interface OffsetTarget { key: string; face: 'top' | 'bottom'; z: number; ring: Pt[]; inners: Pt[][] }

/** Короче этого отступ не считаем (контур совпал бы с исходным), м. */
const MIN_OFFSET = 0.05;

/**
 * Инструмент «Отступ» (Offset): клик по плоской грани или её ребру (верх плоской крыши или низ; Shift — низ)
 * выбирает грань; её внешний контур отступает наружу или внутрь — на расстояние курсора от контура. Клик или число + Enter — новый плоский контур
 * на высоте грани (что с ним делать — решает commit). Esc — отмена, повторный Esc — выйти.
 */
export class OffsetTool {
  state: 'off' | 'pick' | 'offset' = 'off';
  private target?: OffsetTarget;
  private d = 0;
  private typed = '';
  /** Shift зажат — при выборе грани берётся низ. */
  private back = false;
  private lastPoint?: [number, number];
  private readonly vcb: HTMLDivElement;

  constructor(
    private readonly layer: BuildingsLayer,
    container: HTMLElement,
    /** Грань под курсором (back — Shift: низ); строка — почему нельзя. */
    private readonly pick: (point: [number, number], back: boolean) => OffsetTarget | string | undefined,
    private readonly commit: (t: OffsetTarget, shape: OffsetShape) => string | undefined,
    private readonly onState: (hint: string, error?: boolean) => void,
  ) {
    this.vcb = document.createElement('div');
    this.vcb.className = 'vcb';
    this.vcb.hidden = true;
    container.appendChild(this.vcb);
  }

  get active() { return this.state !== 'off'; }

  start() {
    this.state = 'pick';
    this.onState('Отступ: клик по плоской грани или по её ребру (Shift+клик по объекту — низ). Esc — выйти.');
  }

  stop() {
    this.cancel();
    this.state = 'off';
    this.onState('');
  }

  click(point: [number, number], back = false) {
    if (this.state === 'pick') {
      const t = this.pick(point, back);
      if (!t) return;
      if (typeof t === 'string') { this.onState(t, true); return; }
      this.layer.setOutline(undefined);
      this.target = t;
      this.d = 0;
      this.typed = '';
      this.state = 'offset';
      this.onState('Отступ — от внешнего контура грани: ведите курсор наружу или внутрь. Клик — новый контур, число + Enter — отступ в метрах (минус — внутрь), Esc — отмена.');
      // Начинаем с самого контура: точка клика (внутри грани) не задаёт отступ
      this.preview();
      return;
    }
    if (this.state === 'offset') this.apply(this.d);
  }

  move(point: [number, number]) {
    this.lastPoint = point;
    if (this.state === 'pick') { this.hover(point); return; }
    if (this.state !== 'offset' || !this.target) return;
    const ray = this.layer.focusRay(point);
    const q = ray?.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -this.target.z), new THREE.Vector3());
    if (!q) return;
    this.d = signedDistance(this.target.ring, [q.x, q.y]);
    this.preview();
  }

  /** Выбор грани: подсветить внешний контур, от которого пойдёт отступ. */
  private hover(point: [number, number]) {
    const t = this.pick(point, this.back);
    if (!t || typeof t === 'string') { this.layer.setOutline(undefined); return; }
    this.layer.setOutline([t.ring, ...t.inners].map((ring) => ring.map((p) => new THREE.Vector3(p[0], p[1], t.z))));
  }

  key(e: KeyboardEvent): boolean {
    if (!this.active) return false;
    if (e.key === 'Shift') {
      this.back = e.type === 'keydown';
      if (this.state === 'pick' && this.lastPoint) this.hover(this.lastPoint);
      return false;
    }
    if (e.type !== 'keydown') return false;
    if (e.key === 'Escape') {
      if (this.state === 'offset') { this.cancel(); this.start(); } else this.stop();
      return true;
    }
    if (this.state !== 'offset') return false;
    if (/^[\d.,-]$/.test(e.key)) { this.typed += e.key === ',' ? '.' : e.key; this.preview(); return true; }
    if (e.key === 'Backspace') { this.typed = this.typed.slice(0, -1); this.preview(); return true; }
    if (e.key === 'Enter') {
      const v = Number(this.typed);
      if (!this.typed || !Number.isFinite(v)) return true;
      // Без знака — в ту сторону, куда ведут курсор
      this.apply(this.typed.startsWith('-') ? v : v * (this.d < 0 ? -1 : 1));
      return true;
    }
    return false;
  }

  private apply(d: number) {
    const t = this.target;
    if (!t) return;
    if (Math.abs(d) < MIN_OFFSET) { this.onState('Отведите курсор от контура.', true); return; }
    const r = offsetPolygon(t, d);
    if (typeof r === 'string') { this.onState(`Такой отступ не получится: ${r}`, true); return; }
    const fail = this.commit(t, r);
    if (fail) { this.onState(fail, true); return; }
    this.cancel();
    this.state = 'pick';
  }

  private preview() {
    const t = this.target;
    if (!t) return;
    const typed = Number(this.typed);
    const d = this.typed && Number.isFinite(typed) ? (this.typed.startsWith('-') ? typed : typed * (this.d < 0 ? -1 : 1)) : this.d;
    const r: OffsetShape | string = Math.abs(d) >= MIN_OFFSET ? offsetPolygon(t, d) : [[t.ring, ...t.inners]];
    // Все кольца всех частей; не получилось — исходный контур
    const rings = typeof r === 'string' ? [t.ring, ...t.inners] : r.flat();
    this.layer.setOutline(rings.map((ring) => ring.map((p) => new THREE.Vector3(p[0], p[1], t.z))), 2);
    this.vcb.hidden = false;
    const holes = typeof r === 'string' ? '' : `${r.length > 1 ? ` · частей: ${r.length}` : ''}${t.inners.length || r.some((p) => p.length > 1) ? ` · дворов: ${r.reduce((n, p) => n + p.length - 1, 0)}` : ''}`;
    this.vcb.innerHTML = `<span class="vcb-label">Отступ</span><span class="vcb-value${this.typed ? ' typed' : ''}">${this.typed || Math.abs(d).toFixed(2)}</span> м
      <span class="vcb-axis">${d < 0 ? 'внутрь' : 'наружу'}${typeof r === 'string' ? ` · ${r}` : holes}</span>`;
  }

  private cancel() {
    this.layer.setOutline(undefined);
    this.target = undefined;
    this.typed = '';
    this.vcb.hidden = true;
    this.layer.setDrawPreview(undefined);
  }
}

/** Отступ грани — набор многоугольников: [внешний контур, ...дворы]. */
export type OffsetShape = Pt[][][];

/** Наибольшая длина острого угла (митры) в долях отступа: дальше угол срезается. */
const MITER_LIMIT = 4;

/**
 * Отступ грани с дырами булевыми операциями — без самопересечений при любом отступе. Вдоль каждой стороны
 * (внешнего контура и дворов) строится полоса шириной |d| в сторону от материала (d > 0) или в него (d < 0),
 * в выпуклых углах — заполнение до острого угла (митра, при очень остром — срез). Наружу: грань ∪ полосы,
 * внутрь: грань \ полосы. Сблизившиеся части сливаются, дворы — сужаются, сливаются или пропадают, грань
 * может распасться на несколько частей.
 */
export function offsetPolygon(t: { ring: Pt[]; inners: Pt[][] }, d: number): OffsetShape | string {
  const a = Math.abs(d);
  const pieces: Pt[][][] = [];
  for (const [ring, hole] of [[t.ring, false], ...t.inners.map((r) => [r, true] as const)] as const) {
    const n = ring.length;
    const ccw = area2(ring) > 0;
    // Нормаль «от материала»: у внешнего контура — наружу, у двора — внутрь двора; при d < 0 — наоборот
    const sgn = (ccw ? 1 : -1) * (hole ? -1 : 1) * (d > 0 ? 1 : -1);
    const nrm = (p: Pt, q: Pt): Pt => {
      const dx = q[0] - p[0], dy = q[1] - p[1], l = Math.hypot(dx, dy) || 1;
      return [(dy / l) * sgn, (-dx / l) * sgn];
    };
    for (let i = 0; i < n; i++) {
      const p = ring[i], q = ring[(i + 1) % n], r = ring[(i + 2) % n];
      if (Math.hypot(q[0] - p[0], q[1] - p[1]) < 1e-6) continue;
      const n1 = nrm(p, q), n2 = nrm(q, r);
      pieces.push([[p, q, [q[0] + n1[0] * a, q[1] + n1[1] * a], [p[0] + n1[0] * a, p[1] + n1[1] * a]]]);
      // Угол в q: полосы расходятся (выпуклый в сторону отступа) — заполнить
      const cr = n1[0] * n2[1] - n1[1] * n2[0];
      const e1: Pt = [q[0] - p[0], q[1] - p[1]];
      const convex = (e1[0] * n2[0] + e1[1] * n2[1]) > 1e-9;
      if (!convex || Math.abs(cr) < 1e-9 && n1[0] * n2[0] + n1[1] * n2[1] > 0) continue;
      const b1: Pt = [q[0] + n1[0] * a, q[1] + n1[1] * a], b2: Pt = [q[0] + n2[0] * a, q[1] + n2[1] * a];
      // Острие — пересечение сдвинутых сторон: q + (n1 + n2)·a / (1 + n1·n2)
      const k = 1 + n1[0] * n2[0] + n1[1] * n2[1];
      const m: Pt | undefined = k > 1e-6 ? [q[0] + (n1[0] + n2[0]) * a / k, q[1] + (n1[1] + n2[1]) * a / k] : undefined;
      pieces.push(m && Math.hypot(m[0] - q[0], m[1] - q[1]) <= MITER_LIMIT * a ? [[q, b1, m, b2]] : [[q, b1, b2]]);
    }
  }
  const face: Pt[][][] = [[t.ring, ...t.inners]];
  let res: Pt[][][];
  try {
    res = (d > 0 ? polygonClipping.union(face as never, ...(pieces as never[])) : polygonClipping.difference(face as never, ...(pieces as never[]))) as unknown as Pt[][][];
  } catch {
    return 'не удалось построить контур';
  }
  // Кольца без повтора первой точки и без узлов на прямых; мелкие осколки — прочь
  const out: Pt[][][] = [];
  const big = (r: Pt[]) => r.length >= 3 && Math.abs(area2(r)) / 2 >= MIN_PIECE_AREA;
  for (const poly of res) {
    const outer = simplify(poly[0].slice(0, -1));
    if (!big(outer)) continue;
    out.push([outer, ...poly.slice(1).map((r) => simplify(r.slice(0, -1))).filter(big)]);
  }
  return out.length ? out : 'контур вырождается';
}

/** Осколки меньше этой площади после отступа отбрасываются, м². */
const MIN_PIECE_AREA = 0.5;

/** Убрать узлы на прямой (и повторы). */
function simplify(ring: Pt[]): Pt[] {
  let pts = ring.filter((p, i) => { const q = ring[(i + 1) % ring.length]; return Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-4; });
  let changed = true;
  while (changed && pts.length > 3) {
    changed = false;
    pts = pts.filter((p, i, arr) => {
      const a = arr[(i - 1 + arr.length) % arr.length], b = arr[(i + 1) % arr.length];
      const cr = (p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0]);
      const keep = Math.abs(cr) > 1e-3 * Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (!keep) changed = true;
      return keep;
    });
  }
  return pts;
}

/** Удвоенная площадь со знаком (> 0 — против часовой). */
function area2(ring: Pt[]): number {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) s += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return s;
}

/** Расстояние от точки до контура: > 0 — снаружи, < 0 — внутри. */
function signedDistance(ring: Pt[], q: Pt): number {
  let best = Infinity, inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j], b = ring[i];
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / l2));
    best = Math.min(best, Math.hypot(q[0] - a[0] - dx * t, q[1] - a[1] - dy * t));
    if ((a[1] > q[1]) !== (b[1] > q[1]) && q[0] < a[0] + ((q[1] - a[1]) / (b[1] - a[1])) * dx) inside = !inside;
  }
  return inside ? -best : best;
}

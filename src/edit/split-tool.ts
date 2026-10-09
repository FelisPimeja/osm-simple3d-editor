import * as THREE from 'three';
import type { BuildingsLayer, SnapHit } from '../render/buildings-layer';

type Pt = [number, number];

/** Направление разреза ближе этого угла к оси (вдоль начального ребра или перпендикулярно) — точно по оси, градусы. */
const AXIS_LOCK_DEG = 3;

/** Точка разреза на контуре: сторона (i → i+1), положение на ней и, если попали в вершину, её номер. */
export interface CutPoint { edge: number; p: Pt; vertex?: number }

/**
 * Инструмент «Рассечь»: прямой разрез верхней грани от ребра к ребру делит контур на два.
 * 1. клик по ребру верхней грани (вершины и середины — с привязкой) — начало разреза;
 * 2. второй клик по другому ребру той же грани — конец; разрез должен целиком идти внутри контура.
 *    От начала — свои оси: вдоль начального ребра и перпендикулярно ему; рядом с осью разрез прилипает к ней,
 *    Shift держит ось — конец разреза там, где прямая по оси встречает контур (перпендикуляр к ребру).
 * Что можно резать и как делить данные — решают eligible и split снаружи. Esc — отмена.
 */
export class SplitTool {
  state: 'off' | 'pick' | 'cut' = 'off';
  private target?: string;
  private start?: CutPoint;
  /** Привязка последнего пересчёта точки разреза — для маркера. */
  snap?: SnapHit;
  private z = 0;
  /** Оси от начала разреза: x — вдоль начального ребра, y — перпендикуляр к нему. */
  private axes?: { x: Pt; y: Pt };
  private axis?: 0 | 1;
  /** Ось, зафиксированная Shift. */
  private locked?: 0 | 1;
  private lastPoint?: [number, number];
  private shift = false;

  constructor(
    private readonly layer: BuildingsLayer,
    /** Почему объект нельзя резать (undefined — можно). */
    private readonly eligible: (key: string) => string | undefined,
    private readonly split: (key: string, a: CutPoint, b: CutPoint) => string | undefined,
    private readonly onState: (hint: string, error?: boolean) => void,
  ) {}

  get active() { return this.state !== 'off'; }

  begin() {
    this.state = 'pick';
    this.onState('Рассечь: кликните по ребру верхней грани — начало разреза. Esc — выйти.');
  }

  stop() {
    this.cancel();
    this.state = 'off';
    this.onState('');
  }

  click(point: [number, number]): boolean {
    if (this.state === 'pick') {
      const hit = this.layer.focusRayHits(point)[0];
      if (!hit) return false;
      const why = this.eligible(hit.key);
      if (why) { this.onState(why, true); return true; }
      const box = this.layer.focusItemBox(hit.key);
      if (!box) return true;
      this.target = hit.key;
      this.z = box.max.z;
      const c = this.cutPointAt(point);
      if (!c) { this.target = undefined; this.onState('Кликните точно по ребру верхней грани (вершины и середины подсвечиваются).', true); return true; }
      this.start = c;
      const ring = this.layer.focusPolygons(hit.key)![0].outer;
      const a = ring[c.edge], b = ring[(c.edge + 1) % ring.length];
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      this.axes = { x: [(b[0] - a[0]) / l, (b[1] - a[1]) / l], y: [-(b[1] - a[1]) / l, (b[0] - a[0]) / l] };
      this.axis = this.locked = undefined;
      this.state = 'cut';
      this.guide(c.p);
      this.onState('Ведите разрез ко второму ребру этой грани и кликните. Оси — по начальному ребру и перпендикулярно (Shift — держать ось). Esc — отмена.');
      return true;
    }
    if (this.state === 'cut' && this.target && this.start) {
      const c = this.endAt(point);
      if (!c) { this.onState('Конец разреза — на ребре верхней грани.', true); return true; }
      const err = this.split(this.target, this.start, c);
      if (err) { this.onState(err, true); return true; }
      this.cancel();
      this.begin();
      return true;
    }
    return false;
  }

  move(point: [number, number]) {
    this.lastPoint = point;
    if (this.state !== 'cut' || !this.start) return;
    const c = this.endAt(point);
    this.guide(c?.p ?? this.planePoint(point));
  }

  /**
   * Конец разреза: по оси (прилипание или Shift) — точка, где прямая по оси от начала встречает контур;
   * иначе — точка на ребре под курсором.
   */
  private endAt(point: [number, number]): CutPoint | undefined {
    const free = this.cutPointAt(point);
    const s = this.start!, ax = this.axes;
    this.axis = undefined;
    if (!ax) return free;
    const q = free && this.snap ? free.p : this.planePoint(point);
    if (!q) return free;
    const d: Pt = [q[0] - s.p[0], q[1] - s.p[1]];
    const len = Math.hypot(d[0], d[1]);
    let axis = this.locked;
    // Shift без прилипшей оси — ближайшая по направлению
    if (axis === undefined && this.shift && len > 1e-6) {
      axis = this.locked = Math.abs(d[0] * ax.y[0] + d[1] * ax.y[1]) > Math.abs(d[0] * ax.x[0] + d[1] * ax.x[1]) ? 1 : 0;
    }
    if (axis === undefined && len > 1e-6 && !this.snap) {
      for (const i of [0, 1] as const) {
        const u = i ? ax.y : ax.x;
        if (Math.abs(d[0] * u[0] + d[1] * u[1]) / len > Math.cos((AXIS_LOCK_DEG * Math.PI) / 180)) axis = i;
      }
    }
    if (axis === undefined) return free;
    const u = axis ? ax.y : ax.x;
    const sign = d[0] * u[0] + d[1] * u[1] < 0 ? -1 : 1;
    const hit = this.rayToRing([u[0] * sign, u[1] * sign]);
    if (!hit) return free;
    this.axis = axis;
    return hit;
  }

  /** Первая точка контура на луче от начала разреза в направлении dir (не на начальном ребре). */
  private rayToRing(dir: Pt): CutPoint | undefined {
    const ring = this.target ? this.layer.focusPolygons(this.target)?.[0]?.outer : undefined;
    if (!ring || !this.start) return;
    const o = this.start.p;
    let best: CutPoint & { t: number } | undefined;
    for (let i = 0; i < ring.length; i++) {
      if (i === this.start.edge) continue;
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const e: Pt = [b[0] - a[0], b[1] - a[1]];
      const den = dir[0] * e[1] - dir[1] * e[0];
      if (Math.abs(den) < 1e-9) continue;
      const t = ((a[0] - o[0]) * e[1] - (a[1] - o[1]) * e[0]) / den;
      const s = ((a[0] - o[0]) * dir[1] - (a[1] - o[1]) * dir[0]) / den;
      if (t <= 0.01 || s < -1e-9 || s > 1 + 1e-9) continue;
      if (!best || t < best.t) {
        const l = Math.hypot(e[0], e[1]);
        const vertex = s * l < 0.05 ? i : (1 - s) * l < 0.05 ? (i + 1) % ring.length : undefined;
        best = { edge: i, p: vertex === undefined ? [o[0] + dir[0] * t, o[1] + dir[1] * t] : ring[vertex], vertex, t };
      }
    }
    if (!best) return;
    const { t: _t, ...c } = best;
    void _t;
    return c;
  }

  key(e: KeyboardEvent): boolean {
    if (!this.active) return false;
    if (e.key === 'Shift' && this.state === 'cut') {
      this.shift = e.type === 'keydown';
      this.locked = this.shift ? this.axis ?? this.locked : undefined;
      if (this.lastPoint) this.move(this.lastPoint);
      return true;
    }
    if (e.type !== 'keydown' || e.key !== 'Escape') return false;
    if (this.state === 'cut') { this.cancel(); this.begin(); } else this.stop();
    return true;
  }

  /** Точка под курсором на плоскости верхней грани. */
  private planePoint(point: [number, number]): Pt | undefined {
    const ray = this.layer.focusRay(point);
    if (!ray || Math.abs(ray.direction.z) < 1e-6) return;
    const t = (this.z - ray.origin.z) / ray.direction.z;
    if (t <= 0) return;
    const q = ray.at(t, new THREE.Vector3());
    return [q.x, q.y];
  }

  /** Точка разреза на ребре: привязка к вершине/середине или ближайшая точка ребра в пределах допуска. */
  private cutPointAt(point: [number, number]): CutPoint | undefined {
    const ring = this.target ? this.layer.focusPolygons(this.target)?.[0]?.outer : undefined;
    if (!ring) return;
    // Второй конец разреза — и перпендикуляр из первого на рёбра
    const from = this.start && new THREE.Vector3(this.start.p[0], this.start.p[1], this.z);
    const snap = this.snap = this.layer.snapAt(point, (k) => k === this.target, undefined, { from });
    const onTop = snap && Math.abs(snap.local.z - this.z) < 0.05 && snap.kind !== 'center';
    const q: Pt | undefined = onTop ? [snap.local.x, snap.local.y] : this.planePoint(point);
    if (!q) return;
    const ray = this.layer.focusRay(point);
    const dist = ray ? ray.origin.distanceTo(new THREE.Vector3(q[0], q[1], this.z)) : 50;
    const tol = onTop ? 0.05 : Math.max(0.3, dist * 0.015);
    let best: CutPoint & { d: number } | undefined;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
      if (!l2) continue;
      const t = Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / l2));
      const p: Pt = [a[0] + t * dx, a[1] + t * dy];
      const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (d < tol && (!best || d < best.d)) {
        // У самой вершины — сама вершина (без нового узла)
        const vertex = t * Math.sqrt(l2) < 0.05 ? i : (1 - t) * Math.sqrt(l2) < 0.05 ? (i + 1) % ring.length : undefined;
        best = { edge: i, p: vertex === undefined ? p : ring[vertex], vertex, d };
      }
    }
    if (!best) return;
    const { d: _d, ...c } = best;
    void _d;
    return c;
  }

  private guide(to: Pt | undefined) {
    if (!this.start) return;
    const from = new THREE.Vector3(this.start.p[0], this.start.p[1], this.z);
    this.layer.setMoveGuide({ from, to: to ? new THREE.Vector3(to[0], to[1], this.z) : undefined, axis: this.axis, locked: this.locked, axes: this.axes });
  }

  private cancel() {
    this.layer.setMoveGuide(undefined);
    this.target = undefined;
    this.start = undefined;
    this.axes = this.axis = this.locked = undefined;
  }
}

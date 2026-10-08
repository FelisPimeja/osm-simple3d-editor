import * as THREE from 'three';
import type { BuildingsLayer } from '../render/buildings-layer';

type Pt = [number, number];

/** Точка разреза на контуре: сторона (i → i+1), положение на ней и, если попали в вершину, её номер. */
export interface CutPoint { edge: number; p: Pt; vertex?: number }

/**
 * Инструмент «Рассечь»: прямой разрез верхней грани от ребра к ребру делит контур на два.
 * 1. клик по ребру верхней грани (вершины и середины — с привязкой) — начало разреза;
 * 2. второй клик по другому ребру той же грани — конец; разрез должен целиком идти внутри контура.
 * Что можно резать и как делить данные — решают eligible и split снаружи. Esc — отмена.
 */
export class SplitTool {
  state: 'off' | 'pick' | 'cut' = 'off';
  private target?: string;
  private start?: CutPoint;
  private z = 0;

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
      this.state = 'cut';
      this.guide(c.p);
      this.onState('Ведите разрез ко второму ребру этой грани и кликните. Esc — отмена.');
      return true;
    }
    if (this.state === 'cut' && this.target && this.start) {
      const c = this.cutPointAt(point);
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
    if (this.state !== 'cut' || !this.start) return;
    const c = this.cutPointAt(point);
    this.guide(c?.p ?? this.planePoint(point));
  }

  key(e: KeyboardEvent): boolean {
    if (!this.active || e.type !== 'keydown' || e.key !== 'Escape') return false;
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
    const snap = this.layer.snapAt(point, (k) => k === this.target);
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
    this.layer.setMoveGuide({ from, to: to ? new THREE.Vector3(to[0], to[1], this.z) : undefined });
  }

  private cancel() {
    this.layer.setMoveGuide(undefined);
    this.target = undefined;
    this.start = undefined;
  }
}

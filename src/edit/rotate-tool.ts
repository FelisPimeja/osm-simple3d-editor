import * as THREE from 'three';
import type { BuildingsLayer, SnapHit } from '../render/buildings-layer';

/** Шаг «прилипания» угла, градусы. */
const STEP_DEG = 15;
/** Ближе этого к кратному шагу — угол прилипает к нему, градусы. */
const STICK_DEG = 1.5;

/**
 * Инструмент «Повернуть» (как Rotate в SketchUp), вокруг вертикальной оси, в режиме одного здания:
 * 1. клик — ось поворота (с привязкой: вершина, середина, центр, сетка);
 * 2. клик — опорное направление (от оси на эту точку);
 * 3. движение курсора — поворот: угол от опорного направления до направления на курсор; рядом с кратным
 *    15° прилипает к нему, Shift — только шагом 15°, привязка к точке выравнивает направление на неё;
 *    клик — применить; число + Enter — угол в градусах (против часовой стрелки, минус — по часовой). Esc — отмена.
 */
export class RotateTool {
  state: 'off' | 'pivot' | 'ref' | 'rotate' = 'off';
  keys = new Set<string>();
  snap?: SnapHit;
  private pivot = new THREE.Vector3();
  private refAngle = 0;
  private refPoint = new THREE.Vector3();
  private angle = 0;
  private shift = false;
  private typed = '';
  private lastPoint?: [number, number];
  private readonly vcb: HTMLDivElement;

  constructor(
    private readonly layer: BuildingsLayer,
    container: HTMLElement,
    /** Повернуть keys на angle (радианы, против часовой) вокруг точки pivot (метры сцены). */
    private readonly commit: (keys: string[], pivot: THREE.Vector3, angle: number) => void,
    private readonly onState: (hint: string) => void,
  ) {
    this.vcb = document.createElement('div');
    this.vcb.className = 'vcb';
    this.vcb.hidden = true;
    container.appendChild(this.vcb);
  }

  get active() { return this.state !== 'off'; }

  start(keys: string[]) {
    this.keys = new Set(keys);
    this.state = 'pivot';
    this.onState('Поворот: кликните ось поворота (вершина, центр, точка на объекте или на земле). Esc — выйти.');
  }

  stop() {
    this.cancel();
    this.state = 'off';
    this.keys = new Set();
    this.onState('');
  }

  click(point: [number, number]) {
    if (this.state === 'pivot') {
      const p = this.pointAt(point);
      if (!p) return;
      this.pivot.copy(p);
      this.state = 'ref';
      this.preview(point);
      this.onState('Кликните опорное направление — от оси на точку (например, на угол здания). Esc — отмена.');
      return;
    }
    if (this.state === 'ref') {
      const p = this.pointAt(point);
      if (!p || Math.hypot(p.x - this.pivot.x, p.y - this.pivot.y) < 1e-3) return;
      this.refPoint.set(p.x, p.y, this.pivot.z);
      this.refAngle = Math.atan2(p.y - this.pivot.y, p.x - this.pivot.x);
      this.angle = 0;
      this.state = 'rotate';
      this.onState(`Ведите курсор — поворот (у кратных ${STEP_DEG}° прилипает, Shift — только шагом ${STEP_DEG}°). Клик — применить, число + Enter — угол в градусах, Esc — отмена.`);
      this.preview(point);
      return;
    }
    if (this.state === 'rotate') this.apply(this.angle);
  }

  move(point: [number, number]) {
    this.lastPoint = point;
    if (this.state === 'off') return;
    this.preview(point);
  }

  key(e: KeyboardEvent): boolean {
    if (!this.active) return false;
    if (e.key === 'Shift') {
      this.shift = e.type === 'keydown';
      if (this.lastPoint) this.preview(this.lastPoint);
      return true;
    }
    if (e.type !== 'keydown') return false;
    if (e.key === 'Escape') {
      if (this.state === 'pivot') this.stop();
      else { this.cancel(); this.start([...this.keys]); }
      return true;
    }
    if (this.state !== 'rotate') return false;
    if (/^[\d.,-]$/.test(e.key)) { this.typed += e.key === ',' ? '.' : e.key; this.updateVcb(); return true; }
    if (e.key === 'Backspace') { this.typed = this.typed.slice(0, -1); this.updateVcb(); return true; }
    if (e.key === 'Enter') {
      const deg = Number(this.typed);
      if (this.typed && Number.isFinite(deg)) this.apply((deg * Math.PI) / 180);
      return true;
    }
    return false;
  }

  /** Точка под курсором: привязка, поверхность объекта или плоскость оси (до выбора оси — земля). */
  private pointAt(point: [number, number], filter?: (k: string) => boolean): THREE.Vector3 | undefined {
    this.snap = this.layer.snapAt(point, filter);
    if (this.snap) return this.snap.local.clone();
    if (this.state === 'pivot') {
      const hit = this.layer.focusRayHits(point)[0];
      if (hit) return hit.local.clone();
    }
    const ray = this.layer.focusRay(point);
    const z = this.state === 'pivot' ? 0 : this.pivot.z;
    return ray?.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -z), new THREE.Vector3()) ?? undefined;
  }

  private preview(point: [number, number]) {
    if (this.state === 'pivot') { this.pointAt(point); return; }
    // Поворачиваемые объекты не притягивают направление (иначе оно цепляется за них самих)
    const p = this.pointAt(point, this.state === 'rotate' ? (k) => !this.keys.has(k) : undefined);
    if (!p) return;
    const v = (x: number, y: number) => new THREE.Vector3(x, y, this.pivot.z);
    if (this.state === 'ref') {
      this.layer.setDrawPreview([v(this.pivot.x, this.pivot.y), v(p.x, p.y)]);
      return;
    }
    let a = Math.atan2(p.y - this.pivot.y, p.x - this.pivot.x) - this.refAngle;
    a = Math.atan2(Math.sin(a), Math.cos(a)); // −π…π
    const step = (STEP_DEG * Math.PI) / 180;
    const k = Math.round(a / step) * step;
    if (this.shift || (!this.snap && Math.abs(a - k) < (STICK_DEG * Math.PI) / 180)) a = k;
    this.angle = a;
    // Стороны угла: опорное направление и повёрнутое, длиной до курсора
    const r = Math.max(Math.hypot(p.x - this.pivot.x, p.y - this.pivot.y), Math.hypot(this.refPoint.x - this.pivot.x, this.refPoint.y - this.pivot.y));
    const end = this.refAngle + a;
    this.layer.setDrawPreview([
      v(this.pivot.x + Math.cos(this.refAngle) * r, this.pivot.y + Math.sin(this.refAngle) * r),
      v(this.pivot.x, this.pivot.y),
      v(this.pivot.x + Math.cos(end) * r, this.pivot.y + Math.sin(end) * r),
    ], false, true);
    this.layer.setRotatePreview([...this.keys], this.pivot, a);
    this.updateVcb();
  }

  private apply(angle: number) {
    const keys = [...this.keys];
    const pivot = this.pivot.clone();
    this.cancel();
    if (Math.abs(angle) > 1e-6) this.commit(keys, pivot, angle);
    this.start(keys);
  }

  private cancel() {
    if (this.state === 'rotate') this.layer.setRotatePreview([...this.keys], undefined, 0);
    this.layer.setDrawPreview(undefined);
    this.snap = undefined;
    this.typed = '';
    this.angle = 0;
    this.vcb.hidden = true;
  }

  private updateVcb() {
    if (this.state !== 'rotate') { this.vcb.hidden = true; return; }
    this.vcb.hidden = false;
    const deg = (this.angle * 180) / Math.PI;
    this.vcb.innerHTML = `<span class="vcb-label">Угол</span><span class="vcb-value${this.typed ? ' typed' : ''}">${this.typed || deg.toFixed(1)}</span>°
      <span class="vcb-axis">${this.snap ? 'привязка' : this.shift ? `шаг ${STEP_DEG}° (Shift)` : 'против часовой'}</span>`;
  }
}

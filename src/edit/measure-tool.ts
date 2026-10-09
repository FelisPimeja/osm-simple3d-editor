import * as THREE from 'three';
import type { BuildingsLayer, SnapHit } from '../render/buildings-layer';

/**
 * Инструмент «Рулетка»: расстояние между двумя точками (с привязками). Клик — первая точка, второй клик —
 * вторая (замер остаётся на экране до следующего клика). Shift держит ось здания (x, y или z — ближайшую
 * к текущему направлению). Esc — сбросить замер, повторный Esc — выйти.
 */
export class MeasureTool {
  state: 'off' | 'first' | 'second' = 'off';
  snap?: SnapHit;
  private a?: THREE.Vector3;
  private b?: THREE.Vector3;
  /** Ось, зафиксированная Shift: 0 — x здания, 1 — y, 2 — вертикаль. */
  private locked?: 0 | 1 | 2;
  private lastPoint?: [number, number];
  private readonly vcb: HTMLDivElement;

  constructor(
    private readonly layer: BuildingsLayer,
    container: HTMLElement,
    private readonly onState: (hint: string) => void,
  ) {
    this.vcb = document.createElement('div');
    this.vcb.className = 'vcb';
    this.vcb.hidden = true;
    container.appendChild(this.vcb);
  }

  get active() { return this.state !== 'off'; }

  start() {
    this.state = 'first';
    this.onState('Рулетка: кликните первую точку (привязки к вершинам, рёбрам, сетке). Esc — выйти.');
  }

  stop() {
    this.reset();
    this.state = 'off';
    this.onState('');
  }

  click(point: [number, number]) {
    if (this.state === 'off') return;
    const p = this.pointAt(point);
    if (!p) return;
    if (this.state === 'first') {
      this.a = p;
      this.state = 'second';
      this.show(p);
      this.onState('Рулетка: кликните вторую точку. Esc — отмена.');
      return;
    }
    // Замер остаётся на экране; следующий клик начнёт новый
    this.show(p, true);
    this.a = undefined;
    this.state = 'first';
    this.onState('Рулетка: кликните первую точку следующего замера. Esc — выйти.');
  }

  move(point: [number, number]) {
    if (this.state === 'off') return;
    this.lastPoint = point;
    const p = this.pointAt(point);
    if (this.state === 'second' && p) this.show(p);
  }

  /** true — клавиша обработана. */
  key(e: KeyboardEvent): boolean {
    if (!this.active) return false;
    if (e.key === 'Shift') {
      if (e.type === 'keyup') this.locked = undefined;
      else if (!e.repeat && this.state === 'second' && this.a && this.b) this.locked = this.nearestAxis(this.b.clone().sub(this.a));
      if (this.lastPoint) this.move(this.lastPoint);
      return true;
    }
    if (e.type !== 'keydown' || e.key !== 'Escape') return false;
    if (this.state === 'second' || !this.vcb.hidden) { this.reset(); this.state = 'first'; this.start(); } else this.stop();
    return true;
  }

  /** Точка под курсором: привязка, поверхность объекта или земля. */
  private pointAt(point: [number, number]): THREE.Vector3 | undefined {
    if (this.locked !== undefined && this.a) return this.onAxis(point, this.axes()[this.locked]);
    this.snap = this.layer.snapAt(point, undefined, undefined, { from: this.a });
    if (this.snap) return this.snap.local.clone();
    const hit = this.layer.focusRayHits(point)[0];
    if (hit) return hit.local.clone();
    const ray = this.layer.focusRay(point);
    return ray?.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), new THREE.Vector3()) ?? undefined;
  }

  /** Оси здания в метрах сцены. */
  private axes(): THREE.Vector3[] {
    const f = this.layer.focusAxes;
    return [new THREE.Vector3(f?.x[0] ?? 1, f?.x[1] ?? 0, 0), new THREE.Vector3(f?.y[0] ?? 0, f?.y[1] ?? 1, 0), new THREE.Vector3(0, 0, 1)];
  }

  private nearestAxis(d: THREE.Vector3): 0 | 1 | 2 {
    const dots = this.axes().map((a) => Math.abs(a.dot(d)));
    return dots.indexOf(Math.max(...dots)) as 0 | 1 | 2;
  }

  /** Точка на оси через первую точку: проекция привязки или ближайшая к лучу курсора. */
  private onAxis(point: [number, number], dir: THREE.Vector3): THREE.Vector3 | undefined {
    const a = this.a!;
    this.snap = this.layer.snapAt(point, undefined, undefined, {});
    if (this.snap) return a.clone().addScaledVector(dir, this.snap.local.clone().sub(a).dot(dir));
    const ray = this.layer.focusRay(point);
    if (!ray) return;
    const w0 = ray.origin.clone().sub(a);
    const b = ray.direction.dot(dir), d = ray.direction.dot(w0), e = dir.dot(w0);
    const den = 1 - b * b;
    return den < 1e-6 ? a.clone() : a.clone().addScaledVector(dir, (e - b * d) / den);
  }

  private show(b: THREE.Vector3, done = false) {
    const a = this.a!;
    this.b = b;
    this.layer.setMoveGuide({ from: a, to: b, axis: this.locked, locked: this.locked });
    const d = b.clone().sub(a);
    const flat = Math.hypot(d.x, d.y);
    this.vcb.hidden = false;
    this.vcb.innerHTML = `<span class="vcb-label">${done ? 'Замер' : 'Расстояние'}</span><span class="vcb-value">${d.length().toFixed(2)}</span> м
      <span class="vcb-axis">${this.locked !== undefined ? `по оси ${'xyz'[this.locked]} (Shift) · ` : ''}по горизонтали ${flat.toFixed(2)} · по высоте ${d.z >= 0 ? '+' : ''}${d.z.toFixed(2)}</span>`;
  }

  private reset() {
    this.a = this.b = undefined;
    this.locked = undefined;
    this.snap = undefined;
    this.vcb.hidden = true;
    this.layer.setMoveGuide(undefined);
  }
}

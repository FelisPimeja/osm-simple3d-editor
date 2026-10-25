import * as THREE from 'three';
import type { BuildingsLayer, SnapHit } from '../render/buildings-layer';
import { tr } from '../i18n';
import type { UnderlayTarget } from './underlay-target';
import { linkedNote, type LinkPreview, glueClick, glueSwitch, isGlueKey, loadGlue, saveGlue } from './glue';

/** Шаг «прилипания» угла, градусы. */
const STEP_DEG = 15;
/** Ближе этого к кратному шагу — угол прилипает к нему, градусы. */
const STICK_DEG = 1.5;
const AXIS_NAMES = ['x', 'y', 'z'] as const;
type Axis = 0 | 1 | 2;
const Z = new THREE.Vector3(0, 0, 1);

/**
 * Инструмент «Повернуть» (как Rotate в SketchUp), в режиме одного здания:
 * 1. клик — ось поворота (с привязкой: вершина, середина, центр, сетка). Ось вертикальна; у подложек (без частей
 *    здания в выделении) — любая: стрелки → x, ← y, ↑ z (оси здания), ↓ — по картинке под курсором (её нормаль);
 * 2. клик — опорное направление (от оси на эту точку);
 * 3. движение курсора — поворот: угол от опорного направления до направления на курсор; рядом с кратным
 *    15° прилипает к нему, Shift — только шагом 15°, привязка к точке выравнивает направление на неё;
 *    клик — применить; число + Enter — угол в градусах (против часовой стрелки, минус — по часовой). Esc — отмена.
 */
export class RotateTool {
  state: 'off' | 'pivot' | 'ref' | 'rotate' = 'off';
  keys = new Set<string>();
  /** Выделенные подложки (id) — поворачиваются вместе с объектами. */
  underlayIds = new Set<string>();
  underlays?: UnderlayTarget;
  snap?: SnapHit;
  /** Общие с соседями узлы: тянуть соседей следом или отделиться (D). */
  glue = loadGlue();
  private pivot = new THREE.Vector3();
  /** Ось поворота (единичная) и базис плоскости поворота: угол — от u к v. */
  private axis = Z.clone();
  private u = new THREE.Vector3(1, 0, 0);
  private v = new THREE.Vector3(0, 1, 0);
  /** Ось зафиксирована стрелкой; undefined — z, а у подложки под курсором — её нормаль. */
  private locked?: Axis;
  private refAngle = 0;
  private refPoint = new THREE.Vector3();
  private angle = 0;
  private shift = false;
  private typed = '';
  private lastPoint?: [number, number];
  private readonly vcb: HTMLDivElement;
  /** Превью соседей «с соседями» (подключает main.ts) и сколько их тянется. */
  linkPreview?: LinkPreview;
  private linked = 0;

  constructor(
    private readonly layer: BuildingsLayer,
    container: HTMLElement,
    /** Повернуть keys на angle (радианы, против часовой) вокруг точки pivot (метры сцены). */
    private readonly commit: (keys: string[], pivot: THREE.Vector3, angle: number, glue: boolean, axis: THREE.Vector3, underlays: string[]) => void,
    private readonly onState: (hint: string) => void,
  ) {
    this.vcb = document.createElement('div');
    this.vcb.className = 'vcb';
    this.vcb.hidden = true;
    container.appendChild(this.vcb);
    for (const ev of ['mousedown', 'click', 'dblclick'] as const) this.vcb.addEventListener(ev, (e) => e.stopPropagation());
    this.vcb.addEventListener('click', (e) => { const g = glueClick(e); if (g !== undefined) this.setGlue(g); });
  }

  setGlue(on: boolean) {
    this.glue = on;
    saveGlue(on);
    if (this.state === 'rotate' && this.lastPoint) this.preview(this.lastPoint);
    this.updateVcb();
  }

  get active() { return this.state !== 'off'; }

  start(keys: string[], underlays: string[] = []) {
    this.keys = new Set(keys);
    this.underlayIds = new Set(underlays);
    if (keys.length) this.locked = undefined; // части здания — только вокруг вертикали
    this.setAxis(this.lockedAxis() ?? Z);
    this.glue = loadGlue();
    this.state = 'pivot';
    this.updateVcb();
    this.onState(tr('Поворот: кликните ось поворота (вершина, центр, точка на объекте или на земле). Esc — выйти.'));
  }

  stop() {
    this.cancel();
    this.state = 'off';
    this.keys = new Set();
    this.underlayIds = new Set();
    this.locked = undefined;
    this.vcb.hidden = true;
    this.onState('');
  }

  click(point: [number, number]) {
    if (this.state === 'pivot') {
      const p = this.pointAt(point);
      if (!p) return;
      this.pivot.copy(p);
      // По картинке подложки — ось по её нормали (если ось не зафиксирована)
      if (!this.keys.size && this.locked === undefined) this.setAxis(this.underlayNormal(point) ?? Z);
      this.state = 'ref';
      this.updateVcb();
      this.preview(point);
      this.onState(tr('Кликните опорное направление — от оси на точку (например, на угол здания). Esc — отмена.'));
      return;
    }
    if (this.state === 'ref') {
      const p = this.pointAt(point);
      if (!p || p.distanceTo(this.pivot) < 1e-3) return;
      this.refPoint.copy(p);
      this.refAngle = this.angleOf(p);
      this.angle = 0;
      this.state = 'rotate';
      this.onState(tr('Ведите курсор — поворот (у кратных {step}° прилипает, Shift — только шагом {step}°). Клик — применить, число + Enter — угол в градусах, Esc — отмена.', { step: STEP_DEG }));
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
      else { this.cancel(); this.start([...this.keys], [...this.underlayIds]); }
      return true;
    }
    if (isGlueKey(e) && this.keys.size) { this.setGlue(!this.glue); return true; }
    const arrows: Record<string, Axis | null> = { ArrowRight: 0, ArrowLeft: 1, ArrowUp: 2, ArrowDown: null };
    if (e.key in arrows) {
      if (this.keys.size) { this.onState(tr('Части здания поворачиваются только вокруг вертикали (у подложек без частей — любая ось).')); return true; }
      const a = arrows[e.key];
      this.locked = a === null || this.locked === a ? undefined : a;
      // Ось меняется — опорное направление выбираем заново
      if (this.state !== 'pivot') { this.cancel(); this.state = 'ref'; }
      this.setAxis(this.lockedAxis() ?? Z);
      if (this.lastPoint) this.preview(this.lastPoint);
      this.updateVcb();
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

  /**
   * Точка под курсором: привязка (здания, а при выборе центра и опорной точки — и подложек), поверхность объекта или подложки,
   * плоскость поворота (до выбора оси — земля). После выбора оси — проекция на плоскость поворота.
   */
  private pointAt(point: [number, number], filter?: (k: string) => boolean): THREE.Vector3 | undefined {
    const pivoting = this.state === 'pivot';
    // Свои подложки притягивают центр и опорную точку (угол растра), но не цель поворота: они сами едут
    const own = (pivoting || this.state === 'ref') && this.underlayIds.size;
    this.snap = this.layer.snapAt(point, filter) ?? (own ? this.underlays?.snap(point, this.underlayIds) : undefined);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(this.axis, this.pivot);
    if (this.snap) return pivoting ? this.snap.local.clone() : plane.projectPoint(this.snap.local, new THREE.Vector3());
    if (pivoting) {
      const hit = this.layer.focusRayHits(point)[0]?.local ?? (this.underlayIds.size ? this.underlays?.hit(point, this.underlayIds)?.p : undefined);
      if (hit) return hit.clone();
    }
    const ray = this.layer.focusRay(point);
    if (pivoting) return ray?.intersectPlane(new THREE.Plane(Z, 0), new THREE.Vector3()) ?? undefined;
    return ray?.intersectPlane(plane, new THREE.Vector3()) ?? undefined;
  }

  /** Нормаль подложки под курсором — к камере. */
  private underlayNormal(point: [number, number]): THREE.Vector3 | undefined {
    const h = this.underlayIds.size ? this.underlays?.hit(point, this.underlayIds) : undefined;
    const ray = this.layer.focusRay(point);
    if (!h) return;
    return ray && h.n.dot(ray.direction) > 0 ? h.n.clone().negate() : h.n.clone();
  }

  private axes(): [THREE.Vector3, THREE.Vector3, THREE.Vector3] {
    const f = this.layer.focusAxes;
    return f ? [new THREE.Vector3(f.x[0], f.x[1], 0), new THREE.Vector3(f.y[0], f.y[1], 0), Z.clone()] : [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), Z.clone()];
  }

  private lockedAxis() { return this.locked === undefined ? undefined : this.axes()[this.locked]; }

  /** Ось поворота и базис плоскости: u — горизонтально (у горизонтальной плоскости — восток), v = axis × u. */
  private setAxis(axis: THREE.Vector3) {
    this.axis.copy(axis).normalize();
    this.u.crossVectors(Z, this.axis);
    if (this.u.lengthSq() < 1e-8) this.u.set(1, 0, 0);
    this.u.normalize();
    this.v.crossVectors(this.axis, this.u);
    // Вокруг вертикали — как было: угол от востока против часовой, если смотреть сверху
    if (this.axis.z > 0.999) { this.u.set(1, 0, 0); this.v.set(0, 1, 0); }
    else if (this.axis.z < -0.999) { this.axis.set(0, 0, 1); this.u.set(1, 0, 0); this.v.set(0, 1, 0); }
  }

  /** Угол точки (в плоскости поворота) от u к v. */
  private angleOf(p: THREE.Vector3) {
    const d = p.clone().sub(this.pivot);
    return Math.atan2(d.dot(this.v), d.dot(this.u));
  }

  /** Точка плоскости поворота на угле a и расстоянии r от оси. */
  private at(a: number, r: number) {
    return this.pivot.clone().addScaledVector(this.u, Math.cos(a) * r).addScaledVector(this.v, Math.sin(a) * r);
  }

  /** Поворот вокруг оси через pivot на угол a (метры сцены). */
  private matrix(a: number) {
    return new THREE.Matrix4().makeTranslation(this.pivot.x, this.pivot.y, this.pivot.z)
      .multiply(new THREE.Matrix4().makeRotationAxis(this.axis, a))
      .multiply(new THREE.Matrix4().makeTranslation(-this.pivot.x, -this.pivot.y, -this.pivot.z));
  }

  private preview(point: [number, number]) {
    if (this.state === 'pivot') { this.pointAt(point); return; }
    // Поворачиваемые объекты не притягивают направление (иначе оно цепляется за них самих)
    const p = this.pointAt(point, this.state === 'rotate' ? (k) => !this.keys.has(k) : undefined);
    if (!p) return;
    if (this.state === 'ref') {
      this.layer.setDrawPreview([this.pivot.clone(), p.clone()]);
      return;
    }
    let a = this.angleOf(p) - this.refAngle;
    a = Math.atan2(Math.sin(a), Math.cos(a)); // −π…π
    const step = (STEP_DEG * Math.PI) / 180;
    const k = Math.round(a / step) * step;
    if (this.shift || (!this.snap && Math.abs(a - k) < (STICK_DEG * Math.PI) / 180)) a = k;
    this.angle = a;
    // Стороны угла: опорное направление и повёрнутое, длиной до курсора
    const r = Math.max(p.distanceTo(this.pivot), this.refPoint.distanceTo(this.pivot));
    this.layer.setDrawPreview([this.at(this.refAngle, r), this.pivot.clone(), this.at(this.refAngle + a, r)], false, true);
    const m = this.matrix(a);
    if (this.keys.size) {
      this.linked = this.linkPreview?.([...this.keys], m, this.glue) ?? 0;
      this.layer.setRotatePreview([...this.keys], this.pivot, a);
    }
    if (this.underlayIds.size) this.underlays?.preview(this.underlayIds, m);
    this.updateVcb();
  }

  private apply(angle: number) {
    const keys = [...this.keys], underlays = [...this.underlayIds];
    const pivot = this.pivot.clone(), axis = this.axis.clone();
    this.cancel();
    if (Math.abs(angle) > 1e-6) this.commit(keys, pivot, angle, this.glue, axis, underlays);
    this.start(keys, underlays);
  }

  private cancel() {
    if (this.state === 'rotate') {
      if (this.keys.size) { this.linked = this.linkPreview?.([...this.keys], undefined, false) ?? 0; this.layer.setRotatePreview([...this.keys], undefined, 0); }
      if (this.underlayIds.size) this.underlays?.preview(this.underlayIds, undefined);
    }
    this.layer.setDrawPreview(undefined);
    this.snap = undefined;
    this.typed = '';
    this.angle = 0;
  }

  private updateVcb() {
    if (!this.active) { this.vcb.hidden = true; return; }
    this.vcb.hidden = false;
    // Только подложки — соседей нет, зато ось любая
    const glue = this.keys.size ? glueSwitch(this.glue) : '';
    const axis = this.keys.size ? '' : `<span class="vcb-axis">${this.locked !== undefined ? tr('ось {axis} (зафиксирована)', { axis: AXIS_NAMES[this.locked] })
      : this.state === 'pivot' ? tr('ось z или по картинке (стрелки — x, y, z)') : Math.abs(this.axis.z) > 0.999 ? tr('ось {axis}', { axis: 'z' }) : tr('по картинке')}</span>`;
    if (this.state !== 'rotate') { this.vcb.innerHTML = `<span class="vcb-label">${tr('Поворот')}</span>${axis}${glue}`; return; }
    const deg = (this.angle * 180) / Math.PI;
    this.vcb.innerHTML = `<span class="vcb-label">${tr('Угол')}</span><span class="vcb-value${this.typed ? ' typed' : ''}">${this.typed || deg.toFixed(1)}</span>°
      <span class="vcb-axis">${this.snap ? tr('привязка') : this.shift ? tr('шаг {step}° (Shift)', { step: STEP_DEG }) : tr('против часовой')}</span>${axis}${this.keys.size && this.glue ? linkedNote(this.linked) : ''}${glue}`;
  }
}

import * as THREE from 'three';
import type { BuildingsLayer, SnapHit } from '../render/buildings-layer';
import { tr } from '../i18n';
import type { UnderlayTarget } from './underlay-target';
import { linkedNote, type LinkPreview, glueClick, glueSwitch, isGlueKey, loadGlue, saveGlue } from './glue';

/** Шаг «прилипания» угла, градусы. */
const STEP_DEG = 15;
/** Радиус транспортира на экране, px. */
const PROTRACTOR_PX = 48;
/** Длина стрелок осей растра у центра поворота, px. */
const AXES_PX = 70;
/** Курсор идёт от центра вдоль стрелки оси (на экране) с таким допуском — ось подсвечивается, градусы. */
const AXIS_SNAP_DEG = 12;
/** Ближе к центру направление курсора ещё не определено, px. */
const MIN_DRAG_PX = 8;
/** Ближе этого к кратному шагу — угол прилипает к нему, градусы. */
const STICK_DEG = 1.5;
const AXIS_NAMES = ['x', 'y', 'z'] as const;
type Axis = 0 | 1 | 2;
const Z = new THREE.Vector3(0, 0, 1);

/**
 * Инструмент «Повернуть» (как Rotate в SketchUp), в режиме одного здания:
 * 1. клик — центр поворота (с привязкой: вершина, середина, центр, сетка). Ось вертикальна. У подложек (без частей
 *    здания в выделении) в центре — стрелки осей растра (x — вдоль ширины картинки, y — вдоль высоты, z — нормаль):
 *    курсор, ведомый от центра вдоль стрелки, подсвечивает ось, Shift (держать) — поворот вокруг неё; без Shift — вокруг
 *    нормали растра (в его плоскости). Стрелки клавиатуры → x, ← y, ↑ z фиксируют оси растра, ↓ — снять;
 * 2. клик — опорное направление (от оси на эту точку, в плоскости поворота);
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
  /** Ось зафиксирована (стрелкой клавиатуры или Shift); undefined — по умолчанию (z, у растра — его нормаль). */
  private locked?: Axis;
  /** Ось зафиксирована Shift (снимается при отпускании). */
  private shiftLocked = false;
  /** Ось растра, вдоль стрелки которой идёт курсор (выбор опорной точки). */
  private hovered?: Axis;
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
    if (keys.length || this.shiftLocked) this.locked = undefined; // части здания — только вокруг вертикали
    this.shiftLocked = false;
    this.hovered = undefined;
    this.setAxis(this.lockedAxis() ?? this.defaultAxis());
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
      this.setAxis(this.lockedAxis() ?? this.defaultAxis());
      this.state = 'ref';
      this.updateVcb();
      this.preview(point);
      this.onState(this.rasterAxes()
        ? tr('Ось поворота: ведите курсор от центра вдоль стрелки оси растра и держите Shift — поворот вокруг неё (без Shift — в плоскости растра). Клик — опорное направление. Esc — отмена.')
        : tr('Кликните опорное направление — от оси на точку (например, на угол здания). Esc — отмена.'));
      return;
    }
    if (this.state === 'ref') {
      const p = this.pointAt(point);
      if (!p || p.distanceTo(this.pivot) < 1e-3) return;
      this.refPoint.copy(p);
      this.refAngle = this.angleOf(p);
      this.angle = 0;
      this.state = 'rotate';
      // Ось выбрана: Shift дальше — шаг угла, его отпускание ось не меняет
      if (this.shiftLocked) { this.shiftLocked = false; this.locked = undefined; }
      this.hovered = undefined;
      this.layer.setRotateAxes(undefined);
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
      // Выбор оси растра: Shift держит ось, вдоль которой шёл курсор
      if (this.state === 'ref' && this.rasterAxes()) {
        if (this.shift && !e.repeat && this.locked === undefined && this.hovered !== undefined) { this.locked = this.hovered; this.shiftLocked = true; }
        if (!this.shift && this.shiftLocked) { this.locked = undefined; this.shiftLocked = false; }
      }
      if (this.lastPoint) this.preview(this.lastPoint);
      this.updateVcb();
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
      this.shiftLocked = false;
      // Посреди поворота ось сменилась — опорное направление выбираем заново
      if (this.state === 'rotate') { this.cancel(); this.state = 'ref'; }
      this.setAxis(this.lockedAxis() ?? this.defaultAxis());
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

  /**
   * Транспортир в центре поворота, в плоскости поворота (после выбора центра). При выборе оси растра — уже в плоскости
   * подсвеченной оси: видно, какая плоскость будет, если взять её Shift.
   */
  private showProtractor() {
    const c = this.pivot;
    if (this.state !== 'ref' && this.state !== 'rotate') { this.layer.setProtractor(undefined); return; }
    const shown = this.state === 'ref' && this.locked === undefined && this.hovered !== undefined ? this.hovered : undefined;
    const { u, v } = shown !== undefined ? basis(this.axes()[shown]) : { u: this.u, v: this.v };
    const s0 = this.layer.focusProject(c), s1 = this.layer.focusProject(c.clone().add(u)), s2 = this.layer.focusProject(c.clone().add(v));
    const px = s0 && Math.max(s1 ? Math.hypot(s1[0] - s0[0], s1[1] - s0[1]) : 0, s2 ? Math.hypot(s2[0] - s0[0], s2[1] - s0[1]) : 0);
    if (!px) { this.layer.setProtractor(undefined); return; }
    this.layer.setProtractor({ center: c, u, v, r: PROTRACTOR_PX / px, axis: shown ?? this.axisIndex() });
  }

  /** Px на метр у центра поворота (вдоль d). */
  private pxPerM(d: THREE.Vector3): number {
    const s0 = this.layer.focusProject(this.pivot), s1 = this.layer.focusProject(this.pivot.clone().add(d));
    return s0 && s1 ? Math.hypot(s1[0] - s0[0], s1[1] - s0[1]) : 0;
  }

  /** Стрелки осей растра у центра (выбор опорной точки у одних подложек). */
  private showRasterAxes() {
    const dirs = this.state === 'ref' ? this.rasterAxes() : undefined;
    if (!dirs) { this.layer.setRotateAxes(undefined); return; }
    const px = Math.max(this.pxPerM(dirs[0]), this.pxPerM(dirs[1]), this.pxPerM(dirs[2]));
    if (!px) { this.layer.setRotateAxes(undefined); return; }
    this.layer.setRotateAxes({ from: this.pivot, dirs, len: AXES_PX / px, active: this.hovered, locked: this.locked });
  }

  /** Ось растра, вдоль стрелки которой (на экране) идёт курсор от центра. */
  private inferAxis(point: [number, number], dirs: THREE.Vector3[]): Axis | undefined {
    const s0 = this.layer.focusProject(this.pivot);
    if (!s0) return;
    const cx = point[0] - s0[0], cy = point[1] - s0[1], len = Math.hypot(cx, cy);
    if (len < MIN_DRAG_PX) return;
    let best: { i: Axis; angle: number } | undefined;
    dirs.forEach((d, i) => {
      const s1 = this.layer.focusProject(this.pivot.clone().add(d));
      if (!s1) return;
      const dx = s1[0] - s0[0], dy = s1[1] - s0[1], l = Math.hypot(dx, dy);
      if (l < 1e-6) return;
      // Ось почти в камеру — на экране короткая: её не выбрать направлением
      const angle = Math.acos(Math.min(1, Math.abs((cx * dx + cy * dy) / (len * l)))) * 180 / Math.PI;
      if (!best || angle < best.angle) best = { i: i as Axis, angle };
    });
    return best && best.angle < AXIS_SNAP_DEG ? best.i : undefined;
  }

  /** Номер оси (растра или здания), по которой идёт ось поворота (undefined — произвольная). */
  private axisIndex(): Axis | undefined {
    const i = this.axes().findIndex((a) => Math.abs(a.dot(this.axis)) > 0.999);
    return i < 0 ? undefined : (i as Axis);
  }

  /** Оси растра — у одних подложек (без частей здания в выделении). */
  private rasterAxes() { return this.keys.size || !this.underlayIds.size ? undefined : this.underlays?.axes(this.underlayIds); }

  /** Ось по умолчанию: у растра — его нормаль, иначе вертикаль. */
  private defaultAxis() { return this.rasterAxes()?.[2] ?? Z; }

  /** Оси для фиксации: у растра — его оси, иначе оси здания. */
  private axes(): [THREE.Vector3, THREE.Vector3, THREE.Vector3] {
    const r = this.rasterAxes();
    if (r) return r;
    const f = this.layer.focusAxes;
    return f ? [new THREE.Vector3(f.x[0], f.x[1], 0), new THREE.Vector3(f.y[0], f.y[1], 0), Z.clone()] : [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), Z.clone()];
  }

  private lockedAxis() { return this.locked === undefined ? undefined : this.axes()[this.locked]; }

  /** Ось поворота и базис её плоскости (basis). */
  private setAxis(axis: THREE.Vector3) {
    const b = basis(axis);
    this.axis.copy(b.axis); this.u.copy(b.u); this.v.copy(b.v);
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
    if (this.state === 'ref') {
      const dirs = this.rasterAxes();
      const hovered = dirs ? this.inferAxis(point, dirs) : undefined;
      if (hovered !== this.hovered) { this.hovered = hovered; this.updateVcb(); }
      this.setAxis(this.lockedAxis() ?? this.defaultAxis());
      this.showRasterAxes();
    }
    this.showProtractor();
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
    this.layer.setProtractor(undefined);
    this.layer.setRotateAxes(undefined);
    this.snap = undefined;
    this.typed = '';
    this.angle = 0;
  }

  private updateVcb() {
    if (!this.active) { this.vcb.hidden = true; return; }
    this.vcb.hidden = false;
    // Только подложки — соседей нет, зато ось любая
    const glue = this.keys.size ? glueSwitch(this.glue) : '';
    // Ось растра: зафиксированная, подсвеченная (Shift — взять) или нормаль по умолчанию
    const raster = !!this.rasterAxes();
    const axis = this.keys.size ? '' : `<span class="vcb-axis">${this.locked !== undefined
      ? tr('ось {axis} растра (зафиксирована)', { axis: AXIS_NAMES[this.locked] })
      : this.state === 'ref' && this.hovered !== undefined ? tr('ось {axis} растра — Shift, чтобы взять', { axis: AXIS_NAMES[this.hovered] })
      : raster && this.state === 'rotate' && this.axisIndex() !== 2 && this.axisIndex() !== undefined ? tr('вокруг оси {axis} растра', { axis: AXIS_NAMES[this.axisIndex()!] })
      : raster ? tr('в плоскости растра') : tr('ось {axis}', { axis: 'z' })}</span>`;
    if (this.state !== 'rotate') { this.vcb.innerHTML = `<span class="vcb-label">${tr('Поворот')}</span>${axis}${glue}`; return; }
    const deg = (this.angle * 180) / Math.PI;
    this.vcb.innerHTML = `<span class="vcb-label">${tr('Угол')}</span><span class="vcb-value${this.typed ? ' typed' : ''}">${this.typed || deg.toFixed(1)}</span>°
      <span class="vcb-axis">${this.snap ? tr('привязка') : this.shift ? tr('шаг {step}° (Shift)', { step: STEP_DEG }) : tr('против часовой')}</span>${axis}${this.keys.size && this.glue ? linkedNote(this.linked) : ''}${glue}`;
  }
}

/** Ось поворота и базис её плоскости: u — горизонтально (у горизонтальной плоскости — восток), v = axis × u. */
function basis(a: THREE.Vector3): { axis: THREE.Vector3; u: THREE.Vector3; v: THREE.Vector3 } {
  const axis = a.clone().normalize();
  // Вокруг вертикали — как было: угол от востока против часовой, если смотреть сверху
  if (Math.abs(axis.z) > 0.999) return { axis: Z.clone(), u: new THREE.Vector3(1, 0, 0), v: new THREE.Vector3(0, 1, 0) };
  const u = new THREE.Vector3().crossVectors(Z, axis).normalize();
  return { axis, u, v: new THREE.Vector3().crossVectors(axis, u) };
}

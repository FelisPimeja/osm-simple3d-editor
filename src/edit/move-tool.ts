import * as THREE from 'three';
import type { BuildingsLayer, SnapHit } from '../render/buildings-layer';

/** Угол между движением курсора и осью на экране, при котором движение «прилипает» к оси. */
const AXIS_SNAP_DEG = 15;
/** Курсор ближе к точке захвата — направление ещё не определено. */
const MIN_DRAG_PX = 6;
const AXIS_NAMES = ['x', 'y', 'z'] as const;

type Axis = 0 | 1 | 2;

/**
 * Инструмент «Переместить» (как Move в SketchUp), работает в режиме одного здания:
 * 1. клик по точке привязки (или поверхности) выбранного объекта — точка захвата;
 * 2. движение курсора: направление прилипает к осям локальной системы здания, если курсор идёт вдоль
 *    одной из них на экране; иначе — свободно по горизонтали. Привязка к точкам других объектов
 *    переносит точку захвата в них (при зафиксированной оси — проекция на ось);
 * 3. второй клик — применить; число с клавиатуры + Enter — сдвиг на столько метров.
 * Shift держит текущую ось, стрелки фиксируют ось (→ x, ← y, ↑ z, ↓ — снять). Esc — отмена.
 */
export class MoveTool {
  state: 'off' | 'pick' | 'move' = 'off';
  keys = new Set<string>();
  /** Привязка, к которой сейчас тянем (для маркера). */
  snap?: SnapHit;
  private from = new THREE.Vector3();
  private offset = new THREE.Vector3();
  private axis?: Axis;
  /** Ось, зафиксированная стрелкой или Shift. */
  private locked?: Axis;
  private shiftLock = false;
  /** Ось зафиксирована стрелкой — отпускание Shift её не снимает. */
  private arrowLock = false;
  private typed = '';
  private lastPoint?: [number, number];
  private readonly vcb: HTMLDivElement;

  constructor(
    private readonly layer: BuildingsLayer,
    container: HTMLElement,
    private readonly commit: (keys: string[], offset: THREE.Vector3) => void,
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
    this.state = 'pick';
    this.onState('Кликните по точке на выбранном объекте — от неё пойдёт перемещение. Esc — выйти из инструмента.');
  }

  stop() {
    this.cancelMove();
    this.state = 'off';
    this.keys = new Set();
    this.onState('');
  }

  /** Привязки в режиме выбора точки захвата — только на перемещаемых объектах. */
  pickFilter = (key: string) => this.keys.has(key);

  click(point: [number, number]) {
    if (this.state === 'pick') {
      const s = this.layer.snapAt(point, this.pickFilter);
      const hit = s ? undefined : this.layer.pickHit(point);
      const p = s?.local ?? (hit && this.keys.has(hit.key) ? hit.local : undefined);
      if (!p) return this.onState('Кликните по точке на выбранном объекте (подсвеченные привязки — вершины, середины, центр).');
      this.from.copy(p);
      this.offset.set(0, 0, 0);
      this.axis = this.locked = undefined;
      this.typed = '';
      this.state = 'move';
      this.layer.setMoveGuide({ from: this.from });
      this.updateVcb();
      this.onState('Ведите курсор: вдоль оси здания движение прилипает к ней. Клик — применить, число + Enter — сдвиг в метрах, Esc — отмена.');
      return;
    }
    if (this.state === 'move') this.apply(this.offset);
  }

  move(point: [number, number]) {
    this.lastPoint = point;
    if (this.state !== 'move') return;
    const axes = this.axes();
    const ray = this.layer.focusRay(point);
    if (!axes || !ray) return;
    const fixed = this.locked;
    this.snap = this.layer.snapAt(point, (k) => !this.keys.has(k), undefined, { from: this.from });
    let axis: Axis | undefined = fixed;
    const offset = new THREE.Vector3();
    if (this.snap) {
      offset.subVectors(this.snap.local, this.from);
      // Проекцию считаем до copy: иначе offset уже перезаписан осью и dot даёт 1
      if (fixed !== undefined) { const along = offset.dot(axes[fixed]); offset.copy(axes[fixed]).multiplyScalar(along); }
    } else {
      if (axis === undefined) axis = this.inferAxis(point, axes);
      if (axis !== undefined) {
        offset.copy(axes[axis]).multiplyScalar(closestOnLine(ray, this.from, axes[axis]));
      } else {
        // Свободно — по горизонтальной плоскости через точку захвата
        const hit = ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -this.from.z), new THREE.Vector3());
        if (hit) offset.subVectors(hit, this.from).setZ(0);
      }
    }
    this.axis = axis;
    if (this.shiftLock && this.locked === undefined && axis !== undefined) this.locked = axis;
    this.offset.copy(offset);
    this.layer.setMovePreview([...this.keys], offset);
    this.layer.setMoveGuide({ from: this.from, to: this.from.clone().add(offset), axis, locked: this.locked });
    this.updateVcb();
  }

  /** true — клавиша обработана инструментом. */
  key(e: KeyboardEvent): boolean {
    if (!this.active) return false;
    if (e.key === 'Escape') {
      if (this.state === 'move') { this.cancelMove(); this.state = 'pick'; this.start([...this.keys]); }
      else this.stop();
      return true;
    }
    if (this.state !== 'move') return false;
    if (e.type === 'keyup') {
      if (e.key === 'Shift') { this.shiftLock = false; if (!this.arrowLock) this.locked = undefined; this.refresh(); return true; }
      return false;
    }
    if (e.key === 'Shift') {
      if (e.repeat) return true;
      this.shiftLock = true;
      if (this.axis !== undefined) this.locked = this.axis;
      this.refresh();
      return true;
    }
    const arrows: Record<string, Axis | null> = { ArrowRight: 0, ArrowLeft: 1, ArrowUp: 2, ArrowDown: null };
    if (e.key in arrows) {
      const a = arrows[e.key];
      this.locked = a === null || this.locked === a ? undefined : a;
      this.arrowLock = this.locked !== undefined;
      this.refresh();
      return true;
    }
    if (/^[\d.,-]$/.test(e.key)) { this.typed += e.key === ',' ? '.' : e.key; this.updateVcb(); return true; }
    if (e.key === 'Backspace') { this.typed = this.typed.slice(0, -1); this.updateVcb(); return true; }
    if (e.key === 'Enter') {
      const dist = Number(this.typed);
      if (!this.typed || !Number.isFinite(dist)) return true;
      const axes = this.axes()!;
      // Направление — ось (в сторону курсора) или текущее направление движения
      let dir: THREE.Vector3;
      if (this.axis !== undefined) dir = axes[this.axis].clone().multiplyScalar(this.offset.dot(axes[this.axis]) < 0 ? -1 : 1);
      else if (this.offset.lengthSq() > 1e-6) dir = this.offset.clone().normalize();
      else return true;
      this.apply(dir.multiplyScalar(dist));
      return true;
    }
    return false;
  }

  private refresh() {
    if (this.lastPoint) this.move(this.lastPoint);
  }

  private apply(offset: THREE.Vector3) {
    const keys = [...this.keys];
    this.cancelMove();
    this.state = 'pick';
    if (offset.lengthSq() > 1e-8) this.commit(keys, offset.clone());
    this.start(keys);
  }

  private cancelMove() {
    if (this.state === 'move') this.layer.setMovePreview([...this.keys], undefined);
    this.layer.setMoveGuide(undefined);
    this.snap = undefined;
    this.typed = '';
    this.shiftLock = this.arrowLock = false;
    this.locked = undefined;
    this.vcb.hidden = true;
  }

  private axes(): [THREE.Vector3, THREE.Vector3, THREE.Vector3] | undefined {
    const f = this.layer.focusAxes;
    if (!f) return;
    return [new THREE.Vector3(f.x[0], f.x[1], 0), new THREE.Vector3(f.y[0], f.y[1], 0), new THREE.Vector3(0, 0, 1)];
  }

  /** Ось, вдоль которой (на экране) идёт курсор от точки захвата, с допуском AXIS_SNAP_DEG. */
  private inferAxis(point: [number, number], axes: THREE.Vector3[]): Axis | undefined {
    const s0 = this.layer.focusProject(this.from);
    if (!s0) return;
    const cx = point[0] - s0[0], cy = point[1] - s0[1];
    const len = Math.hypot(cx, cy);
    if (len < MIN_DRAG_PX) return;
    let best: { axis: Axis; angle: number } | undefined;
    axes.forEach((a, i) => {
      const s1 = this.layer.focusProject(this.from.clone().addScaledVector(a, 5));
      if (!s1) return;
      const dx = s1[0] - s0[0], dy = s1[1] - s0[1];
      const l = Math.hypot(dx, dy);
      if (l < 1) return; // ось смотрит в камеру — по экрану вдоль неё не потянешь
      const angle = Math.acos(Math.min(1, Math.abs((cx * dx + cy * dy) / (len * l)))) * 180 / Math.PI;
      if (!best || angle < best.angle) best = { axis: i as Axis, angle };
    });
    return best && best.angle < AXIS_SNAP_DEG ? best.axis : undefined;
  }

  private updateVcb() {
    if (this.state !== 'move') { this.vcb.hidden = true; return; }
    this.vcb.hidden = false;
    const along = this.locked !== undefined ? `ось ${AXIS_NAMES[this.locked]} (зафиксирована)`
      : this.axis !== undefined ? `ось ${AXIS_NAMES[this.axis]}` : 'свободно';
    const value = this.typed || this.offset.length().toFixed(2);
    this.vcb.innerHTML = `<span class="vcb-label">Расстояние</span><span class="vcb-value${this.typed ? ' typed' : ''}">${value}</span> м
      <span class="vcb-axis">${this.snap ? `к точке · ${along}` : along}</span>`;
  }
}

/** Параметр t ближайшей к лучу точки прямой from + t·dir (dir единичный). */
function closestOnLine(ray: THREE.Ray, from: THREE.Vector3, dir: THREE.Vector3): number {
  const w0 = ray.origin.clone().sub(from);
  const b = ray.direction.dot(dir), d = ray.direction.dot(w0), e = dir.dot(w0);
  const denom = 1 - b * b;
  if (denom < 1e-6) return 0;
  return (e - b * d) / denom;
}

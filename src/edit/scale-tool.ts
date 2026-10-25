import * as THREE from 'three';
import type { BuildingsLayer, SnapHit } from '../render/buildings-layer';
import type { UnderlayTarget } from './underlay-target';
import { linkedNote, type LinkPreview, glueClick, glueSwitch, isGlueKey, loadGlue, saveGlue } from './glue';
import { tr } from '../i18n';

export type ScaleMode = 'factor' | 'points';
const MODE_STORAGE = 'scale-mode';
/** Меньше этого множитель не бывает (иначе объект схлопнется в точку). */
const MIN_FACTOR = 0.01;
const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);

/**
 * Инструмент «Масштаб» (как Scale в SketchUp), в режиме одного здания: в рабочей плоскости. С частями здания —
 * в плане (высоты не меняются); одни подложки — в плоскости картинки под первым кликом (у стоящей — в её плоскости),
 * только равномерно.
 * Режим «множитель»:
 * 1. клик — базовая точка (неподвижная);
 * 2. клик — опорная точка: отрезок от базы до неё — длина «×1»;
 * 3. движение курсора — множитель: проекция курсора на направление отрезка, делённая на его длину; Shift — только
 *    вдоль оси здания, ближайшей к отрезку; клик — применить; число (или 150%) + Enter — множитель.
 * Режим «по двум точкам» (как у подложек): клик — точка на объекте, клик — куда её поставить, затем так же вторая
 * точка; объект переносится, поворачивается и масштабируется так, чтобы обе точки встали на места (Shift — без поворота).
 * Tab — режим, D — общие с соседями узлы: тянуть соседей следом или отделить часть. Esc — отмена.
 */
export class ScaleTool {
  state: 'off' | 'base' | 'ref' | 'scale' | 'src1' | 'dst1' | 'src2' | 'dst2' = 'off';
  keys = new Set<string>();
  /** Выделенные подложки (id) — масштабируются вместе с объектами. */
  underlayIds = new Set<string>();
  underlays?: UnderlayTarget;
  snap?: SnapHit;
  mode: ScaleMode = loadMode();
  glue = loadGlue();
  /** Рабочая плоскость: начало, оси e1, e2 и нормаль; точки ниже — в её координатах. */
  private o = new THREE.Vector3();
  private e1 = X.clone();
  private e2 = Y.clone();
  private n = Z.clone();
  private base = new THREE.Vector2();
  private ref = new THREE.Vector2();
  private src1 = new THREE.Vector2();
  private dst1 = new THREE.Vector2();
  private src2 = new THREE.Vector2();
  private factor = 1;
  private angle = 0;
  /** Ось здания, вдоль которой масштаб при Shift (единичный вектор в плане). */
  private axis?: THREE.Vector2;
  private matrix?: THREE.Matrix4;
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
    /**
     * Применить преобразование m (метры сцены) к keys — в плане (z не трогает) — и к подложкам underlays;
     * glue — тянуть соседей следом.
     */
    private readonly commit: (keys: string[], m: THREE.Matrix4, glue: boolean, underlays: string[]) => void,
    private readonly onState: (hint: string) => void,
  ) {
    this.vcb = document.createElement('div');
    this.vcb.className = 'vcb';
    this.vcb.hidden = true;
    container.appendChild(this.vcb);
    this.vcb.addEventListener('mousedown', (e) => e.stopPropagation());
    this.vcb.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const m = t.closest<HTMLElement>('[data-scale-mode]')?.dataset.scaleMode as ScaleMode | undefined;
      if (m) this.setMode(m);
      const g = glueClick(e);
      if (g !== undefined) this.setGlue(g);
    });
  }

  get active() { return this.state !== 'off'; }
  /** Посреди действия (точка уже выбрана). */
  get busy() { return this.state !== 'off' && this.state !== 'base' && this.state !== 'src1'; }

  start(keys: string[], underlays: string[] = []) {
    this.keys = new Set(keys);
    this.underlayIds = new Set(underlays);
    this.glue = loadGlue();
    this.state = this.mode === 'factor' ? 'base' : 'src1';
    this.onState(this.mode === 'factor'
      ? tr('Масштаб: кликните базовую точку — она останется на месте. Tab — по двум точкам, Esc — выйти.')
      : tr('Масштаб по двум точкам: кликните первую точку на объекте. Tab — множителем, Esc — выйти.'));
    this.updateVcb();
  }

  stop() {
    this.cancel();
    this.state = 'off';
    this.keys = new Set();
    this.underlayIds = new Set();
    this.vcb.hidden = true;
    this.onState('');
  }

  setMode(m: ScaleMode) {
    if (m === this.mode) return;
    this.mode = m;
    try { localStorage.setItem(MODE_STORAGE, m); } catch { /* без хранилища — до перезагрузки */ }
    if (!this.active) return;
    this.cancel();
    this.start([...this.keys], [...this.underlayIds]);
  }

  setGlue(on: boolean) {
    this.glue = on;
    saveGlue(on);
    if (this.lastPoint && this.busy) this.preview(this.lastPoint);
    this.updateVcb();
  }

  click(point: [number, number]) {
    const first = this.state === 'base' || this.state === 'src1';
    const p = this.pointAt(point, this.moving() ? (k) => !this.keys.has(k) : undefined);
    if (!p) return;
    if (first) this.choosePlane(point, p);
    const q = this.to2(p);
    switch (this.state) {
      case 'base':
        this.base.copy(q);
        this.state = 'ref';
        this.onState(tr('Кликните опорную точку: отрезок от базы до неё — исходная длина (×1). Esc — отмена.'));
        break;
      case 'ref':
        if (q.distanceTo(this.base) < 1e-3) return;
        this.ref.copy(q);
        this.factor = 1;
        this.axis = undefined;
        this.state = 'scale';
        this.onState(this.underlayIds.size
          ? tr('Ведите курсор вдоль отрезка — множитель. Клик — применить, число или 150% + Enter — множитель, Esc — отмена.')
          : tr('Ведите курсор вдоль отрезка — множитель (Shift — только вдоль оси здания). Клик — применить, число или 150% + Enter — множитель, Esc — отмена.'));
        break;
      case 'scale':
        if (this.matrix) this.apply();
        return;
      case 'src1':
        this.src1.copy(q);
        this.state = 'dst1';
        this.onState(tr('Кликните, куда поставить первую точку. Esc — отмена.'));
        break;
      case 'dst1':
        this.dst1.copy(q);
        this.state = 'src2';
        this.show(undefined);
        this.onState(tr('Кликните вторую точку на объекте. Esc — отмена.'));
        break;
      case 'src2':
        if (q.distanceTo(this.src1) < 1e-3) return;
        this.src2.copy(q);
        this.state = 'dst2';
        this.onState(tr('Кликните, куда поставить вторую точку (Shift — без поворота). Esc — отмена.'));
        break;
      case 'dst2':
        if (this.matrix) this.apply();
        return;
      default:
        return;
    }
    this.preview(point);
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
      if (this.state === 'base' || this.state === 'src1') this.stop();
      else { this.cancel(); this.start([...this.keys], [...this.underlayIds]); }
      return true;
    }
    if (e.key === 'Tab') { this.setMode(this.mode === 'factor' ? 'points' : 'factor'); return true; }
    if (isGlueKey(e) && this.keys.size) { this.setGlue(!this.glue); return true; }
    if (this.state !== 'scale') return false;
    if (/^[\d.,%]$/.test(e.key)) { this.typed += e.key === ',' ? '.' : e.key; this.updateVcb(); return true; }
    if (e.key === 'Backspace') { this.typed = this.typed.slice(0, -1); this.updateVcb(); return true; }
    if (e.key === 'Enter') {
      const pct = this.typed.endsWith('%');
      const k = Number(pct ? this.typed.slice(0, -1) : this.typed) / (pct ? 100 : 1);
      if (this.typed && Number.isFinite(k) && k >= MIN_FACTOR) {
        this.factor = k;
        this.matrix = this.lift(this.factorMatrix(k));
        this.apply();
      }
      return true;
    }
    return false;
  }

  /** Ведём точку к цели (свои объекты не притягивают). */
  private moving() { return this.state === 'scale' || this.state === 'dst1' || this.state === 'dst2'; }

  /**
   * Рабочая плоскость по первому клику: одни подложки и клик по наклонной (стоящей) картинке — её плоскость
   * (e1 — по горизонтали, e2 — вверх по ней); иначе — горизонтальная через точку.
   */
  private choosePlane(point: [number, number], p: THREE.Vector3) {
    const h = !this.keys.size && this.underlayIds.size ? this.underlays?.hit(this.snap?.point ?? point, this.underlayIds) : undefined;
    if (h && Math.abs(h.n.z) < 0.999) {
      this.n.copy(h.n).normalize();
      this.e1.crossVectors(Z, this.n).normalize();
      this.e2.crossVectors(this.n, this.e1);
      this.o.copy(p);
    } else {
      this.n.copy(Z); this.e1.copy(X); this.e2.copy(Y);
      this.o.set(0, 0, p.z);
    }
  }

  private to2(p: THREE.Vector3) {
    const d = p.clone().sub(this.o);
    return new THREE.Vector2(d.dot(this.e1), d.dot(this.e2));
  }

  private from2(v: THREE.Vector2) {
    return this.o.clone().addScaledVector(this.e1, v.x).addScaledVector(this.e2, v.y);
  }

  /** Плоское (2D, в координатах плоскости) преобразование — в метры сцены; по нормали плоскости ничего не меняет. */
  private lift(m: THREE.Matrix3): THREE.Matrix4 {
    const e = m.elements; // по столбцам
    const m4 = new THREE.Matrix4().set(e[0], e[3], 0, e[6], e[1], e[4], 0, e[7], 0, 0, 1, 0, 0, 0, 0, 1);
    const b = new THREE.Matrix4().makeBasis(this.e1, this.e2, this.n).setPosition(this.o);
    return b.clone().multiply(m4).multiply(b.invert());
  }

  /**
   * Точка под курсором: привязка (при выборе точек на объекте — и подложек), поверхность объекта или подложки,
   * рабочая плоскость (до первого клика — земля). После первого клика — проекция на рабочую плоскость.
   */
  private pointAt(point: [number, number], filter?: (k: string) => boolean): THREE.Vector3 | undefined {
    const first = this.state === 'base' || this.state === 'src1';
    const onObject = first || this.state === 'ref' || this.state === 'src2';
    const ids = onObject && this.underlayIds.size ? this.underlayIds : undefined;
    this.snap = this.layer.snapAt(point, filter) ?? (ids ? this.underlays?.snap(point, ids) : undefined);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(this.n, this.o);
    if (this.snap) return first ? this.snap.local.clone() : plane.projectPoint(this.snap.local, new THREE.Vector3());
    if (first) {
      const hit = this.layer.focusRayHits(point)[0]?.local ?? (ids ? this.underlays?.hit(point, ids)?.p : undefined);
      if (hit) return hit.clone();
    }
    const ray = this.layer.focusRay(point);
    if (first) return ray?.intersectPlane(new THREE.Plane(Z, 0), new THREE.Vector3()) ?? undefined;
    return ray?.intersectPlane(plane, new THREE.Vector3()) ?? undefined;
  }

  private preview(point: [number, number]) {
    const p3 = this.pointAt(point, this.moving() ? (k) => !this.keys.has(k) : undefined);
    if (this.state === 'base' || this.state === 'src1' || !p3) return;
    const p = this.to2(p3);
    const at = (v: THREE.Vector2) => this.from2(v);
    if (this.state === 'ref') {
      this.layer.setDrawPreview([at(this.base), at(p)]);
      return;
    }
    if (this.state === 'scale') {
      const d = p.clone().sub(this.base);
      const r = this.ref.clone().sub(this.base);
      // Вдоль оси — только у частей здания (подложка масштабируется равномерно)
      this.axis = this.shift && !this.underlayIds.size ? this.nearestAxis(r) : undefined;
      const dir = (this.axis ?? r).clone().normalize();
      if (r.dot(dir) < 0) dir.negate();
      const len = r.dot(dir);
      const k = d.dot(dir) / len;
      this.factor = Math.max(MIN_FACTOR, Number.isFinite(k) ? k : 1);
      this.matrix = this.lift(this.factorMatrix(this.factor));
      const end = this.base.clone().addScaledVector(dir, len * this.factor);
      this.layer.setDrawPreview([at(this.ref), at(this.base), at(end)], false, true);
      this.show(this.matrix);
      this.updateVcb();
      return;
    }
    if (this.state === 'dst1') {
      this.matrix = this.lift(new THREE.Matrix3().makeTranslation(p.x - this.src1.x, p.y - this.src1.y));
      this.layer.setDrawPreview([at(this.src1), at(p)]);
      this.show(this.matrix);
      return;
    }
    if (this.state === 'src2') {
      this.layer.setDrawPreview([at(this.src1), at(this.dst1), at(p)], false, true);
      return;
    }
    // dst2: подобие, переводящее src1 → dst1 и src2 → курсор
    const vx = this.src2.x - this.src1.x, vy = this.src2.y - this.src1.y;
    const wx = p.x - this.dst1.x, wy = p.y - this.dst1.y;
    const vv = vx * vx + vy * vy;
    let a = (vx * wx + vy * wy) / vv, b = (vx * wy - vy * wx) / vv;
    if (this.shift) { a = Math.hypot(a, b); b = 0; }
    this.factor = Math.hypot(a, b);
    this.angle = Math.atan2(b, a);
    if (this.factor < MIN_FACTOR) { this.matrix = undefined; return; }
    const tx = this.dst1.x - (a * this.src1.x - b * this.src1.y), ty = this.dst1.y - (b * this.src1.x + a * this.src1.y);
    const m2 = new THREE.Matrix3().set(a, -b, tx, b, a, ty, 0, 0, 1);
    this.matrix = this.lift(m2);
    const end = this.src2.clone().applyMatrix3(m2);
    this.layer.setDrawPreview([at(this.src1), at(this.src2), at(this.dst1), at(end)], false, true);
    this.show(this.matrix);
    this.updateVcb();
  }

  /** Превью: соседи (если тянутся), затем сами объекты и подложки; undefined — вернуть как было. */
  private show(m: THREE.Matrix4 | undefined) {
    if (this.keys.size) {
      this.linked = this.linkPreview?.([...this.keys], m, this.glue) ?? 0;
      this.layer.setMatrixPreview([...this.keys], m);
    }
    if (this.underlayIds.size) this.underlays?.preview(this.underlayIds, m);
  }

  /** Масштаб k от базы (в координатах плоскости): равномерно или (Shift) только вдоль оси this.axis. */
  private factorMatrix(k: number): THREE.Matrix3 {
    const u = this.axis;
    const s = u
      ? new THREE.Matrix3().set(1 + (k - 1) * u.x * u.x, (k - 1) * u.x * u.y, 0, (k - 1) * u.x * u.y, 1 + (k - 1) * u.y * u.y, 0, 0, 0, 1)
      : new THREE.Matrix3().makeScale(k, k);
    return new THREE.Matrix3().makeTranslation(this.base.x, this.base.y).multiply(s).multiply(new THREE.Matrix3().makeTranslation(-this.base.x, -this.base.y));
  }

  /** Ось здания (x или y), ближайшая по направлению к r; без осей — само r. */
  private nearestAxis(r: THREE.Vector2): THREE.Vector2 {
    const f = this.layer.focusAxes;
    if (!f) return r.clone().normalize();
    const x = new THREE.Vector2(...f.x), y = new THREE.Vector2(...f.y);
    return Math.abs(r.dot(x)) >= Math.abs(r.dot(y)) ? x : y;
  }

  private apply() {
    const keys = [...this.keys], underlays = [...this.underlayIds];
    const m = this.matrix!.clone();
    const glue = this.glue;
    this.cancel();
    this.commit(keys, m, glue, underlays);
    this.start(keys, underlays);
  }

  private cancel() {
    this.show(undefined);
    this.layer.setDrawPreview(undefined);
    this.snap = undefined;
    this.matrix = undefined;
    this.typed = '';
    this.factor = 1;
    this.angle = 0;
    this.axis = undefined;
  }

  private updateVcb() {
    if (!this.active) { this.vcb.hidden = true; return; }
    this.vcb.hidden = false;
    const modes = `<span class="vcb-units" title="${tr('Способ масштабирования (Tab)')}">${(['factor', 'points'] as const)
      .map((m) => `<button type="button" data-scale-mode="${m}"${m === this.mode ? ' class="active"' : ''}>${m === 'factor' ? tr('множитель') : tr('по двум точкам')}</button>`).join('')}</span>`;
    // Только подложки — соседей нет
    const glue = this.keys.size ? glueSwitch(this.glue, tr('Общие с соседями узлы: «с соседями» — соседи тянутся следом, «отдельно» — часть отделяется от них (D)')) : '';
    let value = '';
    if (this.state === 'scale') {
      const along = this.axis ? tr('вдоль оси здания (Shift)') : this.snap ? tr('привязка') : tr('равномерно');
      value = `<span class="vcb-value${this.typed ? ' typed' : ''}">${this.typed || '×' + fmt(this.factor)}</span><span class="vcb-axis">${along}</span>`;
    } else if (this.state === 'dst2') {
      value = `<span class="vcb-value">×${fmt(this.factor)}</span><span class="vcb-axis">${this.shift ? tr('без поворота (Shift)') : tr('поворот {deg}°', { deg: ((this.angle * 180) / Math.PI).toFixed(1) })}</span>`;
    }
    this.vcb.innerHTML = `<span class="vcb-label">${tr('Масштаб')}</span>${value}${this.keys.size && this.glue ? linkedNote(this.linked) : ''}${modes}${glue}`;
  }
}

const fmt = (k: number) => String(Math.round(k * 1000) / 1000);

function loadMode(): ScaleMode {
  try { return localStorage.getItem(MODE_STORAGE) === 'points' ? 'points' : 'factor'; } catch { return 'factor'; }
}


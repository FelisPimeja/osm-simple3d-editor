import * as THREE from 'three';
import type { BuildingsLayer, SnapHit } from '../render/buildings-layer';
import { linkedNote, type LinkPreview, glueClick, glueSwitch, isGlueKey, loadGlue, saveGlue } from './glue';
import { tr } from '../i18n';

export type ScaleMode = 'factor' | 'points';
const MODE_STORAGE = 'scale-mode';
/** Меньше этого множитель не бывает (иначе объект схлопнется в точку). */
const MIN_FACTOR = 0.01;

/**
 * Инструмент «Масштаб» (как Scale в SketchUp), только в плане — высоты не меняются; в режиме одного здания.
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
  snap?: SnapHit;
  mode: ScaleMode = loadMode();
  glue = loadGlue();
  private base = new THREE.Vector3();
  private ref = new THREE.Vector3();
  private src1 = new THREE.Vector3();
  private dst1 = new THREE.Vector3();
  private src2 = new THREE.Vector3();
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
    /** Применить к keys плановое преобразование m (метры сцены, z не трогает); glue — тянуть соседей следом. */
    private readonly commit: (keys: string[], m: THREE.Matrix4, glue: boolean) => void,
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

  start(keys: string[]) {
    this.keys = new Set(keys);
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
    this.vcb.hidden = true;
    this.onState('');
  }

  setMode(m: ScaleMode) {
    if (m === this.mode) return;
    this.mode = m;
    try { localStorage.setItem(MODE_STORAGE, m); } catch { /* без хранилища — до перезагрузки */ }
    if (!this.active) return;
    this.cancel();
    this.start([...this.keys]);
  }

  setGlue(on: boolean) {
    this.glue = on;
    saveGlue(on);
    if (this.lastPoint && this.busy) this.preview(this.lastPoint);
    this.updateVcb();
  }

  click(point: [number, number]) {
    const p = this.pointAt(point, this.state === 'scale' || this.state === 'dst1' || this.state === 'dst2' ? (k) => !this.keys.has(k) : undefined);
    switch (this.state) {
      case 'base':
        if (!p) return;
        this.base.copy(p);
        this.state = 'ref';
        this.onState(tr('Кликните опорную точку: отрезок от базы до неё — исходная длина (×1). Esc — отмена.'));
        break;
      case 'ref':
        if (!p || Math.hypot(p.x - this.base.x, p.y - this.base.y) < 1e-3) return;
        this.ref.set(p.x, p.y, this.base.z);
        this.factor = 1;
        this.axis = undefined;
        this.state = 'scale';
        this.onState(tr('Ведите курсор вдоль отрезка — множитель (Shift — только вдоль оси здания). Клик — применить, число или 150% + Enter — множитель, Esc — отмена.'));
        break;
      case 'scale':
        if (this.matrix) this.apply();
        return;
      case 'src1':
        if (!p) return;
        this.src1.copy(p);
        this.state = 'dst1';
        this.onState(tr('Кликните, куда поставить первую точку. Esc — отмена.'));
        break;
      case 'dst1':
        if (!p) return;
        this.dst1.set(p.x, p.y, this.src1.z);
        this.state = 'src2';
        this.show(undefined);
        this.onState(tr('Кликните вторую точку на объекте. Esc — отмена.'));
        break;
      case 'src2':
        if (!p || Math.hypot(p.x - this.src1.x, p.y - this.src1.y) < 1e-3) return;
        this.src2.copy(p);
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
      else { this.cancel(); this.start([...this.keys]); }
      return true;
    }
    if (e.key === 'Tab') { this.setMode(this.mode === 'factor' ? 'points' : 'factor'); return true; }
    if (isGlueKey(e)) { this.setGlue(!this.glue); return true; }
    if (this.state !== 'scale') return false;
    if (/^[\d.,%]$/.test(e.key)) { this.typed += e.key === ',' ? '.' : e.key; this.updateVcb(); return true; }
    if (e.key === 'Backspace') { this.typed = this.typed.slice(0, -1); this.updateVcb(); return true; }
    if (e.key === 'Enter') {
      const pct = this.typed.endsWith('%');
      const k = Number(pct ? this.typed.slice(0, -1) : this.typed) / (pct ? 100 : 1);
      if (this.typed && Number.isFinite(k) && k >= MIN_FACTOR) {
        this.factor = k;
        this.matrix = this.factorMatrix(k);
        this.apply();
      }
      return true;
    }
    return false;
  }

  /** Точка под курсором: привязка, поверхность объекта или горизонтальная плоскость через первую точку. */
  private pointAt(point: [number, number], filter?: (k: string) => boolean): THREE.Vector3 | undefined {
    this.snap = this.layer.snapAt(point, filter);
    if (this.snap) return this.snap.local.clone();
    const first = this.state === 'base' || this.state === 'src1' || this.state === 'src2';
    if (first) {
      const hit = this.layer.focusRayHits(point)[0];
      if (hit) return hit.local.clone();
    }
    const ray = this.layer.focusRay(point);
    const z = this.state === 'base' || this.state === 'src1' ? 0 : this.mode === 'factor' ? this.base.z : this.src1.z;
    return ray?.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -z), new THREE.Vector3()) ?? undefined;
  }

  private preview(point: [number, number]) {
    const moving = this.state === 'scale' || this.state === 'dst1' || this.state === 'dst2';
    const p = this.pointAt(point, moving ? (k) => !this.keys.has(k) : undefined);
    if (this.state === 'base' || this.state === 'src1' || !p) return;
    const at = (v: THREE.Vector3, z: number) => new THREE.Vector3(v.x, v.y, z);
    if (this.state === 'ref') {
      this.layer.setDrawPreview([this.base.clone(), at(p, this.base.z)]);
      return;
    }
    if (this.state === 'scale') {
      const d = new THREE.Vector2(p.x - this.base.x, p.y - this.base.y);
      const r = new THREE.Vector2(this.ref.x - this.base.x, this.ref.y - this.base.y);
      this.axis = this.shift ? this.nearestAxis(r) : undefined;
      const dir = (this.axis ?? r).clone().normalize();
      if (r.dot(dir) < 0) dir.negate();
      const len = r.dot(dir);
      const k = d.dot(dir) / len;
      this.factor = Math.max(MIN_FACTOR, Number.isFinite(k) ? k : 1);
      this.matrix = this.factorMatrix(this.factor);
      const z = this.base.z;
      const end = new THREE.Vector3(this.base.x + dir.x * len * this.factor, this.base.y + dir.y * len * this.factor, z);
      this.layer.setDrawPreview([at(this.ref, z), this.base.clone(), end], false, true);
      this.show(this.matrix);
      this.updateVcb();
      return;
    }
    if (this.state === 'dst1') {
      this.matrix = new THREE.Matrix4().makeTranslation(p.x - this.src1.x, p.y - this.src1.y, 0);
      this.layer.setDrawPreview([this.src1.clone(), at(p, this.src1.z)]);
      this.show(this.matrix);
      return;
    }
    if (this.state === 'src2') {
      this.layer.setDrawPreview([this.src1.clone(), this.dst1.clone(), at(p, this.dst1.z)], false, true);
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
    this.matrix = new THREE.Matrix4().set(a, -b, 0, tx, b, a, 0, ty, 0, 0, 1, 0, 0, 0, 0, 1);
    const end = this.src2.clone().applyMatrix4(this.matrix);
    this.layer.setDrawPreview([this.src1.clone(), this.src2.clone(), this.dst1.clone(), end], false, true);
    this.show(this.matrix);
    this.updateVcb();
  }

  /** Превью: соседи (если тянутся), затем сами объекты; undefined — вернуть как было. */
  private show(m: THREE.Matrix4 | undefined) {
    this.linked = this.linkPreview?.([...this.keys], m, this.glue) ?? 0;
    this.layer.setMatrixPreview([...this.keys], m);
  }

  /** Масштаб k от базы: равномерно или (Shift) только вдоль оси this.axis. */
  private factorMatrix(k: number): THREE.Matrix4 {
    const u = this.axis;
    const s = u
      ? new THREE.Matrix4().set(1 + (k - 1) * u.x * u.x, (k - 1) * u.x * u.y, 0, 0, (k - 1) * u.x * u.y, 1 + (k - 1) * u.y * u.y, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)
      : new THREE.Matrix4().makeScale(k, k, 1);
    return new THREE.Matrix4().makeTranslation(this.base.x, this.base.y, 0).multiply(s).multiply(new THREE.Matrix4().makeTranslation(-this.base.x, -this.base.y, 0));
  }

  /** Ось здания (x или y), ближайшая по направлению к r; без осей — само r. */
  private nearestAxis(r: THREE.Vector2): THREE.Vector2 {
    const f = this.layer.focusAxes;
    if (!f) return r.clone().normalize();
    const x = new THREE.Vector2(...f.x), y = new THREE.Vector2(...f.y);
    return Math.abs(r.dot(x)) >= Math.abs(r.dot(y)) ? x : y;
  }

  private apply() {
    const keys = [...this.keys];
    const m = this.matrix!.clone();
    const glue = this.glue;
    this.cancel();
    this.commit(keys, m, glue);
    this.start(keys);
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
    const glue = glueSwitch(this.glue, tr('Общие с соседями узлы: «с соседями» — соседи тянутся следом, «отдельно» — часть отделяется от них (D)'));
    let value = '';
    if (this.state === 'scale') {
      const along = this.axis ? tr('вдоль оси здания (Shift)') : this.snap ? tr('привязка') : tr('равномерно');
      value = `<span class="vcb-value${this.typed ? ' typed' : ''}">${this.typed || '×' + fmt(this.factor)}</span><span class="vcb-axis">${along}</span>`;
    } else if (this.state === 'dst2') {
      value = `<span class="vcb-value">×${fmt(this.factor)}</span><span class="vcb-axis">${this.shift ? tr('без поворота (Shift)') : tr('поворот {deg}°', { deg: ((this.angle * 180) / Math.PI).toFixed(1) })}</span>`;
    }
    this.vcb.innerHTML = `<span class="vcb-label">${tr('Масштаб')}</span>${value}${this.glue ? linkedNote(this.linked) : ''}${modes}${glue}`;
  }
}

const fmt = (k: number) => String(Math.round(k * 1000) / 1000);

function loadMode(): ScaleMode {
  try { return localStorage.getItem(MODE_STORAGE) === 'points' ? 'points' : 'factor'; } catch { return 'factor'; }
}


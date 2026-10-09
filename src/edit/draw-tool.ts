import * as THREE from 'three';
import type { BuildingsLayer, SnapHit } from '../render/buildings-layer';

type Pt = [number, number];

export type DrawShape = 'polygon' | 'rect';
/** Способ построения прямоугольника: по двум углам вдоль осей здания, по трём точкам (повёрнутый), от центра. */
export type RectMode = 'corners' | 'three' | 'center';

export const RECT_MODES: RectMode[] = ['corners', 'three', 'center'];
export const RECT_LABELS: Record<RectMode, string> = { corners: 'по двум углам', three: 'по трём точкам', center: 'от центра' };
/** Направление ребра ближе этого угла к оси здания — выравниваем по оси, градусы. */
const AXIS_LOCK_DEG = 3;
/** Клик ближе стольких px к первой точке замыкает полигон. */
const CLOSE_PX = 10;
/** Минимальная площадь контура, м². */
const MIN_AREA = 0.5;

/**
 * Инструменты «Прямоугольник» (R) и «Полигон» (L): плоский контур на земле или на плоской крыше части.
 * Плоскость — по первому клику (привязка или грань крыши под курсором, иначе земля). Точки — с привязкой
 * к вершинам и серединам, без привязки направление рядом с осью здания выравнивается по ней; Shift держит эту ось.
 * Число + Enter — длина текущей стороны (у прямоугольника по двум углам и от центра — «ширина;глубина»).
 * Полигон замыкается кликом в первую точку или Enter, Backspace убирает последнюю точку. Tab — способ
 * построения прямоугольника. Esc — отмена. Что делать с готовым контуром — решает commit снаружи.
 */
export class DrawTool {
  shape: DrawShape = 'polygon';
  rectMode: RectMode = 'corners';
  state: 'off' | 'draw' = 'off';
  snap?: SnapHit;
  private pts: Pt[] = [];
  private z = 0;
  private cursor?: Pt;
  private axis?: 0 | 1;
  /** Ось, зафиксированная Shift (пока зажат): точки только по ней от последней. */
  private locked?: 0 | 1;
  /** Shift на привязке «Продолжение»: точка идёт только по прямой этого ребра. */
  private lineLock?: SnapHit;
  private lastPoint?: [number, number];
  private typed = '';
  private readonly vcb: HTMLDivElement;
  /** Подписи длин сторон контура (HTML поверх карты). */
  private readonly dims: HTMLDivElement;
  /** Стороны для подписей: точки контура, замкнут ли он, какая сторона — текущая (тянется курсором). */
  private dimRing?: { pts: Pt[]; closed: boolean; current?: number };

  constructor(
    private readonly layer: BuildingsLayer,
    container: HTMLElement,
    /** Готовый контур (метры сцены, плоскость z); строка — ошибка, контур остаётся для правки. */
    private readonly commit: (ring: Pt[], z: number) => string | undefined,
    private readonly onState: (hint: string, error?: boolean) => void,
  ) {
    this.vcb = document.createElement('div');
    this.vcb.className = 'vcb';
    this.vcb.hidden = true;
    container.appendChild(this.vcb);
    this.dims = document.createElement('div');
    this.dims.className = 'draw-dims';
    container.appendChild(this.dims);
  }

  get active() { return this.state !== 'off'; }

  begin(shape: DrawShape) {
    this.reset();
    this.shape = shape;
    this.state = 'draw';
    this.hint();
  }

  /** Сменить способ построения прямоугольника; первая точка остаётся (угол, начало стороны или центр). */
  setRectMode(mode: RectMode) {
    this.rectMode = mode;
    if (this.state !== 'draw' || this.shape !== 'rect') return;
    this.pts = this.pts.slice(0, 1);
    this.typed = '';
    if (this.lastPoint) this.move(this.lastPoint); else this.preview();
    this.hint();
  }

  stop() {
    this.reset();
    this.state = 'off';
    this.onState('');
  }

  click(point: [number, number]): boolean {
    if (this.state !== 'draw') return false;
    const q = this.pointAt(point);
    if (!q) return true;
    if (this.shape === 'polygon' && this.pts.length >= 3) {
      const first = this.layer.focusProject(new THREE.Vector3(this.pts[0][0], this.pts[0][1], this.z));
      if (first && Math.hypot(first[0] - point[0], first[1] - point[1]) < CLOSE_PX) { this.finish(this.pts); return true; }
    }
    this.add(q);
    return true;
  }

  move(point: [number, number]) {
    if (this.state !== 'draw') return;
    this.lastPoint = point;
    this.cursor = this.pointAt(point);
    this.preview();
  }

  key(e: KeyboardEvent): boolean {
    if (!this.active) return false;
    // Shift — держать текущую ось (как при перемещении): пока зажат, точка идёт только вдоль неё
    if (e.key === 'Shift') {
      if (e.type === 'keyup') { this.locked = undefined; this.lineLock = undefined; }
      // У привязки «Продолжение» Shift держит прямую этого ребра
      else if (!e.repeat && this.snap?.kind === 'extension' && this.snap.along) this.lineLock = { ...this.snap, local: this.snap.local.clone() };
      else if (!e.repeat && this.pts.length && this.axis !== undefined) this.locked = this.axis;
      else return true;
      if (this.lastPoint) this.move(this.lastPoint);
      return true;
    }
    if (e.type !== 'keydown') return false;
    if (e.key === 'Escape') {
      if (this.pts.length) { this.reset(); this.hint(); } else this.stop();
      return true;
    }
    if (e.key === 'Tab' && this.shape === 'rect') {
      this.setRectMode(RECT_MODES[(RECT_MODES.indexOf(this.rectMode) + 1) % RECT_MODES.length]);
      return true;
    }
    // «;» — по физической клавише (в русской раскладке там «ж»)
    const ch = e.code === 'Semicolon' ? ';' : e.key;
    if (/^[\d.,;-]$/.test(ch) && this.pts.length) {
      this.typed += ch === ',' ? '.' : ch;
      this.updateVcb();
      return true;
    }
    if (e.key === 'Backspace') {
      if (this.typed) this.typed = this.typed.slice(0, -1);
      else if (this.pts.length) { this.pts.pop(); if (!this.pts.length) this.hint(); }
      this.preview();
      return true;
    }
    if (e.key === 'Enter') {
      if (this.typed) this.applyTyped();
      else if (this.shape === 'polygon' && this.pts.length >= 3) this.finish(this.pts);
      return true;
    }
    return false;
  }

  /** Точка на плоскости рисования под курсором: привязка, иначе луч на плоскость (с выравниванием по оси). */
  private pointAt(point: [number, number]): Pt | undefined {
    if (this.lineLock) return this.onLine(point, this.lineLock);
    const last = this.pts[this.pts.length - 1];
    this.snap = this.layer.snapAt(point, undefined, undefined, { from: last && new THREE.Vector3(last[0], last[1], this.z) });
    if (this.snap?.kind === 'center') this.snap = undefined;
    this.axis = undefined;
    if (!this.pts.length) {
      // Плоскость — по первой точке: привязка, плоская крыша под курсором или земля
      if (this.snap) { this.z = this.snap.local.z; return [this.snap.local.x, this.snap.local.y]; }
      const hit = this.layer.focusRayHits(point)[0];
      this.z = hit?.face === 'roof' && this.flatAt(hit.key, hit.local.z) ? hit.local.z : 0;
      return this.planePoint(point);
    }
    if (this.locked !== undefined) {
      // Ось зафиксирована: точка привязки или курсора — проекцией на ось от последней точки
      const q = this.snap ? [this.snap.local.x, this.snap.local.y] as Pt : this.planePoint(point);
      if (!q) return;
      const ax = this.locked ? this.layer.focusAxes?.y ?? [0, 1] : this.layer.focusAxes?.x ?? [1, 0];
      const t = (q[0] - last[0]) * ax[0] + (q[1] - last[1]) * ax[1];
      this.axis = this.locked;
      return [last[0] + ax[0] * t, last[1] + ax[1] * t];
    }
    if (this.snap) return [this.snap.local.x, this.snap.local.y];
    const q = this.planePoint(point);
    if (!q) return;
    return this.lockAxis(this.pts[this.pts.length - 1], q);
  }

  /** Точка на зафиксированной прямой продолжения ребра: проекция привязки или курсора (на плоскости прямой). */
  private onLine(point: [number, number], lock: SnapHit): Pt | undefined {
    const a = lock.along!;
    const d = new THREE.Vector2(lock.local.x - a.x, lock.local.y - a.y);
    if (d.lengthSq() < 1e-8) return;
    d.normalize();
    this.z = lock.local.z;
    const s = this.layer.snapAt(point, undefined, undefined, {});
    const q = s && s.kind !== 'center' ? [s.local.x, s.local.y] as Pt : this.planePoint(point);
    if (!q) return;
    const t = (q[0] - a.x) * d.x + (q[1] - a.y) * d.y;
    const p = new THREE.Vector3(a.x + d.x * t, a.y + d.y * t, this.z);
    this.axis = undefined;
    // Маркер и пунктир — как у привязки «Продолжение», в новой точке
    this.snap = { ...lock, local: p, point: this.layer.focusProject(p) ?? lock.point };
    return [p.x, p.y];
  }

  /** Крыша объекта плоская на этой высоте (рисовать на скатах нельзя). */
  private flatAt(key: string, z: number): boolean {
    const box = this.layer.focusItemBox(key);
    return !!box && Math.abs(box.max.z - z) < 0.05;
  }

  private planePoint(point: [number, number]): Pt | undefined {
    const ray = this.layer.focusRay(point);
    if (!ray || Math.abs(ray.direction.z) < 1e-6) return;
    const t = (this.z - ray.origin.z) / ray.direction.z;
    if (t <= 0) return;
    const q = ray.at(t, new THREE.Vector3());
    return [q.x, q.y];
  }

  /** Направление от a к q почти вдоль оси здания — точно по оси. */
  private lockAxis(a: Pt, q: Pt): Pt {
    const f = this.layer.focusAxes;
    if (!f) return q;
    const d: Pt = [q[0] - a[0], q[1] - a[1]];
    const len = Math.hypot(d[0], d[1]);
    if (len < 1e-6) return q;
    for (const i of [0, 1] as const) {
      const ax = i ? f.y : f.x;
      const t = d[0] * ax[0] + d[1] * ax[1];
      if (Math.abs(t) / len > Math.cos(AXIS_LOCK_DEG * Math.PI / 180)) {
        this.axis = i;
        return [a[0] + ax[0] * t, a[1] + ax[1] * t];
      }
    }
    return q;
  }

  private add(q: Pt) {
    this.typed = '';
    // Двойной клик и повторный клик в ту же точку — не новая вершина
    const last = this.pts[this.pts.length - 1];
    if (last && Math.hypot(q[0] - last[0], q[1] - last[1]) < 0.01) return;
    this.pts.push(q);
    if (this.shape === 'rect') {
      const need = this.rectMode === 'three' ? 3 : 2;
      if (this.pts.length === need) { this.finish(this.rectRing(this.pts)!); return; }
    }
    this.hint();
    this.preview();
  }

  /** Прямоугольник по введённым точкам (последняя может быть курсором). */
  private rectRing(p: Pt[]): Pt[] | undefined {
    const f = this.layer.focusAxes;
    const ax: Pt = f?.x ?? [1, 0], ay: Pt = f?.y ?? [0, 1];
    const dot = (v: Pt, u: Pt) => v[0] * u[0] + v[1] * u[1];
    const at = (o: Pt, u: number, v: number, x: Pt = ax, y: Pt = ay): Pt => [o[0] + x[0] * u + y[0] * v, o[1] + x[1] * u + y[1] * v];
    if (this.rectMode === 'three') {
      if (p.length < 2) return;
      const [a, b] = p;
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (l < 1e-6) return;
      const x: Pt = [(b[0] - a[0]) / l, (b[1] - a[1]) / l], y: Pt = [-x[1], x[0]];
      if (p.length < 3) return [a, b];
      const w = dot([p[2][0] - b[0], p[2][1] - b[1]], y);
      return [a, b, at(b, 0, w, x, y), at(a, 0, w, x, y)];
    }
    if (p.length < 2) return;
    const [a, b] = p;
    const d: Pt = [b[0] - a[0], b[1] - a[1]];
    const u = dot(d, ax), v = dot(d, ay);
    if (this.rectMode === 'center') return [at(a, -u, -v), at(a, u, -v), at(a, u, v), at(a, -u, v)];
    return [a, at(a, u, 0), at(a, u, v), at(a, 0, v)];
  }

  /** Число + Enter: длина стороны (полигон, первая сторона по трём точкам) или «ширина;глубина». */
  private applyTyped() {
    const nums = this.typed.split(';').map(Number);
    this.typed = '';
    if (nums.some((n) => !Number.isFinite(n))) { this.updateVcb(); return; }
    const last = this.pts[this.pts.length - 1];
    const cur = this.cursor ?? last;
    const dir: Pt = [cur[0] - last[0], cur[1] - last[1]];
    const len = Math.hypot(dir[0], dir[1]);
    if (this.shape === 'rect' && this.rectMode !== 'three' || this.shape === 'rect' && this.pts.length === 2) {
      const f = this.layer.focusAxes;
      if (this.rectMode === 'three') {
        // Ширина повёрнутого прямоугольника: в сторону курсора
        const [a, b] = this.pts;
        const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const y: Pt = [-(b[1] - a[1]) / l, (b[0] - a[0]) / l];
        const s = Math.sign((cur[0] - b[0]) * y[0] + (cur[1] - b[1]) * y[1]) || 1;
        this.add([b[0] + y[0] * nums[0] * s, b[1] + y[1] * nums[0] * s]);
        return;
      }
      const ax: Pt = f?.x ?? [1, 0], ay: Pt = f?.y ?? [0, 1];
      const su = Math.sign(dir[0] * ax[0] + dir[1] * ax[1]) || 1, sv = Math.sign(dir[0] * ay[0] + dir[1] * ay[1]) || 1;
      const k = this.rectMode === 'center' ? 0.5 : 1;
      const u = nums[0] * k * su, v = (nums[1] ?? nums[0]) * k * sv;
      this.add([last[0] + ax[0] * u + ay[0] * v, last[1] + ax[1] * u + ay[1] * v]);
      return;
    }
    if (len < 1e-6) { this.onState('Укажите направление курсором, затем введите длину.', true); return; }
    this.add([last[0] + dir[0] / len * nums[0], last[1] + dir[1] / len * nums[0]]);
  }

  private finish(ring: Pt[]) {
    const err = validRing(ring);
    if (err) { this.onState(err, true); if (this.shape === 'rect') { this.pts.pop(); this.preview(); } return; }
    const fail = this.commit(ring, this.z);
    if (fail) { this.onState(fail, true); return; }
    this.reset();
    this.hint();
  }

  /** Подписи длин сторон у их середин на экране (и после движения камеры). */
  relabel() {
    const r = this.dimRing;
    if (!r || this.state !== 'draw') { this.dims.innerHTML = ''; return; }
    const n = r.closed ? r.pts.length : r.pts.length - 1;
    let html = '';
    for (let i = 0; i < n; i++) {
      const a = r.pts[i], b = r.pts[(i + 1) % r.pts.length];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 0.05) continue;
      const px = this.layer.focusProject(new THREE.Vector3((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, this.z));
      if (!px) continue;
      html += `<span class="draw-dim${i === r.current ? ' current' : ''}" style="left:${px[0].toFixed(1)}px;top:${px[1].toFixed(1)}px">${len.toFixed(2)} м</span>`;
    }
    this.dims.innerHTML = html;
  }

  private reset() {
    this.dimRing = undefined;
    this.dims.innerHTML = '';
    this.pts = [];
    this.cursor = undefined;
    this.snap = undefined;
    this.typed = '';
    this.locked = undefined;
    this.lineLock = undefined;
    this.layer.setDrawPreview(undefined);
    this.layer.setMoveGuide(undefined);
    this.vcb.hidden = true;
  }

  private preview() {
    const v = (p: Pt) => new THREE.Vector3(p[0], p[1], this.z);
    const pts = this.cursor ? [...this.pts, this.cursor] : this.pts;
    const ring = this.shape === 'rect' ? this.rectRing(pts) : pts;
    this.layer.setDrawPreview(ring?.map(v), this.shape === 'rect');
    // Размеры: у прямоугольника — ширина и глубина (две соседние стороны), у полигона — все стороны и тянущаяся
    this.dimRing = !ring || ring.length < 2 ? undefined
      : this.shape === 'rect' ? { pts: ring.length > 2 ? ring.slice(0, 3) : ring, closed: false }
      : { pts: ring, closed: false, current: this.cursor && this.pts.length ? ring.length - 2 : undefined };
    this.relabel();
    // Ось, по которой выровнено текущее ребро, — цветом оси
    const last = this.pts[this.pts.length - 1];
    if (last && this.cursor && this.axis !== undefined) this.layer.setMoveGuide({ from: v(last), to: v(this.cursor), axis: this.axis, locked: this.locked });
    else this.layer.setMoveGuide(undefined);
    this.updateVcb();
  }

  private updateVcb() {
    const last = this.pts[this.pts.length - 1];
    if (!last || !this.cursor) { this.vcb.hidden = true; return; }
    this.vcb.hidden = false;
    let label = 'Длина', value: string;
    if (this.shape === 'rect' && !(this.rectMode === 'three' && this.pts.length === 1)) {
      const r = this.rectRing([...this.pts, this.cursor]);
      const side = (i: number) => r && r.length === 4 ? Math.hypot(r[i + 1][0] - r[i][0], r[i + 1][1] - r[i][1]) : 0;
      label = this.rectMode === 'three' ? 'Ширина' : 'Размер';
      value = this.rectMode === 'three' ? side(1).toFixed(2) : `${side(0).toFixed(2)}; ${side(1).toFixed(2)}`;
    } else value = Math.hypot(this.cursor[0] - last[0], this.cursor[1] - last[1]).toFixed(2);
    this.vcb.innerHTML = `<span class="vcb-label">${label}</span><span class="vcb-value${this.typed ? ' typed' : ''}">${this.typed || value}</span> м
      <span class="vcb-axis">${this.snap ? 'привязка' : this.axis === 0 ? 'по оси X' : this.axis === 1 ? 'по оси Y' : ''}${this.locked !== undefined ? ' (Shift)' : ''}</span>`;
  }

  private hint() {
    if (this.shape === 'polygon') {
      this.onState(this.pts.length
        ? 'Следующая точка; клик в первую точку или Enter — замкнуть, число + Enter — длина стороны, Backspace — убрать точку, Esc — отмена.'
        : 'Полигон: кликните первую точку на земле или на плоской крыше. Esc — выйти.');
      return;
    }
    const mode = `Прямоугольник ${RECT_LABELS[this.rectMode]} (Tab — сменить способ)`;
    const step = this.rectMode === 'three'
      ? ['первая точка стороны', 'конец стороны (число + Enter — длина)', 'ширина (число + Enter)'][this.pts.length]
      : this.rectMode === 'center'
        ? ['центр', 'угол (число;число + Enter — ширина;глубина)'][this.pts.length]
        : ['первый угол', 'противоположный угол (число;число + Enter — ширина;глубина)'][this.pts.length];
    this.onState(`${mode}: ${step}. Esc — ${this.pts.length ? 'отмена' : 'выйти'}.`);
  }
}

/** Контур годится для части: ≥ 3 точек, без самопересечений и не слишком мал. */
function validRing(ring: Pt[]): string | undefined {
  if (ring.length < 3) return 'Нужно хотя бы три точки.';
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) s += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  if (Math.abs(s / 2) < MIN_AREA) return `Слишком маленький контур (меньше ${MIN_AREA} м²).`;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      if (cross(ring[i], ring[(i + 1) % n], ring[j], ring[(j + 1) % n])) return 'Стороны контура пересекаются.';
    }
  }
  return;
}

function cross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o = (p: Pt, q: Pt, r: Pt) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
  return ((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9)) && ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9));
}

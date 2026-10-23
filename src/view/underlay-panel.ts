/**
 * Панель подгонки подложки здания (режим здания). Пока она открыта, щелчки по карте — только для подложки:
 *  - щелчок по картинке — она едет за курсором (за точку щелчка), повторный щелчок — отпустить;
 *  - щелчок по угловой ручке — поворот и масштаб вокруг центра (Shift — только масштаб);
 *  - «По двум точкам»: точка на картинке → где она должна быть, вторая точка → где она должна быть
 *    (сдвиг, поворот и единый масштаб); концы прилипают к привязкам здания;
 *  - поля: поворот (горизонтальная — азимут верха картинки, вертикальная — куда обращена лицевая сторона), ширина,
 *    низ (у вертикальной), зеркально, вертикально.
 * «Подтвердить» — оставить, Esc или × — вернуть как было до открытия.
 * Всё считается в плоскости подложки: у горизонтальной — z = отметка (оси — восток и север), у вертикальной —
 * плоскость через линию картинки (оси — вдоль линии и вверх). Стоящую картинку мышью двигают по горизонтали
 * (на высоте точки захвата) и поворачивают вокруг вертикали (Shift — растянуть в её плоскости); «По двум точкам» —
 * в её плоскости (масштаб, высота, наклон).
 */
import * as THREE from 'three';
import type { Map as MlMap, MapMouseEvent } from 'maplibre-gl';
import { tr } from '../i18n';
import type { SnapHit } from '../render/buildings-layer';
import { isVertical, planeAngle, withPlaneAngle, type Underlay } from './underlays';

type Pt = [number, number];
type LonLat = [number, number];

/** Что панели нужно от слоя зданий (сцена режима здания, метры). */
export interface UnderlayScene {
  focusRay(point: Pt): THREE.Ray | undefined;
  focusProjector(): ((p: THREE.Vector3) => Pt | undefined) | undefined;
  focusToLocal(p: LonLat): Pt | undefined;
  focusToLngLat(x: number, y: number): LonLat | undefined;
  snapAt(point: Pt): SnapHit | undefined;
  /** Высота центра подложки над землёй, м (основание — земля или пол этажа, плюс её elevation). */
  elevation(u: Underlay): number;
}

export interface UnderlayPanelHooks {
  /** Подложку изменили (показать сразу). */
  change(u: Underlay): void;
  /** Панель закрыта: done — подтвердили (сохранить). */
  close(u: Underlay, done: boolean): void;
}

const POS_KEY = 'osm3d.underlay-panel-pos';
/** Захват угловой ручки — в пределах, px. */
const HANDLE_PX = 10;
/** Щелчок, а не перетаскивание карты, — если мышь сдвинулась не дальше, px. */
const CLICK_PX = 4;

/** Плоскость подложки: начало и оси (метры сцены); координаты точек в ней — [вдоль e1, вдоль e2]. */
interface Frame { o: THREE.Vector3; e1: THREE.Vector3; e2: THREE.Vector3; n: THREE.Vector3 }

/** Что сейчас делает мышь; точки — в координатах плоскости f (она не меняется, пока тянем). */
type Drag =
  /** Сдвиг: f — плоскость, в которой едет точка захвата (у стоящей картинки — горизонтальная через неё). */
  | { kind: 'move'; f: Frame; base: Underlay; from: Pt }
  /** Угол: у лежащей — поворот и масштаб в её плоскости; у стоящей — поворот вокруг вертикали (f — горизонтальная через центр). */
  | { kind: 'turn'; f: Frame; base: Underlay; center: Pt; from: Pt }
  /** По двум точкам: step 0 — ждём точку на картинке, 1 — ведём её на место, 2 — вторая точка, 3 — ведём её. */
  | { kind: 'fit'; f: Frame; step: 0 | 1 | 2 | 3; start: Underlay; base: Underlay; a?: Pt; a2?: Pt; b?: Pt };

export class UnderlayPanel {
  private readonly el: HTMLDivElement;
  private readonly title: HTMLDivElement;
  private readonly info: HTMLDivElement;
  private readonly rotLabel: HTMLSpanElement;
  private readonly rotRow: HTMLLabelElement;
  private readonly rotInput: HTMLInputElement;
  private readonly widthInput: HTMLInputElement;
  private readonly bottomRow: HTMLLabelElement;
  private readonly bottomInput: HTMLInputElement;
  private readonly mirrorInput: HTMLInputElement;
  private readonly verticalInput: HTMLInputElement;
  private readonly fitBtn: HTMLButtonElement;
  private readonly svg: SVGSVGElement;
  private readonly snapEl: HTMLDivElement;
  private u?: Underlay;
  private before?: Underlay;
  private drag?: Drag;
  private down?: { x: number; y: number };
  private cursor?: Pt;
  private shift = false;

  constructor(private readonly map: MlMap, private readonly scene: UnderlayScene, private readonly hooks: UnderlayPanelHooks) {
    const el = this.el = document.createElement('div');
    el.className = 'offset-panel underlay-panel';
    el.hidden = true;
    const head = document.createElement('div');
    head.className = 'offset-head';
    this.title = document.createElement('div');
    this.title.className = 'offset-title';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'offset-close';
    close.title = tr('Отменить');
    close.textContent = '×';
    close.addEventListener('click', () => this.cancel());
    head.append(this.title, close);
    this.draggable(head);
    const field = (label: string | HTMLElement, title: string, unit: string, step: string) => {
      const row = document.createElement('label');
      row.title = title;
      const input = document.createElement('input');
      input.type = 'number';
      input.step = step;
      row.append(label, input, unit);
      return { row, input };
    };
    this.rotLabel = document.createElement('span');
    const rot = field(this.rotLabel, '', '°', '0.1');
    this.rotRow = rot.row;
    this.rotInput = rot.input;
    rot.input.addEventListener('change', () => {
      const az = Number(rot.input.value) * Math.PI / 180, u = this.u;
      if (!u || !Number.isFinite(az)) return;
      // Горизонтальная: азимут верха картинки; вертикальная: куда обращена лицевая сторона (нормаль — R_z(rotation)·(0, −1))
      this.set({ ...u, rotation: isVertical(u) ? Math.PI - az : -az });
    });
    const width = field(tr('Ширина'), tr('Ширина картинки на местности'), tr('м'), '0.01');
    this.widthInput = width.input;
    width.input.addEventListener('change', () => {
      const w = Number(width.input.value), u = this.u;
      if (!u || !(w > 0)) return;
      // Растягиваем вокруг центра; у вертикальной низ остаётся на месте
      const v = { ...u, scale: w / u.width };
      this.set(isVertical(u) ? { ...v, elevation: u.elevation + this.halfHeight(v) - this.halfHeight(u) } : v);
    });
    const bottom = field(tr('Низ'), tr('Высота нижнего края картинки над землёй (у подложки этажа — над его полом)'), tr('м'), '0.01');
    this.bottomRow = bottom.row;
    this.bottomInput = bottom.input;
    bottom.input.addEventListener('change', () => {
      const b = Number(bottom.input.value), u = this.u;
      if (u && Number.isFinite(b)) this.set({ ...u, elevation: b + this.halfHeight(u) });
    });
    const check = (label: string, title: string, onChange: (on: boolean) => void) => {
      const row = document.createElement('label');
      row.className = 'underlay-mirror';
      row.title = title;
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.addEventListener('change', () => onChange(input.checked));
      row.append(input, label);
      return { row, input };
    };
    const vertical = check(tr('Вертикально'), tr('Поставить картинку вертикально (фасад, разрез): низ — на земле, ширина — вдоль её нижнего края'), (on) => {
      if (this.u) this.set(this.turned(this.u, on));
    });
    this.verticalInput = vertical.input;
    const mirror = check(tr('Зеркально'), '', (on) => { if (this.u) this.set({ ...this.u, mirror: on }); });
    this.mirrorInput = mirror.input;
    const fit = this.fitBtn = document.createElement('button');
    fit.type = 'button';
    fit.className = 'underlay-fit';
    fit.textContent = tr('По двум точкам');
    fit.title = tr('Щёлкните точку на картинке и место, где она должна быть; затем так же вторую точку');
    fit.addEventListener('click', () => {
      const u = this.u, f = u && this.frame(u);
      if (!u || !f) return;
      if (this.drag?.kind === 'fit') this.stopDrag(true);
      else { this.stopDrag(true); this.drag = { kind: 'fit', f, step: 0, start: u, base: u }; }
      this.sync();
    });
    this.info = document.createElement('div');
    this.info.className = 'offset-info';
    const buttons = document.createElement('div');
    buttons.className = 'offset-buttons';
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'offset-ok';
    ok.textContent = tr('Подтвердить');
    ok.addEventListener('click', () => this.confirm());
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = tr('Отменить');
    cancel.title = tr('Вернуть как было до открытия (Esc)');
    cancel.addEventListener('click', () => this.cancel());
    buttons.append(ok, cancel);
    el.append(head, rot.row, width.row, bottom.row, vertical.row, mirror.row, fit, this.info, buttons);

    // Рамка, ручки и точки подгонки — поверх карты, пересчитываются каждый кадр
    const svg = this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('underlay-handles');
    svg.style.display = 'none';
    this.snapEl = document.createElement('div');
    this.snapEl.className = 'snap-marker';
    this.snapEl.hidden = true;
    map.getContainer().append(svg, el, this.snapEl);
    map.on('render', () => { if (!el.hidden) this.draw(); });

    // Щелчки по карте, пока панель открыта, — только для подложки (до обработчиков MapLibre и инструментов)
    const onCanvas = (e: Event) => !el.hidden && map.getCanvasContainer().contains(e.target as Node);
    window.addEventListener('mousedown', (e) => { if (onCanvas(e)) this.down = { x: e.clientX, y: e.clientY }; }, true);
    window.addEventListener('click', (e) => {
      if (!onCanvas(e)) return;
      e.stopPropagation();
      const d = this.down;
      if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) > CLICK_PX) return; // двигали карту
      this.shift = e.shiftKey;
      this.onClick(this.point(e));
    }, true);
    window.addEventListener('dblclick', (e) => { if (onCanvas(e)) e.stopPropagation(); }, true);
    window.addEventListener('keydown', (e) => {
      if (el.hidden || e.key !== 'Escape') return;
      e.stopPropagation();
      if (this.drag) { this.stopDrag(true); this.sync(); } else this.cancel();
    }, true);
    const shiftKey = (e: KeyboardEvent) => {
      if (el.hidden || e.key !== 'Shift' || this.shift === (e.type === 'keydown')) return;
      this.shift = e.type === 'keydown';
      if (this.cursor) this.onMove(this.cursor);
    };
    window.addEventListener('keydown', shiftKey, true);
    window.addEventListener('keyup', shiftKey, true);
    map.on('mousemove', (e: MapMouseEvent) => {
      if (el.hidden) return;
      this.shift = e.originalEvent.shiftKey;
      this.onMove([e.point.x, e.point.y]);
    });
  }

  get open() { return !this.el.hidden; }
  get id() { return this.el.hidden ? undefined : this.u?.id; }

  show(u: Underlay) {
    if (!this.el.hidden && this.u?.id !== u.id) this.confirm();
    this.u = this.before = u;
    this.drag = undefined;
    this.title.textContent = tr('Подложка здания: {name}', { name: u.name });
    this.el.hidden = false;
    this.svg.style.display = '';
    this.place();
    this.sync();
    this.map.triggerRepaint();
  }

  /** Подложку изменили снаружи (галка видимости, прозрачность) — взять её поля, не теряя положения. */
  update(u: Underlay) {
    if (!this.u || this.u.id !== u.id) return;
    this.u = { ...this.u, opacity: u.opacity, visible: u.visible };
  }

  /** Закрыть, оставив как есть (выход из здания, удаление подложки). */
  hide() {
    if (!this.el.hidden) this.confirm();
  }

  private confirm() {
    this.stopDrag(false);
    this.close(true);
  }

  private cancel() {
    this.stopDrag(true);
    if (this.before) this.set(this.before);
    this.close(false);
  }

  private close(done: boolean) {
    this.el.hidden = true;
    this.svg.style.display = 'none';
    this.snapEl.hidden = true;
    this.map.getCanvas().style.cursor = '';
    if (this.u) this.hooks.close(this.u, done);
  }

  private point(e: MouseEvent): Pt {
    const r = this.map.getCanvasContainer().getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  // --- Геометрия: метры сцены режима здания

  /** Центр картинки в сцене. */
  private center3(u: Underlay): THREE.Vector3 | undefined {
    const c = this.scene.focusToLocal(u.center);
    return c && new THREE.Vector3(c[0], c[1], this.scene.elevation(u));
  }

  /** Плоскость картинки с началом в её центре: у горизонтальной оси — восток и север, у вертикальной — вдоль её линии и вверх. */
  private frame(u: Underlay): Frame | undefined {
    const o = this.center3(u);
    if (!o) return;
    const e1 = isVertical(u) ? new THREE.Vector3(Math.cos(u.rotation), Math.sin(u.rotation), 0) : new THREE.Vector3(1, 0, 0);
    const e2 = isVertical(u) ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
    return { o, e1, e2, n: e1.clone().cross(e2) };
  }

  private toPlane(f: Frame, v: THREE.Vector3): Pt {
    const d = v.clone().sub(f.o);
    return [d.dot(f.e1), d.dot(f.e2)];
  }

  private fromPlane(f: Frame, [a, b]: Pt): THREE.Vector3 {
    return f.o.clone().addScaledVector(f.e1, a).addScaledVector(f.e2, b);
  }

  /** Точка плоскости под курсором. */
  private onPlane(f: Frame, pt: Pt): Pt | undefined {
    const ray = this.scene.focusRay(pt);
    if (!ray) return;
    const dn = ray.direction.dot(f.n);
    if (Math.abs(dn) < 1e-9) return;
    const t = f.o.clone().sub(ray.origin).dot(f.n) / dn;
    if (t < 0) return;
    return this.toPlane(f, ray.at(t, new THREE.Vector3()));
  }

  /** Куда ведём: привязка здания (её проекция на плоскость) или точка плоскости под курсором. */
  private target(f: Frame, pt: Pt): { p?: Pt; snap?: SnapHit } {
    const snap = this.scene.snapAt(pt);
    if (snap) return { p: this.toPlane(f, snap.local), snap };
    return { p: this.onPlane(f, pt) };
  }

  /** Половина высоты картинки по вертикали плоскости, м (у вертикальной — от центра до нижнего угла). */
  private halfHeight(u: Underlay): number {
    const a = planeAngle(u), w = u.width * u.scale / 2, h = u.height * u.scale / 2;
    return Math.abs(Math.sin(a)) * w + Math.abs(Math.cos(a)) * h;
  }

  /** Поставить вертикально (низ — на основании, линия картинки — как была её ось X) или положить обратно. */
  private turned(u: Underlay, vertical: boolean): Underlay {
    if (vertical === isVertical(u)) return u;
    const flat = { ...u, tilt: 0, spin: 0, elevation: 0 };
    return vertical ? { ...flat, tilt: Math.PI / 2, elevation: u.height * u.scale / 2 } : flat;
  }

  /** Углы картинки по кругу (сцена). */
  private corners(u: Underlay): THREE.Vector3[] | undefined {
    const f = this.frame(u);
    if (!f) return;
    const a = planeAngle(u), w = u.width * u.scale / 2, h = u.height * u.scale / 2, cos = Math.cos(a), sin = Math.sin(a);
    return [[-w, -h], [w, -h], [w, h], [-w, h]].map(([x, y]) => this.fromPlane(f, [x * cos - y * sin, x * sin + y * cos]));
  }

  /** Горизонтальная плоскость через точку (оси — восток и север). */
  private flat(o: THREE.Vector3): Frame {
    return { o, e1: new THREE.Vector3(1, 0, 0), e2: new THREE.Vector3(0, 1, 0), n: new THREE.Vector3(0, 0, 1) };
  }

  /** Сдвинуть центр на вектор d (сцена). */
  private shifted(base: Underlay, d: THREE.Vector3): Underlay | undefined {
    const c = this.center3(base);
    const ll = c && this.scene.focusToLngLat(c.x + d.x, c.y + d.y);
    return ll && { ...base, center: ll, elevation: base.elevation + (isVertical(base) ? d.z : 0) };
  }

  /** Положение: центр — точка c плоскости f, поворот в плоскости и масштаб. */
  private pose(f: Frame, base: Underlay, c: Pt, angle: number, scale: number): Underlay | undefined {
    const v = this.fromPlane(f, c), ll = this.scene.focusToLngLat(v.x, v.y);
    if (!ll) return;
    // У вертикальной центр ходит и по высоте
    const elevation = isVertical(base) ? base.elevation + v.z - this.scene.elevation(base) : base.elevation;
    return withPlaneAngle({ ...base, center: ll, elevation, scale }, angle);
  }

  /**
   * Подобие в плоскости: точка p переходит в q, всё повёрнуто на angle и растянуто в k раз вокруг q
   * (центр c' = q + k·R(angle)·(c − p)).
   */
  private similar(f: Frame, base: Underlay, p: Pt, q: Pt, angle: number, k: number): Underlay | undefined {
    const c3 = this.center3(base);
    if (!c3) return;
    const [cx, cy] = this.toPlane(f, c3);
    const dx = cx - p[0], dy = cy - p[1], cos = Math.cos(angle), sin = Math.sin(angle);
    return this.pose(f, base, [q[0] + k * (dx * cos - dy * sin), q[1] + k * (dx * sin + dy * cos)], planeAngle(base) + angle, base.scale * k);
  }

  // --- Мышь

  private onClick(pt: Pt) {
    const u = this.u;
    if (!u) return;
    const d = this.drag;
    if (d?.kind === 'fit') { this.fitClick(d, pt); return; }
    if (d) { this.onMove(pt); this.stopDrag(false); this.sync(); return; }
    const f = this.frame(u);
    if (!f) return;
    const corner = this.cornerAt(pt);
    if (corner) {
      // Стоящая: поворот вокруг вертикали — в горизонтальной плоскости через центр (с Shift — растянуть, в её плоскости)
      const g = isVertical(u) ? this.flat(f.o) : f;
      this.drag = { kind: 'turn', f: g, base: u, center: [0, 0], from: this.toPlane(g, corner) };
    } else {
      const p = this.onPlane(f, pt);
      if (!p || !this.inside(pt)) return;
      // Стоящая едет по горизонтали — на высоте точки захвата
      const g = isVertical(u) ? this.flat(this.fromPlane(f, p)) : f;
      this.drag = { kind: 'move', f: g, base: u, from: this.toPlane(g, this.fromPlane(f, p)) };
    }
    this.sync();
  }

  private fitClick(d: Extract<Drag, { kind: 'fit' }>, pt: Pt) {
    if (d.step === 0 || d.step === 2) {
      // Точка на картинке — без привязок
      const p = this.onPlane(d.f, pt);
      if (!p || !this.inside(pt)) return;
      if (d.step === 0) { d.a = p; d.step = 1; } else { d.b = p; d.base = this.u!; d.step = 3; }
    } else {
      this.onMove(pt);
      const t = this.target(d.f, pt).p;
      if (!t) return;
      if (d.step === 1) { d.a2 = t; d.base = this.u!; d.step = 2; } else { this.drag = undefined; this.showSnap(undefined); }
    }
    this.sync();
  }

  private onMove(pt: Pt) {
    this.cursor = pt;
    const d = this.drag;
    let snap: SnapHit | undefined;
    if (d && this.u) {
      const t = d.kind === 'fit' && (d.step === 0 || d.step === 2) ? {} : this.target(d.f, pt);
      snap = t.snap;
      const q = t.p;
      if (!q) { /* курсор мимо плоскости */ }
      else if (d.kind === 'move') this.set(this.shifted(d.base, this.fromPlane(d.f, q).sub(this.fromPlane(d.f, d.from))));
      else if (d.kind === 'turn' && isVertical(d.base)) {
        const [fx, fy] = d.from;
        if (this.shift) {
          // Растянуть: в плоскости картинки вокруг центра — угол картинки идёт на удаление курсора от центра
          const g = this.frame(d.base), p = g && this.onPlane(g, pt);
          const half = d.base.scale * Math.hypot(d.base.width, d.base.height) / 2;
          if (g && p && half > 1e-6) this.set(this.similar(g, d.base, [0, 0], [0, 0], 0, Math.hypot(p[0], p[1]) / half));
        } else if (Math.hypot(fx, fy) > 1e-6 && Math.hypot(q[0], q[1]) > 1e-6) {
          this.set({ ...d.base, rotation: d.base.rotation + Math.atan2(q[1], q[0]) - Math.atan2(fy, fx) });
        }
      } else if (d.kind === 'turn') {
        const [cx, cy] = d.center;
        const a0 = Math.atan2(d.from[1] - cy, d.from[0] - cx), a1 = Math.atan2(q[1] - cy, q[0] - cx);
        const r0 = Math.hypot(d.from[0] - cx, d.from[1] - cy), r1 = Math.hypot(q[0] - cx, q[1] - cy);
        if (r0 > 1e-6 && r1 > 1e-6) this.set(this.similar(d.f, d.base, d.center, d.center, this.shift ? 0 : a1 - a0, r1 / r0));
      } else if (d.step === 1 && d.a) this.set(this.similar(d.f, d.base, d.a, q, 0, 1));
      else if (d.step === 3 && d.a2 && d.b) {
        const [ax, ay] = d.a2;
        const r0 = Math.hypot(d.b[0] - ax, d.b[1] - ay), r1 = Math.hypot(q[0] - ax, q[1] - ay);
        if (r0 > 1e-6 && r1 > 1e-6) {
          const angle = Math.atan2(q[1] - ay, q[0] - ax) - Math.atan2(d.b[1] - ay, d.b[0] - ax);
          this.set(this.similar(d.f, d.base, d.a2, d.a2, angle, r1 / r0));
        }
      }
    }
    this.showSnap(snap);
    this.map.getCanvas().style.cursor = this.cursorAt(pt);
    this.draw();
  }

  private cursorAt(pt: Pt): string {
    const d = this.drag;
    if (d?.kind === 'fit') return 'crosshair';
    if (d) return 'grabbing';
    if (this.cornerAt(pt)) return 'alias';
    return this.inside(pt) ? 'move' : '';
  }

  /** Угол картинки под курсором (сцена). */
  private cornerAt(pt: Pt): THREE.Vector3 | undefined {
    const u = this.u, project = this.scene.focusProjector(), cs = u && this.corners(u);
    if (!project || !cs) return;
    return cs.find((c) => {
      const s = project(c);
      return s && Math.hypot(s[0] - pt[0], s[1] - pt[1]) <= HANDLE_PX;
    });
  }

  /** Курсор над картинкой. */
  private inside(pt: Pt): boolean {
    const u = this.u, f = u && this.frame(u), p = f && this.onPlane(f, pt);
    if (!u || !p) return false;
    const a = planeAngle(u), cos = Math.cos(a), sin = Math.sin(a);
    return Math.abs(p[0] * cos + p[1] * sin) <= u.width * u.scale / 2 && Math.abs(-p[0] * sin + p[1] * cos) <= u.height * u.scale / 2;
  }

  private stopDrag(revert: boolean) {
    const d = this.drag;
    this.drag = undefined;
    this.showSnap(undefined);
    if (revert && d) this.set(d.kind === 'fit' ? d.start : d.base);
  }

  private set(u: Underlay | undefined) {
    if (!u) return;
    this.u = u;
    this.hooks.change(u);
    this.sync();
  }

  // --- Отображение

  private showSnap(s: SnapHit | undefined) {
    this.snapEl.hidden = !s;
    if (!s) return;
    this.snapEl.className = `snap-marker ${s.kind}`;
    this.snapEl.dataset.label = s.label ?? '';
    this.snapEl.style.left = `${s.point[0]}px`;
    this.snapEl.style.top = `${s.point[1]}px`;
  }

  private syncFields() {
    const u = this.u;
    if (!u) return;
    const vertical = isVertical(u);
    // Горизонтальная — куда смотрит верх картинки; вертикальная — куда обращена её лицевая сторона
    this.rotLabel.textContent = vertical ? tr('Лицом на') : tr('Поворот');
    this.rotRow.title = vertical ? tr('Куда обращена лицевая сторона картинки: азимут по часовой от севера')
      : tr('Куда смотрит верх картинки: азимут по часовой от севера');
    let az = ((vertical ? Math.PI - u.rotation : -u.rotation) * 180 / Math.PI) % 360;
    if (az < 0) az += 360;
    if (document.activeElement !== this.rotInput) this.rotInput.value = az.toFixed(1);
    if (document.activeElement !== this.widthInput) this.widthInput.value = (u.width * u.scale).toFixed(2);
    this.bottomRow.hidden = !vertical;
    if (document.activeElement !== this.bottomInput) this.bottomInput.value = (u.elevation - this.halfHeight(u)).toFixed(2);
    this.verticalInput.checked = vertical;
    this.mirrorInput.checked = u.mirror;
  }

  private sync() {
    this.syncFields();
    const d = this.drag;
    this.fitBtn.classList.toggle('active', d?.kind === 'fit');
    const u = this.u;
    const size = u ? tr('Картинка {w} × {h} м.', { w: (u.width * u.scale).toFixed(2), h: (u.height * u.scale).toFixed(2) }) : '';
    const vertical = !!u && isVertical(u);
    this.info.textContent = !d
      ? (vertical ? tr('Щелчок по картинке — сдвинуть по горизонтали, по углу — повернуть вокруг вертикали (Shift — растянуть).')
        : tr('Щелчок по картинке — сдвинуть, по углу — повернуть и растянуть (Shift — без поворота).'))
      : d.kind === 'move' ? tr('Ведите мышью, щелчок — отпустить, Esc — вернуть.')
      : d.kind === 'turn' ? (vertical ? tr('Ведите угол, щелчок — отпустить, Esc — вернуть. Shift — растянуть.')
        : tr('Ведите угол, щелчок — отпустить, Esc — вернуть. Shift — без поворота.'))
      : [tr('Щёлкните первую точку на картинке.'), tr('Щёлкните, где эта точка должна быть.'),
          tr('Щёлкните вторую точку на картинке.'), tr('Щёлкните, где вторая точка должна быть.')][d.step];
    if (!d) this.info.append(document.createElement('br'), size);
    this.draw();
  }

  /** Рамка картинки, ручки на углах, точки подгонки и пунктир к курсору. */
  private draw() {
    const svg = this.svg, u = this.u, project = this.scene.focusProjector();
    const cs = u && this.corners(u);
    if (!u || !project || !cs) { svg.replaceChildren(); return; }
    const ring = cs.map((c) => project(c));
    const parts: string[] = [];
    if (ring.every(Boolean)) {
      parts.push(`<polygon class="frame" points="${ring.map((p) => p!.join(',')).join(' ')}"/>`);
      if (this.drag?.kind !== 'fit') for (const p of ring) parts.push(`<rect class="handle" x="${p![0] - 4}" y="${p![1] - 4}" width="8" height="8"/>`);
    }
    const d = this.drag;
    if (d?.kind === 'fit') {
      const scr = (p: Pt | undefined) => p && project(this.fromPlane(d.f, p));
      const mark = (p: Pt | undefined, cls: string, label: string) => {
        const s = scr(p);
        if (s) parts.push(`<circle class="${cls}" cx="${s[0]}" cy="${s[1]}" r="5"/><text x="${s[0] + 8}" y="${s[1] - 8}">${label}</text>`);
      };
      // Точки на картинке едут вместе с ней: пересчитать из положения на момент щелчка
      const moved = (p: Pt | undefined) => p && this.carry(d.f, p, d.base, u);
      if (d.step === 1) mark(moved(d.a), 'pick', 'A');
      if (d.step >= 2) mark(d.a2, 'pin', 'A');
      if (d.step === 3) mark(moved(d.b), 'pick', 'B');
      const a = scr(d.step === 1 ? moved(d.a) : d.step === 3 ? moved(d.b) : undefined);
      if (a && this.cursor) parts.push(`<line class="lead" x1="${a[0]}" y1="${a[1]}" x2="${this.cursor[0]}" y2="${this.cursor[1]}"/>`);
    }
    svg.innerHTML = parts.join('');
  }

  /** Точка p картинки в положении base — где она в положении now (координаты плоскости f). */
  private carry(f: Frame, p: Pt, base: Underlay, now: Underlay): Pt | undefined {
    const b3 = this.center3(base), n3 = this.center3(now);
    if (!b3 || !n3) return;
    const c0 = this.toPlane(f, b3), c1 = this.toPlane(f, n3);
    const angle = planeAngle(now) - planeAngle(base), k = now.scale / base.scale;
    const dx = p[0] - c0[0], dy = p[1] - c0[1], cos = Math.cos(angle), sin = Math.sin(angle);
    return [c1[0] + k * (dx * cos - dy * sin), c1[1] + k * (dx * sin + dy * cos)];
  }

  // --- Положение панели (как у панели сдвига снимка)

  private place() {
    const box = this.map.getContainer().getBoundingClientRect();
    const w = this.el.offsetWidth, h = this.el.offsetHeight;
    let pos: { x: number; y: number } | undefined;
    try { pos = JSON.parse(localStorage.getItem(POS_KEY) ?? 'null') ?? undefined; } catch { /* по умолчанию */ }
    if (!pos) {
      const ctrl = this.map.getContainer().querySelector('.maplibregl-ctrl-top-right .maplibregl-ctrl-group')?.getBoundingClientRect();
      const left = document.getElementById('left-col')?.getBoundingClientRect();
      const right = ctrl ? ctrl.left - box.left - 8 : box.width - 12;
      const min = left ? left.right - box.left + 8 : 12;
      pos = { x: Math.max(min, right - w), y: 10 };
    }
    this.moveTo(pos.x, pos.y, w, h);
  }

  private moveTo(x: number, y: number, w = this.el.offsetWidth, h = this.el.offsetHeight) {
    const box = this.map.getContainer().getBoundingClientRect();
    this.el.style.left = `${Math.round(Math.min(Math.max(0, x), box.width - w))}px`;
    this.el.style.top = `${Math.round(Math.min(Math.max(0, y), box.height - h))}px`;
  }

  private draggable(head: HTMLElement) {
    head.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
      e.preventDefault();
      const sx = e.clientX - this.el.offsetLeft, sy = e.clientY - this.el.offsetTop;
      head.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => this.moveTo(ev.clientX - sx, ev.clientY - sy);
      const up = () => {
        head.removeEventListener('pointermove', move);
        try { localStorage.setItem(POS_KEY, JSON.stringify({ x: this.el.offsetLeft, y: this.el.offsetTop })); } catch { /* до перезагрузки */ }
      };
      head.addEventListener('pointermove', move);
      head.addEventListener('pointerup', up, { once: true });
      head.addEventListener('pointercancel', up, { once: true });
    });
  }
}

/**
 * Панель подгонки подложки здания (режим здания). Пока она открыта, щелчки по карте — только для подложки:
 *  - щелчок по картинке — она едет за курсором (за точку щелчка), повторный щелчок — отпустить;
 *  - щелчок по угловой ручке — поворот и масштаб вокруг центра (Shift — только масштаб);
 *  - «По двум точкам»: точка на картинке → где она должна быть, вторая точка → где она должна быть
 *    (сдвиг, поворот и единый масштаб); концы прилипают к привязкам здания;
 *  - поля: поворот (азимут верха картинки, °), ширина (м), зеркально.
 * «Подтвердить» — оставить, Esc или × — вернуть как было до открытия.
 * Пока подложки только горизонтальные: всё считается в плоскости z = отметка подложки (оси сцены режима здания).
 */
import * as THREE from 'three';
import type { Map as MlMap, MapMouseEvent } from 'maplibre-gl';
import { tr } from '../i18n';
import type { SnapHit } from '../render/buildings-layer';
import type { Underlay } from './underlays';

type Pt = [number, number];
type LonLat = [number, number];

/** Что панели нужно от слоя зданий (сцена режима здания, метры). */
export interface UnderlayScene {
  focusRay(point: Pt): THREE.Ray | undefined;
  focusProjector(): ((p: THREE.Vector3) => Pt | undefined) | undefined;
  focusToLocal(p: LonLat): Pt | undefined;
  focusToLngLat(x: number, y: number): LonLat | undefined;
  snapAt(point: Pt): SnapHit | undefined;
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

/** Что сейчас делает мышь. */
type Drag =
  | { kind: 'move'; base: Underlay; from: Pt }
  | { kind: 'turn'; base: Underlay; center: Pt; from: Pt }
  /** По двум точкам: step 0 — ждём точку на картинке, 1 — ведём её на место, 2 — вторая точка, 3 — ведём её. */
  | { kind: 'fit'; step: 0 | 1 | 2 | 3; start: Underlay; base: Underlay; a?: Pt; a2?: Pt; b?: Pt };

export class UnderlayPanel {
  private readonly el: HTMLDivElement;
  private readonly title: HTMLDivElement;
  private readonly info: HTMLDivElement;
  private readonly rotInput: HTMLInputElement;
  private readonly widthInput: HTMLInputElement;
  private readonly mirrorInput: HTMLInputElement;
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
    const field = (label: string, title: string, unit: string, step: string) => {
      const row = document.createElement('label');
      row.title = title;
      const input = document.createElement('input');
      input.type = 'number';
      input.step = step;
      row.append(label, input, unit);
      return { row, input };
    };
    const rot = field(tr('Поворот'), tr('Куда смотрит верх картинки: азимут по часовой от севера'), '°', '0.1');
    this.rotInput = rot.input;
    rot.input.addEventListener('change', () => {
      const az = Number(rot.input.value);
      if (this.u && Number.isFinite(az)) this.set({ ...this.u, rotation: -az * Math.PI / 180 });
    });
    const width = field(tr('Ширина'), tr('Ширина картинки на местности'), tr('м'), '0.01');
    this.widthInput = width.input;
    width.input.addEventListener('change', () => {
      const w = Number(width.input.value);
      if (this.u && w > 0) this.set({ ...this.u, scale: w / this.u.width });
    });
    const mirror = document.createElement('label');
    mirror.className = 'underlay-mirror';
    const mirrorInput = this.mirrorInput = document.createElement('input');
    mirrorInput.type = 'checkbox';
    mirrorInput.addEventListener('change', () => { if (this.u) this.set({ ...this.u, mirror: mirrorInput.checked }); });
    mirror.append(mirrorInput, tr('Зеркально'));
    const fit = this.fitBtn = document.createElement('button');
    fit.type = 'button';
    fit.className = 'underlay-fit';
    fit.textContent = tr('По двум точкам');
    fit.title = tr('Щёлкните точку на картинке и место, где она должна быть; затем так же вторую точку');
    fit.addEventListener('click', () => {
      if (!this.u) return;
      if (this.drag?.kind === 'fit') this.stopDrag(true);
      else { this.stopDrag(true); this.drag = { kind: 'fit', step: 0, start: this.u, base: this.u }; }
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
    el.append(head, rot.row, width.row, mirror, fit, this.info, buttons);

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

  // --- Геометрия: метры сцены режима здания, плоскость подложки z = elevation

  private centerOf(u: Underlay): Pt | undefined { return this.scene.focusToLocal(u.center); }

  /** Точка плоскости подложки под курсором (x, y). */
  private onPlane(pt: Pt, u = this.u): Pt | undefined {
    const ray = this.scene.focusRay(pt);
    if (!ray || !u || Math.abs(ray.direction.z) < 1e-9) return;
    const t = (u.elevation - ray.origin.z) / ray.direction.z;
    if (t < 0) return;
    const p = ray.at(t, new THREE.Vector3());
    return [p.x, p.y];
  }

  /** Куда ведём: привязка здания (её x, y) или точка плоскости под курсором. */
  private target(pt: Pt): { p?: Pt; snap?: SnapHit } {
    const snap = this.scene.snapAt(pt);
    if (snap) return { p: [snap.local.x, snap.local.y], snap };
    return { p: this.onPlane(pt) };
  }

  /** Углы картинки по кругу (метры сцены). */
  private corners(u: Underlay): Pt[] | undefined {
    const c = this.centerOf(u);
    if (!c) return;
    const w = u.width * u.scale / 2, h = u.height * u.scale / 2;
    const cos = Math.cos(u.rotation), sin = Math.sin(u.rotation);
    return [[-w, -h], [w, -h], [w, h], [-w, h]].map(([x, y]) => [c[0] + x * cos - y * sin, c[1] + x * sin + y * cos]);
  }

  /**
   * Подобие в плоскости: точка p переходит в q, всё повёрнуто на angle и растянуто в k раз вокруг q
   * (центр c' = q + k·R(angle)·(c − p)).
   */
  private similar(base: Underlay, p: Pt, q: Pt, angle: number, k: number): Underlay | undefined {
    const c = this.centerOf(base);
    if (!c) return;
    const dx = c[0] - p[0], dy = c[1] - p[1], cos = Math.cos(angle), sin = Math.sin(angle);
    const ll = this.scene.focusToLngLat(q[0] + k * (dx * cos - dy * sin), q[1] + k * (dx * sin + dy * cos));
    if (!ll) return;
    return { ...base, center: ll, rotation: base.rotation + angle, scale: base.scale * k };
  }

  // --- Мышь

  private onClick(pt: Pt) {
    const u = this.u;
    if (!u) return;
    const d = this.drag;
    if (d?.kind === 'fit') { this.fitClick(d, pt); return; }
    if (d) { this.onMove(pt); this.stopDrag(false); this.sync(); return; }
    const corner = this.cornerAt(pt);
    const c = this.centerOf(u);
    if (corner && c) {
      this.drag = { kind: 'turn', base: u, center: c, from: corner };
    } else {
      const p = this.onPlane(pt);
      if (!p || !this.inside(pt)) return;
      this.drag = { kind: 'move', base: u, from: p };
    }
    this.sync();
  }

  private fitClick(d: Extract<Drag, { kind: 'fit' }>, pt: Pt) {
    if (d.step === 0 || d.step === 2) {
      // Точка на картинке — без привязок
      const p = this.onPlane(pt);
      if (!p || !this.inside(pt)) return;
      if (d.step === 0) { d.a = p; d.step = 1; } else { d.b = p; d.base = this.u!; d.step = 3; }
    } else {
      this.onMove(pt);
      const t = this.target(pt).p;
      if (!t) return;
      if (d.step === 1) { d.a2 = t; d.base = this.u!; d.step = 2; } else { this.drag = undefined; this.showSnap(undefined); }
    }
    this.sync();
  }

  private onMove(pt: Pt) {
    this.cursor = pt;
    const d = this.drag, u = this.u;
    let snap: SnapHit | undefined;
    if (d && u) {
      if (d.kind === 'move') {
        const t = this.target(pt);
        snap = t.snap;
        if (t.p) this.set(this.similar(d.base, d.from, t.p, 0, 1));
      } else if (d.kind === 'turn') {
        const t = this.target(pt);
        snap = t.snap;
        if (t.p) {
          const [cx, cy] = d.center;
          const a0 = Math.atan2(d.from[1] - cy, d.from[0] - cx), a1 = Math.atan2(t.p[1] - cy, t.p[0] - cx);
          const r0 = Math.hypot(d.from[0] - cx, d.from[1] - cy), r1 = Math.hypot(t.p[0] - cx, t.p[1] - cy);
          if (r0 > 1e-6 && r1 > 1e-6) this.set(this.similar(d.base, d.center, d.center, this.shift ? 0 : a1 - a0, r1 / r0));
        }
      } else if (d.step === 1 && d.a) {
        const t = this.target(pt);
        snap = t.snap;
        if (t.p) this.set(this.similar(d.base, d.a, t.p, 0, 1));
      } else if (d.step === 3 && d.a2 && d.b) {
        const t = this.target(pt);
        snap = t.snap;
        const [ax, ay] = d.a2;
        const r0 = Math.hypot(d.b[0] - ax, d.b[1] - ay), r1 = t.p && Math.hypot(t.p[0] - ax, t.p[1] - ay);
        if (t.p && r0 > 1e-6 && r1 && r1 > 1e-6) {
          const angle = Math.atan2(t.p[1] - ay, t.p[0] - ax) - Math.atan2(d.b[1] - ay, d.b[0] - ax);
          this.set(this.similar(d.base, d.a2, d.a2, angle, r1 / r0));
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

  /** Угол картинки под курсором (метры сцены). */
  private cornerAt(pt: Pt): Pt | undefined {
    const u = this.u, project = this.scene.focusProjector(), cs = u && this.corners(u);
    if (!project || !cs) return;
    return cs.find((c) => {
      const s = project(new THREE.Vector3(c[0], c[1], u.elevation));
      return s && Math.hypot(s[0] - pt[0], s[1] - pt[1]) <= HANDLE_PX;
    });
  }

  /** Курсор над картинкой (в её рамке на экране). */
  private inside(pt: Pt): boolean {
    const u = this.u, p = this.onPlane(pt), c = u && this.centerOf(u);
    if (!u || !p || !c) return false;
    const cos = Math.cos(u.rotation), sin = Math.sin(u.rotation), dx = p[0] - c[0], dy = p[1] - c[1];
    return Math.abs(dx * cos + dy * sin) <= u.width * u.scale / 2 && Math.abs(-dx * sin + dy * cos) <= u.height * u.scale / 2;
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
    let az = (-u.rotation * 180 / Math.PI) % 360;
    if (az < 0) az += 360;
    if (document.activeElement !== this.rotInput) this.rotInput.value = az.toFixed(1);
    if (document.activeElement !== this.widthInput) this.widthInput.value = (u.width * u.scale).toFixed(2);
    this.mirrorInput.checked = u.mirror;
  }

  private sync() {
    this.syncFields();
    const d = this.drag;
    this.fitBtn.classList.toggle('active', d?.kind === 'fit');
    const u = this.u;
    const size = u ? tr('Картинка {w} × {h} м.', { w: (u.width * u.scale).toFixed(2), h: (u.height * u.scale).toFixed(2) }) : '';
    this.info.textContent = !d
      ? tr('Щелчок по картинке — сдвинуть, по углу — повернуть и растянуть (Shift — без поворота).')
      : d.kind === 'move' ? tr('Ведите мышью, щелчок — отпустить, Esc — вернуть.')
      : d.kind === 'turn' ? tr('Ведите угол, щелчок — отпустить, Esc — вернуть. Shift — без поворота.')
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
    const z = u.elevation;
    const scr = (p: Pt) => project(new THREE.Vector3(p[0], p[1], z));
    const ring = cs.map(scr);
    const parts: string[] = [];
    if (ring.every(Boolean)) {
      parts.push(`<polygon class="frame" points="${ring.map((p) => p!.join(',')).join(' ')}"/>`);
      if (this.drag?.kind !== 'fit') for (const p of ring) parts.push(`<rect class="handle" x="${p![0] - 4}" y="${p![1] - 4}" width="8" height="8"/>`);
    }
    const d = this.drag;
    if (d?.kind === 'fit') {
      const mark = (p: Pt | undefined, cls: string, label: string) => {
        const s = p && scr(p);
        if (s) parts.push(`<circle class="${cls}" cx="${s[0]}" cy="${s[1]}" r="5"/><text x="${s[0] + 8}" y="${s[1] - 8}">${label}</text>`);
      };
      // Точки на картинке едут вместе с ней: пересчитать из положения на момент щелчка
      const moved = (p: Pt | undefined, base: Underlay) => p && this.carry(p, base, u);
      if (d.step === 1) mark(moved(d.a, d.base), 'pick', 'A');
      if (d.step >= 2) mark(d.a2, 'pin', 'A');
      if (d.step === 3) mark(moved(d.b, d.base), 'pick', 'B');
      const from = d.step === 1 ? moved(d.a, d.base) : d.step === 3 ? moved(d.b, d.base) : undefined;
      const a = from && scr(from);
      if (a && this.cursor) parts.push(`<line class="lead" x1="${a[0]}" y1="${a[1]}" x2="${this.cursor[0]}" y2="${this.cursor[1]}"/>`);
    }
    svg.innerHTML = parts.join('');
  }

  /** Точка p картинки в положении base — где она в положении now. */
  private carry(p: Pt, base: Underlay, now: Underlay): Pt | undefined {
    const c0 = this.centerOf(base), c1 = this.centerOf(now);
    if (!c0 || !c1) return;
    const angle = now.rotation - base.rotation, k = now.scale / base.scale;
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

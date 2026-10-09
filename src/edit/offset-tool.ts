import * as THREE from 'three';
import type { BuildingsLayer } from '../render/buildings-layer';
import { validRing } from './draw-tool';

type Pt = [number, number];

/** Плоская грань, от контура которой откладываем: объект, верх или низ, высота и контур (метры сцены). */
export interface OffsetTarget { key: string; face: 'top' | 'bottom'; z: number; ring: Pt[] }

/** Короче этого отступ не считаем (контур совпал бы с исходным), м. */
const MIN_OFFSET = 0.05;

/**
 * Инструмент «Отступ» (Offset): контур плоской грани (верх плоской крыши или низ; Shift — низ) отступает
 * наружу или внутрь — в какую сторону от контура ведут курсор. Клик или число + Enter — новый плоский контур
 * на высоте грани (что с ним делать — решает commit). Esc — отмена, повторный Esc — выйти.
 */
export class OffsetTool {
  state: 'off' | 'pick' | 'offset' = 'off';
  private target?: OffsetTarget;
  private d = 0;
  private typed = '';
  private readonly vcb: HTMLDivElement;

  constructor(
    private readonly layer: BuildingsLayer,
    container: HTMLElement,
    /** Грань под курсором (back — Shift: низ); строка — почему нельзя. */
    private readonly pick: (point: [number, number], back: boolean) => OffsetTarget | string | undefined,
    private readonly commit: (t: OffsetTarget, ring: Pt[]) => string | undefined,
    private readonly onState: (hint: string, error?: boolean) => void,
  ) {
    this.vcb = document.createElement('div');
    this.vcb.className = 'vcb';
    this.vcb.hidden = true;
    container.appendChild(this.vcb);
  }

  get active() { return this.state !== 'off'; }

  start() {
    this.state = 'pick';
    this.onState('Отступ: клик по плоской крыше — от её контура, Shift+клик — от низа. Esc — выйти.');
  }

  stop() {
    this.cancel();
    this.state = 'off';
    this.onState('');
  }

  click(point: [number, number], back = false) {
    if (this.state === 'pick') {
      const t = this.pick(point, back);
      if (!t) return;
      if (typeof t === 'string') { this.onState(t, true); return; }
      this.target = t;
      this.d = 0;
      this.typed = '';
      this.state = 'offset';
      this.onState('Ведите курсор наружу или внутрь контура. Клик — новый контур, число + Enter — отступ в метрах (минус — внутрь), Esc — отмена.');
      this.move(point);
      return;
    }
    if (this.state === 'offset') this.apply(this.d);
  }

  move(point: [number, number]) {
    if (this.state !== 'offset' || !this.target) return;
    const ray = this.layer.focusRay(point);
    const q = ray?.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -this.target.z), new THREE.Vector3());
    if (!q) return;
    this.d = signedDistance(this.target.ring, [q.x, q.y]);
    this.preview();
  }

  key(e: KeyboardEvent): boolean {
    if (!this.active || e.type !== 'keydown') return false;
    if (e.key === 'Escape') {
      if (this.state === 'offset') { this.cancel(); this.start(); } else this.stop();
      return true;
    }
    if (this.state !== 'offset') return false;
    if (/^[\d.,-]$/.test(e.key)) { this.typed += e.key === ',' ? '.' : e.key; this.preview(); return true; }
    if (e.key === 'Backspace') { this.typed = this.typed.slice(0, -1); this.preview(); return true; }
    if (e.key === 'Enter') {
      const v = Number(this.typed);
      if (!this.typed || !Number.isFinite(v)) return true;
      // Без знака — в ту сторону, куда ведут курсор
      this.apply(this.typed.startsWith('-') ? v : v * (this.d < 0 ? -1 : 1));
      return true;
    }
    return false;
  }

  private apply(d: number) {
    const t = this.target;
    if (!t) return;
    if (Math.abs(d) < MIN_OFFSET) { this.onState('Отведите курсор от контура.', true); return; }
    const ring = offsetRing(t.ring, d);
    const err = validRing(ring);
    if (err) { this.onState(`Такой отступ не получится: ${err}`, true); return; }
    const fail = this.commit(t, ring);
    if (fail) { this.onState(fail, true); return; }
    this.cancel();
    this.state = 'pick';
  }

  private preview() {
    const t = this.target;
    if (!t) return;
    const typed = Number(this.typed);
    const d = this.typed && Number.isFinite(typed) ? (this.typed.startsWith('-') ? typed : typed * (this.d < 0 ? -1 : 1)) : this.d;
    const ring = Math.abs(d) >= MIN_OFFSET ? offsetRing(t.ring, d) : t.ring;
    const pts = ring.map((p) => new THREE.Vector3(p[0], p[1], t.z));
    this.layer.setDrawPreview([...pts, pts[0]], true);
    this.vcb.hidden = false;
    this.vcb.innerHTML = `<span class="vcb-label">Отступ</span><span class="vcb-value${this.typed ? ' typed' : ''}">${this.typed || Math.abs(d).toFixed(2)}</span> м
      <span class="vcb-axis">${d < 0 ? 'внутрь' : 'наружу'}${validRing(ring) && Math.abs(d) >= MIN_OFFSET ? ' · контур вырождается' : ''}</span>`;
  }

  private cancel() {
    this.target = undefined;
    this.typed = '';
    this.vcb.hidden = true;
    this.layer.setDrawPreview(undefined);
  }
}

/** Удвоенная площадь со знаком (> 0 — против часовой). */
function area2(ring: Pt[]): number {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) s += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return s;
}

/** Контур, отступивший на d (> 0 — наружу): стороны сдвигаются по нормали, углы — пересечения соседних сторон. */
export function offsetRing(ring: Pt[], d: number): Pt[] {
  const n = ring.length;
  const ccw = area2(ring) > 0;
  // Наружная нормаль стороны a→b: у контура против часовой — справа от направления
  const normal = (a: Pt, b: Pt): Pt => {
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
    return ccw ? [dy / l, -dx / l] : [-dy / l, dx / l];
  };
  return ring.map((p, i) => {
    const prev = ring[(i - 1 + n) % n], next = ring[(i + 1) % n];
    const n1 = normal(prev, p), n2 = normal(p, next);
    // Прямые сторон, сдвинутые на d: p + n·d + t·dir
    const a1: Pt = [prev[0] + n1[0] * d, prev[1] + n1[1] * d], d1: Pt = [p[0] - prev[0], p[1] - prev[1]];
    const a2: Pt = [p[0] + n2[0] * d, p[1] + n2[1] * d], d2: Pt = [next[0] - p[0], next[1] - p[1]];
    const den = d1[0] * d2[1] - d1[1] * d2[0];
    if (Math.abs(den) < 1e-9 * Math.hypot(...d1) * Math.hypot(...d2)) return [p[0] + n1[0] * d, p[1] + n1[1] * d] as Pt;
    const t = ((a2[0] - a1[0]) * d2[1] - (a2[1] - a1[1]) * d2[0]) / den;
    return [a1[0] + d1[0] * t, a1[1] + d1[1] * t] as Pt;
  });
}

/** Расстояние от точки до контура: > 0 — снаружи, < 0 — внутри. */
function signedDistance(ring: Pt[], q: Pt): number {
  let best = Infinity, inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j], b = ring[i];
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / l2));
    best = Math.min(best, Math.hypot(q[0] - a[0] - dx * t, q[1] - a[1] - dy * t));
    if ((a[1] > q[1]) !== (b[1] > q[1]) && q[0] < a[0] + ((q[1] - a[1]) / (b[1] - a[1])) * dx) inside = !inside;
  }
  return inside ? -best : best;
}

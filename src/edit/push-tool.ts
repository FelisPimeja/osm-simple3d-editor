import * as THREE from 'three';
import type { BuildingsLayer, SnapHit } from '../render/buildings-layer';

export type PushFace = 'top' | 'bottom' | 'side';

/**
 * Что тянем: объект, грань и точка захвата (метры сцены режима здания). У боковой грани — ребро контура
 * (полигон, кольцо: 0 — внешнее, 1… — дыры, номер стороны) и направление наружу (горизонтальное, единичное).
 */
export interface PushTarget {
  key: string;
  face: PushFace;
  from: THREE.Vector3;
  edge?: { poly: number; ring: number; i: number; n: THREE.Vector3 };
}

/** Насколько далеко точка на стене может быть от ребра контура, м. */
const EDGE_EPS = 0.15;

/**
 * Инструмент «Вытянуть» (как Push/Pull в SketchUp):
 * 1. клик по крыше — тянем верх (height); по стене — эту стену наружу/внутрь (два узла контура);
 *    по нижней грани — низ (min_height). Shift — задняя грань под курсором: дно или дальняя стена;
 * 2. движение курсора — верх/низ едут по вертикали, стена — по своей нормали; привязка к точке
 *    другого объекта выравнивает грань по ней;
 * 3. второй клик — применить; число + Enter — сдвиг в метрах (минус — внутрь/вниз). Esc — отмена.
 * Пересчёт тегов и геометрии, проверка общих узлов и ограничения — снаружи (allowSide, clamp, preview, commit).
 */
export class PushTool {
  state: 'off' | 'pick' | 'push' = 'off';
  snap?: SnapHit;
  private target?: PushTarget;
  private dz = 0;
  private typed = '';
  private readonly vcb: HTMLDivElement;

  constructor(
    private readonly layer: BuildingsLayer,
    container: HTMLElement,
    /** Можно ли тянуть объект (член здания, не скрыт). */
    private readonly allowed: (key: string) => boolean,
    /** Можно ли тянуть эту стену (нет общих узлов с другими объектами); сам объясняет, если нельзя. */
    private readonly allowSide: (t: PushTarget) => boolean,
    /** Ограничить сдвиг допустимым для грани. */
    private readonly clamp: (t: PushTarget, dz: number) => number,
    private readonly preview: (t: PushTarget, dz: number | undefined) => void,
    private readonly commit: (t: PushTarget, dz: number) => void,
    private readonly onState: (hint: string) => void,
  ) {
    this.vcb = document.createElement('div');
    this.vcb.className = 'vcb';
    this.vcb.hidden = true;
    container.appendChild(this.vcb);
  }

  get active() { return this.state !== 'off'; }

  start() {
    this.state = 'pick';
    this.onState('Клик по крыше — тянем верх, по стене — стену; Shift+клик — задняя грань (дно или дальняя стена). Esc — выйти.');
  }

  stop() {
    this.cancel();
    this.state = 'off';
    this.onState('');
  }

  /** Грань под курсором. back (Shift) — задняя грань того же объекта: где луч из него выходит. */
  faceAt(point: [number, number], back = false): PushTarget | undefined {
    const hits = this.layer.focusRayHits(point, this.allowed);
    if (!hits.length) return;
    const key = hits[0].key;
    const own = hits.filter((h) => h.key === key);
    const h = back ? own[own.length - 1] : own[0];
    const box = this.layer.focusItemBox(key);
    if (!box) return;
    if (h.face === 'bottom') return { key, face: 'bottom', from: h.local.clone().setZ(box.min.z) };
    if (h.face === 'wall') {
      const edge = this.edgeAt(key, h.local);
      if (edge) return { key, face: 'side', from: h.local.clone(), edge };
    }
    // Крыша (и стена, у которой не нашли ребро контура) — верх
    return { key, face: 'top', from: h.local.clone().setZ(box.max.z) };
  }

  /** Сторона контура, на которой стоит стена с точкой p, и нормаль наружу от объекта. */
  private edgeAt(key: string, p: THREE.Vector3): PushTarget['edge'] {
    const polys = this.layer.focusPolygons(key);
    if (!polys) return;
    let best: { poly: number; ring: number; i: number; d: number } | undefined;
    polys.forEach((poly, pi) => [poly.outer, ...poly.inners].forEach((ring, ri) => {
      for (let i = 0; i < ring.length; i++) {
        const d = segDist([p.x, p.y], ring[i], ring[(i + 1) % ring.length]);
        if (d < EDGE_EPS && (!best || d < best.d)) best = { poly: pi, ring: ri, i, d };
      }
    }));
    if (!best) return;
    const poly = polys[best.poly];
    const ring = best.ring ? poly.inners[best.ring - 1] : poly.outer;
    const a = ring[best.i], b = ring[(best.i + 1) % ring.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1e-6) return;
    const n = new THREE.Vector3((b[1] - a[1]) / len, -(b[0] - a[0]) / len, 0);
    // Наружу — туда, где нет тела объекта (внутри внешнего кольца и вне дыр)
    const mx = (a[0] + b[0]) / 2 + n.x * 0.05, my = (a[1] + b[1]) / 2 + n.y * 0.05;
    const solid = inRing([mx, my], poly.outer) && !poly.inners.some((r) => inRing([mx, my], r));
    if (solid) n.negate();
    return { poly: best.poly, ring: best.ring, i: best.i, n };
  }

  /** back — Shift: задняя грань под курсором. */
  click(point: [number, number], back = false): boolean {
    if (this.state === 'pick') {
      const t = this.faceAt(point, back);
      if (!t) return false;
      if (t.face === 'side' && !this.allowSide(t)) return true;
      this.target = t;
      this.dz = 0;
      this.typed = '';
      this.state = 'push';
      this.guide();
      this.updateVcb();
      this.onState(t.face === 'side'
        ? 'Тянем стену: ведите курсор наружу или внутрь. Клик — применить, число + Enter — в метрах, Esc — отмена.'
        : `Тянем ${t.face === 'top' ? 'верх' : 'низ'}: ведите курсор вверх или вниз. Клик — применить, число + Enter — в метрах, Esc — отмена.`);
      return true;
    }
    if (this.state === 'push') { this.apply(this.dz); return true; }
    return false;
  }

  move(point: [number, number]) {
    if (this.state !== 'push' || !this.target) return;
    const t = this.target;
    this.snap = this.layer.snapAt(point, (k) => k !== t.key);
    // Направление движения: вертикаль для верха/низа, нормаль стены для боковой грани
    const dir = t.edge ? t.edge.n : new THREE.Vector3(0, 0, 1);
    let d: number;
    if (this.snap) d = this.snap.local.clone().sub(t.from).dot(dir);
    else {
      const ray = this.layer.focusRay(point);
      if (!ray) return;
      d = closestOnLine(ray, t.from, dir);
    }
    this.dz = this.clamp(t, d);
    this.preview(t, this.dz);
    this.guide();
    this.updateVcb();
  }

  /** true — клавиша обработана инструментом. */
  key(e: KeyboardEvent): boolean {
    if (!this.active || e.type !== 'keydown') return false;
    if (e.key === 'Escape') {
      if (this.state === 'push') { this.cancel(); this.start(); } else this.stop();
      return true;
    }
    if (this.state !== 'push') return false;
    if (/^[\d.,-]$/.test(e.key)) { this.typed += e.key === ',' ? '.' : e.key; this.updateVcb(); return true; }
    if (e.key === 'Backspace') { this.typed = this.typed.slice(0, -1); this.updateVcb(); return true; }
    if (e.key === 'Enter') {
      const v = Number(this.typed);
      if (!this.typed || !Number.isFinite(v) || !this.target) return true;
      // Без знака — в ту сторону, куда тянули курсором
      const dz = this.typed.startsWith('-') ? v : this.dz < 0 ? -v : v;
      this.apply(this.clamp(this.target, dz));
      return true;
    }
    return false;
  }

  private apply(dz: number) {
    const t = this.target;
    this.cancel();
    this.state = 'pick';
    if (t && Math.abs(dz) > 1e-4) this.commit(t, dz);
    this.start();
  }

  private cancel() {
    if (this.state === 'push' && this.target) this.preview(this.target, undefined);
    this.layer.setMoveGuide(undefined);
    this.target = undefined;
    this.snap = undefined;
    this.typed = '';
    this.dz = 0;
    this.vcb.hidden = true;
  }

  /** Направляющая: вертикаль (цветом оси z) или нормаль стены. */
  private guide() {
    const t = this.target;
    if (!t) return;
    const dir = t.edge ? t.edge.n : new THREE.Vector3(0, 0, 1);
    const to = t.from.clone().addScaledVector(dir, this.dz);
    this.layer.setMoveGuide(t.edge ? { from: t.from, to } : { from: t.from, to, axis: 2, locked: 2 });
  }

  private updateVcb() {
    if (this.state !== 'push' || !this.target) { this.vcb.hidden = true; return; }
    this.vcb.hidden = false;
    const value = this.typed || (this.dz >= 0 ? '+' : '') + this.dz.toFixed(2);
    this.vcb.innerHTML = `<span class="vcb-label">${{ top: 'Верх', bottom: 'Низ', side: 'Стена' }[this.target.face]}</span><span class="vcb-value${this.typed ? ' typed' : ''}">${value}</span> м
      <span class="vcb-axis">${this.snap ? 'до точки' : this.target.face === 'side' ? 'по нормали' : 'по вертикали'}</span>`;
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

function segDist([px, py]: [number, number], [ax, ay]: [number, number], [bx, by]: [number, number]): number {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

function inRing([x, y]: [number, number], ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

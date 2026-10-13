import * as THREE from 'three';
import type { BuildingsLayer, SnapHit } from '../render/buildings-layer';
import { tr } from '../i18n';

type Pt = [number, number];

/** Точка разреза на контуре: сторона (i → i+1), положение на ней и, если попали в вершину, её номер. */
export interface CutPoint { edge: number; p: Pt; vertex?: number }
type Candidate = { key: string; z: number; start: CutPoint };

/**
 * Инструмент «Рассечь»: ломаная от ребра к ребру делит верхнюю грань на две.
 * 1. клик по ребру верхней грани (вершины и середины — с привязкой) — начало разреза;
 * 2. клики внутри грани добавляют изгибы, клик по ребру завершает разрез.
 *    Shift привязывает следующую точку к оси вдоль начального ребра или перпендикулярно ему.
 * Что можно резать и как делить данные — решают eligible и split снаружи. Esc — отмена.
 */
export class SplitTool {
  state: 'off' | 'pick' | 'cut' = 'off';
  private target?: string;
  private start?: CutPoint;
  /** Несколько частей на начальном ребре: ждём направления первого сегмента. */
  private candidates: Candidate[] = [];
  private bends: Pt[] = [];
  /** Привязка последнего пересчёта точки разреза — для маркера. */
  snap?: SnapHit;
  private z = 0;
  /** Оси от начала разреза: x — вдоль начального ребра, y — перпендикуляр к нему. */
  private axes?: { x: Pt; y: Pt };
  private axis?: 0 | 1;
  /** Ось, зафиксированная Shift. */
  private locked?: 0 | 1;
  private lastPoint?: [number, number];
  private shift = false;

  constructor(
    private readonly layer: BuildingsLayer,
    /** Выделенная часть имеет приоритет на общей границе. */
    private readonly selected: () => string | undefined,
    private readonly members: () => string[],
    /** Почему объект нельзя резать (undefined — можно). */
    private readonly eligible: (key: string) => string | undefined,
    private readonly split: (key: string, a: CutPoint, b: CutPoint, bends: Pt[]) => string | undefined,
    private readonly onState: (hint: string, error?: boolean) => void,
  ) {}

  get active() { return this.state !== 'off'; }

  begin() {
    this.state = 'pick';
    this.onState(tr('Рассечь: кликните по ребру верхней грани — начало разреза. Esc — выйти.'));
  }

  stop() {
    this.cancel();
    this.state = 'off';
    this.onState('');
  }

  click(point: [number, number]): boolean {
    if (this.state === 'pick') {
      const hits = this.layer.focusRayHits(point);
      const preferred = this.selected();
      const keys = [...new Set([...(preferred ? [preferred] : []), ...hits.map((h) => h.key), ...this.members()])];
      if (!keys.length) return false;
      const candidates: Candidate[] = [];
      let reason: string | undefined;
      for (const key of keys) {
        const why = this.eligible(key);
        if (why) { if (hits.some((h) => h.key === key)) reason ??= why; continue; }
        const box = this.layer.focusItemBox(key);
        if (!box) continue;
        this.target = key;
        this.z = box.max.z;
        const c = this.cutPointAt(point);
        if (c) candidates.push({ key, z: this.z, start: c });
      }
      if (!candidates.length) {
        this.target = undefined;
        if (!hits.length) return false;
        this.onState(reason ?? tr('Кликните точно по ребру верхней грани (вершины и середины подсвечиваются).'), true);
        return true;
      }
      this.candidates = preferred && candidates[0].key === preferred ? [] : candidates.length > 1 ? candidates : [];
      this.useCandidate(candidates[0]);
      this.bends = [];
      this.state = 'cut';
      this.guide(this.start!.p);
      this.onState(this.candidates.length
        ? tr('Общее ребро: кликните внутри нужной грани, чтобы выбрать направление разреза.')
        : tr('Кликайте внутри грани для изгибов разреза; клик по другому ребру завершит его. Shift — держать ось. Esc — отмена.'));
      return true;
    }
    if (this.state === 'cut' && this.target && this.start) {
      if (this.candidates.length) {
        const candidate = this.candidateAt(point);
        if (!candidate) { this.onState(tr('Общее ребро: кликните внутри нужной грани, чтобы выбрать направление разреза.'), true); return true; }
        this.useCandidate(candidate);
        this.candidates = [];
      }
      const c = this.cutPointAt(point);
      if (!c) {
        const raw = this.planePoint(point);
        const q = raw ? this.axisPoint(raw) : undefined;
        const ring = this.layer.focusPolygons(this.target)?.[0]?.outer;
        if (q && ring && insideRing(q, ring) && Math.hypot(q[0] - (this.bends.at(-1) ?? this.start.p)[0], q[1] - (this.bends.at(-1) ?? this.start.p)[1]) > 0.05) {
          this.bends.push(q);
          this.axis = this.locked = undefined;
          this.guide(q);
          this.onState(tr('Добавлена точка разреза. Продолжайте внутри грани или кликните по ребру для завершения.'));
        } else this.onState(tr('Точка разреза должна быть внутри верхней грани.'), true);
        return true;
      }
      const err = this.split(this.target, this.start, c, this.bends);
      if (err) { this.onState(err, true); return true; }
      this.cancel();
      this.begin();
      return true;
    }
    return false;
  }

  move(point: [number, number]) {
    this.lastPoint = point;
    if (this.state !== 'cut' || !this.start) return;
    if (this.candidates.length) {
      const candidate = this.candidateAt(point);
      if (candidate) this.useCandidate(candidate);
    }
    const c = this.cutPointAt(point);
    const raw = c?.p ?? this.planePoint(point);
    this.guide(c?.p ?? (raw ? this.axisPoint(raw) : undefined));
  }

  private useCandidate(candidate: Candidate) {
    this.target = candidate.key;
    this.z = candidate.z;
    this.start = candidate.start;
    const ring = this.layer.focusPolygons(candidate.key)![0].outer;
    const a = ring[candidate.start.edge], b = ring[(candidate.start.edge + 1) % ring.length];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    this.axes = { x: [(b[0] - a[0]) / l, (b[1] - a[1]) / l], y: [-(b[1] - a[1]) / l, (b[0] - a[0]) / l] };
    this.axis = this.locked = undefined;
  }

  /** Направление следующего сегмента определяет прилегающую грань, даже если клик пришёлся на её ребро. */
  private candidateAt(point: [number, number]): Candidate | undefined {
    const previousZ = this.z;
    const matches = this.candidates.filter((candidate) => {
      this.z = candidate.z;
      const q = this.planePoint(point);
      const ring = this.layer.focusPolygons(candidate.key)?.[0]?.outer;
      if (!q || !ring || Math.hypot(q[0] - candidate.start.p[0], q[1] - candidate.start.p[1]) <= 0.05) return false;
      const mid: Pt = [(q[0] + candidate.start.p[0]) / 2, (q[1] + candidate.start.p[1]) / 2];
      return insideRing(mid, ring);
    });
    this.z = previousZ;
    return matches.length === 1 ? matches[0] : undefined;
  }

  /** Привязать промежуточную точку к выбранной Shift оси от предыдущей точки. */
  private axisPoint(q: Pt): Pt {
    const s = this.bends.at(-1) ?? this.start?.p, ax = this.axes;
    this.axis = undefined;
    if (!this.shift || !s || !ax) return q;
    const d: Pt = [q[0] - s[0], q[1] - s[1]];
    const len = Math.hypot(d[0], d[1]);
    let axis = this.locked;
    if (axis === undefined && len > 1e-6) {
      axis = this.locked = Math.abs(d[0] * ax.y[0] + d[1] * ax.y[1]) > Math.abs(d[0] * ax.x[0] + d[1] * ax.x[1]) ? 1 : 0;
    }
    if (axis === undefined) return q;
    const u = axis ? ax.y : ax.x;
    this.axis = axis;
    const length = d[0] * u[0] + d[1] * u[1];
    return [s[0] + u[0] * length, s[1] + u[1] * length];
  }

  key(e: KeyboardEvent): boolean {
    if (!this.active) return false;
    if (e.key === 'Shift') {
      this.shift = e.type === 'keydown';
      this.locked = this.shift && this.state === 'cut' ? this.axis ?? this.locked : undefined;
      if (this.state === 'cut' && this.lastPoint) this.move(this.lastPoint);
      return true;
    }
    if (e.type !== 'keydown' || e.key !== 'Escape') return false;
    if (this.state === 'cut') { this.cancel(); this.begin(); } else this.stop();
    return true;
  }

  /** Точка под курсором на плоскости верхней грани. */
  private planePoint(point: [number, number]): Pt | undefined {
    const ray = this.layer.focusRay(point);
    if (!ray || Math.abs(ray.direction.z) < 1e-6) return;
    const t = (this.z - ray.origin.z) / ray.direction.z;
    if (t <= 0) return;
    const q = ray.at(t, new THREE.Vector3());
    return [q.x, q.y];
  }

  /** Точка разреза на ребре: привязка к вершине/середине или ближайшая точка ребра в пределах допуска. */
  private cutPointAt(point: [number, number]): CutPoint | undefined {
    const ring = this.target ? this.layer.focusPolygons(this.target)?.[0]?.outer : undefined;
    if (!ring) return;
    // Перпендикуляр к ребру строится от последней точки текущего сегмента.
    const previous = this.bends.at(-1) ?? this.start?.p;
    const from = previous && new THREE.Vector3(previous[0], previous[1], this.z);
    const snap = this.snap = this.layer.snapAt(point, (k) => k === this.target, undefined, { from });
    const onTop = snap && Math.abs(snap.local.z - this.z) < 0.05 && snap.kind !== 'center';
    const q: Pt | undefined = onTop ? [snap.local.x, snap.local.y] : this.planePoint(point);
    if (!q) return;
    const ray = this.layer.focusRay(point);
    const dist = ray ? ray.origin.distanceTo(new THREE.Vector3(q[0], q[1], this.z)) : 50;
    const tol = onTop ? 0.05 : Math.max(0.3, dist * 0.015);
    let best: CutPoint & { d: number } | undefined;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
      if (!l2) continue;
      const t = Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / l2));
      const p: Pt = [a[0] + t * dx, a[1] + t * dy];
      const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (d < tol && (!best || d < best.d)) {
        // У самой вершины — сама вершина (без нового узла)
        const vertex = t * Math.sqrt(l2) < 0.05 ? i : (1 - t) * Math.sqrt(l2) < 0.05 ? (i + 1) % ring.length : undefined;
        best = { edge: i, p: vertex === undefined ? p : ring[vertex], vertex, d };
      }
    }
    if (!best) return;
    const { d: _d, ...c } = best;
    void _d;
    return c;
  }

  private guide(to: Pt | undefined) {
    if (!this.start) return;
    const from = new THREE.Vector3(this.start.p[0], this.start.p[1], this.z);
    this.layer.setMoveGuide({ from, to: to ? new THREE.Vector3(to[0], to[1], this.z) : undefined, path: this.bends.map((p) => new THREE.Vector3(p[0], p[1], this.z)), axis: this.axis, locked: this.locked, axes: this.axes, dashSize: 0.2, gapSize: 0.12 });
  }

  private cancel() {
    this.layer.setMoveGuide(undefined);
    this.target = undefined;
    this.start = undefined;
    this.candidates = [];
    this.bends = [];
    this.axes = this.axis = this.locked = undefined;
    this.shift = false;
    this.lastPoint = undefined;
    this.snap = undefined;
  }
}

function insideRing([x, y]: Pt, ring: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

import * as THREE from 'three';
import { LngLat } from 'maplibre-gl';
import type { BuildingsLayer, FocusHit, SnapHit } from '../render/buildings-layer';
import { tr } from '../i18n';

type Pt = [number, number];

/**
 * Точка разреза на контуре: кольцо (0 — внешнее, k — внутреннее k-1), сторона (i → i+1), положение на ней
 * и, если попали в вершину, её номер.
 */
export interface CutPoint { poly: number; ring: number; edge: number; p: Pt; vertex?: number }

/** Кольца полигона по номеру: 0 — внешнее, дальше — внутренние. */
const ringsOf = (p: { outer: Pt[]; inners: Pt[][] }) => [p.outer, ...p.inners];
type Candidate = { key: string; z: number; start: CutPoint };

/**
 * Инструмент «Рассечь»: ломаная от ребра к ребру делит верхнюю грань на две.
 * 1. клик по ребру верхней грани (вершины и середины — с привязкой) — начало разреза;
 * 2. клики внутри грани добавляют изгибы, клик по ребру завершает разрез.
 *    Shift привязывает следующую точку к оси вдоль начального ребра или перпендикулярно ему.
 * Первый клик внутри грани (не у ребра) — замкнутое кольцо: точки внутри грани, клик в первую точку
 * его замыкает — объект получает дыру, внутри — новая часть (двор, башня, атриум).
 * Что можно резать и как делить данные — решают eligible и split снаружи. Esc — отмена.
 */
export class SplitTool {
  state: 'off' | 'pick' | 'cut' = 'off';
  private target?: string;
  private start?: CutPoint;
  /** Несколько частей на начальном ребре: ждём направления первого сегмента. */
  private candidates: Candidate[] = [];
  private bends: Pt[] = [];
  /** Замкнутое кольцо внутри грани: объект, его полигон и точки. */
  private loop?: { key: string; poly: number; pts: Pt[] };
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
    /** Вырезать кольцо ring (метры сцены) из полигона poly объекта key. */
    private readonly hole: (key: string, poly: number, ring: Pt[]) => string | undefined,
    private readonly onState: (hint: string, error?: boolean) => void,
  ) {}

  get active() { return this.state !== 'off'; }

  begin() {
    this.state = 'pick';
    this.onState(tr('Рассечь: кликните по ребру верхней грани — начало разреза, или внутри грани — замкнутое кольцо (двор, башня). Esc — выйти.'));
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
      const ray = this.layer.focusRay(point);
      for (const key of keys) {
        const why = this.eligible(key);
        if (why) { if (hits.some((h) => h.key === key)) reason ??= why; continue; }
        const box = this.layer.focusItemBox(key);
        if (!box) continue;
        // Верх, заслонённый ближней поверхностью (часть под крышей другой), — не кандидат: его ребро не видно
        if (ray && hits.length && key !== hits[0].key && Math.abs(ray.direction.z) > 1e-6) {
          const t = (box.max.z - ray.origin.z) / ray.direction.z;
          if (t > hits[0].t + 0.05) continue;
        }
        this.target = key;
        this.z = box.max.z;
        for (let poly = 0; poly < (this.layer.focusPolygons(key)?.length ?? 0); poly++) {
          const c = this.cutPointAt(point, poly);
          if (c) candidates.push({ key, z: this.z, start: c });
        }
      }
      if (!candidates.length) {
        this.target = undefined;
        if (!hits.length) return false;
        if (this.startLoop(point, hits[0])) return true;
        this.onState(reason ?? tr('Кликните точно по ребру верхней грани (вершины и середины подсвечиваются).'), true);
        return true;
      }
      this.candidates = preferred && candidates[0].key === preferred && candidates.filter((c) => c.key === preferred).length === 1
        ? [] : candidates.length > 1 ? candidates : [];
      this.useCandidate(candidates[0]);
      this.bends = [];
      this.state = 'cut';
      this.guide(this.start!.p);
      this.onState(this.candidates.length
        ? tr('Общее ребро: кликните внутри нужной грани, чтобы выбрать направление разреза.')
        : tr('Кликайте внутри грани для изгибов разреза; клик по другому ребру завершит его. Shift — держать ось. Esc — отмена.'));
      return true;
    }
    if (this.state === 'cut' && this.loop) return this.loopClick(point);
    if (this.state === 'cut' && this.target && this.start) {
      if (this.candidates.length) {
        const candidate = this.candidateAt(point);
        if (!candidate) { this.onState(tr('Общее ребро: кликните внутри нужной грани, чтобы выбрать направление разреза.'), true); return true; }
        this.useCandidate(candidate);
        this.candidates = [];
      }
      const { end: c, q } = this.cutEnd(point);
      if (!c) {
        const polygon = this.layer.focusPolygons(this.target)?.[this.start.poly];
        if (q && polygon && insideRing(q, polygon.outer) && !polygon.inners.some((hole) => insideRing(q, hole))
          && Math.hypot(q[0] - (this.bends.at(-1) ?? this.start.p)[0], q[1] - (this.bends.at(-1) ?? this.start.p)[1]) > 0.05) {
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
    if (this.state === 'cut' && this.loop) {
      const q = this.pointAt(point);
      this.guide(this.closesLoop(point) ? this.loop.pts[0] : q);
      return;
    }
    if (this.state !== 'cut' || !this.start) return;
    if (this.candidates.length) {
      const candidate = this.candidateAt(point);
      if (candidate) this.useCandidate(candidate);
    }
    const { end, q } = this.cutEnd(point);
    this.guide(end?.p ?? q);
  }

  /**
   * Конец разреза под курсором: клик по ребру (без Shift — по самому курсору) или точка, где следующий отрезок
   * (с привязками и осью Shift) доходит до стороны контура или пересекает её, — иначе q, следующий изгиб.
   */
  private cutEnd(point: [number, number]): { end?: CutPoint; q?: Pt } {
    const c = this.shift ? undefined : this.cutPointAt(point);
    if (c) return { end: c, q: c.p };
    const q = this.pointAt(point);
    const end = q && this.crossing(q);
    if (end && Math.hypot(end.p[0] - q[0], end.p[1] - q[1]) > 0.05) this.snap = undefined; // привязка осталась за стороной
    return { end, q };
  }

  /** Первая точка, где отрезок от предыдущей точки разреза до q касается стороны контура или пересекает её. */
  private crossing(q: Pt): CutPoint | undefined {
    if (!this.start || !this.target) return;
    const polygon = this.layer.focusPolygons(this.target)?.[this.start.poly];
    if (!polygon) return;
    const prev = this.bends.at(-1) ?? this.start.p;
    const rx = q[0] - prev[0], ry = q[1] - prev[1];
    let best: { s: number; c: CutPoint } | undefined;
    ringsOf(polygon).forEach((ring, ri) => {
      const take = (s: number, edge: number, p: Pt) => {
        if (Math.hypot(p[0] - prev[0], p[1] - prev[1]) <= 0.05 || (best && best.s <= s)) return;
        const a = ring[edge], b = ring[(edge + 1) % ring.length];
        const vertex = Math.hypot(p[0] - a[0], p[1] - a[1]) < 0.05 ? edge : Math.hypot(p[0] - b[0], p[1] - b[1]) < 0.05 ? (edge + 1) % ring.length : undefined;
        best = { s, c: { poly: this.start!.poly, ring: ri, edge, p: vertex === undefined ? p : ring[vertex], vertex } };
      };
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        const ex = b[0] - a[0], ey = b[1] - a[1], l2 = ex * ex + ey * ey;
        if (!l2) continue;
        // Конец отрезка на самой стороне
        const t = Math.max(0, Math.min(1, ((q[0] - a[0]) * ex + (q[1] - a[1]) * ey) / l2));
        const foot: Pt = [a[0] + t * ex, a[1] + t * ey];
        if (Math.hypot(q[0] - foot[0], q[1] - foot[1]) < 0.05) take(1, i, foot);
        // Пересечение отрезка со стороной
        const den = rx * ey - ry * ex;
        if (Math.abs(den) < 1e-12) continue;
        const wx = a[0] - prev[0], wy = a[1] - prev[1];
        const sp = (wx * ey - wy * ex) / den, u = (wx * ry - wy * rx) / den;
        if (sp > 0 && sp <= 1 && u >= 0 && u <= 1) take(sp, i, [prev[0] + sp * rx, prev[1] + sp * ry]);
      }
    });
    return best?.c;
  }

  private useCandidate(candidate: Candidate) {
    this.target = candidate.key;
    this.z = candidate.z;
    this.start = candidate.start;
    const ring = ringsOf(this.layer.focusPolygons(candidate.key)![candidate.start.poly])[candidate.start.ring];
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
      const polygon = this.layer.focusPolygons(candidate.key)?.[candidate.start.poly];
      if (!q || !polygon || Math.hypot(q[0] - candidate.start.p[0], q[1] - candidate.start.p[1]) <= 0.05) return false;
      const mid: Pt = [(q[0] + candidate.start.p[0]) / 2, (q[1] + candidate.start.p[1]) / 2];
      return insideRing(mid, polygon.outer) && !polygon.inners.some((hole) => insideRing(mid, hole));
    });
    this.z = previousZ;
    return matches.length === 1 ? matches[0] : undefined;
  }

  /** Начать кольцо: первый клик — на плоской верхней грани разрешённого объекта, внутри контура. */
  private startLoop(point: [number, number], hit: FocusHit): boolean {
    const key = hit.key;
    const box = this.layer.focusItemBox(key);
    const polygons = this.layer.focusPolygons(key);
    if (this.eligible(key) || !box || !polygons || hit.face !== 'roof' || Math.abs(hit.local.z - box.max.z) > 0.05) return false;
    this.z = box.max.z;
    const q = this.planePoint(point);
    const poly = q ? polygons.findIndex((p) => insideRing(q, p.outer) && !p.inners.some((h) => insideRing(q, h))) : -1;
    if (!q || poly < 0) return false;
    // Оси — по ближайшей стороне контура
    const ring = polygons[poly].outer;
    let best = 0, bd = Infinity;
    for (let i = 0; i < ring.length; i++) {
      const d = segDist(q, ring[i], ring[(i + 1) % ring.length]);
      if (d < bd) { bd = d; best = i; }
    }
    const a = ring[best], b = ring[(best + 1) % ring.length];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    this.axes = { x: [(b[0] - a[0]) / l, (b[1] - a[1]) / l], y: [-(b[1] - a[1]) / l, (b[0] - a[0]) / l] };
    this.axis = this.locked = undefined;
    this.target = key;
    this.loop = { key, poly, pts: [q] };
    this.state = 'cut';
    this.guide(q);
    this.onState(tr('Кольцо: кликайте внутри грани, клик в первую точку замкнёт его. Shift — держать ось. Backspace — убрать точку, Esc — отмена.'));
    return true;
  }

  private loopClick(point: [number, number]): boolean {
    const loop = this.loop!;
    if (loop.pts.length >= 3 && this.closesLoop(point)) {
      const err = this.hole(loop.key, loop.poly, loop.pts);
      if (err) { this.onState(err, true); return true; }
      this.cancel();
      this.begin();
      return true;
    }
    const q = this.pointAt(point);
    const polygon = this.layer.focusPolygons(loop.key)?.[loop.poly];
    const last = loop.pts.at(-1)!;
    if (!q || !polygon || !insideRing(q, polygon.outer) || polygon.inners.some((h) => insideRing(q, h))) {
      this.onState(tr('Точки кольца — внутри верхней грани, не на её рёбрах.'), true);
      return true;
    }
    if (Math.hypot(q[0] - last[0], q[1] - last[1]) <= 0.05) return true;
    loop.pts.push(q);
    this.axis = this.locked = undefined;
    this.guide(q);
    this.onState(loop.pts.length >= 3
      ? tr('Кликните в первую точку, чтобы замкнуть кольцо, или продолжайте. Backspace — убрать точку.')
      : tr('Кольцо: кликайте внутри грани, клик в первую точку замкнёт его. Shift — держать ось. Backspace — убрать точку, Esc — отмена.'));
    return true;
  }

  /** Курсор у первой точки кольца (на экране). */
  private closesLoop(point: [number, number]): boolean {
    const first = this.loop?.pts[0];
    if (!first || this.loop!.pts.length < 3) return false;
    const s = this.layer.focusProject(new THREE.Vector3(first[0], first[1], this.z));
    return !!s && Math.hypot(s[0] - point[0], s[1] - point[1]) < CLOSE_RADIUS_PX;
  }

  /** Точки разреза или кольца, поставленные до сих пор. */
  private ownPoints(): Pt[] {
    return this.loop ? this.loop.pts : this.start ? [this.start.p, ...this.bends] : [];
  }

  /**
   * Следующая точка разреза или кольца: с Shift — по оси от предыдущей; иначе привязка на этой плоскости (точки
   * объектов и самого разреза), пересечение или одна из линий выравнивания от точек разреза, иначе курсор.
   */
  private pointAt(point: [number, number]): Pt | undefined {
    this.snap = undefined;
    const raw = this.planePoint(point);
    const own = this.ownPoints();
    const key = this.target ?? '';
    const at = (p: Pt) => new THREE.Vector3(p[0], p[1], this.z);
    const extra = own.flatMap((p, i) => [
      { kind: 'vertex' as const, key, p: at(p), label: tr('Точка разреза') },
      ...(i ? [{ kind: 'midpoint' as const, key, p: at([(p[0] + own[i - 1][0]) / 2, (p[1] + own[i - 1][1]) / 2]) }] : []),
    ]);
    const prev = own.at(-1);
    // С Shift линия идёт по зафиксированной оси — перпендикуляр из якоря опускается на неё
    const ax = this.shift && this.locked !== undefined && this.axes ? (this.locked ? this.axes.y : this.axes.x) : undefined;
    const s = this.layer.snapAt(point, undefined, undefined, { from: prev && at(prev), extra, dir: ax && new THREE.Vector3(ax[0], ax[1], 0) });
    const flat = s && s.kind !== 'center' && Math.abs(s.local.z - this.z) < 0.05 ? s : undefined;
    if (this.shift) {
      const q: Pt | undefined = flat ? [flat.local.x, flat.local.y] : raw;
      return q && this.axisPoint(q);
    }
    this.axis = undefined;
    const use = (h: SnapHit): Pt => { this.snap = h; return [h.local.x, h.local.y]; };
    if (flat && STRONG_SNAPS.has(flat.kind)) return use(flat);
    const inferred = raw && this.inference(point, raw, own);
    if (inferred) return use(inferred);
    if (flat) return use(flat);
    return raw;
  }

  /**
   * Линии выравнивания от точек разреза: вдоль осей и вдоль первого отрезка и перпендикулярно ему. Курсор у двух
   * линий разных направлений — их пересечение (угол прямоугольника), у одной — точка на ней.
   */
  private inference(point: [number, number], raw: Pt, own: Pt[]): SnapHit | undefined {
    if (!own.length) return;
    const dirs: Pt[] = [];
    const add = (u: Pt) => { if (!dirs.some((d) => Math.abs(d[0] * u[1] - d[1] * u[0]) < 0.02)) dirs.push(u); };
    if (this.axes) { add(this.axes.x); add(this.axes.y); }
    if (own.length >= 2) {
      const dx = own[1][0] - own[0][0], dy = own[1][1] - own[0][1], l = Math.hypot(dx, dy);
      if (l > 1e-6) { add([dx / l, dy / l]); add([-dy / l, dx / l]); }
    }
    const at = (p: Pt) => new THREE.Vector3(p[0], p[1], this.z);
    const screen = (p: Pt) => {
      const px = this.layer.focusProject(at(p));
      return px ? Math.hypot(px[0] - point[0], px[1] - point[1]) : Infinity;
    };
    const lines: { o: Pt; u: Pt; foot: Pt; d: number }[] = [];
    for (const o of own) for (const u of dirs) {
      const t = (raw[0] - o[0]) * u[0] + (raw[1] - o[1]) * u[1];
      if (Math.abs(t) < 0.3) continue; // у самой точки линии сходятся — не мешаем
      const foot: Pt = [o[0] + u[0] * t, o[1] + u[1] * t];
      const d = screen(foot);
      if (d <= INFER_RADIUS_PX) lines.push({ o, u, foot, d });
    }
    if (!lines.length) return;
    lines.sort((a, b) => a.d - b.d);
    const hit = (p: Pt, kind: SnapHit['kind'], label: string, along: Pt): SnapHit | undefined => {
      const px = this.layer.focusProject(at(p));
      const ll = this.layer.focusToLngLat(p[0], p[1]);
      return px && ll ? { kind, key: this.target ?? '', local: at(p), lngLat: new LngLat(ll[0], ll[1]), altitude: this.z, point: px, along: at(along), label } : undefined;
    };
    for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) {
      const a = lines[i], b = lines[j];
      const cross = a.u[0] * b.u[1] - a.u[1] * b.u[0];
      if (Math.abs(cross) < 0.02) continue;
      const t = ((b.o[0] - a.o[0]) * b.u[1] - (b.o[1] - a.o[1]) * b.u[0]) / cross;
      const p: Pt = [a.o[0] + a.u[0] * t, a.o[1] + a.u[1] * t];
      if (screen(p) <= INFER_RADIUS_PX * 1.5) return hit(p, 'tracked', tr('Пересечение'), a.o);
    }
    return hit(lines[0].foot, 'extension', tr('От точки разреза'), lines[0].o);
  }

  /** Привязать промежуточную точку к выбранной Shift оси от предыдущей точки. */
  private axisPoint(q: Pt): Pt {
    const s = this.loop?.pts.at(-1) ?? this.bends.at(-1) ?? this.start?.p, ax = this.axes;
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
    if (e.type === 'keydown' && e.key === 'Backspace' && this.loop) {
      if (this.loop.pts.length > 1) this.loop.pts.pop();
      else { this.cancel(); this.begin(); return true; }
      this.axis = this.locked = undefined;
      if (this.lastPoint) this.move(this.lastPoint); else this.guide(this.loop.pts.at(-1));
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
  private cutPointAt(point: [number, number], onlyPoly?: number): CutPoint | undefined {
    if (!this.target) return;
    // Перпендикуляр к ребру строится от последней точки текущего сегмента.
    const previous = this.bends.at(-1) ?? this.start?.p;
    const from = previous && new THREE.Vector3(previous[0], previous[1], this.z);
    const snap = this.snap = this.layer.snapAt(point, (k) => k === this.target, undefined, { from });
    const onTop = snap && Math.abs(snap.local.z - this.z) < 0.05 && snap.kind !== 'center';
    const best = (onTop ? this.nearestEdge([snap.local.x, snap.local.y], point, true, onlyPoly) : undefined)
      ?? this.nearestEdge(this.planePoint(point), point, false, onlyPoly);
    if (!best) return;
    const { d: _d, ...c } = best;
    void _d;
    return c;
  }

  /** Ближайшая к q точка стороны контура: exact — q уже точка привязки (до 5 см), иначе — до EDGE_PX на экране. */
  private nearestEdge(q: Pt | undefined, point: [number, number], exact: boolean, onlyPoly?: number): (CutPoint & { d: number }) | undefined {
    const polygons = this.target ? this.layer.focusPolygons(this.target) : undefined;
    if (!q || !polygons) return;
    // Допуск — на экране: в метрах он рос с расстоянием, и издали на небольшой крыше любой клик был «у ребра»
    const px = (p: Pt) => {
      const sp = this.layer.focusProject(new THREE.Vector3(p[0], p[1], this.z));
      return sp ? Math.hypot(sp[0] - point[0], sp[1] - point[1]) : Infinity;
    };
    let best: CutPoint & { d: number } | undefined;
    for (let poly = 0; poly < polygons.length; poly++) {
      if ((this.start && poly !== this.start.poly) || (onlyPoly !== undefined && poly !== onlyPoly)) continue;
      ringsOf(polygons[poly]).forEach((ring, ri) => {
        for (let i = 0; i < ring.length; i++) {
          const a = ring[i], b = ring[(i + 1) % ring.length];
          const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
          if (!l2) continue;
          const t = Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / l2));
          const p: Pt = [a[0] + t * dx, a[1] + t * dy];
          const d = exact ? Math.hypot(q[0] - p[0], q[1] - p[1]) : px(p);
          if ((exact ? d < 0.05 : d <= EDGE_PX) && (!best || d < best.d)) {
            const vertex = t * Math.sqrt(l2) < 0.05 ? i : (1 - t) * Math.sqrt(l2) < 0.05 ? (i + 1) % ring.length : undefined;
            best = { poly, ring: ri, edge: i, p: vertex === undefined ? p : ring[vertex], vertex, d };
          }
        }
      });
    }
    return best;
  }

  private guide(to: Pt | undefined) {
    if (this.loop) {
      const [first, ...rest] = this.loop.pts.map((p) => new THREE.Vector3(p[0], p[1], this.z));
      this.layer.setMoveGuide({ from: first, to: to ? new THREE.Vector3(to[0], to[1], this.z) : undefined, path: rest, axis: this.axis, locked: this.locked, axes: this.axes, dashSize: 0.2, gapSize: 0.12, widthPx: 2.5 });
      return;
    }
    if (!this.start) return;
    const from = new THREE.Vector3(this.start.p[0], this.start.p[1], this.z);
    this.layer.setMoveGuide({ from, to: to ? new THREE.Vector3(to[0], to[1], this.z) : undefined, path: this.bends.map((p) => new THREE.Vector3(p[0], p[1], this.z)), axis: this.axis, locked: this.locked, axes: this.axes, dashSize: 0.2, gapSize: 0.12, widthPx: 2.5 });
  }

  private cancel() {
    this.layer.setMoveGuide(undefined);
    this.target = undefined;
    this.start = undefined;
    this.loop = undefined;
    this.candidates = [];
    this.bends = [];
    this.axes = this.axis = this.locked = undefined;
    this.shift = false;
    this.lastPoint = undefined;
    this.snap = undefined;
  }
}

/** Привязки, которые важнее линий выравнивания. */
const STRONG_SNAPS = new Set<SnapHit['kind']>(['vertex', 'midpoint', 'perpendicular', 'tracked']);
/** Как близко к линии выравнивания курсор ловится на неё, px. */
const INFER_RADIUS_PX = 8;

/** Как близко к ребру верхней грани на экране клик считается кликом по ребру, px. */
const EDGE_PX = 8;

/** Радиус «попал в первую точку кольца», px. */
const CLOSE_RADIUS_PX = 12;

function segDist([px, py]: Pt, [ax, ay]: Pt, [bx, by]: Pt): number {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

function insideRing([x, y]: Pt, ring: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

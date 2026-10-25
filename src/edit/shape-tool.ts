import * as THREE from 'three';
import type { BuildingsLayer, SnapHit, SnapOpts } from '../render/buildings-layer';
import { linkedNote, glueClick, glueSwitch, isGlueKey, loadGlue, saveGlue } from './glue';
import { tr, trn } from '../i18n';
import { MIN_ROOF_HEIGHT } from './push-height';
import { LEVEL_HEIGHT } from '../osm/heights';

type Pt = [number, number];

/** Угол между движением курсора и направлением на экране, при котором движение «прилипает» к нему. */
const AXIS_SNAP_DEG = 15;
/** Курсор ближе к точке захвата — направление ещё не определено. */
const MIN_DRAG_PX = 6;
/** Как близко (px) к вертикальному ребру стены курсор берёт вершину. */
const GRAB_PX = 12;
/** Как близко (px) к стороне (верху или низу стены) курсор берёт точку на ней — новую вершину. */
const EDGE_PX = 8;
/** Точка на стороне ближе этого к её концу (доля длины) — не новая вершина: там уже есть. */
const EDGE_END = 0.02;

/**
 * Захваченная вершина: объект, полигон, кольцо (0 — внешнее, 1… — дыры), номер вершины и точка захвата (метры сцены).
 * insert — захвачена точка на стороне i → i+1 (её положение на стороне, 0…1): там встанет новая вершина.
 * roof — захвачена ручка крыши (верхняя точка): сдвиг только по вертикали, меняется высота крыши; poly, ring, i не нужны.
 * eave — захвачена ручка верха стен (основание крыши): по вертикали, меняется высота стен, крыша едет целиком.
 * also — другие вершины, выбранные рамкой: едут (удаляются) вместе с захваченной.
 */
export interface ShapeTarget { key: string; poly: number; ring: number; i: number; from: THREE.Vector3; insert?: number; roof?: boolean; eave?: boolean; also?: ShapeVert[] }

/** Вершина кольца: полигон, кольцо (0 — внешнее), номер. */
export interface ShapeVert { poly: number; ring: number; i: number }
const vertKey = (v: ShapeVert) => `${v.poly}:${v.ring}:${v.i}`;
/** Оси, по которым ходят ручки: вершины основания — в плане, верх стен и крыша — по вертикали. */
const PLAN = [0, 1] as const, VERTICAL = [2] as const;
/** Ниже этого стены ручкой верха не опускаются. */
const MIN_WALL_HEIGHT = 0.2;

type Hover = { index?: number; point?: THREE.Vector3; roof?: number; eave?: number };

/** Направления, к которым прилипает движение: оси здания и стороны у вершины. */
type Dir = { v: THREE.Vector3; name: string; axis?: 0 | 1 };

/**
 * Инструмент «Форма»: правка контура выделенной части по вершинам (только в плане — в Simple 3D у вершины нет высоты).
 * 1. клик по вершине выделенной части — захват; вершину можно взять на любой высоте вертикального ребра стены,
 *    маркеры вершин — у основания, видны поверх геометрии (заслонённые — полые). Клик по стороне у основания — новая
 *    вершина ровно на стороне (сразу применяется), дальше её можно отвести, как обычную. Клик мимо — выбрать другой объект
 *    (мимо всех — снять выделение). Shift+клик по вершине или Shift+рамка — выбрать несколько вершин основания: захват
 *    любой из них двигает все, Del удаляет все;
 * 2. движение курсора — вершина едет по горизонтали; прилипает к осям здания и продолжениям сторон у вершины,
 *    привязка к точке другого объекта ставит вершину в неё (по высоте — проекция);
 * 3. второй клик — применить; число + Enter — сдвиг в метрах по текущему направлению. Shift держит направление.
 *    Вершина у соседней по кольцу (на экране) — прилипает к ней, клик сливает их (захваченная пропадает).
 * Del — удалить вершину под курсором (или захваченную).
 * Ручки крыши (конёк, вершина пирамиды или купола, верхнее ребро односкатной) — только по вертикали: верх стен стоит,
 * меняется высота крыши (не ниже MIN_ROOF_HEIGHT); привязка к точке другого объекта — по её высоте.
 * Ручки верха стен (вершины по верху стены) — тоже по вертикали: меняется высота стен, крыша не меняется. У верхнего
 * конца вертикального ребра ручка верха стен важнее вершины: вершину берут ниже по ребру или у основания.
 * Общие с соседями узлы (D): «с соседями» — соседи тянутся следом, «отдельно» — у части новый узел.
 * Esc — отмена, повторный Esc — выйти. Пересчёт геометрии, проверка и правки — снаружи (preview, commit).
 */
export class ShapeTool {
  state: 'off' | 'pick' | 'drag' = 'off';
  snap?: SnapHit;
  glue = loadGlue();
  /** Сколько соседей тянется в текущем превью (задаёт preview). */
  linked = 0;
  private target?: ShapeTarget;
  private offset = new THREE.Vector3();
  private dir?: Dir;
  private locked?: Dir;
  private shiftLock = false;
  private typed = '';
  /** Почему текущее положение нельзя применить (самопересечение и т. п.). */
  private problem?: string;
  /** Под курсором: номер вершины или точка на стороне (новая вершина). */
  private hover?: Hover;
  /** Захваченная вершина у соседней по кольцу — клик сольёт их. */
  private merge = false;
  /** Вершины, выбранные Shift+кликом или рамкой (у объекта pickedKey). */
  private picked = new Map<string, ShapeVert>();
  private pickedKey?: string;
  /** Точка захвата в плоскости основания (под курсором в момент захвата). */
  private grabBase = new THREE.Vector3();
  /** Места едущих вершин до сдвига (превью двигает саму геометрию слоя). */
  private origin = new Map<string, [number, number]>();
  /** Свои точки привязки на время сдвига: середины сторон в исходном виде (в превью стороны уже сдвинуты). */
  private extraSnaps: NonNullable<SnapOpts['extra']> = [];
  /** Шаг сдвига по вертикали: высота задана только этажами — целыми этажами. */
  private step?: number;
  /** Высота задана только этажами: пояснение (меняется целыми этажами, как перейти на метры); undefined — в метрах. */
  levelLock?: (t: ShapeTarget) => string | undefined;
  /** Какие теги и как изменит сдвиг ручки крыши или верха стен на dz — для панели во время сдвига. */
  tagChanges?: (t: ShapeTarget, dz: number) => string;
  private lastPoint?: [number, number];
  private readonly vcb: HTMLDivElement;

  constructor(
    private readonly layer: BuildingsLayer,
    container: HTMLElement,
    /** Выделенная часть, вершины которой правим (одна, член здания). */
    private readonly selected: () => string | undefined,
    /** Низ и верх стен объекта и высота крыши, м сцены. */
    private readonly walls: (key: string) => { min: number; top: number; roof: number } | undefined,
    /** Объекты, к которым не привязываемся во время сдвига (сам объект и соседи в превью). */
    private readonly moving: () => ReadonlySet<string>,
    /** Превью; строка — почему так нельзя. offset undefined — вернуть как было. */
    private readonly preview: (t: ShapeTarget, offset: THREE.Vector3 | undefined) => string | undefined,
    /** Применить; false — не вышло (сам объяснил). */
    private readonly commit: (t: ShapeTarget, offset: THREE.Vector3) => boolean,
    /** Удалить вершину t; merged — слита с соседней (для сообщения). */
    private readonly remove: (t: ShapeTarget, merged: boolean) => void,
    private readonly onState: (hint: string, error?: boolean) => void,
  ) {
    this.vcb = document.createElement('div');
    this.vcb.className = 'vcb';
    this.vcb.hidden = true;
    container.appendChild(this.vcb);
    for (const ev of ['mousedown', 'click', 'dblclick'] as const) this.vcb.addEventListener(ev, (e) => e.stopPropagation());
    this.vcb.addEventListener('click', (e) => {
      const g = glueClick(e);
      if (g !== undefined) this.setGlue(g);
    });
  }

  get active() { return this.state !== 'off'; }

  /** Последняя подсказка: повторно не выдаём — иначе она затёрла бы сообщение о только что применённой правке. */
  private hint?: string;
  private say(hint: string, error = false) {
    if (hint === this.hint && !error) return;
    this.hint = error ? undefined : hint;
    this.onState(hint, error);
  }

  start() {
    this.glue = loadGlue();
    this.state = 'pick';
    this.refresh();
  }

  stop() {
    this.cancelDrag();
    this.state = 'off';
    this.hover = undefined;
    this.layer.setHandles(undefined);
    this.vcb.hidden = true;
    this.say('');
  }

  setGlue(on: boolean) {
    this.glue = on;
    saveGlue(on);
    if (this.state === 'drag' && this.target) {
      // Превью прежнего режима могло задеть соседей — сбросить его целиком
      this.preview(this.target, undefined);
      this.problem = this.preview(this.target, this.offset);
    }
    this.updateVcb();
  }

  /** Выделение или геометрия поменялись снаружи — перерисовать маркеры и подсказку. */
  refresh() {
    if (this.state === 'drag') { if (this.lastPoint) this.move(this.lastPoint); return; }
    if (this.state !== 'pick') return;
    if (this.selected() !== this.pickedKey) { this.picked.clear(); this.pickedKey = this.selected(); }
    if (this.lastPoint) this.hover = this.hoverAt(this.lastPoint);
    this.showHandles();
    this.updateVcb();
    this.say(this.selected()
      ? tr('Форма: кликните по вершине выделенной части (на любой высоте ребра стены), по стороне — новая вершина, по ручке крыши — её высота. Клик по другому объекту — выбрать его. Esc — выйти.')
      : tr('Форма: выберите часть здания кликом, затем кликните по её вершине. Esc — выйти.'));
  }

  /** Рамку можно тянуть: инструмент ждёт захвата, часть выделена. */
  get canBox() { return this.state === 'pick' && !!this.selected(); }

  /** Shift+рамка (px экрана): вершины основания внутри — к выбранным. */
  boxSelect(x0: number, y0: number, x1: number, y1: number) {
    const key = this.selected();
    const polys = key ? this.layer.focusPolygons(key) : undefined;
    const w = key ? this.walls(key) : undefined;
    if (!key || !polys || !w) return;
    polys.forEach((p, poly) => [p.outer, ...p.inners].forEach((r, ring) => r.forEach(([x, y], i) => {
      const q = this.layer.focusProject(new THREE.Vector3(x, y, w.min));
      if (q && q[0] >= x0 && q[0] <= x1 && q[1] >= y0 && q[1] <= y1) this.picked.set(vertKey({ poly, ring, i }), { poly, ring, i });
    })));
    this.pickedKey = key;
    this.showHandles();
  }

  /** true — клик ушёл в инструмент; false — не по вершине (main выбирает объект под курсором). */
  click(point: [number, number], shift = false): boolean {
    if (this.state === 'drag') {
      if (this.merge && this.target) {
        const t = this.target;
        this.cancelDrag();
        this.state = 'pick';
        this.remove(t, true);
        this.refresh();
        return true;
      }
      if (this.problem) { this.say(this.problem, true); return true; }
      this.apply(this.offset);
      return true;
    }
    if (this.state !== 'pick') return false;
    // У верхнего конца ребра — ручка верха стен, а не вершина
    const eave = this.eaveAt(point);
    // Курсор прямо на ручке крыши — она важнее вершины, чьё ребро стены проходит рядом на экране
    const roof = eave ? undefined : this.roofAt(point);
    const v = eave || roof?.onPoint ? undefined : this.vertexAt(point);
    if (v && shift) {
      const k = vertKey(v.target);
      if (this.picked.has(k)) this.picked.delete(k); else this.picked.set(k, { poly: v.target.poly, ring: v.target.ring, i: v.target.i });
      this.pickedKey = v.target.key;
      this.showHandles();
      return true;
    }
    const hit = eave ?? v ?? roof ?? this.edgeAt(point);
    if (!hit) { this.picked.clear(); return false; }
    const t = hit.target;
    // Захват одной из выбранных — едут все выбранные; иначе выбор сбрасывается
    if (v && this.picked.size > 1 && this.picked.has(vertKey(t))) t.also = [...this.picked.values()].filter((p) => vertKey(p) !== vertKey(t));
    else this.picked.clear();
    if (t.insert !== undefined) {
      // Новая вершина — сразу ровно на стороне; дальше её можно отвести, как обычную (Esc оставит на стороне)
      if (!this.commit(t, new THREE.Vector3())) return true;
      this.beginDrag({ key: t.key, poly: t.poly, ring: t.ring, i: t.i + 1, from: t.from }, true);
      return true;
    }
    this.beginDrag(t);
    return true;
  }

  /** inserted — вершина только что вставлена на сторону: её середина в исходном виде — тоже привязка. */
  private beginDrag(t: ShapeTarget, inserted = false) {
    // Вершина основания — только в плане: за что бы её ни взяли (ребро стены на любой высоте), движение — в плоскости
    // основания, где маркеры
    const base = !t.roof && !t.eave ? this.walls(t.key)?.min : undefined;
    if (base !== undefined) t.from = t.from.clone().setZ(base);
    // Где луч курсора в момент захвата пересёк плоскость основания: сдвиг — от неё (иначе вершина, взятая за ребро
    // стены выше основания, прыгнула бы под курсор на земле)
    const ray = this.lastPoint && this.layer.focusRay(this.lastPoint);
    this.grabBase = (ray && ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -t.from.z), new THREE.Vector3())) || t.from.clone();
    const hit = { target: t };
    this.target = hit.target;
    this.origin.clear();
    this.extraSnaps = [];
    const polys = this.layer.focusPolygons(t.key);
    if (t.insert === undefined && !t.roof && !t.eave) for (const v of [t, ...(t.also ?? [])]) {
      const p = polys?.[v.poly], ring = v.ring ? p?.inners[v.ring - 1] : p?.outer, at = ring?.[v.i];
      if (!ring || !at) continue;
      this.origin.set(vertKey(v), at);
      const n = ring.length, prev = ring[(v.i - 1 + n) % n], next = ring[(v.i + 1) % n];
      const mid = (a: [number, number], b: [number, number]) => new THREE.Vector3((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, t.from.z);
      const label = tr('Середина исходной стороны');
      this.extraSnaps.push({ kind: 'midpoint', key: t.key, p: mid(at, prev), label }, { kind: 'midpoint', key: t.key, p: mid(at, next), label });
      if (inserted) this.extraSnaps.push({ kind: 'midpoint', key: t.key, p: mid(prev, next), label });
    }
    const note = t.roof || t.eave ? this.levelLock?.(t) : undefined;
    this.step = note ? LEVEL_HEIGHT : undefined;
    const units = note ? tr('в этажах') : tr('в метрах');
    this.offset.set(0, 0, 0);
    this.dir = this.locked = undefined;
    this.typed = '';
    this.problem = undefined;
    this.state = 'drag';
    // Оси, по которым ручка не ходит, — серые: у вершин основания — вертикаль, у верха стен и крыши — горизонтали
    this.layer.setMoveGuide({ from: hit.target.from, gizmoScale: 0.375, free: base !== undefined ? PLAN : VERTICAL });
    this.updateVcb();
    this.say((hit.target.roof
      ? tr('Ведите курсор вверх или вниз: верх стен стоит, меняется высота крыши. Клик — применить, число + Enter — сдвиг {units}, Esc — отмена.', { units })
      : hit.target.eave
      ? tr('Ведите курсор вверх или вниз: меняется высота стен, крыша едет целиком. Клик — применить, число + Enter — сдвиг {units}, Esc — отмена.', { units })
      : tr('Ведите курсор: вершина едет в плане, прилипает к осям здания и сторонам у вершины. Клик — применить, число + Enter — сдвиг в метрах, Esc — отмена.'))
      + (note ? ' ' + note : ''));
  }

  move(point: [number, number]) {
    this.lastPoint = point;
    if (this.state === 'pick') {
      const h = this.hoverAt(point);
      if (h?.index !== this.hover?.index || h?.roof !== this.hover?.roof || h?.eave !== this.hover?.eave || !samePoint(h?.point, this.hover?.point)) { this.hover = h; this.showHandles(); }
      return;
    }
    const t = this.target;
    if (this.state !== 'drag' || !t) return;
    if (t.roof || t.eave) { this.moveVertical(point, t); return; }
    const ray = this.layer.focusRay(point);
    const dirs = this.dirs(t);
    if (!ray) return;
    const near = t.insert === undefined && !t.also?.length ? this.neighbourAt(point, t) : undefined;
    this.merge = !!near;
    const prev = this.snap;
    this.snap = near ? undefined : this.layer.snapAt(point, undefined, undefined, { from: t.from, skip: this.snapSkip(t), extra: this.extraSnaps });
    // Привязка на прежнем месте — та же цель (сама вершина стоит там же; подпись — от цели, а не «Вершина»)
    if (this.snap && prev && this.snap.local.distanceToSquared(prev.local) < 1e-6) this.snap = { ...prev, point: this.snap.point };
    let dir = this.locked;
    const offset = new THREE.Vector3();
    if (near) {
      offset.set(near[0] - t.from.x, near[1] - t.from.y, 0);
      dir = undefined;
    } else if (this.snap) {
      offset.subVectors(this.snap.local, t.from).setZ(0);
      if (dir) offset.copy(dir.v).multiplyScalar(offset.dot(dir.v));
    } else if (this.nearGrab(point)) {
      // Курсор у точки захвата — вершина стоит (повторный клик на месте её не сдвигает)
    } else {
      dir ??= this.inferDir(point, this.grabBase, dirs);
      if (dir) offset.copy(dir.v).multiplyScalar(closestOnLine(ray, this.grabBase, dir.v));
      else {
        const hit = ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -t.from.z), new THREE.Vector3());
        if (hit) offset.subVectors(hit, this.grabBase).setZ(0);
      }
    }
    this.dir = dir;
    if (this.shiftLock && !this.locked && dir) this.locked = dir;
    this.offset.copy(offset);
    this.problem = this.preview(t, offset);
    if (this.merge) this.problem = undefined; // совпадение с соседней здесь и есть слияние
    this.showHandles();
    this.guide();
    this.updateVcb();
  }

  /** true — клавиша обработана инструментом. */
  key(e: KeyboardEvent): boolean {
    if (!this.active) return false;
    if (e.type === 'keyup') {
      if (e.key === 'Shift' && this.state === 'drag') { this.shiftLock = false; this.locked = undefined; this.refresh(); return true; }
      return false;
    }
    if (e.key === 'Escape') {
      if (this.state === 'drag') { this.cancelDrag(); this.state = 'pick'; this.refresh(); }
      else if (this.picked.size) { this.picked.clear(); this.showHandles(); }
      else this.stop();
      return true;
    }
    if (isGlueKey(e)) { this.setGlue(!this.glue); return true; }
    // Del (на Mac — Backspace) — удалить вершину под курсором или выбранные; посреди сдвига — захваченную
    // (Backspace там сначала стирает набранное число, а когда его нет — удаляет вершину)
    if (e.key === 'Delete' || (e.key === 'Backspace' && (this.state === 'pick' || !this.typed))) {
      const [first, ...rest] = this.state === 'pick' ? [...this.picked.values()] : [];
      const key = this.selected();
      const t = this.state === 'drag' ? this.target
        : first && key ? { key, ...first, from: new THREE.Vector3(), also: rest }
        : this.lastPoint && !this.eaveAt(this.lastPoint) ? this.vertexAt(this.lastPoint)?.target : undefined;
      this.picked.clear();
      if (!t || t.insert !== undefined || t.roof || t.eave) { this.showHandles(); return true; }
      if (this.state === 'drag') { this.cancelDrag(); this.state = 'pick'; }
      this.remove(t, false);
      this.refresh();
      return true;
    }
    if (this.state !== 'drag') return false;
    if (e.key === 'Shift') {
      if (e.repeat) return true;
      this.shiftLock = true;
      if (this.dir) this.locked = this.dir;
      this.refresh();
      return true;
    }
    if (/^[\d.,-]$/.test(e.key)) { this.typed += e.key === ',' ? '.' : e.key; this.updateVcb(); return true; }
    if (e.key === 'Backspace') { this.typed = this.typed.slice(0, -1); this.updateVcb(); return true; }
    if (e.key === 'Enter') {
      const dist = Number(this.typed);
      if (!this.typed || !Number.isFinite(dist) || !this.target) return true;
      // Крыша — число со знаком по вертикали
      // В этажах — число этажей
      if (this.target.roof || this.target.eave) { this.apply(new THREE.Vector3(0, 0, this.clampVertical(this.target, this.step ? dist * this.step : dist))); return true; }
      // Направление — прилипшее (в сторону курсора) или текущее направление движения
      let v: THREE.Vector3;
      if (this.dir) v = this.dir.v.clone().multiplyScalar(this.offset.dot(this.dir.v) < 0 ? -1 : 1);
      else if (this.offset.lengthSq() > 1e-6) v = this.offset.clone().normalize();
      else return true;
      const offset = v.multiplyScalar(dist);
      const problem = this.preview(this.target, offset);
      if (problem) { this.problem = problem; this.typed = ''; this.updateVcb(); this.say(problem, true); return true; }
      this.apply(offset);
      return true;
    }
    return false;
  }

  private apply(offset: THREE.Vector3) {
    const t = this.target!;
    this.cancelDrag();
    this.state = 'pick';
    this.picked.clear();
    // Новая вершина вставляется и без сдвига
    if (offset.lengthSq() > 1e-8 || t.insert !== undefined) this.commit(t, offset.clone());
    this.refresh();
  }

  private cancelDrag() {
    if (this.state === 'drag' && this.target) this.preview(this.target, undefined);
    this.layer.setMoveGuide(undefined);
    this.target = undefined;
    this.snap = undefined;
    this.typed = '';
    this.problem = undefined;
    this.shiftLock = false;
    this.locked = this.dir = undefined;
    this.linked = 0;
    this.merge = false;
  }

  /** Перерисовать маркеры (камера повернулась — заслонённость поменялась). */
  redraw() {
    if (this.active) this.showHandles();
  }

  /**
   * Привязки во время сдвига вершин: ко всему, в том числе к самой части, кроме едущих вершин и рёбер у них
   * (в превью они уже на новом месте — вершина прилипала бы сама к себе) и центра самой части (он едет вместе с ней).
   */
  private snapSkip(t: ShapeTarget): SnapOpts['skip'] {
    const at = [...this.origin.values()].map(([x, y]) => [x + this.offset.x, y + this.offset.y]);
    // Точка, к которой прилипли в прошлый раз: вершина теперь стоит в ней же — не отбрасывать, иначе привязка мигает
    const kept = this.snap?.local;
    return (p, key, kind) => (key === t.key && (kind === 'center' || kind === 'shape'))
      || (at.some(([x, y]) => Math.abs(p.x - x) < 1e-2 && Math.abs(p.y - y) < 1e-2)
        && !(kind !== 'edge' && kept && p.distanceToSquared(kept) < 1e-6));
  }

  /** Ручка крыши или верха стен: только по вертикали (по лучу курсора или к высоте точки другого объекта). */
  private moveVertical(point: [number, number], t: ShapeTarget) {
    const ray = this.layer.focusRay(point);
    if (!ray) return;
    const moving = this.moving();
    this.snap = this.layer.snapAt(point, (k) => !moving.has(k), undefined, { noEdge: true });
    const dz = this.snap ? this.snap.local.z - t.from.z : closestOnLine(ray, t.from, new THREE.Vector3(0, 0, 1));
    this.offset.set(0, 0, this.clampVertical(t, dz));
    this.problem = this.preview(t, this.offset);
    this.showHandles();
    this.layer.setMoveGuide({ from: t.from, to: t.from.clone().add(this.offset), axis: 2, gizmoScale: 0.375, free: VERTICAL });
    this.updateVcb();
  }

  /** Крыша не ниже MIN_ROOF_HEIGHT, стены не ниже MIN_WALL_HEIGHT; в этажах — целыми этажами. */
  private clampVertical(t: ShapeTarget, dz: number): number {
    const w = this.walls(t.key);
    if (!w) return dz;
    const lower = t.roof ? MIN_ROOF_HEIGHT - w.roof : w.min + MIN_WALL_HEIGHT - w.top;
    if (!this.step) return Math.max(dz, lower);
    return Math.max(Math.round(dz / this.step), Math.ceil(lower / this.step - 1e-6)) * this.step;
  }

  /** Ручки верха стен: вершины по верху стены; у плоского контура без высоты — нет. */
  private eavePoints(key: string): THREE.Vector3[] {
    const polys = this.layer.focusPolygons(key);
    const w = this.walls(key);
    if (!polys || !w || w.top - w.min < MIN_WALL_HEIGHT) return [];
    const z = w.top + (this.state === 'drag' && this.target?.eave ? this.offset.z : 0);
    return polys.flatMap((p) => [p.outer, ...p.inners].flatMap((r) => r.map(([x, y]) => new THREE.Vector3(x, y, z))));
  }

  private eaveAt(point: [number, number]): { target: ShapeTarget; index: number } | undefined {
    const key = this.selected();
    const pts = key ? this.eavePoints(key) : [];
    let best: { index: number; d: number } | undefined;
    pts.forEach((p, i) => {
      const q = this.layer.focusProject(p);
      const d = q ? Math.hypot(q[0] - point[0], q[1] - point[1]) : Infinity;
      if (d <= GRAB_PX && (!best || d < best.d)) best = { index: i, d };
    });
    return best && key ? { target: { key, poly: 0, ring: 0, i: 0, eave: true, from: pts[best.index].clone() }, index: best.index } : undefined;
  }

  /** Ручка крыши под курсором: верхняя точка крыши выделенной части или конёк между двумя такими точками. */
  private roofAt(point: [number, number]): { target: ShapeTarget; index: number; onPoint: boolean } | undefined {
    const key = this.selected();
    const pts = key ? this.layer.focusRoofTop(key) : [];
    if (!key || !pts.length) return;
    const px = pts.map((p) => this.layer.focusProject(p));
    let best: { index: number; d: number; from: THREE.Vector3 } | undefined;
    px.forEach((q, i) => {
      if (!q) return;
      const d = Math.hypot(q[0] - point[0], q[1] - point[1]);
      if (d <= GRAB_PX && (!best || d < best.d)) best = { index: i, d, from: pts[i].clone() };
    });
    const onPoint = !!best;
    // Конёк — отрезок между двумя верхними точками: взять можно за любую его точку
    if (!best && pts.length === 2 && px[0] && px[1]) {
      const { d, s } = segDist(point, px[0], px[1]);
      if (d <= GRAB_PX) best = { index: s < 0.5 ? 0 : 1, d, from: pts[0].clone().lerp(pts[1], s) };
    }
    return best && { target: { key, poly: 0, ring: 0, i: 0, roof: true, from: best.from }, index: best.index, onPoint };
  }

  /** Курсор у точки захвата (на экране) — сдвига ещё нет. */
  private nearGrab(point: [number, number]): boolean {
    const s0 = this.layer.focusProject(this.grabBase);
    return !!s0 && Math.hypot(point[0] - s0[0], point[1] - s0[1]) < MIN_DRAG_PX;
  }

  /** Соседняя по кольцу вершина (вертикальное ребро стены на экране) у курсора — её место в плане. */
  private neighbourAt(point: [number, number], t: ShapeTarget): [number, number] | undefined {
    const p = this.layer.focusPolygons(t.key)?.[t.poly];
    const ring = p && (t.ring ? p.inners[t.ring - 1] : p.outer);
    const w = this.walls(t.key);
    // У треугольника внешнего кольца сливать нечего; внутреннее при слиянии удаляется целиком
    if (!ring || (ring.length <= 3 && !t.ring) || !w) return;
    for (const k of [t.i - 1 + ring.length, t.i + 1]) {
      const [x, y] = ring[k % ring.length];
      const a = this.layer.focusProject(new THREE.Vector3(x, y, w.min));
      const b = this.layer.focusProject(new THREE.Vector3(x, y, w.top));
      if (a && b && segDist(point, a, b).d <= GRAB_PX) return [x, y];
    }
  }

  /** Вершины выделенной части — у основания (верх стен у здания с крышей проходит посреди граней), захваченная — на новом месте. */
  private showHandles() {
    const key = this.selected();
    const polys = key ? this.layer.focusPolygons(key) : undefined;
    const w = key ? this.walls(key) : undefined;
    if (!key || !polys || !w) { this.layer.setHandles(undefined); return; }
    const pts: THREE.Vector3[] = [];
    const active: number[] = [];
    const t = this.state === 'drag' ? this.target : undefined;
    // Едущие вершины: захваченная и выбранные вместе с ней — на новых местах
    const moving = new Set(t && t.insert === undefined && !t.roof ? [t, ...(t.also ?? [])].map(vertKey) : []);
    polys.forEach((p, pi) => [p.outer, ...p.inners].forEach((ring, ri) => ring.forEach(([x, y], i) => {
      const k = vertKey({ poly: pi, ring: ri, i });
      const o = moving.has(k) ? this.origin.get(k) : undefined;
      if (o) {
        active.push(pts.length);
        pts.push(new THREE.Vector3(o[0] + this.offset.x, o[1] + this.offset.y, w.min));
        return;
      }
      if (this.picked.has(k) || (!t && this.hover?.index === pts.length)) active.push(pts.length);
      pts.push(new THREE.Vector3(x, y, w.min));
    })));
    // Будущая новая вершина под курсором
    if (!t && this.hover?.point) { active.push(pts.length); pts.push(this.hover.point.clone().setZ(w.min)); }
    // Ручки крыши — по текущей (в том числе предварительной) геометрии; захваченная или под курсором — выделена
    const roof = this.layer.focusRoofTop(key);
    const roofActive = t?.roof ? nearest(roof, t.from.clone().add(this.offset)) : !t ? this.hover?.roof : undefined;
    const eave = this.eavePoints(key);
    const eaveActive = t?.eave ? nearest(eave, t.from) : !t ? this.hover?.eave : undefined;
    this.layer.setHandles(pts, active, { points: roof, active: roofActive }, { points: eave, active: eaveActive });
  }

  private hoverAt(point: [number, number]): Hover | undefined {
    this.snap = undefined;
    const ev = this.eaveAt(point);
    if (ev) return { eave: ev.index };
    const r = this.roofAt(point);
    if (r?.onPoint) return { roof: r.index };
    const v = this.vertexAt(point);
    if (v) return { index: v.index };
    if (r) return { roof: r.index };
    const e = this.edgeAt(point);
    this.snap = e?.snap;
    return e ? { point: e.target.from } : undefined;
  }

  /**
   * Точка на стороне выделенной части под курсором: сторона — у основания (там же, где маркеры), точка — пересечение
   * луча курсора с горизонталью основания, спроецированное на сторону. Концы сторон — вершины, не тут.
   */
  private edgeAt(point: [number, number]): { target: ShapeTarget; snap?: SnapHit } | undefined {
    const key = this.selected();
    const polys = key ? this.layer.focusPolygons(key) : undefined;
    const w = key ? this.walls(key) : undefined;
    const ray = this.layer.focusRay(point);
    if (!key || !polys || !w || !ray) return;
    let best: { target: ShapeTarget; d: number } | undefined;
    polys.forEach((p, poly) => [p.outer, ...p.inners].forEach((r, ring) => r.forEach(([ax, ay], i) => {
      const [bx, by] = r[(i + 1) % r.length];
      for (const z of [w.min]) {
        const a = this.layer.focusProject(new THREE.Vector3(ax, ay, z));
        const b = this.layer.focusProject(new THREE.Vector3(bx, by, z));
        if (!a || !b) continue;
        const { d } = segDist(point, a, b);
        if (d > EDGE_PX || (best && d >= best.d)) continue;
        const hit = ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -z), new THREE.Vector3());
        const ex = bx - ax, ey = by - ay, l2 = ex * ex + ey * ey;
        if (!hit || l2 < 1e-8) continue;
        const s = ((hit.x - ax) * ex + (hit.y - ay) * ey) / l2;
        if (s < EDGE_END || s > 1 - EDGE_END) continue;
        best = { target: { key, poly, ring, i, insert: s, from: new THREE.Vector3(ax + s * ex, ay + s * ey, z) }, d };
      }
    })));
    if (!best) return;
    // Привязка, лежащая на этой стороне (её середина, чужая вершина на ней): новая вершина встанет точно в неё
    const b: { target: ShapeTarget; snap?: SnapHit } = best;
    const snap = this.layer.snapAt(point, undefined, undefined, { noEdge: true });
    const r = polys[b.target.poly], rr = b.target.ring ? r.inners[b.target.ring - 1] : r.outer;
    const [ax, ay] = rr[b.target.i], [bx, by] = rr[(b.target.i + 1) % rr.length];
    const ex = bx - ax, ey = by - ay, l2 = ex * ex + ey * ey;
    if (snap && l2 > 1e-8) {
      const s = ((snap.local.x - ax) * ex + (snap.local.y - ay) * ey) / l2;
      const off = Math.abs((snap.local.x - ax) * ey - (snap.local.y - ay) * ex) / Math.sqrt(l2);
      if (off < 0.05 && s > EDGE_END && s < 1 - EDGE_END) {
        b.target.insert = s;
        b.target.from.set(ax + s * ex, ay + s * ey, w.min);
        b.snap = snap;
      }
    }
    return b;
  }

  /** Вершина выделенной части под курсором: ближайшее на экране вертикальное ребро стены (низ — верх). */
  private vertexAt(point: [number, number]): { target: ShapeTarget; index: number } | undefined {
    const key = this.selected();
    const polys = key ? this.layer.focusPolygons(key) : undefined;
    const w = key ? this.walls(key) : undefined;
    if (!key || !polys || !w) return;
    let best: { target: ShapeTarget; index: number; d: number } | undefined;
    let index = 0;
    polys.forEach((p, poly) => [p.outer, ...p.inners].forEach((r, ring) => r.forEach(([x, y], i) => {
      const n = index++;
      const a = this.layer.focusProject(new THREE.Vector3(x, y, w.min));
      const b = this.layer.focusProject(new THREE.Vector3(x, y, w.top));
      if (!a || !b) return;
      const { d, s } = segDist(point, a, b);
      if (d > GRAB_PX || (best && d >= best.d)) return;
      best = { target: { key, poly, ring, i, from: new THREE.Vector3(x, y, w.min + s * (w.top - w.min)) }, index: n, d };
    })));
    return best;
  }

  /** Оси здания и продолжения обеих сторон у захваченной вершины (у новой — сама сторона и перпендикуляр к ней). */
  private dirs(t: ShapeTarget): Dir[] {
    const out: Dir[] = [];
    const f = this.layer.focusAxes;
    if (f) {
      out.push({ v: new THREE.Vector3(f.x[0], f.x[1], 0), name: 'x', axis: 0 }, { v: new THREE.Vector3(f.y[0], f.y[1], 0), name: 'y', axis: 1 });
    }
    const p = this.layer.focusPolygons(t.key)?.[t.poly];
    const ring = p && (t.ring ? p.inners[t.ring - 1] : p.outer);
    if (!ring || ring.length < 3) return out;
    const add = (v: THREE.Vector3, name: string) => {
      if (v.lengthSq() < 1e-8) return;
      v.normalize();
      // По оси здания — уже есть
      if (!out.some((d) => Math.abs(d.v.dot(v)) > 0.9998)) out.push({ v, name });
    };
    if (t.insert !== undefined) {
      const [ax, ay] = ring[t.i], [bx, by] = ring[(t.i + 1) % ring.length];
      add(new THREE.Vector3(bx - ax, by - ay, 0), tr('вдоль стороны'));
      add(new THREE.Vector3(ay - by, bx - ax, 0), tr('перпендикуляр к стороне'));
      return out;
    }
    const [vx, vy] = this.origin.get(vertKey(t)) ?? ring[t.i];
    for (const k of [t.i - 1 + ring.length, t.i + 1]) {
      const [x, y] = ring[k % ring.length];
      add(new THREE.Vector3(vx - x, vy - y, 0), tr('вдоль стороны'));
    }
    // Перпендикуляры к сторонам — чтобы отвести вершину (в том числе только что вставленную) поперёк стороны
    for (const k of [t.i - 1 + ring.length, t.i + 1]) {
      const [x, y] = ring[k % ring.length];
      add(new THREE.Vector3(y - vy, vx - x, 0), tr('перпендикуляр к стороне'));
    }
    return out;
  }

  /** Направление, вдоль которого (на экране) идёт курсор от точки захвата, с допуском AXIS_SNAP_DEG. */
  private inferDir(point: [number, number], from: THREE.Vector3, dirs: Dir[]): Dir | undefined {
    const s0 = this.layer.focusProject(from);
    if (!s0) return;
    const cx = point[0] - s0[0], cy = point[1] - s0[1];
    const len = Math.hypot(cx, cy);
    if (len < MIN_DRAG_PX) return;
    let best: { d: Dir; angle: number } | undefined;
    for (const d of dirs) {
      const s1 = this.layer.focusProject(from.clone().addScaledVector(d.v, 5));
      if (!s1) continue;
      const dx = s1[0] - s0[0], dy = s1[1] - s0[1];
      const l = Math.hypot(dx, dy);
      if (l < 1) continue; // направление смотрит в камеру
      const angle = Math.acos(Math.min(1, Math.abs((cx * dx + cy * dy) / (len * l)))) * 180 / Math.PI;
      if (!best || angle < best.angle) best = { d, angle };
    }
    return best && best.angle < AXIS_SNAP_DEG ? best.d : undefined;
  }

  private guide() {
    const t = this.target;
    if (!t) return;
    const to = t.from.clone().add(this.offset);
    const d = this.locked ?? this.dir;
    // Сторона у вершины — своя ось x по ней (цвет оси x)
    const axes = d && d.axis === undefined ? { x: [d.v.x, d.v.y] as Pt, y: [-d.v.y, d.v.x] as Pt } : undefined;
    const axis = d ? (d.axis ?? 0) : undefined;
    this.layer.setMoveGuide({ from: t.from, to, axis, locked: this.locked ? axis : undefined, axes, gizmoScale: 0.375, free: PLAN });
  }

  private updateVcb() {
    if (!this.active) { this.vcb.hidden = true; return; }
    this.vcb.hidden = false;
    const glue = glueSwitch(this.glue, tr('Общие с соседями узлы: «с соседями» — соседи тянутся следом, «отдельно» — часть отделяется от них (D)'));
    if (this.state !== 'drag') { this.vcb.innerHTML = `<span class="vcb-label">${tr('Вершина')}</span>${glue}`; return; }
    if (this.target?.roof || this.target?.eave) {
      const w = this.walls(this.target.key);
      const dz = this.offset.z, roof = !!this.target.roof, step = this.step;
      const value = this.typed || (dz >= 0 ? '+' : '') + (step ? String(Math.round(dz / step)) : dz.toFixed(2));
      const info = !w ? '' : `<span class="vcb-axis">${roof ? tr('высота крыши {h} м', { h: (w.roof + dz).toFixed(2) })
        : tr('высота стен {h} м', { h: (w.top - w.min + dz).toFixed(2) })}</span>`;
      // Какие теги меняются — видно до применения
      const changes = this.tagChanges?.(this.target, dz);
      this.vcb.innerHTML = `<span class="vcb-label">${roof ? tr('Крыша') : tr('Верх стен')}</span><span class="vcb-value${this.typed ? ' typed' : ''}">${value}</span> ${step ? tr('эт.') : tr('м')}
        <span class="vcb-axis">${this.snap ? tr('до точки') : tr('по вертикали')}</span>${info}${changes ? `<span class="vcb-axis vcb-tags">${changes}</span>` : ''}`;
      return;
    }
    const d = this.locked ?? this.dir;
    const along = !d ? tr('свободно') : this.locked ? tr('{dir} (зафиксировано)', { dir: d.axis === undefined ? d.name : tr('ось {axis}', { axis: d.name }) })
      : d.axis === undefined ? d.name : tr('ось {axis}', { axis: d.name });
    const value = this.typed || this.offset.length().toFixed(2);
    const linked = this.glue ? linkedNote(this.linked) : '';
    const problem = this.merge ? `<span class="vcb-axis vcb-linked">${tr('слить с соседней')}</span>`
      : this.problem ? `<span class="vcb-axis vcb-error">${this.problem}</span>` : '';
    this.vcb.innerHTML = `<span class="vcb-label">${tr('Вершина')}</span><span class="vcb-value${this.typed ? ' typed' : ''}">${value}</span> ${tr('м')}
      <span class="vcb-axis">${this.snap ? tr('к точке · {along}', { along }) : along}</span>${linked}${problem}${glue}`;
  }
}

/** Номер ближайшей к p точки (в плане). */
function nearest(pts: THREE.Vector3[], p: THREE.Vector3): number | undefined {
  let best: number | undefined, bd = Infinity;
  pts.forEach((q, i) => { const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2; if (d < bd) { bd = d; best = i; } });
  return best;
}

function samePoint(a: THREE.Vector3 | undefined, b: THREE.Vector3 | undefined): boolean {
  return a === b || (!!a && !!b && a.distanceToSquared(b) < 1e-6);
}

/** Расстояние от точки до отрезка на экране и параметр ближайшей точки (0 — a, 1 — b). */
function segDist([px, py]: Pt, [ax, ay]: Pt, [bx, by]: Pt): { d: number; s: number } {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const s = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return { d: Math.hypot(px - ax - s * dx, py - ay - s * dy), s };
}

/** Параметр t ближайшей к лучу точки прямой from + t·dir (dir единичный). */
function closestOnLine(ray: THREE.Ray, from: THREE.Vector3, dir: THREE.Vector3): number {
  const w0 = ray.origin.clone().sub(from);
  const b = ray.direction.dot(dir), d = ray.direction.dot(w0), e = dir.dot(w0);
  const denom = 1 - b * b;
  if (denom < 1e-6) return 0;
  return (e - b * d) / denom;
}


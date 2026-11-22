import type * as maplibregl from 'maplibre-gl';
import { tr } from '../i18n';

type V3 = [number, number, number];
type P2 = [number, number];

/** Грань куба в осях здания (x, y — оси здания, z — вверх): нормаль, «вправо» и «вверх» по грани снаружи. */
interface Face { label: string; n: V3; right: V3; up: V3 }

const FACES: Face[] = [
  { label: tr('Сверху'), n: [0, 0, 1], right: [1, 0, 0], up: [0, 1, 0] },
  { label: tr('Спереди'), n: [0, -1, 0], right: [1, 0, 0], up: [0, 0, 1] },
  { label: tr('Справа'), n: [1, 0, 0], right: [0, 1, 0], up: [0, 0, 1] },
  { label: tr('Сзади'), n: [0, 1, 0], right: [-1, 0, 0], up: [0, 0, 1] },
  { label: tr('Слева'), n: [-1, 0, 0], right: [0, -1, 0], up: [0, 0, 1] },
];

/** Размер элемента, px. */
const BOX = 112;
const DEG = 180 / Math.PI;
/** Радиус кольца компаса — в половинах ребра куба. */
const RING_R = 2.3;

/** Угол обзора карты: перспектива (по умолчанию MapLibre) и почти параллельная проекция — аксонометрия. */
const FOV_PERSPECTIVE = 36.87;
/** Меньше — камера уходит так далеко, что 3D-слою не хватает точности буфера глубины (здания «просвечивают»). */
const FOV_AXONOMETRIC = 3;
const PROJECTION_KEY = 'view-projection';
const FOV_KEY = 'view-fov';
/** Пределы угла обзора перспективы, градусы по вертикали. */
const FOV_MIN = 15, FOV_MAX = 90;

/** Куб в сцене: центр, половина ребра и оси здания (метры сцены режима здания, x — восток, y — север). */
export interface CubeFrame { center: V3; half: number; x: P2; y: P2 }

export interface ViewCubeOptions {
  /** Где стоит виртуальный куб (на месте здания) — undefined, если режима здания нет. */
  frame: () => CubeFrame | undefined;
  /** Центр поворота (центр здания). */
  center: () => maplibregl.LngLatLike | undefined;
}

/**
 * View cube как в AutoCAD. Куб по осям здания, своя камера с азимутом и наклоном карты и небольшой перспективой. Клик по центру грани — вид с этой стороны,
 * по краю или углу — промежуточный (45°). Снизу MapLibre смотреть не умеет — нижние ячейки неактивны.
 * Кольцо компаса: клик по букве — вид на север/восток/…, перетаскивание — поворот по азимуту.
 * Перетаскивание самого куба (мышью или пальцем) — поворот сцены в сторону драга: азимут и наклон.
 */
export class ViewCube implements maplibregl.IControl {
  private map?: maplibregl.Map;
  private el!: HTMLDivElement;
  /** Рисунок куба и кнопки — перерисовываются; окно настроек рядом — нет. */
  private art!: HTMLDivElement;
  private pop!: HTMLDivElement;
  /** Угол обзора перспективы (настройка вида). */
  private fov = FOV_PERSPECTIVE;
  private readonly sync = () => this.update();
  private lastKey = '';
  /** Выбрана аксонометрия — действует только в режиме здания, вне его всегда перспектива. */
  private axoChosen = false;
  /** Куб включён кнопкой (в режиме здания). */
  shown = true;

  constructor(private readonly opts: ViewCubeOptions) {}

  onAdd(map: maplibregl.Map): HTMLElement {
    this.map = map;
    const el = this.el = document.createElement('div');
    el.className = 'maplibregl-ctrl view-cube';
    el.hidden = true;
    this.art = document.createElement('div');
    this.pop = document.createElement('div');
    this.pop.className = 'vc-settings';
    this.pop.hidden = true;
    el.append(this.art, this.pop);
    this.pop.addEventListener('click', (e) => e.stopPropagation());
    this.pop.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.pop.addEventListener('input', (e) => {
      const t = e.target as HTMLInputElement;
      if (t.name === 'fov') this.setFov(Number(t.value));
    });
    document.addEventListener('pointerdown', (e) => { if (!this.pop.hidden && !el.contains(e.target as Node)) this.closeSettings(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !this.pop.hidden) this.closeSettings(); });
    el.addEventListener('click', (e) => this.click(e));
    // Ребро и угол — это 2 и 3 ячейки на соседних гранях с одним направлением (data-v): подсвечиваем все
    el.addEventListener('mouseover', (e) => this.hover((e.target as Element).closest<SVGElement>('.vc-cell')?.dataset.v));
    el.addEventListener('mouseleave', () => this.hover(undefined));
    // Кольцо — поворот по азимуту, куб — по направлению драга (азимут и наклон); мышь и касание
    el.addEventListener('pointerdown', (e) => {
      const t = e.target as Element;
      if (t.closest('.vc-ring')) this.dragRing(e);
      else if (t.closest('.vc-face')) this.dragCube(e);
    });
    // Клик после перетаскивания — не переход к виду
    el.addEventListener('click', (e) => { if (this.dragged) { e.stopImmediatePropagation(); this.dragged = false; } }, true);
    try { this.axoChosen = localStorage.getItem(PROJECTION_KEY) === 'axo'; } catch { /* перспектива */ }
    try { const v = Number(localStorage.getItem(FOV_KEY)); if (v >= FOV_MIN && v <= FOV_MAX) this.fov = v; } catch { /* по умолчанию */ }
    map.on('move', this.sync);
    return el;
  }

  onRemove() {
    this.map?.off('move', this.sync);
    this.el.remove();
    this.map = undefined;
  }

  /** Перерисовать куб под текущую камеру (только если она поменялась). */
  update() {
    const frame = this.map ? this.opts.frame() : undefined;
    // Смена угла шлёт move и снова вызывает update — к этому моменту угол уже нужный, повтора нет
    const fov = frame && this.axoChosen ? FOV_AXONOMETRIC : this.fov;
    if (this.map && Math.abs(this.map.getVerticalFieldOfView() - fov) > 1e-6) this.map.setVerticalFieldOfView(fov);
    // Режим здания: вместо компаса карты — кнопка куба (стили по этому классу)
    this.map?.getContainer().classList.toggle('vc-mode', !!frame);
    // Своя камера: тот же азимут и наклон, что у карты, но с небольшой перспективой и постоянным размером
    const f = this.shown && frame ? { ...frame, center: [0, 0, 0] as V3, half: 1 } : undefined;
    const cam = this.map ? camera(this.map.getBearing(), this.map.getPitch()) : undefined;
    const project = (p: V3) => (cam ? cam(p) : undefined);
    const pr = (v: V3) => (f ? project(toScene(f, v)) : undefined);
    const key = f && cam ? [this.map!.getBearing(), this.map!.getPitch(), f.x, f.y].join() : '';
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.el.hidden = !key;
    if (!key || !f) { this.art.innerHTML = ''; this.closeSettings(); return; }

    // Все точки рисунка в координатах экрана, затем — общее масштабирование в рамку BOX
    const ring: (P2 | undefined)[] = [];
    for (let i = 0; i <= 64; i++) {
      const a = (i / 64) * 2 * Math.PI;
      ring.push(project(worldDir(f, [Math.cos(a) * RING_R, Math.sin(a) * RING_R], -1)));
    }
    const dirs = [[tr('С'), [0, 1]], [tr('В'), [1, 0]], [tr('Ю'), [0, -1]], [tr('З'), [-1, 0]]] as const;
    const dirPts = dirs.map(([l, d]) => ({ l, d, p: project(worldDir(f, [d[0] * RING_R, d[1] * RING_R], -1)) }));
    const all: P2[] = [];
    for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) { const p = pr([x, y, z]); if (p) all.push(p); }
    for (const p of ring) if (p) all.push(p);
    if (all.length < 8) { this.el.hidden = true; return; }
    // Рисунок (куб с кольцом) — по центру элемента: при наклоне кольцо внизу смещало бы его
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of all) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    const dx = BOX / 2 - (x0 + x1) / 2, dy = BOX / 2 - (y0 + y1) / 2;
    const fit = (p: P2): P2 => [p[0] + dx, p[1] + dy];
    const pt = (p: P2) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`;

    let svg = '';
    // Кольцо — позади куба
    svg += `<polyline class="vc-ring" points="${ring.filter((p): p is P2 => !!p).map((p) => pt(fit(p))).join(' ')}" />`;
    for (const d of dirPts) {
      if (!d.p) continue;
      const [x, y] = fit(d.p);
      svg += `<text class="vc-dir" data-dir="${d.d.join(',')}" x="${x.toFixed(1)}" y="${y.toFixed(1)}">${d.l}</text>`;
    }
    for (const face of FACES) {
      const at = (u: number, w: number) => pr(add(face.n, face.right, u, face.up, w));
      const quad = [at(-1, 1), at(1, 1), at(1, -1), at(-1, -1)];
      if (quad.some((p) => !p)) continue;
      const q = quad.map((p) => fit(p!));
      if (area(q) <= 0) continue; // грань к нам спиной
      svg += `<g class="vc-face${face.n[2] ? ' vc-top' : ''}">`;
      // Сетка 3×3: центр — грань, края — рёбра, углы — вершины куба
      const cuts = [-1, -0.45, 0.45, 1];
      for (let j = 0; j < 3; j++) {
        for (let i = 0; i < 3; i++) {
          const ua = cuts[i], ub = cuts[i + 1], wa = cuts[3 - j], wb = cuts[2 - j];
          const cell = [at(ua, wa), at(ub, wa), at(ub, wb), at(ua, wb)];
          if (cell.some((p) => !p)) continue;
          const u = i - 1, w = 1 - j;
          const v = add(face.n, face.right, u, face.up, w);
          const kind = u === 0 && w === 0 ? 'face' : u === 0 || w === 0 ? 'edge' : 'corner';
          const cls = v[2] < 0 ? 'vc-cell off' : `vc-cell ${kind}`;
          svg += `<polygon class="${cls}"${v[2] < 0 ? '' : ` data-v="${v.join(',')}"`} points="${cell.map((p) => pt(fit(p!))).join(' ')}" />`;
        }
      }
      svg += `<polygon class="vc-outline" points="${q.map(pt).join(' ')}" />`;
      // Подпись — в плоскости грани (аффинное приближение)
      const c = fit(at(0, 0)!), r = fit(at(1, 0)!), u = fit(at(0, 1)!);
      const H = 50;
      const m = [(r[0] - c[0]) / H, (r[1] - c[1]) / H, -(u[0] - c[0]) / H, -(u[1] - c[1]) / H, c[0], c[1]];
      svg += `<text class="vc-label" transform="matrix(${m.map((n) => n.toFixed(4)).join(' ')})">${face.label}</text>`;
      svg += '</g>';
    }
    const axo = this.axonometric;
    const projTitle = axo ? tr('Аксонометрия — переключить на перспективу') : tr('Перспектива — переключить на аксонометрию');
    const gearTitle = tr('Настройки вида');
    this.art.innerHTML = `<svg viewBox="0 0 ${BOX} ${BOX}" width="${BOX}" height="${BOX}">${svg}</svg>`
      + `<button type="button" class="vc-proj" title="${projTitle}" aria-label="${projTitle}">${axo ? tr('А') : tr('П')}</button>`
      + `<button type="button" class="vc-gear${this.pop.hidden ? '' : ' active'}" title="${gearTitle}" aria-label="${gearTitle}"><svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M8.20 4.17L8.65 2.12L11.35 2.12L11.80 4.17L12.85 4.60L14.62 3.47L16.53 5.38L15.40 7.15L15.83 8.20L17.88 8.65L17.88 11.35L15.83 11.80L15.40 12.85L16.53 14.62L14.62 16.53L12.85 15.40L11.80 15.83L11.35 17.88L8.65 17.88L8.20 15.83L7.15 15.40L5.38 16.53L3.47 14.62L4.60 12.85L4.17 11.80L2.12 11.35L2.12 8.65L4.17 8.20L4.60 7.15L3.47 5.38L5.38 3.47L7.15 4.60z"/><circle cx="10" cy="10" r="2.4"/></svg></button>`;
    if (this.hovered) this.hover(this.hovered);
  }

  private hovered?: string;

  private get axonometric() { return this.axoChosen; }

  /** Переключить перспективу и аксонометрию (выбор запоминается). */
  private toggleProjection() {
    if (!this.map) return;
    const axo = this.axoChosen = !this.axoChosen;
    try { localStorage.setItem(PROJECTION_KEY, axo ? 'axo' : 'persp'); } catch { /* только до перезагрузки */ }
    this.lastKey = '';
    this.update();
  }

  /** Окно настроек вида: угол обзора перспективы. */
  private openSettings() {
    this.pop.innerHTML = `<div class="vc-set-title">${tr('Настройки вида')}</div>`
      + `<label class="vc-set-row"><span>${tr('Угол обзора')}</span><output>${Math.round(this.fov)}°</output></label>`
      + `<input type="range" name="fov" min="${FOV_MIN}" max="${FOV_MAX}" step="1" value="${Math.round(this.fov)}">`
      + `<div class="vc-set-hint">${tr('Вертикальный угол камеры в перспективе. По умолчанию {n}°.', { n: Math.round(FOV_PERSPECTIVE) })} `
      + `<button type="button" class="vc-set-reset">${tr('Сбросить')}</button></div>`;
    this.pop.querySelector('.vc-set-reset')!.addEventListener('click', () => {
      this.setFov(FOV_PERSPECTIVE);
      (this.pop.querySelector('input[name=fov]') as HTMLInputElement).value = String(Math.round(FOV_PERSPECTIVE));
    });
    this.pop.hidden = false;
    this.el.querySelector('.vc-gear')?.classList.add('active');
  }

  private closeSettings() {
    this.pop.hidden = true;
    this.el.querySelector('.vc-gear')?.classList.remove('active');
  }

  private setFov(v: number) {
    this.fov = Math.min(FOV_MAX, Math.max(FOV_MIN, v));
    try { localStorage.setItem(FOV_KEY, String(this.fov)); } catch { /* только до перезагрузки */ }
    const out = this.pop.querySelector('output');
    if (out) out.textContent = `${Math.round(this.fov)}°`;
    this.lastKey = '';
    this.update();
  }

  private hover(v: string | undefined) {
    this.hovered = v;
    for (const c of this.el.querySelectorAll<SVGElement>('.vc-cell')) c.classList.toggle('hover', !!v && c.dataset.v === v);
  }

  private click(e: MouseEvent) {
    const t = e.target as Element;
    if (t.closest('.vc-proj')) { this.toggleProjection(); return; }
    if (t.closest('.vc-gear')) { if (this.pop.hidden) this.openSettings(); else this.closeSettings(); return; }
    const f = this.opts.frame();
    if (!f || !this.map) return;
    const dir = t.closest<SVGElement>('.vc-dir');
    if (dir) {
      // Буква — смотрим на эту сторону света, наклон прежний
      const [dx, dy] = dir.dataset.dir!.split(',').map(Number);
      return this.go(Math.atan2(dx, dy) * DEG, this.map.getPitch(), false);
    }
    const cell = t.closest<SVGElement>('.vc-cell');
    if (!cell?.dataset.v) return;
    const v = cell.dataset.v.split(',').map(Number) as V3;
    // Вектор в осях здания → в мир
    const w: V3 = [v[0] * f.x[0] + v[1] * f.y[0], v[0] * f.x[1] + v[1] * f.y[1], v[2]];
    const len = Math.hypot(...w);
    const pitch = Math.acos(w[2] / len) * DEG;
    // Камера в стороне w смотрит в обратную: азимут −w. Вид строго сверху — «вверх» по оси y здания
    const bearing = Math.hypot(w[0], w[1]) < 1e-6 ? Math.atan2(f.y[0], f.y[1]) * DEG : Math.atan2(-w[0], -w[1]) * DEG;
    this.go(bearing, pitch, true);
  }

  private go(bearing: number, pitch: number, recenter: boolean) {
    const map = this.map!;
    // Ближайший путь по азимуту
    const cur = map.getBearing();
    const target = cur + ((((bearing - cur) % 360) + 540) % 360 - 180);
    map.easeTo({ bearing: target, pitch: Math.min(pitch, map.getMaxPitch()), center: recenter ? this.opts.center() : undefined, duration: 600 });
  }

  /** Было перетаскивание — следующий click не обрабатывать. */
  private dragged = false;

  /** Общий драг: move получает смещение от начала, после порога в 3 px. */
  private drag(e: PointerEvent, move: (ev: PointerEvent) => void) {
    if (!this.map || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX, y0 = e.clientY, id = e.pointerId;
    let active = false;
    this.dragged = false;
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      if (!active && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 3) return;
      active = true;
      move(ev);
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      this.dragged = active;
      // Касание может не прислать click — сброс, чтобы не съесть следующий
      setTimeout(() => (this.dragged = false), 300);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  /** Перетаскивание кольца — поворот по азимуту вокруг центра элемента. */
  private dragRing(e: PointerEvent) {
    const r = this.el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const angle = (ev: PointerEvent) => Math.atan2(ev.clientX - cx, cy - ev.clientY) * DEG;
    const start = angle(e), b0 = this.map?.getBearing() ?? 0;
    this.drag(e, (ev) => this.map?.setBearing(b0 - (angle(ev) - start)));
  }

  /**
   * Перетаскивание куба — сцена поворачивается вслед за пальцем: по горизонтали — азимут, по вертикали — наклон,
   * по диагонали — оба сразу (ось поворота перпендикулярна драгу).
   */
  private dragCube(e: PointerEvent) {
    const map = this.map;
    if (!map) return;
    const b0 = map.getBearing(), p0 = map.getPitch();
    this.drag(e, (ev) => {
      const dx = ev.clientX - e.clientX, dy = ev.clientY - e.clientY;
      map.jumpTo({ bearing: b0 + dx * CUBE_DEG_PER_PX, pitch: Math.max(0, Math.min(map.getMaxPitch(), p0 - dy * CUBE_DEG_PER_PX)) });
    });
  }
}

/** Чувствительность драга куба, градусов на пиксель. */
const CUBE_DEG_PER_PX = 0.8;

/** n + right·u + up·w. */
function add(n: V3, right: V3, u: number, up: V3, w: number): V3 {
  return [n[0] + right[0] * u + up[0] * w, n[1] + right[1] * u + up[1] * w, n[2] + right[2] * u + up[2] * w];
}

/** Точка куба (в половинах ребра, оси здания) → метры сцены. */
function toScene(f: CubeFrame, v: V3): V3 {
  return [
    f.center[0] + (v[0] * f.x[0] + v[1] * f.y[0]) * f.half,
    f.center[1] + (v[0] * f.x[1] + v[1] * f.y[1]) * f.half,
    f.center[2] + v[2] * f.half,
  ];
}

/** Точка по сторонам света (x — восток, y — север; в половинах ребра) на уровне z куба. */
function worldDir(f: CubeFrame, d: P2, z: number): V3 {
  return [f.center[0] + d[0] * f.half, f.center[1] + d[1] * f.half, f.center[2] + z * f.half];
}

/** Ориентированная площадь (экран, y вниз): > 0 — обход по часовой, грань к нам лицом. */
function area(q: P2[]): number {
  let s = 0;
  for (let i = 0; i < q.length; i++) { const a = q[i], b = q[(i + 1) % q.length]; s += a[0] * b[1] - b[0] * a[1]; }
  return s;
}

/** Расстояние своей камеры до центра куба (в половинах ребра): чем больше, тем слабее перспектива. */
const CAM_DIST = 16;
/** Фокусное расстояние: кольцо компаса занимает почти весь элемент. */
const FOCAL = (CAM_DIST * BOX * 0.44) / RING_R;

/** Проекция своей камеры: азимут b и наклон p (как у карты, градусы), центр куба — в центре элемента. */
function camera(b: number, p: number): (q: V3) => P2 | undefined {
  const br = b / DEG, pr = p / DEG;
  const F: V3 = [Math.sin(br) * Math.sin(pr), Math.cos(br) * Math.sin(pr), -Math.cos(pr)]; // взгляд
  const R: V3 = [Math.cos(br), -Math.sin(br), 0]; // вправо по экрану
  const U: V3 = [R[1] * F[2] - R[2] * F[1], R[2] * F[0] - R[0] * F[2], R[0] * F[1] - R[1] * F[0]]; // вверх
  const dot = (a: V3, c: V3) => a[0] * c[0] + a[1] * c[1] + a[2] * c[2];
  return (q) => {
    const d: V3 = [q[0] + F[0] * CAM_DIST, q[1] + F[1] * CAM_DIST, q[2] + F[2] * CAM_DIST];
    const z = dot(d, F);
    if (z <= 0.1) return;
    return [BOX / 2 + (FOCAL * dot(d, R)) / z, BOX / 2 - (FOCAL * dot(d, U)) / z];
  };
}

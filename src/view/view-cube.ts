import type * as maplibregl from 'maplibre-gl';

type V3 = [number, number, number];
type P2 = [number, number];

/** Грань куба в осях здания (x, y — оси здания, z — вверх): нормаль, «вправо» и «вверх» по грани снаружи. */
interface Face { label: string; n: V3; right: V3; up: V3 }

const FACES: Face[] = [
  { label: 'Сверху', n: [0, 0, 1], right: [1, 0, 0], up: [0, 1, 0] },
  { label: 'Спереди', n: [0, -1, 0], right: [1, 0, 0], up: [0, 0, 1] },
  { label: 'Справа', n: [1, 0, 0], right: [0, 1, 0], up: [0, 0, 1] },
  { label: 'Сзади', n: [0, 1, 0], right: [-1, 0, 0], up: [0, 0, 1] },
  { label: 'Слева', n: [-1, 0, 0], right: [0, -1, 0], up: [0, 0, 1] },
];

/** Размер элемента, px. */
const BOX = 112;
const DEG = 180 / Math.PI;
/** Радиус кольца компаса — в половинах ребра куба. */
const RING_R = 2.3;

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
 */
export class ViewCube implements maplibregl.IControl {
  private map?: maplibregl.Map;
  private el!: HTMLDivElement;
  private readonly sync = () => this.update();
  private lastKey = '';
  /** Куб включён кнопкой (в режиме здания). */
  shown = true;

  constructor(private readonly opts: ViewCubeOptions) {}

  onAdd(map: maplibregl.Map): HTMLElement {
    this.map = map;
    const el = this.el = document.createElement('div');
    el.className = 'maplibregl-ctrl view-cube';
    el.hidden = true;
    el.addEventListener('click', (e) => this.click(e));
    // Ребро и угол — это 2 и 3 ячейки на соседних гранях с одним направлением (data-v): подсвечиваем все
    el.addEventListener('mouseover', (e) => this.hover((e.target as Element).closest<SVGElement>('.vc-cell')?.dataset.v));
    el.addEventListener('mouseleave', () => this.hover(undefined));
    el.addEventListener('mousedown', (e) => { if ((e.target as Element).closest('.vc-ring')) this.dragRing(e); });
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
    if (!key || !f) { this.el.innerHTML = ''; return; }

    // Все точки рисунка в координатах экрана, затем — общее масштабирование в рамку BOX
    const ring: (P2 | undefined)[] = [];
    for (let i = 0; i <= 64; i++) {
      const a = (i / 64) * 2 * Math.PI;
      ring.push(project(worldDir(f, [Math.cos(a) * RING_R, Math.sin(a) * RING_R], -1)));
    }
    const dirs = [['С', [0, 1]], ['В', [1, 0]], ['Ю', [0, -1]], ['З', [-1, 0]]] as const;
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
    this.el.innerHTML = `<svg viewBox="0 0 ${BOX} ${BOX}" width="${BOX}" height="${BOX}">${svg}</svg>`;
    if (this.hovered) this.hover(this.hovered);
  }

  private hovered?: string;

  private hover(v: string | undefined) {
    this.hovered = v;
    for (const c of this.el.querySelectorAll<SVGElement>('.vc-cell')) c.classList.toggle('hover', !!v && c.dataset.v === v);
  }

  private click(e: MouseEvent) {
    const t = e.target as Element;
    const f = this.opts.frame();
    if (!f || !this.map) return;
    const dir = t.closest<SVGElement>('.vc-dir');
    if (dir && !this.ringDragged) {
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

  private ringDragged = false;

  /** Перетаскивание кольца — поворот по азимуту вокруг центра элемента. */
  private dragRing(e: MouseEvent) {
    if (!this.map || e.button !== 0) return;
    e.preventDefault();
    const r = this.el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const angle = (ev: MouseEvent) => Math.atan2(ev.clientX - cx, cy - ev.clientY) * DEG;
    const start = angle(e), b0 = this.map.getBearing();
    this.ringDragged = false;
    const move = (ev: MouseEvent) => {
      const d = angle(ev) - start;
      if (Math.abs(d) > 2) this.ringDragged = true;
      if (this.ringDragged) this.map?.setBearing(b0 - d);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      // click после перетаскивания не должен ещё и повернуть к букве
      setTimeout(() => (this.ringDragged = false), 0);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }
}

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

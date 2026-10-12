/**
 * Индикатор загрузки: контурный изометрический объём абстрактного здания, части которого перетекают
 * из одной формы в другую. Рисуется только линиями (рёбра и силуэт, невидимые линии скрыты):
 * каждый пиксель — луч в изометрии против выпуклых частей, линия там, где меняется видимая плоскость.
 * Соприкасающиеся части с общей плоскостью сливаются в один объём без шва.
 */

/**
 * Часть объёма: коробка [x0, y0, z0, x1, y1, z1]. С roof — вместо коробки крыша с коньком вдоль оси roof:
 * двускатная (gable), односкатная (skillion, высокий край у меньшей координаты) или ломаная двускатная (gambrel).
 */
export interface Part { b: readonly number[]; roof?: 'x' | 'y'; kind?: 'gable' | 'skillion' | 'gambrel' }
export type Shape = readonly Part[];

type Plane = { n: readonly [number, number, number]; off: number };

const S2 = Math.SQRT1_2, S6 = 1 / Math.sqrt(6), S3 = 1 / Math.sqrt(3);
// Изометрия: зритель в (+1, +1, +1), видны грани +x, +y, +z
const R = [S2, -S2, 0] as const, UP = [-S6, -S6, 2 * S6] as const, D = [S3, S3, S3] as const;
const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Профиль крыши в поперечном сечении (s — поперёк конька, z — высота): отрезки скатов. */
function profile(kind: Part['kind'], s0: number, s1: number, z0: number, z1: number): [number, number][][] {
  const sc = (s0 + s1) / 2, w = s1 - s0, h = z1 - z0;
  if (kind === 'skillion') return [[[s0, z1], [s1, z0]]];
  if (kind === 'gambrel') {
    // Нижние скаты крутые, верхние пологие: перелом на 0.15 ширины от карниза и 0.6 высоты
    const l: [number, number] = [s0 + 0.15 * w, z0 + 0.6 * h], r: [number, number] = [s1 - 0.15 * w, z0 + 0.6 * h];
    return [[[s0, z0], l], [l, [sc, z1]], [[s1, z0], r], [r, [sc, z1]]];
  }
  return [[[s0, z0], [sc, z1]], [[s1, z0], [sc, z1]]];
}

function planes(p: Part): Plane[] {
  const [x0, y0, z0, x1, y1, z1] = p.b;
  if (x1 - x0 < 1e-3 || y1 - y0 < 1e-3 || z1 - z0 < 1e-3) return [];
  const sides: Plane[] = [
    { n: [-1, 0, 0], off: -x0 }, { n: [1, 0, 0], off: x1 },
    { n: [0, -1, 0], off: -y0 }, { n: [0, 1, 0], off: y1 },
    { n: [0, 0, -1], off: -z0 },
  ];
  if (!p.roof) return [...sides, { n: [0, 0, 1], off: z1 }];
  const [s0, s1] = p.roof === 'x' ? [y0, y1] : [x0, x1];
  const inner = [(s0 + s1) / 2, z0 + 1e-3 * (z1 - z0)];
  return [...sides, ...profile(p.kind, s0, s1, z0, z1).map(([a, b]): Plane => {
    // Нормаль отрезка наружу (от точки внутри профиля)
    let ns = -(b[1] - a[1]), nz = b[0] - a[0];
    const l = Math.hypot(ns, nz);
    ns /= l; nz /= l;
    if (ns * (inner[0] - a[0]) + nz * (inner[1] - a[1]) > 0) { ns = -ns; nz = -nz; }
    const n: Plane['n'] = p.roof === 'x' ? [0, ns, nz] : [ns, 0, nz];
    return { n, off: ns * a[0] + nz * a[1] };
  })];
}

const ease = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export interface MorphOptions {
  /** Формы по кругу; у всех одинаковое число частей и одинаковые roof у частей с одним номером. */
  shapes: readonly Shape[];
  /** Длительность перехода и паузы на форме, с. */
  morph?: number; hold?: number;
  /** Сдвиг начала движения соседних частей, с: части трансформируются не разом. */
  stagger?: number;
  /** Толщина линии, CSS px. */
  line?: number;
  /** Поворот вокруг вертикали после каждой формы: длительность, с (0 — без поворота), и угол, градусы. */
  turn?: number; turnAngle?: number;
}

/** Камера, повёрнутая вокруг вертикали на θ (поворот объёма на −θ). */
function camera(theta: number) {
  const c = Math.cos(theta), s = Math.sin(theta);
  const rot = (a: readonly number[]) => [a[0] * c - a[1] * s, a[0] * s + a[1] * c, a[2]] as const;
  return { r: rot(R), up: rot(UP), d: rot(D) };
}

export class MorphLoader {
  private raf = 0;
  private t0 = 0;
  private readonly off = document.createElement('canvas');
  private ids = new Int32Array(0);
  private readonly fit: { c: readonly [number, number, number]; cv: number; scale: number };
  private readonly o: Required<MorphOptions>;

  constructor(private readonly canvas: HTMLCanvasElement, opts: MorphOptions) {
    this.o = { morph: 0.8, hold: 0.55, stagger: 0.09, line: 1.1, turn: 0, turnAngle: 90, ...opts };
    // Ось поворота — центр всех форм в плане; рамка — по всем формам и углам сразу, чтобы объём не «прыгал»
    const all = this.o.shapes.flat();
    const mid = (j: number) => (Math.min(...all.map((p) => p.b[j])) + Math.max(...all.map((p) => p.b[j + 3]))) / 2;
    const c = [mid(0), mid(1), 0] as const;
    let um = 0, v0 = Infinity, v1 = -Infinity;
    for (let a = 0; a < 360; a += this.o.turn ? 15 : 360) {
      const cam = camera((a * Math.PI) / 180);
      for (const p of all) {
        const [x0, y0, z0, x1, y1, z1] = p.b;
        for (const x of [x0, x1]) for (const y of [y0, y1]) for (const z of [z0, z1]) {
          const q = [x - c[0], y - c[1], z];
          um = Math.max(um, Math.abs(dot(q, cam.r))); v0 = Math.min(v0, dot(q, cam.up)); v1 = Math.max(v1, dot(q, cam.up));
        }
      }
    }
    this.fit = { c, cv: (v0 + v1) / 2, scale: 1 / Math.max(2 * um, v1 - v0) };
  }

  start() {
    if (this.raf) return;
    this.t0 = performance.now();
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const tick = (now: number) => {
      this.draw(reduce ? 0 : Math.max(0, now - this.t0) / 1000); // кадр rAF может быть помечен раньше start()
      this.raf = reduce ? 0 : requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop() { cancelAnimationFrame(this.raf); this.raf = 0; }

  /** Форма в момент t (с): части интерполируются с запаздыванием друг относительно друга. */
  private shapeAt(t: number): Part[] {
    const { shapes, morph, hold, stagger, turn } = this.o;
    const step = morph + hold + (turn ? turn + hold : 0), n = shapes.length;
    const i = Math.floor(t / step) % n, local = t % step;
    const a = shapes[i], b = shapes[(i + 1) % n];
    const span = morph - stagger * (a.length - 1);
    const lerp = (x: readonly number[], y: readonly number[], f: number) => x.map((v, j) => v + (y[j] - v) * f);
    const flat = (x: readonly number[]) => [x[0], x[1], x[2], x[3], x[4], x[2]];
    // Части, которые совпадают и до, и после перехода, движутся вместе — иначе их грани расходятся двойной линией
    const same = (j: number, k: number) => a[j].roof === a[k].roof && a[j].kind === a[k].kind && a[j].b.every((v, q) => v === a[k].b[q]) && b[j].b.every((v, q) => v === b[k].b[q]);
    return a.map((p, k) => {
      const order = a.findIndex((_, j) => same(j, k));
      const f = (local - order * stagger) / span;
      if (!p.roof) return { b: lerp(p.b, b[k].b, ease((f - 0.15) / 0.7)) };
      // Крыша сначала ложится, переезжает вместе со стенами и поднимается уже на новом месте
      const pa = p.b, pb = b[k].b;
      const box = f < 0.3 ? lerp(pa, flat(pa), ease(f / 0.3)) : f < 0.7 ? lerp(flat(pa), flat(pb), ease((f - 0.3) / 0.4)) : lerp(flat(pb), pb, ease((f - 0.7) / 0.3));
      return { roof: p.roof, kind: p.kind, b: box };
    });
  }

  /** Угол поворота в момент t: после формы и паузы объём доворачивается на turnAngle. */
  private angleAt(t: number): number {
    const { morph, hold, turn, turnAngle } = this.o;
    if (!turn) return 0;
    const step = morph + hold + turn + hold;
    return ((Math.floor(t / step) + ease(((t % step) - morph - hold) / turn)) * turnAngle * Math.PI) / 180;
  }

  draw(t: number) {
    const dpr = Math.min(window.devicePixelRatio || 1, 3), ss = 2;
    const cw = this.canvas.clientWidth, ch = this.canvas.clientHeight;
    if (!cw || !ch) return;
    const W = Math.round(cw * dpr), H = Math.round(ch * dpr);
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
    const w = W * ss, h = H * ss;
    if (this.off.width !== w || this.off.height !== h) { this.off.width = w; this.off.height = h; this.ids = new Int32Array(w * h); }

    // Плоскости частей; одинаковые плоскости разных частей получают один номер — шва нет
    const keys = new Map<string, number>(), cam = camera(this.angleAt(t)), c = this.fit.c;
    const parts = this.shapeAt(t).map((p) => planes(p).map((pl) => {
      const k = `${pl.n.map((c) => Math.round(c * 1e3)).join()},${Math.round(pl.off * 300)}`;
      let id = keys.get(k);
      if (id === undefined) keys.set(k, (id = keys.size));
      return { id, nr: dot(pl.n, cam.r), nu: dot(pl.n, cam.up), nd: dot(pl.n, cam.d), off: pl.off - dot(pl.n, c) };
    })).filter((ps) => ps.length);

    const pad = 0.06, size = Math.min(w, h) * (1 - 2 * pad) * this.fit.scale, L = 50;
    const ids = this.ids;
    for (let py = 0; py < h; py++) {
      const v = this.fit.cv - (py + 0.5 - h / 2) / size;
      for (let px = 0; px < w; px++) {
        const u = (px + 0.5 - w / 2) / size;
        let best = Infinity, bestId = -1;
        for (const ps of parts) {
          let tn = -Infinity, tf = Infinity, enter = -1;
          for (const pl of ps) {
            // Луч O + s·(−D), O = c + u·R + v·UP + L·D (векторы повёрнутой камеры);  внутри: n·p ≤ off
            const no = u * pl.nr + v * pl.nu + L * pl.nd, nd = -pl.nd;
            if (Math.abs(nd) < 1e-9) { if (no > pl.off) { tn = Infinity; break; } continue; }
            const s = (pl.off - no) / nd;
            if (nd < 0) { if (s > tn) { tn = s; enter = pl.id; } } else if (s < tf) tf = s;
          }
          if (tn < tf - 1e-6 && tn < best) { best = tn; bestId = enter; }
        }
        ids[py * w + px] = bestId;
      }
    }

    // Щели в пиксель между почти совпавшими плоскостями (в середине перехода) дают мусорные точки — заклеиваем
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x, l = ids[i - 1], u = ids[i - w];
      if (l === ids[i + 1] && l !== ids[i]) ids[i] = l;
      else if (u === ids[i + w] && u !== ids[i]) ids[i] = u;
    }

    // Линии: пиксели, где сосед справа или снизу видит другую плоскость, с утолщением до толщины линии
    const color = getComputedStyle(this.canvas).color.match(/[\d.]+/g)?.map(Number) ?? [31, 41, 55];
    const ctx = this.off.getContext('2d')!;
    const img = ctx.createImageData(w, h), px8 = img.data;
    const r = Math.max(0, (this.o.line * dpr * ss) / 2 - 0.5), ri = Math.ceil(r);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const id = ids[y * w + x];
      const edge = (x + 1 < w && ids[y * w + x + 1] !== id) || (y + 1 < h && ids[(y + 1) * w + x] !== id);
      if (!edge) continue;
      for (let dy = -ri; dy <= ri; dy++) for (let dx = -ri; dx <= ri; dx++) {
        const X = x + dx, Y = y + dy;
        if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
        const a = Math.max(0, Math.min(1, r + 1 - Math.hypot(dx, dy)));
        const i4 = (Y * w + X) * 4;
        if (a * 255 > px8[i4 + 3]) { px8[i4] = color[0]; px8[i4 + 1] = color[1]; px8[i4 + 2] = color[2]; px8[i4 + 3] = a * 255; }
      }
    }
    ctx.putImageData(img, 0, 0);
    const out = this.canvas.getContext('2d')!;
    out.clearRect(0, 0, W, H);
    out.imageSmoothingEnabled = true; out.imageSmoothingQuality = 'high';
    out.globalAlpha = color[3] ?? 1;
    out.drawImage(this.off, 0, 0, W, H);
  }
}

const box = (...b: number[]): Part => ({ b });
const roofX = (...b: number[]): Part => ({ b, roof: 'x' });
const roofY = (...b: number[]): Part => ({ b, roof: 'y' });
const gambrelY = (...b: number[]): Part => ({ b, roof: 'y', kind: 'gambrel' });
const skillionX = (...b: number[]): Part => ({ b, roof: 'x', kind: 'skillion' });

/**
 * Формы, вписанные в куб 3×3×3: двускатная крыша → ломаная → высокий корпус с односкатной пристройкой →
 * односкатная на весь куб → половина с плоской крышей, половина с двускатной.
 * Части: нижний объём, верхний объём, двускатная (конёк по x), ломаная (по y), односкатная (по x), двускатная (по y).
 */
const flat = (z: number, x0 = 0, y0 = 0, x1 = 3, y1 = 3) => [x0, y0, z, x1, y1, z];
export const CUBE_SHAPES: readonly Shape[] = [
  [box(0, 0, 0, 3, 3, 1.8), box(0, 0, 0, 3, 3, 1.8), roofX(0, 0, 1.8, 3, 3, 3), gambrelY(...flat(1.8)), skillionX(...flat(1.8)), roofY(...flat(1.8))],
  [box(0, 0, 0, 3, 3, 1.2), box(0, 0, 0, 3, 3, 1.2), roofX(...flat(1.2)), gambrelY(0, 0, 1.2, 3, 3, 3), skillionX(...flat(1.2)), roofY(...flat(1.2))],
  [box(0, 0, 0, 3, 3, 1.4), box(0, 0, 1.4, 3, 1.4, 3), roofX(...flat(1.4, 0, 1.4)), gambrelY(...flat(1.4, 0, 1.4)), skillionX(0, 1.4, 1.4, 3, 3, 2.6), roofY(...flat(1.4, 0, 1.4))],
  [box(0, 0, 0, 3, 3, 1.6), box(0, 0, 0, 3, 3, 1.6), roofX(...flat(1.6)), gambrelY(...flat(1.6)), skillionX(0, 0, 1.6, 3, 3, 3), roofY(...flat(1.6))],
  [box(0, 0, 0, 3, 3, 1.6), box(1.5, 0, 1.6, 3, 3, 3), roofX(...flat(1.6, 0, 0, 1.5)), gambrelY(...flat(1.6, 0, 0, 1.5)), skillionX(...flat(1.6, 0, 0, 1.5)), roofY(0, 0, 1.6, 1.5, 3, 3)],
];

/** Параметры анимации индикатора в редакторе. */
export const LOADER_TIMING = { morph: 0.9, hold: 0.3, turn: 0.7, stagger: 0.08 } as const;

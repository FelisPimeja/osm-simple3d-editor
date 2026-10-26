/**
 * Универсальная пипетка — одна для заливки (Ctrl/Cmd/Alt+клик) и для кнопки-пипетки у цветовых тегов в свойствах.
 * Что под курсором:
 *  - здание на карте — берётся его цвет (фасада или крыши — куда кликнули), лупы нет;
 *  - иначе карта (спутниковая подложка) или фото в окне панорамы — цвет с растра: лупа с увеличенными пикселями,
 *    в зачёт идёт среднее по пятну в центре (рамка в лупе).
 * Пиксели читаем с того, что нарисовано на экране (WebGL карты и панорамы, холст обычного фото), — как видно, так и берём.
 */
import { tr } from '../i18n';
import { toolCursor } from '../view/cursors';

export type PickFace = 'roof' | 'wall';

/** Пятно усреднения цвета (радиус в пикселях) и сколько пикселей видно в лупе. */
const SAMPLE_R = 1;
const LOUPE_R = 7;

/** Источник растра: элемент и пиксели вокруг точки в нём (квадрат (2R+1)², строки сверху вниз, RGBA). */
export interface RasterSource {
  el: HTMLElement;
  pixels(x: number, y: number, R: number): Uint8ClampedArray | undefined;
}

/** Режим пипетки: кто её включил и что делать со взятым. */
export interface PickMode {
  /** Брать только с зажатым Ctrl/Cmd/Alt (заливка) или любым кликом (кнопка у поля). */
  modifier: boolean;
  /** Клик по зданию: ключ и поверхность (undefined — не определить, вне режима здания). */
  building(key: string, face: PickFace | undefined): void;
  /** Цвет с растра. */
  colour(hex: string): void;
  /** Esc или клик мимо всего — выйти (только для режима кнопки). */
  cancel?(): void;
}

/** Здание под точкой карты (в пикселях контейнера карты). */
export type BuildingAt = (x: number, y: number) => { key: string; face?: PickFace } | undefined;

/** Средний цвет пятна SAMPLE_R вокруг центра квадрата пикселей (без шума сжатия), '#rrggbb'. */
function average(px: Uint8ClampedArray, R: number): string | undefined {
  const n = 2 * R + 1;
  let r = 0, g = 0, b = 0, cnt = 0;
  for (let row = R - SAMPLE_R; row <= R + SAMPLE_R; row++) {
    for (let col = R - SAMPLE_R; col <= R + SAMPLE_R; col++) {
      const i = (row * n + col) * 4;
      if (px[i + 3]) { r += px[i]; g += px[i + 1]; b += px[i + 2]; cnt++; }
    }
  }
  if (!cnt) return;
  return '#' + [r, g, b].map((v) => Math.round(v / cnt).toString(16).padStart(2, '0')).join('');
}

/** Пиксели WebGL-холста вокруг точки (CSS px): перерисовать и прочитать в той же задаче, строки — сверху вниз. */
export function glPixels(gl: WebGLRenderingContext | WebGL2RenderingContext, x: number, y: number, R: number, k: number) {
  const n = 2 * R + 1;
  const gx = Math.round(x * k), gy = Math.round(gl.drawingBufferHeight - y * k);
  const raw = new Uint8Array(n * n * 4);
  gl.readPixels(gx - R, gy - R, n, n, gl.RGBA, gl.UNSIGNED_BYTE, raw);
  const px = new Uint8ClampedArray(n * n * 4);
  for (let row = 0; row < n; row++) px.set(raw.subarray((n - 1 - row) * n * 4, (n - row) * n * 4), row * n * 4);
  return px;
}

export class Eyedropper {
  private mode?: PickMode;
  private readonly loupe: HTMLCanvasElement;
  /** Курсор: над каким источником и где (координаты экрана). */
  private pointer?: { src: RasterSource; isMap: boolean; x: number; y: number };
  private modifierDown = false;
  /** Когда последний раз взяли цвет: click карты после нажатия пипеткой — не выделение и не заливка. */
  pickedAt = 0;

  constructor(
    private readonly map: RasterSource,
    /** Фото в окнах просмотра (Panoramax, Mapillary). */
    private readonly photos: RasterSource[],
    private readonly buildingAt: BuildingAt,
    /** Курсор над картой и фото сменился (пипетка или обычный). */
    private readonly onCursor: () => void,
  ) {
    this.loupe = document.createElement('canvas');
    this.loupe.className = 'eyedropper-loupe';
    this.loupe.hidden = true;
    document.body.append(this.loupe);
    for (const [src, isMap] of [[map, true] as const, ...photos.map((p) => [p, false] as const)]) {
      src.el.addEventListener('pointermove', (e) => { this.track(src, isMap, e); this.sync(); });
      src.el.addEventListener('pointerleave', () => { if (this.pointer?.src === src) this.pointer = undefined; this.sync(); });
      // Берём на нажатии: на macOS Ctrl+клик — правый, click не придёт; перехватываем раньше карты и панорамы
      src.el.addEventListener('pointerdown', (e) => {
        if (!this.armed(e)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        this.track(src, isMap, e);
        this.pick();
      }, { capture: true });
      src.el.addEventListener('contextmenu', (e) => { if (this.mode) e.preventDefault(); });
    }
    for (const type of ['keydown', 'keyup'] as const) {
      addEventListener(type, (e: KeyboardEvent) => {
        const on = e.ctrlKey || e.metaKey || e.altKey;
        if (on !== this.modifierDown) { this.modifierDown = on; this.sync(); this.onCursor(); }
        if (type === 'keydown' && e.key === 'Escape' && this.mode?.cancel) { e.preventDefault(); this.mode.cancel(); }
      }, { capture: true });
    }
    addEventListener('blur', () => { this.modifierDown = false; this.sync(); });
  }

  get active() { return !!this.mode; }

  /** Отменить режим со своей отменой (пипетка цветового поля); false — такого нет. */
  cancel(): boolean {
    if (!this.mode?.cancel) return false;
    this.mode.cancel();
    return true;
  }

  /** Курсор-пипетка сейчас (без модификатора у заливки — нет). */
  get picking() { return !!this.mode && (!this.mode.modifier || this.modifierDown); }

  /** Включить (mode) или выключить (undefined). */
  set(mode: PickMode | undefined) {
    this.mode = mode;
    this.sync();
    this.onCursor();
  }

  /** Курсор-пипетка над фото (над картой курсором ведает main.ts — у неё свои курсоры инструментов). */
  private syncPhotoCursor() {
    for (const p of this.photos) p.el.style.cursor = this.picking ? toolCursor('pick') : '';
  }

  private armed(e: MouseEvent) {
    return !!this.mode && (!this.mode.modifier || e.ctrlKey || e.metaKey || e.altKey);
  }

  private track(src: RasterSource, isMap: boolean, e: MouseEvent) {
    const r = src.el.getBoundingClientRect();
    this.pointer = { src, isMap, x: e.clientX - r.left, y: e.clientY - r.top };
    this.modifierDown = e.ctrlKey || e.metaKey || e.altKey;
  }

  /** Здание под курсором карты (тогда цвет — из тегов, лупы нет). */
  private building() {
    const p = this.pointer;
    return p?.isMap ? this.buildingAt(p.x, p.y) : undefined;
  }

  private pick() {
    const p = this.pointer, mode = this.mode;
    if (!p || !mode) return;
    this.pickedAt = performance.now();
    const b = this.building();
    if (b) { mode.building(b.key, b.face); return; }
    const px = p.src.pixels(p.x, p.y, SAMPLE_R);
    const c = px && average(px, SAMPLE_R);
    if (c) mode.colour(c);
    else mode.cancel?.();
  }

  /** Лупа — пока пипетка «взведена» и под курсором растр, а не здание. */
  private sync() {
    this.syncPhotoCursor();
    const p = this.pointer;
    if (!p || !this.picking || this.building()) { this.loupe.hidden = true; return; }
    const px = p.src.pixels(p.x, p.y, LOUPE_R);
    if (!px) { this.loupe.hidden = true; return; }
    this.draw(px, p.src.el.getBoundingClientRect(), p.x, p.y);
  }

  /** Лупа у курсора: увеличенные пиксели, рамка — пятно усреднения, кольцо и плашка — взятый цвет. */
  private draw(px: Uint8ClampedArray, box: DOMRect, x: number, y: number) {
    const n = 2 * LOUPE_R + 1, c = this.loupe, size = 108, cell = size / n, dpr = devicePixelRatio;
    if (c.width !== Math.round(size * dpr)) c.width = c.height = Math.round(size * dpr);
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    for (let row = 0; row < n; row++) {
      for (let col = 0; col < n; col++) {
        const i = (row * n + col) * 4;
        ctx.fillStyle = px[i + 3] ? `rgb(${px[i]},${px[i + 1]},${px[i + 2]})` : '#111';
        ctx.fillRect(col * cell, row * cell, cell + 0.5, cell + 0.5);
      }
    }
    const a = (LOUPE_R - SAMPLE_R) * cell, w = (2 * SAMPLE_R + 1) * cell;
    ctx.lineWidth = 2; ctx.strokeStyle = '#000'; ctx.strokeRect(a, a, w, w);
    ctx.lineWidth = 1; ctx.strokeStyle = '#fff'; ctx.strokeRect(a - 1.5, a - 1.5, w + 3, w + 3);
    const colour = average(px, LOUPE_R) ?? '#ffffff';
    c.style.borderColor = colour;
    // Итоговый цвет — плашкой с кодом внизу лупы (кольцо сливается с соседними пикселями)
    const pw = 64, ph = 18, pxl = (size - pw) / 2, pyl = size - ph - 8;
    ctx.beginPath(); ctx.roundRect(pxl, pyl, pw, ph, 9);
    ctx.fillStyle = colour; ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#fff'; ctx.stroke();
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(colour.slice(i, i + 2), 16));
    ctx.fillStyle = 0.299 * r + 0.587 * g + 0.114 * b > 140 ? '#111' : '#fff';
    ctx.font = '600 11px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(colour, size / 2, pyl + ph / 2 + 0.5);
    // Выше и правее курсора, у краёв экрана — с другой стороны (размер с рамкой — 120)
    const S = 120, cx = box.left + x, cy = box.top + y;
    const lx = cx + 16 + S > innerWidth ? cx - 16 - S : cx + 16, ly = cy - 16 - S < 0 ? cy + 16 : cy - 16 - S;
    c.style.transform = `translate(${lx}px, ${ly}px)`;
    c.hidden = false;
  }
}

/** Подсказка режима кнопки-пипетки у поля. */
export const pickFieldHint = () =>
  tr('Пипетка: клик по зданию — его цвет, по спутниковой подложке или фото в окне панорамы — цвет пикселей. Esc — отмена.');

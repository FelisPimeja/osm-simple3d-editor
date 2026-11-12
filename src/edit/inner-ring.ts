/**
 * Внутреннее кольцо — общее для всех инструментов, строящих замкнутый контур (рисование полигона, прямоугольника,
 * круга, многоугольника; «Отступ»), и в режиме здания, и на плане этажа: переключатель режима и проверка, что
 * кольцо лежит внутри полигона. Само добавление кольца — addInnerRing в main.ts (части здания и объекты этажа).
 */
import polygonClipping from 'polygon-clipping';
import { tr } from '../i18n';
import type { Segment, ToolOptions } from './tool-options';

type Pt = [number, number];

/** Переключатель «новый объект / внутреннее кольцо» на плашке инструмента (клавиша I). */
export class RingMode {
  /** Режим включён: контур — дырой в цели. */
  on = false;
  private readonly seg: Segment<boolean>;

  /** changed — после переключения (подсказка, перерисовка). */
  constructor(private readonly options: ToolOptions, title: string, private readonly changed: (on: boolean) => void) {
    this.seg = options.segment([{ value: false, label: tr('новый объект') }, { value: true, label: tr('внутреннее кольцо') }], title, (v) => this.set(v));
  }

  /** Режим доступен сейчас (переключатель виден). */
  get available() { return !this.seg.el.hidden; }

  /** Показать или спрятать переключатель; спрятанный — выключен. */
  show(available: boolean) {
    this.seg.el.hidden = !available;
    if (!available) this.on = false;
    this.seg.set(this.on);
    this.options.sync();
  }

  set(on: boolean) {
    if (!this.available) return;
    this.on = on;
    this.seg.set(on);
    this.changed(on);
  }

  /** Подпись режима без кольца (у «Отступа» на плане этажа — буфер стен). */
  offLabel(text: string) { const b = this.seg.el.querySelector('button'); if (b && b.textContent !== text) b.textContent = text; }

  /** Сбросить на «новый объект» (новый запуск инструмента). */
  reset() { this.on = false; this.seg.set(false); }

  /** Клавиша I — переключить; true — нажатие обработано. */
  key(e: KeyboardEvent): boolean {
    if (e.type !== 'keydown' || e.code !== 'KeyI' || !this.available || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return false;
    this.set(!this.on);
    return true;
  }
}

const close = (r: Pt[]): Pt[] => (r.length && (r[0][0] !== r.at(-1)![0] || r[0][1] !== r.at(-1)![1]) ? [...r, r[0]] : r);
const area = (r: Pt[]) => { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]); return Math.abs(a / 2); };

/** Кольцо ring лежит внутри полигона [outer, ...inners] (метры): не выходит за контур и не задевает его дыр. */
export function ringInside(ring: Pt[], outer: Pt[], inners: Pt[][]): boolean {
  const own = area(ring);
  if (own <= 0) return false;
  try {
    const cut = polygonClipping.intersection([close(ring)], [close(outer), ...inners.map(close)]);
    const got = cut.reduce((a, p) => a + area(p[0]) - p.slice(1).reduce((b, h) => b + area(h), 0), 0);
    return Math.abs(got - own) <= 1e-3 * Math.max(1, own);
  } catch { return false; }
}

/**
 * Панель инструмента — одна плашка по центру внизу (как у «Вытянуть»): строка ввода инструмента (vcb) и в ряд с ней
 * опции, доступные ему сейчас, кнопками-сегментами. Скрытые опции не видны; нет видимого — не видна и плашка.
 */
/** Сегменты-кнопки панели: элемент и подсветка выбранного. */
export interface Segment<V> { el: HTMLSpanElement; set: (v: V) => void }

export class ToolOptions {
  readonly bar: HTMLDivElement;
  private readonly el: HTMLSpanElement;

  /** vcb — строка ввода инструмента: переезжает в плашку, перед опциями. */
  constructor(container: HTMLElement, vcb?: HTMLElement) {
    this.bar = document.createElement('div');
    this.bar.className = 'tool-bar';
    // Клики по плашке — не карте
    for (const ev of ['mousedown', 'click', 'dblclick'] as const) this.bar.addEventListener(ev, (e) => e.stopPropagation());
    if (vcb) this.bar.appendChild(vcb);
    this.el = document.createElement('span');
    this.el.className = 'tool-options';
    this.el.hidden = true;
    this.bar.appendChild(this.el);
    container.appendChild(this.bar);
  }

  /** Добавить опцию; показывается через sync(). */
  add<T extends HTMLElement>(item: T): T {
    item.classList.add('tool-option');
    item.hidden = true;
    this.el.appendChild(item);
    return item;
  }

  /**
   * Сегменты-кнопки (одна — переключатель вкл/выкл, несколько — выбор одного): onPick получает значение нажатой.
   * set(value) — подсветить выбранное (у одной кнопки — true/false).
   */
  segment<V>(choices: { value: V; label: string }[], title: string, onPick: (v: V) => void): Segment<V> {
    const el = this.add(document.createElement('span'));
    el.classList.add('vcb-units');
    el.title = title;
    const buttons = choices.map((c) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = c.label;
      b.addEventListener('click', () => onPick(choices.length === 1 ? (!b.classList.contains('active') as unknown as V) : c.value));
      el.appendChild(b);
      return b;
    });
    return {
      el,
      set: (v: V) => buttons.forEach((b, i) => b.classList.toggle('active', choices.length === 1 ? (v as unknown) === true : choices[i].value === v)),
    };
  }

  /** Опции видны, если видна хоть одна. */
  sync() {
    this.el.hidden = ![...this.el.children].some((c) => !(c as HTMLElement).hidden);
  }
}

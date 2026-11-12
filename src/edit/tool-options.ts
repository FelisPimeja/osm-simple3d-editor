/**
 * Панель опций инструмента: одна плашка над панелью ввода, в ней — опции, доступные выбранному инструменту
 * сейчас (переключатели режимов, поля). Скрытые опции не видны; нет видимых — не видна и панель.
 */
export class ToolOptions {
  readonly el: HTMLDivElement;

  constructor(container: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'draw-opts tool-options';
    this.el.hidden = true;
    // Клики по панели — не карте
    for (const ev of ['mousedown', 'click', 'dblclick'] as const) this.el.addEventListener(ev, (e) => e.stopPropagation());
    container.appendChild(this.el);
  }

  /** Добавить опцию (строка панели); показывается через sync(). */
  add<T extends HTMLElement>(item: T): T {
    item.classList.add('tool-option');
    item.hidden = true;
    this.el.appendChild(item);
    return item;
  }

  /** Панель видна, если видна хоть одна опция. */
  sync() {
    this.el.hidden = ![...this.el.children].some((c) => !(c as HTMLElement).hidden);
  }
}

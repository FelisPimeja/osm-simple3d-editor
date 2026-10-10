/**
 * Уведомления над картой: подсказка активного инструмента (держится, пока инструмент её не снимет) и стопка
 * всплывающих сообщений — обычные уходят через 4 с, ошибки через 10 с; наведение придерживает, × закрывает.
 * Текст выделяется и копируется. Повтор того же текста не плодит копию, а продлевает показ.
 */
const INFO_MS = 4000;
const ERROR_MS = 10000;
const MAX_TOASTS = 4;

export class Toasts {
  private readonly root: HTMLDivElement;
  private readonly hintEl: HTMLDivElement;
  private readonly stack: HTMLDivElement;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.id = 'toasts';
    this.hintEl = document.createElement('div');
    this.hintEl.className = 'toast hint-bar';
    this.hintEl.hidden = true;
    this.stack = document.createElement('div');
    this.stack.className = 'toast-stack';
    this.root.append(this.hintEl, this.stack);
    parent.appendChild(this.root);
  }

  /** Подсказка инструмента; undefined — убрать. */
  hint(text: string | undefined, error = false) {
    this.hintEl.hidden = !text;
    if (!text) return;
    this.hintEl.textContent = text;
    this.hintEl.classList.toggle('error', error);
  }

  /** Всплывающее сообщение; html — дополнение разметкой (ссылка на changeset и т. п.). */
  show(text: string, error = false, html = '') {
    const same = [...this.stack.children].find((el) => (el as HTMLElement).dataset.text === text + html) as HTMLElement | undefined;
    const el = same ?? document.createElement('div');
    if (!same) {
      el.className = 'toast';
      el.dataset.text = text + html;
      const body = document.createElement('span');
      body.textContent = text;
      if (html) body.insertAdjacentHTML('beforeend', ` ${html}`);
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'toast-close';
      close.title = 'Закрыть';
      close.textContent = '×';
      close.addEventListener('click', () => el.remove());
      el.append(body, close);
      el.addEventListener('mouseenter', () => clearTimeout(Number(el.dataset.timer)));
      el.addEventListener('mouseleave', () => this.arm(el, error ? ERROR_MS / 2 : INFO_MS / 2));
    }
    el.classList.toggle('error', error);
    this.stack.prepend(el);
    while (this.stack.children.length > MAX_TOASTS) this.stack.lastElementChild!.remove();
    this.arm(el, error ? ERROR_MS : INFO_MS);
  }

  private arm(el: HTMLElement, ms: number) {
    clearTimeout(Number(el.dataset.timer));
    // Не убирать, пока в сообщении выделен текст (копируют)
    const tick = () => {
      const sel = getSelection();
      if (sel && !sel.isCollapsed && el.contains(sel.anchorNode)) el.dataset.timer = String(setTimeout(tick, 1000));
      else el.remove();
    };
    el.dataset.timer = String(setTimeout(tick, ms));
  }
}

/**
 * Подложки здания в меню слоёв (только в режиме здания): галка видимости у каждой, настройки под стрелкой —
 * прозрачность и удаление; «Добавить картинку…» — выбор файлов.
 */
import { tr } from '../i18n';
import { FOLD_SVG, MOVE_SVG } from './basemaps';
import { UNDERLAY_TYPES, type Underlay } from './underlays';

export interface UnderlayMenuHooks {
  add(files: File[]): void;
  /** Подложку изменили (видимость, прозрачность). */
  change(u: Underlay): void;
  remove(u: Underlay): void;
  /** Открыть панель подгонки (положение, поворот, масштаб). */
  adjust(u: Underlay): void;
}

export class UnderlayMenu {
  readonly el: HTMLDivElement;
  private readonly list: HTMLDivElement;
  private readonly file: HTMLInputElement;
  /** Подложка с раскрытыми настройками. */
  private open?: string;
  private items: Underlay[] = [];

  constructor(private readonly hooks: UnderlayMenuHooks) {
    const el = this.el = document.createElement('div');
    el.className = 'underlay-menu';
    el.hidden = true;
    el.addEventListener('click', (e) => e.stopPropagation());
    const head = document.createElement('div');
    head.className = 'basemap-overlay basemap-overlay-head';
    head.textContent = tr('Подложки здания');
    this.list = document.createElement('div');
    const file = this.file = document.createElement('input');
    file.type = 'file';
    file.accept = UNDERLAY_TYPES.join(',');
    file.multiple = true;
    file.hidden = true;
    file.addEventListener('change', () => {
      const files = [...file.files ?? []];
      file.value = '';
      if (files.length) hooks.add(files);
    });
    const buttons = document.createElement('div');
    buttons.className = 'basemap-shift-buttons underlay-add';
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'basemap-shift-tool';
    add.textContent = tr('Добавить картинку…');
    add.title = tr('Скан плана, чертёж, фасад (PNG, JPG, WebP, SVG). Можно и перетащить файл на карту или вставить Ctrl+V');
    add.addEventListener('click', () => file.click());
    buttons.append(add, file);
    const note = document.createElement('div');
    note.className = 'basemap-note';
    note.textContent = tr('Картинки хранятся только в этом браузере. Обводите только то, на что у вас есть права.');
    el.append(head, this.list, buttons, note);
  }

  /** Подложки здания; undefined — не в режиме здания (секция скрыта). */
  set(items: Underlay[] | undefined) {
    this.el.hidden = !items;
    this.items = items ?? [];
    this.render();
  }

  private render() {
    this.list.replaceChildren(...this.items.flatMap((u) => this.row(u)));
  }

  private row(u: Underlay): HTMLElement[] {
    const row = document.createElement('label');
    row.className = 'basemap-overlay-sub underlay-row';
    row.title = u.name;
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = u.visible;
    input.addEventListener('change', () => this.hooks.change({ ...u, visible: input.checked }));
    const name = document.createElement('span');
    name.className = 'underlay-name';
    name.textContent = u.name;
    const fold = document.createElement('button');
    fold.type = 'button';
    fold.className = 'basemap-offset-btn basemap-fold';
    fold.title = tr('Настройки подложки: прозрачность, подгонка, удаление');
    fold.innerHTML = FOLD_SVG;
    fold.classList.toggle('open', this.open === u.id);
    fold.addEventListener('click', (e) => {
      e.preventDefault(); // не переключать галку строки
      this.open = this.open === u.id ? undefined : u.id;
      this.render();
    });
    row.append(input, name, fold);
    if (this.open !== u.id) return [row];
    const sec = document.createElement('div');
    sec.className = 'basemap-imagery';
    const alphaRow = document.createElement('label');
    alphaRow.className = 'basemap-alpha';
    const alpha = document.createElement('input');
    alpha.type = 'range';
    alpha.min = '0';
    alpha.max = '100';
    alpha.step = '5';
    const value = document.createElement('span');
    const sync = (opacity: number) => {
      const t = Math.round((1 - opacity) * 100);
      alpha.value = String(t);
      value.textContent = `${t} %`;
    };
    sync(u.opacity);
    alpha.addEventListener('input', () => {
      const opacity = 1 - Number(alpha.value) / 100;
      sync(opacity);
      // Строку не пересобираем — ползунок остаётся под мышью
      const i = this.items.findIndex((x) => x.id === u.id);
      if (i >= 0) this.items[i] = u = { ...u, opacity };
      this.hooks.change(u);
    });
    alphaRow.append(tr('Прозрачность'), alpha, value);
    const buttons = document.createElement('div');
    buttons.className = 'basemap-shift-buttons';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'basemap-shift-reset';
    remove.textContent = tr('Удалить');
    remove.title = tr('Удалить подложку из этого браузера');
    remove.addEventListener('click', () => {
      if (this.open === u.id) this.open = undefined;
      this.hooks.remove(u);
    });
    const adjust = document.createElement('button');
    adjust.type = 'button';
    adjust.className = 'basemap-shift-tool';
    adjust.innerHTML = `${MOVE_SVG}<span>${tr('Подогнать')}</span>`;
    adjust.title = tr('Сдвинуть, повернуть и растянуть мышью, числами или по двум точкам');
    adjust.addEventListener('click', () => this.hooks.adjust(u));
    buttons.append(adjust, remove);
    sec.append(alphaRow, buttons);
    return [row, sec];
  }
}

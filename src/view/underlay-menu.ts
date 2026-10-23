/**
 * Подложки здания в меню слоёв (только в режиме здания): галка видимости у каждой, настройки под стрелкой —
 * прозрачность, этаж, подгонка и удаление; «Добавить картинку…» — выбор файлов.
 */
import { tr } from '../i18n';
import { FOLD_SVG, MOVE_SVG } from './basemaps';
import { UNDERLAY_TYPES, type Underlay } from './underlays';

export interface UnderlayMenuHooks {
  add(files: File[]): void;
  /** Подложку изменили (видимость, прозрачность, этаж). */
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
  /** Этажи здания (подпись — как в панели этажей) и выбранный. */
  private levels: { n: number; label: string }[] = [];
  private current?: number;

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

  /** Подложки здания; undefined — не в режиме здания (секция скрыта). levels — этажи здания, current — выбранный. */
  set(items: Underlay[] | undefined, levels: { n: number; label: string }[] = [], current?: number) {
    this.el.hidden = !items;
    this.items = items ?? [];
    this.levels = levels;
    this.current = current;
    this.render();
  }

  private levelLabel(n: number) { return this.levels.find((l) => l.n === n)?.label ?? `level=${n}`; }

  private render() {
    this.list.replaceChildren(...this.items.flatMap((u) => this.row(u)));
  }

  private row(u: Underlay): HTMLElement[] {
    const row = document.createElement('label');
    row.className = 'basemap-overlay-sub underlay-row';
    // Подложка другого этажа сейчас не видна — бледнее
    const away = u.level !== undefined && u.level !== this.current;
    row.classList.toggle('away', away);
    row.title = u.level === undefined ? u.name
      : `${u.name} · ${tr('видна на этаже: {level}', { level: this.levelLabel(u.level) })}`;
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
    fold.title = tr('Настройки подложки: прозрачность, этаж, подгонка, удаление');
    fold.innerHTML = FOLD_SVG;
    fold.classList.toggle('open', this.open === u.id);
    fold.addEventListener('click', (e) => {
      e.preventDefault(); // не переключать галку строки
      this.open = this.open === u.id ? undefined : u.id;
      this.render();
    });
    row.append(input, name);
    if (u.level !== undefined) {
      const lv = document.createElement('span');
      lv.className = 'underlay-level';
      lv.textContent = this.levelLabel(u.level);
      row.append(lv);
    }
    row.append(fold);
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
    // Этаж: на земле (видна всегда) или на отметке пола этажа (видна только на нём)
    const levelRow = document.createElement('label');
    levelRow.className = 'basemap-alpha underlay-level-row';
    levelRow.title = tr('Подложка этажа лежит на отметке его пола и видна, только когда этот этаж выбран в панели этажей');
    const select = document.createElement('select');
    const opt = (value: string, text: string) => {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = text;
      return o;
    };
    select.append(opt('', tr('На земле')), ...this.levels.map((l) => opt(String(l.n), l.label)));
    // Этажа подложки больше нет в здании — всё равно показать его
    if (u.level !== undefined && !this.levels.some((l) => l.n === u.level)) select.append(opt(String(u.level), `level=${u.level}`));
    select.value = u.level === undefined ? '' : String(u.level);
    select.addEventListener('change', () => this.hooks.change({ ...u, level: select.value === '' ? undefined : Number(select.value) }));
    levelRow.append(tr('Этаж'), select);
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
    sec.append(alphaRow, levelRow, buttons);
    return [row, sec];
  }
}

/**
 * Свои подложки в меню слоёв: на карте — общие, в режиме здания — его и общие. Галка видимости у каждой,
 * настройки под стрелкой — прозрачность, где видна (в режиме здания), этаж (у подложки здания), выбор и удаление;
 * «Добавить картинку…» — выбор файлов (на карте — общая, в режиме здания — этого здания).
 */
import { tr } from '../i18n';
import { FOLD_SVG, MOVE_SVG } from './basemaps';
import { UNDERLAY_TYPES, type Underlay } from './underlays';

export interface UnderlayMenuHooks {
  add(files: File[]): void;
  /** Подложку изменили (видимость, прозрачность, этаж, здание). */
  change(u: Underlay): void;
  remove(u: Underlay): void;
  /** Выделить подложку (инструменты и свойства). */
  select(u: Underlay): void;
  /** Новый порядок отрисовки: id снизу вверх (последняя — поверх). */
  reorder(ids: string[]): void;
}

const LOCK_SVG = '<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4.5" y="9" width="11" height="8" rx="1.5"/><path d="M7 9V6.5a3 3 0 0 1 6 0V9"/></svg>';

export class UnderlayMenu {
  readonly el: HTMLDivElement;
  private readonly list: HTMLDivElement;
  private readonly file: HTMLInputElement;
  /** Подложка с раскрытыми настройками. */
  private open?: string;
  private items: Underlay[] = [];
  /** Здание режима (undefined — карта), его этажи (подпись — как в панели этажей) и выбранный. */
  private building?: string;
  private levels: { n: number; label: string }[] = [];
  private current?: number;

  constructor(private readonly hooks: UnderlayMenuHooks) {
    const el = this.el = document.createElement('div');
    el.className = 'underlay-menu';
    el.addEventListener('click', (e) => e.stopPropagation());
    const head = document.createElement('div');
    head.className = 'basemap-overlay basemap-overlay-head';
    head.textContent = tr('Свои подложки');
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

  /** Подложки для списка; building — здание режима (undefined — карта), levels — его этажи, current — выбранный. */
  set(items: Underlay[], building?: string, levels: { n: number; label: string }[] = [], current?: number) {
    this.items = items;
    this.building = building;
    this.levels = levels;
    this.current = current;
    this.render();
  }

  private levelLabel(n: number) { return this.levels.find((l) => l.n === n)?.label ?? `level=${n}`; }

  /** Перетаскиваемая строка (id). */
  private dragged?: string;

  private render() {
    // Сверху — то, что рисуется поверх (как слои в графических редакторах)
    this.list.replaceChildren(...[...this.items].reverse().flatMap((u) => this.row(u)));
  }

  /** Строку dragged поставить над (before) или под target в списке. */
  private drop(target: string, before: boolean) {
    const id = this.dragged;
    this.dragged = undefined;
    if (!id || id === target) return this.render();
    const shown = [...this.items].reverse().map((u) => u.id).filter((x) => x !== id);
    const i = shown.indexOf(target);
    if (i < 0) return this.render();
    shown.splice(before ? i : i + 1, 0, id);
    this.hooks.reorder(shown.reverse());
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
    fold.title = tr('Настройки подложки: прозрачность, где видна, этаж, подгонка, удаление');
    fold.innerHTML = FOLD_SVG;
    fold.classList.toggle('open', this.open === u.id);
    fold.addEventListener('click', (e) => {
      e.preventDefault(); // не переключать галку строки
      this.open = this.open === u.id ? undefined : u.id;
      this.render();
    });
    row.append(input, name);
    if (u.locked) {
      const lock = document.createElement('span');
      lock.className = 'underlay-lock';
      lock.innerHTML = LOCK_SVG;
      lock.title = tr('Закреплена: кликом на карте не выделяется');
      row.append(lock);
    }
    // Порядок — перетаскиванием строки: выше в списке — поверх на карте
    if (this.items.length > 1) {
      row.draggable = true;
      row.addEventListener('dragstart', (e) => { this.dragged = u.id; e.dataTransfer?.setData('text/plain', u.id); row.classList.add('dragging'); });
      row.addEventListener('dragend', () => { this.dragged = undefined; row.classList.remove('dragging', 'drop-before', 'drop-after'); });
      const half = (e: DragEvent) => { const r = row.getBoundingClientRect(); return e.clientY < r.top + r.height / 2; };
      row.addEventListener('dragover', (e) => {
        if (!this.dragged || this.dragged === u.id) return;
        e.preventDefault();
        row.classList.toggle('drop-before', half(e));
        row.classList.toggle('drop-after', !half(e));
      });
      row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after'));
      row.addEventListener('drop', (e) => { e.preventDefault(); row.classList.remove('drop-before', 'drop-after'); this.drop(u.id, half(e)); });
    }
    const shared = u.building === undefined;
    if (shared && this.building !== undefined) {
      const tag = document.createElement('span');
      tag.className = 'underlay-level';
      tag.textContent = tr('на карте');
      tag.title = tr('Общая подложка: видна на карте и в режиме любого здания');
      row.append(tag);
    }
    if (u.level !== undefined) {
      const lv = document.createElement('span');
      lv.className = 'underlay-level';
      lv.textContent = this.levelLabel(u.level);
      row.append(lv);
    }
    row.append(fold);
    if (this.open !== u.id) return [row];
    // Настройки: сетка «подпись — элемент», под строкой подложки (с отступом до имени файла)
    const sec = document.createElement('div');
    sec.className = 'underlay-settings';
    const field = (label: string, control: HTMLElement, title = '') => {
      const l = document.createElement('label');
      l.className = 'underlay-set-label';
      l.textContent = label;
      if (title) l.title = title;
      const c = document.createElement('div');
      c.className = 'underlay-set-control';
      c.append(control);
      if (title) c.title = title;
      sec.append(l, c);
      return c;
    };
    // Имя: подпись в списке и в source changeset
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = u.name;
    nameInput.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') nameInput.blur(); if (e.key === 'Escape') { nameInput.value = u.name; nameInput.blur(); } });
    nameInput.addEventListener('change', () => {
      const v = nameInput.value.trim();
      if (v && v !== u.name) this.hooks.change({ ...u, name: v });
      else nameInput.value = u.name;
    });
    field(tr('Имя'), nameInput);
    const alpha = document.createElement('input');
    alpha.type = 'range';
    alpha.min = '0';
    alpha.max = '100';
    alpha.step = '5';
    const value = document.createElement('span');
    value.className = 'underlay-set-value';
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
    field(tr('Прозрачность'), alpha).append(value);
    const opt = (value: string, text: string) => {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = text;
      return o;
    };
    // Где видна (только в режиме здания): в этом здании или везде — на карте и во всех зданиях
    if (this.building !== undefined) {
      const scope = document.createElement('select');
      scope.append(opt('building', tr('В этом здании')), opt('shared', tr('Везде')));
      scope.value = shared ? 'shared' : 'building';
      scope.addEventListener('change', () => this.hooks.change(scope.value === 'shared'
        ? { ...u, building: undefined, level: undefined }
        : { ...u, building: this.building }));
      field(tr('Видна'), scope, tr('«Везде» — на карте и в режиме любого здания, «в этом здании» — только в его режиме'));
    }
    // Этаж (только у подложки здания): на земле (видна всегда) или на отметке пола этажа (видна только на нём)
    if (this.building !== undefined && !shared) {
      const select = document.createElement('select');
      select.append(opt('', tr('На земле')), ...this.levels.map((l) => opt(String(l.n), l.label)));
      // Этажа подложки больше нет в здании — всё равно показать его
      if (u.level !== undefined && !this.levels.some((l) => l.n === u.level)) select.append(opt(String(u.level), `level=${u.level}`));
      select.value = u.level === undefined ? '' : String(u.level);
      select.addEventListener('change', () => this.hooks.change({ ...u, level: select.value === '' ? undefined : Number(select.value) }));
      field(tr('Этаж'), select, tr('Подложка этажа лежит на отметке его пола и видна, только когда этот этаж выбран в панели этажей'));
    }
    const lockBox = document.createElement('input');
    lockBox.type = 'checkbox';
    lockBox.checked = !!u.locked;
    lockBox.addEventListener('change', () => this.hooks.change({ ...u, locked: lockBox.checked }));
    field(tr('Закрепить'), lockBox, tr('Закреплённая подложка не выделяется кликом на карте — её не сдвинуть случайно'));
    const buttons = document.createElement('div');
    buttons.className = 'underlay-set-actions';
    const adjust = document.createElement('button');
    adjust.type = 'button';
    adjust.className = 'underlay-select';
    adjust.innerHTML = `${MOVE_SVG}<span>${tr('Выбрать')}</span>`;
    adjust.title = tr('Выделить подложку: двигать, поворачивать и масштабировать — инструментами (M, Q, E), точные значения — в свойствах');
    adjust.disabled = !!u.locked;
    if (u.locked) adjust.title = tr('Подложка закреплена — снимите галку «Закрепить», чтобы её двигать');
    adjust.addEventListener('click', () => this.hooks.select(u));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'underlay-remove';
    remove.textContent = tr('Удалить');
    remove.title = tr('Удалить подложку из этого браузера');
    remove.addEventListener('click', () => {
      if (this.open === u.id) this.open = undefined;
      this.hooks.remove(u);
    });
    buttons.append(adjust, remove);
    sec.append(buttons);
    return [row, sec];
  }
}

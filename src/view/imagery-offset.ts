/**
 * Панель смещения снимка: поля сдвига (м, по широте — на север, по долготе — на восток), «Подтвердить» и «Сбросить».
 * Пока панель открыта, сдвиг задаётся и мышью: щелчок по точке снимка — она «прилипает» к курсору (сдвиг только
 * в плоскости земли), повторный щелчок — закончить. Щелчки по карте в это время не выделяют объекты.
 * Esc или × — отменить (вернуть сдвиг, бывший до открытия).
 */
import type { LngLat, Map as MlMap, MapMouseEvent } from 'maplibre-gl';
import { tr } from '../i18n';
import { getOffset, IMAGERY, isOffset, refreshImagery, storeOffset, type Offset } from './basemaps';

const R = 6378137;
/** Пересборка тайлов при перетаскивании — не чаще, мс. */
const LIVE_MS = 80;

export class ImageryOffsetPanel {
  private readonly el: HTMLDivElement;
  private readonly title: HTMLDivElement;
  private readonly latInput: HTMLInputElement;
  private readonly lonInput: HTMLInputElement;
  private readonly info: HTMLDivElement;
  private id: string | undefined;
  /** Сдвиг до открытия панели — для отмены. */
  private before: Offset = { east: 0, north: 0 };
  private offset: Offset = { east: 0, north: 0 };
  /** Перетаскивание: точка снимка под курсором при первом щелчке и сдвиг на тот момент. */
  private anchor: { at: LngLat; base: Offset } | undefined;
  private down: { x: number; y: number } | undefined;
  private liveTimer = 0;
  private lastLive = 0;

  constructor(private readonly map: MlMap, private readonly onChange: (id: string) => void) {
    const el = this.el = document.createElement('div');
    el.className = 'offset-panel';
    el.hidden = true;
    const head = document.createElement('div');
    head.className = 'offset-head';
    this.title = document.createElement('div');
    this.title.className = 'offset-title';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'offset-close';
    close.title = tr('Отменить');
    close.textContent = '×';
    close.addEventListener('click', () => this.cancel());
    head.append(this.title, close);
    const field = (label: string, title: string) => {
      const row = document.createElement('label');
      row.title = title;
      const input = document.createElement('input');
      input.type = 'number';
      input.step = '0.1';
      input.addEventListener('input', () => this.fromInputs());
      row.append(label, input, tr('м'));
      return { row, input };
    };
    const lat = field(tr('По широте'), tr('Сдвиг на север (минус — на юг), м'));
    const lon = field(tr('По долготе'), tr('Сдвиг на восток (минус — на запад), м'));
    this.latInput = lat.input;
    this.lonInput = lon.input;
    this.info = document.createElement('div');
    this.info.className = 'offset-info';
    const buttons = document.createElement('div');
    buttons.className = 'offset-buttons';
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'offset-ok';
    ok.textContent = tr('Подтвердить');
    ok.addEventListener('click', () => this.confirm());
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.textContent = tr('Сбросить');
    reset.addEventListener('click', () => { this.set({ east: 0, north: 0 }, true); this.confirm(); });
    buttons.append(ok, reset);
    el.append(head, lat.row, lon.row, this.info, buttons);
    map.getContainer().append(el);

    // Щелчки по карте, пока панель открыта, — только для сдвига (до обработчиков MapLibre и инструментов)
    const onCanvas = (e: Event) => !el.hidden && map.getCanvasContainer().contains(e.target as Node);
    window.addEventListener('mousedown', (e) => { if (onCanvas(e)) this.down = { x: e.clientX, y: e.clientY }; }, true);
    window.addEventListener('click', (e) => {
      if (!onCanvas(e)) return;
      e.stopPropagation();
      const d = this.down;
      if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return; // двигали карту
      this.onClick(e);
    }, true);
    window.addEventListener('dblclick', (e) => { if (onCanvas(e)) e.stopPropagation(); }, true);
    window.addEventListener('keydown', (e) => {
      if (el.hidden || e.key !== 'Escape') return;
      e.stopPropagation();
      if (this.anchor) this.stopMove(true); else this.cancel();
    }, true);
    map.on('mousemove', (e: MapMouseEvent) => this.onMove(e));
  }

  get open() { return !this.el.hidden; }

  /** Открыть для снимка (он уже показан на карте). */
  show(id: string) {
    if (this.id && this.id !== id && !this.el.hidden) this.cancel();
    this.id = id;
    this.before = this.offset = getOffset(id);
    this.title.textContent = tr('Смещение: {name}', { name: IMAGERY.find((i) => i.id === id)?.name ?? id });
    this.el.hidden = false;
    this.syncInputs();
  }

  /** Снимок сменили или убрали — панель закрыть, оставив сдвиг как есть. */
  hide() {
    if (this.el.hidden) return;
    this.confirm();
  }

  private onClick(e: MouseEvent) {
    const r = this.map.getCanvasContainer().getBoundingClientRect();
    const at = this.map.unproject([e.clientX - r.left, e.clientY - r.top]);
    if (this.anchor) this.stopMove(false);
    else {
      this.anchor = { at, base: this.offset };
      this.map.getCanvas().style.cursor = 'grabbing';
      this.syncInputs();
    }
  }

  private onMove(e: MapMouseEvent) {
    const a = this.anchor;
    if (!a || this.el.hidden) return;
    const lat = (a.at.lat * Math.PI) / 180;
    this.set({
      east: a.base.east + (R * ((e.lngLat.lng - a.at.lng) * Math.PI)) / 180 * Math.cos(lat),
      north: a.base.north + (R * ((e.lngLat.lat - a.at.lat) * Math.PI)) / 180,
    });
  }

  private stopMove(revert: boolean) {
    const a = this.anchor;
    this.anchor = undefined;
    this.map.getCanvas().style.cursor = '';
    if (revert && a) this.set(a.base, true);
    else this.apply();
    this.syncInputs();
  }

  private fromInputs() {
    this.set({ east: Number(this.lonInput.value) || 0, north: Number(this.latInput.value) || 0 }, false, false);
  }

  /** Новый сдвиг; при перетаскивании тайлы пересобираются не чаще LIVE_MS. */
  private set(o: Offset, now = false, inputs = true) {
    this.offset = o;
    if (inputs) this.syncInputs(); else this.syncInfo();
    clearTimeout(this.liveTimer);
    const wait = now ? 0 : LIVE_MS - (performance.now() - this.lastLive);
    if (wait <= 0) this.apply();
    else this.liveTimer = window.setTimeout(() => this.apply(), wait);
  }

  private apply() {
    clearTimeout(this.liveTimer);
    this.lastLive = performance.now();
    if (!this.id) return;
    storeOffset(this.id, this.offset);
    refreshImagery(this.map, this.id);
    this.onChange(this.id);
  }

  private syncInputs() {
    this.latInput.value = this.offset.north.toFixed(1);
    this.lonInput.value = this.offset.east.toFixed(1);
    this.syncInfo();
  }

  private syncInfo() {
    const d = Math.hypot(this.offset.east, this.offset.north);
    const moved = isOffset(this.offset) ? tr('Сдвиг {d} м.', { d: d.toFixed(1) }) : tr('Без сдвига.');
    this.info.textContent = `${moved} ${this.anchor
      ? tr('Ведите мышью, щелчок — закончить, Esc — отменить.')
      : tr('Щёлкните точку на снимке и ведите её к тому месту, где она должна быть (по GPS-трекам).')}`;
  }

  private confirm() {
    if (this.anchor) this.stopMove(false);
    this.apply();
    this.el.hidden = true;
  }

  private cancel() {
    if (this.anchor) this.stopMove(true);
    this.set(this.before, true);
    this.el.hidden = true;
  }
}

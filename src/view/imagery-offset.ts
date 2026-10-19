/**
 * Панель настроек снимка: прозрачность и смещение — поля сдвига (м, по широте — на север, по долготе — на восток), «Подтвердить» и «Сбросить».
 * Пока панель открыта, сдвиг задаётся и мышью: щелчок по точке снимка — она «прилипает» к курсору (сдвиг только
 * в плоскости земли), повторный щелчок — закончить. Щелчки по карте в это время не выделяют объекты.
 * Esc или × — отменить (вернуть сдвиг, бывший до открытия). Точка первого щелчка отмечена, от неё до курсора —
 * пунктир; конец прилипает к привязкам (вершины и середины рёбер зданий на земле) — их даёт main.ts.
 */
import type { GeoJSONSource, LngLat, Map as MlMap, MapMouseEvent } from 'maplibre-gl';
import { tr } from '../i18n';
import { findImagery, getOffset, getOpacity, isOffset, refreshImagery, setImageryOpacity, storeOffset, storeOpacity, type Offset } from './basemaps';

const R = 6378137;
const POS_KEY = 'osm3d.offset-panel-pos';
const ANCHOR = 'imagery-offset-anchor';

/** Привязка конца сдвига: точка на земле и где её показать. */
export interface OffsetSnap { lngLat: LngLat; point: [number, number]; kind: string; label: string }

export interface OffsetPanelHooks {
  /** Изменился сдвиг (подсветка кнопок). */
  onChange(id: string): void;
  /** Панель открылась или закрылась (кнопка привязок на панели инструментов). */
  onOpen?(open: boolean): void;
  /** Привязка под курсором (экранная точка); undefined — нет или выключены. */
  snap?(point: [number, number]): OffsetSnap | undefined;
}
/** Пересборка тайлов при перетаскивании — не чаще, мс. */
const LIVE_MS = 80;

export class ImageryOffsetPanel {
  private readonly el: HTMLDivElement;
  private readonly title: HTMLDivElement;
  private readonly latInput: HTMLInputElement;
  private readonly lonInput: HTMLInputElement;
  private readonly info: HTMLDivElement;
  private readonly alphaInput: HTMLInputElement;
  private readonly alphaValue: HTMLSpanElement;
  /** Непрозрачность: текущая и до открытия панели. */
  private opacity = 1;
  private opacityBefore = 1;
  private id: string | undefined;
  /** Сдвиг до открытия панели — для отмены. */
  private before: Offset = { east: 0, north: 0 };
  private offset: Offset = { east: 0, north: 0 };
  /** Перетаскивание: точка снимка под курсором при первом щелчке и сдвиг на тот момент. */
  private anchor: { at: LngLat; base: Offset } | undefined;
  private down: { x: number; y: number } | undefined;
  private liveTimer = 0;
  private lastLive = 0;

  private readonly snapEl: HTMLDivElement;

  constructor(private readonly map: MlMap, private readonly hooks: OffsetPanelHooks) {
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
    this.draggable(head);
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
    // Прозрачность снимка: 0 % — как есть, 100 % — не виден
    const alphaRow = document.createElement('label');
    alphaRow.className = 'offset-alpha';
    this.alphaInput = document.createElement('input');
    this.alphaInput.type = 'range';
    this.alphaInput.min = '0';
    this.alphaInput.max = '100';
    this.alphaInput.step = '5';
    this.alphaValue = document.createElement('span');
    this.alphaInput.addEventListener('input', () => {
      this.opacity = 1 - Number(this.alphaInput.value) / 100;
      this.syncAlpha();
      setImageryOpacity(this.map, this.opacity);
      if (this.id) storeOpacity(this.id, this.opacity);
      if (this.id) this.hooks.onChange(this.id);
    });
    alphaRow.append(tr('Прозрачность'), this.alphaInput, this.alphaValue);
    const shiftHead = document.createElement('div');
    shiftHead.className = 'offset-sub';
    shiftHead.textContent = tr('Смещение');
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
    reset.title = tr('Убрать смещение и прозрачность');
    reset.addEventListener('click', () => { this.setOpacity(1); this.set({ east: 0, north: 0 }, true); this.confirm(); });
    buttons.append(ok, reset);
    el.append(head, alphaRow, shiftHead, lat.row, lon.row, this.info, buttons);
    this.snapEl = document.createElement('div');
    this.snapEl.className = 'snap-marker';
    this.snapEl.hidden = true;
    map.getContainer().append(el, this.snapEl);

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
    this.opacityBefore = this.opacity = getOpacity(id);
    this.title.textContent = tr('Подложка: {name}', { name: findImagery(id)?.name ?? id });
    this.syncAlpha();
    this.el.hidden = false;
    this.hooks.onOpen?.(true);
    this.place();
    this.syncInputs();
  }

  /**
   * Где показать: где оставили (в пределах карты), иначе — сверху, слева от кнопок карты, между колонками панелей.
   */
  private place() {
    const box = this.map.getContainer().getBoundingClientRect();
    const w = this.el.offsetWidth, h = this.el.offsetHeight;
    let pos: { x: number; y: number } | undefined;
    try { pos = JSON.parse(localStorage.getItem(POS_KEY) ?? 'null') ?? undefined; } catch { /* по умолчанию */ }
    if (!pos) {
      const ctrl = this.map.getContainer().querySelector('.maplibregl-ctrl-top-right .maplibregl-ctrl-group')?.getBoundingClientRect();
      const left = document.getElementById('left-col')?.getBoundingClientRect();
      const right = ctrl ? ctrl.left - box.left - 8 : box.width - 12;
      const min = left ? left.right - box.left + 8 : 12;
      pos = { x: Math.max(min, right - w), y: 10 };
    }
    this.moveTo(pos.x, pos.y, w, h);
  }

  private moveTo(x: number, y: number, w = this.el.offsetWidth, h = this.el.offsetHeight) {
    const box = this.map.getContainer().getBoundingClientRect();
    this.el.style.left = `${Math.round(Math.min(Math.max(0, x), box.width - w))}px`;
    this.el.style.top = `${Math.round(Math.min(Math.max(0, y), box.height - h))}px`;
  }

  /** Панель перетаскивается за заголовок; место запоминается. */
  private draggable(head: HTMLElement) {
    head.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
      e.preventDefault();
      const sx = e.clientX - this.el.offsetLeft, sy = e.clientY - this.el.offsetTop;
      head.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => this.moveTo(ev.clientX - sx, ev.clientY - sy);
      const up = () => {
        head.removeEventListener('pointermove', move);
        try { localStorage.setItem(POS_KEY, JSON.stringify({ x: this.el.offsetLeft, y: this.el.offsetTop })); } catch { /* до перезагрузки */ }
      };
      head.addEventListener('pointermove', move);
      head.addEventListener('pointerup', up, { once: true });
      head.addEventListener('pointercancel', up, { once: true });
    });
  }

  /** Снимок сменили или убрали — панель закрыть, оставив сдвиг как есть. */
  hide() {
    if (this.el.hidden) return;
    this.confirm();
  }

  private onClick(e: MouseEvent) {
    const r = this.map.getCanvasContainer().getBoundingClientRect();
    const pt: [number, number] = [e.clientX - r.left, e.clientY - r.top];
    if (this.anchor) {
      this.dragTo(this.target(pt).lngLat); // конец — с привязкой
      this.stopMove(false);
    } else {
      // Начало — точка на снимке, без привязок к данным
      const at = this.map.unproject(pt);
      this.anchor = { at, base: this.offset };
      this.map.getCanvas().style.cursor = 'grabbing';
      this.drawAnchor(at, at);
      this.syncInputs();
    }
  }

  /** Куда ведём: привязка под курсором или точка на земле. */
  private target(pt: [number, number]): { lngLat: LngLat; snap?: OffsetSnap } {
    const snap = this.hooks.snap?.(pt);
    return snap ? { lngLat: snap.lngLat, snap } : { lngLat: this.map.unproject(pt) };
  }

  private onMove(e: MapMouseEvent) {
    if (!this.anchor || this.el.hidden) return;
    const t = this.target([e.point.x, e.point.y]);
    this.showSnap(t.snap);
    this.dragTo(t.lngLat);
  }

  /** Сдвиг, при котором точка снимка из первого щелчка оказывается в to. */
  private dragTo(to: LngLat) {
    const a = this.anchor;
    if (!a) return;
    const lat = (a.at.lat * Math.PI) / 180;
    this.drawAnchor(a.at, to);
    this.set({
      east: a.base.east + (R * ((to.lng - a.at.lng) * Math.PI)) / 180 * Math.cos(lat),
      north: a.base.north + (R * ((to.lat - a.at.lat) * Math.PI)) / 180,
    });
  }

  private showSnap(s: OffsetSnap | undefined) {
    this.snapEl.hidden = !s;
    if (!s) return;
    this.snapEl.className = `snap-marker ${s.kind}`;
    this.snapEl.dataset.label = s.label;
    this.snapEl.style.left = `${s.point[0]}px`;
    this.snapEl.style.top = `${s.point[1]}px`;
  }

  /** Отметка точки первого щелчка и пунктир до текущего конца; undefined — убрать. */
  private drawAnchor(from: LngLat | undefined, to?: LngLat) {
    const data: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: from ? [
      { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [from.lng, from.lat] } },
      ...(to ? [{ type: 'Feature' as const, properties: {}, geometry: { type: 'LineString' as const, coordinates: [[from.lng, from.lat], [to.lng, to.lat]] } }] : []),
    ] : [] };
    const src = this.map.getSource(ANCHOR) as GeoJSONSource | undefined;
    if (src) { src.setData(data); return; }
    if (!from) return;
    this.map.addSource(ANCHOR, { type: 'geojson', data });
    this.map.addLayer({ id: `${ANCHOR}-line`, type: 'line', source: ANCHOR, filter: ['==', ['geometry-type'], 'LineString'],
      paint: { 'line-color': '#ff7a00', 'line-width': 2, 'line-dasharray': [2, 1.5] } });
    this.map.addLayer({ id: `${ANCHOR}-point`, type: 'circle', source: ANCHOR, filter: ['==', ['geometry-type'], 'Point'],
      paint: { 'circle-radius': 5, 'circle-color': '#ff7a00', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
  }

  private stopMove(revert: boolean) {
    const a = this.anchor;
    this.anchor = undefined;
    this.map.getCanvas().style.cursor = '';
    this.showSnap(undefined);
    this.drawAnchor(undefined);
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
    this.hooks.onChange(this.id);
  }

  private syncInputs() {
    this.latInput.value = this.offset.north.toFixed(1);
    this.lonInput.value = this.offset.east.toFixed(1);
    this.syncInfo();
  }

  private syncAlpha() {
    const t = Math.round((1 - this.opacity) * 100);
    this.alphaInput.value = String(t);
    this.alphaValue.textContent = `${t} %`;
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
    this.close();
  }

  private setOpacity(v: number) {
    this.opacity = v;
    this.syncAlpha();
    setImageryOpacity(this.map, v);
    if (this.id) storeOpacity(this.id, v);
  }

  private cancel() {
    if (this.anchor) this.stopMove(true);
    this.setOpacity(this.opacityBefore);
    this.set(this.before, true);
    this.close();
  }

  private close() {
    this.el.hidden = true;
    this.hooks.onOpen?.(false);
  }
}

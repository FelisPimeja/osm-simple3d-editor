/**
 * Заслонение подписей и иконок стиля зданиями: после остановки камеры точечные подписи, к которым луч
 * от камеры упирается в здание раньше, чем в саму точку, приглушаются (feature-state `occluded`).
 * Symbol-слои MapLibre буфер глубины не учитывают, поэтому проверяем сами — лучом в наши объёмы.
 */
import { MercatorCoordinate, type Map as MlMap, type MapGeoJSONFeature, type LngLat } from 'maplibre-gl';

type Depth = (ll: { lng: number; lat: number }, altitude: number) => number | undefined;

type Hit = { lngLat: LngLat; altitude: number } | undefined;

/** Насколько ближе к камере, чем точка подписи, должно быть попадание в здание, м (вход на своей стене — не заслонён). */
const EPS = 2;
/** Непрозрачность заслонённой подписи (видно, что за домом что-то есть). */
const DIM = 0; // закрытые зданием — полностью прозрачные
/** Бюджет одного куска расчёта, мс. */
const SLICE = 4;
/** Сколько точек линии проверять. */
const LINE_SAMPLES = 8;
const PROPS = ['icon-opacity', 'text-opacity'] as const;

/** Значение свойства с приглушением по feature-state; зум-выражение должно остаться верхним — меняем его выходы. */
function dimmed(v: unknown): unknown {
  const wrap = (x: unknown) => ['case', ['boolean', ['feature-state', 'occluded'], false], ['*', DIM, x as number], x];
  if (Array.isArray(v) && (v[0] === 'interpolate' || v[0] === 'step') && JSON.stringify(v[v[0] === 'step' ? 1 : 2]) === '["zoom"]') {
    const out = [...v];
    if (v[0] === 'step') { out[2] = wrap(v[2]); for (let i = 4; i < out.length; i += 2) out[i] = wrap(out[i]); }
    else for (let i = 4; i < out.length; i += 2) out[i] = wrap(out[i]);
    return out;
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) return v; // старые функции стиля — не трогаем
  return wrap(v ?? 1);
}

export class LabelOcclusion {
  private enabled = false;
  private layers: { id: string; source: string; sourceLayer?: string }[] = [];
  private original = new Map<string, unknown>();
  /** Помеченные сейчас: ключ source/sourceLayer/id → объект для setFeatureState. */
  private marked = new Map<string, { source: string; sourceLayer?: string; id: string | number }>();
  private readonly onIdle = () => this.update();

  constructor(private map: MlMap, private pickHit: (p: [number, number], inside?: [number, number]) => Hit, private depthAt: Depth, private ready: () => boolean, private rev: () => number = () => 0) {}

  setEnabled(on: boolean) {
    if (on === this.enabled) return;
    this.enabled = on;
    if (on) { this.map.on('idle', this.onIdle); this.map.on('movestart', this.onMove); this.map.on('moveend', this.onMoveEnd); this.update(); }
    else { this.map.off('idle', this.onIdle); this.map.off('movestart', this.onMove); this.map.off('moveend', this.onMoveEnd); this.run++; this.done = ''; this.concealed = false; this.clear(); this.restoreLayers(); this.layers = []; }
  }

  /**
   * Прозрачность подписей переписали снаружи (смена подложки, выход из режима здания) — обёртка приглушения
   * пропала: обернуть заново текущие значения и пересчитать.
   */
  repatch() {
    if (!this.enabled) return;
    this.concealed = false;
    this.original.clear();
    this.layers = [];
    this.done = '';
    this.update();
  }

  /** Symbol-слои стиля на векторных источниках (точечные и вдоль линий — стрелки одностороннего движения, названия улиц). */
  private patchLayers() {
    this.layers = [];
    for (const l of this.map.getStyle().layers) {
      if (l.type !== 'symbol' || !('source' in l) || this.map.getSource(l.source)?.type !== 'vector') continue;
      this.layers.push({ id: l.id, source: l.source, sourceLayer: l['source-layer'] });
      for (const p of PROPS) {
        const v = this.map.getPaintProperty(l.id, p);
        this.original.set(`${l.id}|${p}`, v);
        try { this.map.setPaintProperty(l.id, p, dimmed(v) as number); } catch { /* выражение не обернуть — оставляем */ }
      }
    }
  }

  private restoreLayers() {
    for (const [k, v] of this.original) {
      const [id, p] = k.split('|');
      if (this.map.getLayer(id)) this.map.setPaintProperty(id, p as typeof PROPS[number], v as number);
    }
    this.original.clear();
  }

  private clear() {
    for (const f of this.marked.values()) this.map.setFeatureState(f, { occluded: false });
    this.marked.clear();
  }

  private metres(a: { lng: number; lat: number }, ah: number, b: { lng: number; lat: number }, bh: number): number {
    const ca = MercatorCoordinate.fromLngLat(a, ah), cb = MercatorCoordinate.fromLngLat(b, bh);
    return Math.hypot(ca.x - cb.x, ca.y - cb.y, ca.z - cb.z) / ca.meterInMercatorCoordinateUnits();
  }

  /** Точка на земле закрыта зданием (кроме тех, в контуре которых лежит inside). */
  private hidden(lng: number, lat: number, inside?: [number, number]): boolean {
    const ground = this.map.queryTerrainElevation?.([lng, lat]) ?? 0;
    const pt = this.map.project([lng, lat]);
    const hit = this.pickHit([pt.x, pt.y], inside);
    if (!hit) return false;
    // Попадание на луче ближе к камере, чем сама точка, и не рядом с ней
    const dHit = this.depthAt(hit.lngLat, hit.altitude), dLabel = this.depthAt({ lng, lat }, ground);
    if (dHit === undefined || dLabel === undefined || dHit >= dLabel) return false;
    return this.metres(hit.lngLat, hit.altitude, { lng, lat }, ground) > EPS;
  }

  /** До LINE_SAMPLES точек линии, попадающих на экран: середины отрезков. */
  private samples(lines: [number, number][][], max = LINE_SAMPLES): [number, number][] {
    const { clientWidth: w, clientHeight: h } = this.map.getCanvas();
    const out: [number, number][] = [];
    // Точки через ~40 px экрана (у длинного отрезка подпись не обязательно на середине)
    for (const l of lines) for (let k = 0; k + 1 < l.length; k++) {
      const a = this.map.project(l[k]), b = this.map.project(l[k + 1]);
      const n = Math.max(1, Math.min(50, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 40)));
      for (let j = 0; j < n; j++) {
        const t = (j + 0.5) / n;
        const m: [number, number] = [l[k][0] + (l[k + 1][0] - l[k][0]) * t, l[k][1] + (l[k + 1][1] - l[k][1]) * t];
        const p = this.map.project(m);
        if (p.x >= 0 && p.y >= 0 && p.x <= w && p.y <= h) out.push(m);
      }
    }
    if (out.length <= max) return out;
    return Array.from({ length: max }, (_, j) => out[Math.floor((j + 0.5) * out.length / max)]);
  }

  /** Номер прохода: новый проход или движение камеры обрывают текущий. */
  private run = 0;
  /** Камера и набор подписей последнего законченного прохода — idle без изменений не пересчитываем. */
  private done = '';
  private readonly onMove = () => { this.run++; clearTimeout(this.endTimer); this.conceal(); };
  /** Камера встала — считать сразу (idle после догрузки тайлов бывает через секунды), с короткой паузой на инерцию. */
  private endTimer?: ReturnType<typeof setTimeout>;
  private readonly onMoveEnd = () => { clearTimeout(this.endTimer); this.endTimer = setTimeout(() => this.update(), 80); };
  /** Пока камера движется и идёт пересчёт — подписи и значки слоёв погашены (не мелькают заслонённые). */
  private concealed = false;
  private conceal() {
    if (this.concealed || !this.layers.length) return;
    this.concealed = true;
    for (const l of this.layers) for (const p of PROPS) {
      if (!this.map.getLayer(l.id)) continue;
      try { this.map.setPaintProperty(l.id, p, 0); } catch { /* слой без свойства */ }
    }
  }
  /** Пересчёт готов — вернуть прозрачность (с приглушением заслонённых). */
  private reveal() {
    if (!this.concealed) return;
    this.concealed = false;
    for (const l of this.layers) for (const p of PROPS) {
      if (!this.map.getLayer(l.id)) continue;
      try { this.map.setPaintProperty(l.id, p, dimmed(this.original.get(`${l.id}|${p}`)) as number); } catch { /* выражение не обернуть */ }
    }
  }

  /** Проход кусками не дольше SLICE мс между кадрами: начатый пан или вращение не ждёт конца расчёта. */
  private update() {
    if (!this.enabled) return;
    // Считать не по чему (здания ещё не готовы) — подписи не держим погашенными
    if (!this.ready()) { this.reveal(); return; }
    if (!this.layers.length) this.patchLayers();
    if (!this.layers.length) return;
    const ids = this.layers.map((l) => l.id).filter((id) => this.map.getLayer(id));
    const feats: MapGeoJSONFeature[] = this.map.queryRenderedFeatures({ layers: ids });
    // Линия, разрезанная тайлами, приходит кусками с одним id: состояние у неё одно — решать по всем кускам вместе
    const pieces = new Map<string, [number, number][][]>();
    for (const f of feats) {
      if (f.id === undefined || (f.geometry.type !== 'LineString' && f.geometry.type !== 'MultiLineString')) continue;
      const key = `${f.source}/${f.sourceLayer ?? ''}/${f.id}`;
      const lines = (f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates) as [number, number][][];
      const list = pieces.get(key);
      if (list) list.push(...lines); else pieces.set(key, [...lines]);
    }
    const c = this.map.getCenter();
    const sig = `${c.lng},${c.lat},${this.map.getZoom()},${this.map.getBearing()},${this.map.getPitch()},${feats.length},${this.rev()}`;
    if (sig === this.done) { this.reveal(); return; }
    const run = ++this.run;
    const next = new Map<string, { source: string; sourceLayer?: string; id: string | number }>();
    let i = 0;
    const seen = new Set<string>();
    const step = () => {
      if (run !== this.run || !this.enabled) return;
      // Подписи погашены и ждут — кусками крупнее (кадр пожертвовать можно: камера стоит)
      const until = performance.now() + (this.concealed ? SLICE * 3 : SLICE);
      for (; i < feats.length && performance.now() < until; i++) {
        const f = feats[i];
        if (f.id === undefined) continue;
        const key = `${f.source}/${f.sourceLayer ?? ''}/${f.id}`;
        if (next.has(key) || seen.has(key)) continue;
        seen.add(key);
        if (f.geometry.type === 'Point') {
          const [lng, lat] = f.geometry.coordinates as [number, number];
          // Здание, внутри которого стоит POI, его не заслоняет
          if (this.hidden(lng, lat, [lng, lat])) next.set(key, { source: f.source, sourceLayer: f.sourceLayer, id: f.id });
        } else if (f.geometry.type === 'LineString' || f.geometry.type === 'MultiLineString') {
          // Значки вдоль линии — состояние у всей линии: приглушаем, если закрыта большая часть видимых на экране точек
          const lines = pieces.get(key) ?? [];
          // Судить по местам, где подпись этой линии нарисована (название улицы — одно-два места на всю линию):
          // по всей линии улица «видна», а подпись легла на её кусок за домом
          const all = this.samples(lines, LINE_SAMPLES * 3);
          const layer = (f as MapGeoJSONFeature & { layer?: { id: string } }).layer?.id;
          const drawn = layer ? all.filter(([lng, lat]) => {
            const q = this.map.project([lng, lat]);
            return this.map.queryRenderedFeatures([[q.x - 6, q.y - 6], [q.x + 6, q.y + 6]], { layers: [layer] }).some((x) => x.id === f.id);
          }) : [];
          // Подпись, частично лёгшая на дом, рисуется поверх него: гасим, если за зданием хотя бы две её точки или
          // больше трети; без найденной подписи (значки по всей линии) — по большинству точек линии
          if (drawn.length) {
            const h = drawn.filter(([lng, lat]) => this.hidden(lng, lat)).length;
            if (h >= 2 || h * 3 > drawn.length) next.set(key, { source: f.source, sourceLayer: f.sourceLayer, id: f.id });
          } else {
            const pts = this.samples(lines);
            if (pts.length && pts.filter(([lng, lat]) => this.hidden(lng, lat)).length * 2 > pts.length) next.set(key, { source: f.source, sourceLayer: f.sourceLayer, id: f.id });
          }
        }
      }
      if (i < feats.length) { setTimeout(step, 0); return; }
      for (const [k, f] of this.marked) if (!next.has(k)) this.map.setFeatureState(f, { occluded: false });
      for (const [k, f] of next) if (!this.marked.has(k)) this.map.setFeatureState(f, { occluded: true });
      this.marked = next;
      this.done = sig;
      this.reveal();
    };
    step();
  }
}

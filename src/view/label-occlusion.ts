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
const DIM = 0.15;
/** Бюджет одного куска расчёта, мс. */
const SLICE = 4;
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

  constructor(private map: MlMap, private pickHit: (p: [number, number], inside: [number, number]) => Hit, private depthAt: Depth, private ready: () => boolean, private rev: () => number = () => 0) {}

  setEnabled(on: boolean) {
    if (on === this.enabled) return;
    this.enabled = on;
    if (on) { this.map.on('idle', this.onIdle); this.map.on('movestart', this.onMove); this.update(); }
    else { this.map.off('idle', this.onIdle); this.map.off('movestart', this.onMove); this.run++; this.done = ''; this.clear(); this.restoreLayers(); this.layers = []; }
  }

  /** Точечные symbol-слои стиля на векторных источниках. */
  private patchLayers() {
    this.layers = [];
    for (const l of this.map.getStyle().layers) {
      if (l.type !== 'symbol' || !('source' in l) || this.map.getSource(l.source)?.type !== 'vector') continue;
      if (this.map.getLayoutProperty(l.id, 'symbol-placement') && this.map.getLayoutProperty(l.id, 'symbol-placement') !== 'point') continue;
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

  /** Номер прохода: новый проход или движение камеры обрывают текущий. */
  private run = 0;
  /** Камера и набор подписей последнего законченного прохода — idle без изменений не пересчитываем. */
  private done = '';
  private readonly onMove = () => { this.run++; };

  /** Проход кусками не дольше SLICE мс между кадрами: начатый пан или вращение не ждёт конца расчёта. */
  private update() {
    if (!this.enabled || !this.ready()) return;
    if (!this.layers.length) this.patchLayers();
    if (!this.layers.length) return;
    const ids = this.layers.map((l) => l.id).filter((id) => this.map.getLayer(id));
    const feats: MapGeoJSONFeature[] = this.map.queryRenderedFeatures({ layers: ids });
    const c = this.map.getCenter();
    const sig = `${c.lng},${c.lat},${this.map.getZoom()},${this.map.getBearing()},${this.map.getPitch()},${feats.length},${this.rev()}`;
    if (sig === this.done) return;
    const run = ++this.run;
    const next = new Map<string, { source: string; sourceLayer?: string; id: string | number }>();
    let i = 0;
    const step = () => {
      if (run !== this.run || !this.enabled) return;
      const until = performance.now() + SLICE;
      for (; i < feats.length && performance.now() < until; i++) {
        const f = feats[i];
        if (f.id === undefined || f.geometry.type !== 'Point') continue;
        const key = `${f.source}/${f.sourceLayer ?? ''}/${f.id}`;
        if (next.has(key)) continue;
        const [lng, lat] = f.geometry.coordinates as [number, number];
        const ground = this.map.queryTerrainElevation?.([lng, lat]) ?? 0;
        const pt = this.map.project([lng, lat]);
        const hit = this.pickHit([pt.x, pt.y], [lng, lat]);
        if (!hit) continue;
        // Попадание на луче ближе к камере, чем сама точка, и не рядом с ней
        const dHit = this.depthAt(hit.lngLat, hit.altitude), dLabel = this.depthAt({ lng, lat }, ground);
        if (dHit === undefined || dLabel === undefined || dHit >= dLabel) continue;
        if (this.metres(hit.lngLat, hit.altitude, { lng, lat }, ground) > EPS) next.set(key, { source: f.source, sourceLayer: f.sourceLayer, id: f.id });
      }
      if (i < feats.length) { setTimeout(step, 0); return; }
      for (const [k, f] of this.marked) if (!next.has(k)) this.map.setFeatureState(f, { occluded: false });
      for (const [k, f] of next) if (!this.marked.has(k)) this.map.setFeatureState(f, { occluded: true });
      this.marked = next;
      this.done = sig;
    };
    step();
  }
}

import type { GeoJSONSource, Map as MlMap } from 'maplibre-gl';
import { DMR } from '../render/models-layer';

const SOURCE = 'models-3dmr-pins';
const LAYER = 'models-3dmr-pins';
const LABELS = 'models-3dmr-pins-label';
/** До этого зума — метки; дальше грузятся тайлы данных и видны сами модели. */
const MAX_ZOOM = 15;
/** Страниц поиска 3dmr не больше этого (по 20 моделей): защита от бесконечного цикла. */
const MAX_PAGES = 50;

/** Модели репозитория с точкой привязки: [id, title, lat, lon]. */
type Row = [number, string, number | null, number | null];

/**
 * Метки моделей 3dmr.eu на обзорных зумах — чтобы находить места, где они есть. Список всех моделей
 * (POST /api/search/full, как карта самого репозитория) — один раз за сессию; клик — приблизить к модели.
 */
export class ModelPins {
  private loaded?: Promise<void>;
  private shown = false;
  /** Модели с точкой привязки (загруженные к этому моменту). */
  readonly list: { id: number; title: string; at: [number, number] }[] = [];
  /** Пришла очередная страница списка. */
  onList?: () => void;

  constructor(private readonly map: MlMap) {}

  /** Слой на карте (зовётся после загрузки стиля). */
  install() {
    const map = this.map;
    if (map.getSource(SOURCE)) return;
    map.addSource(SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: LAYER, type: 'circle', source: SOURCE, maxzoom: MAX_ZOOM,
      layout: { visibility: 'none' },
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 2, 4, 14, 7], 'circle-color': '#e8590c', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.5 },
    });
    map.addLayer({
      id: LABELS, type: 'symbol', source: SOURCE, minzoom: 9, maxzoom: MAX_ZOOM,
      layout: { visibility: 'none', 'text-field': ['get', 'title'], 'text-size': 11, 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-optional': true },
      paint: { 'text-color': '#7a2e05', 'text-halo-color': '#ffffff', 'text-halo-width': 1.2 },
    });
    map.on('click', LAYER, (e) => {
      const f = e.features?.[0];
      if (!f || f.geometry.type !== 'Point') return;
      map.flyTo({ center: f.geometry.coordinates as [number, number], zoom: 17.5, pitch: Math.max(map.getPitch(), 50) });
    });
    map.on('mouseenter', LAYER, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', LAYER, () => { map.getCanvas().style.cursor = ''; });
    if (this.shown) this.setShown(true);
  }

  setShown(on: boolean) {
    this.shown = on;
    if (!this.map.getLayer(LAYER)) return;
    for (const id of [LAYER, LABELS]) this.map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    if (on) this.loaded ??= this.load();
  }

  private async load() {
    const features: GeoJSON.Feature[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      let rows: Row[];
      try {
        const r = await fetch(`${DMR}/api/search/full`, { method: 'POST', body: JSON.stringify({ page, format: ['id', 'title', 'latitude', 'longitude'] }) });
        if (!r.ok) break;
        rows = await r.json();
      } catch { break; }
      if (!rows.length) break;
      for (const [id, title, lat, lon] of rows) {
        if (lat == null || lon == null) continue;
        features.push({ type: 'Feature', id, properties: { id, title: `${title} · 3dmr #${id}` }, geometry: { type: 'Point', coordinates: [lon, lat] } });
        this.list.push({ id, title, at: [lon, lat] });
      }
      (this.map.getSource(SOURCE) as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features });
      this.onList?.();
    }
  }
}

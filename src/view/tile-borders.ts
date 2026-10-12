import type { GeoJSONSource, Map as MlMap } from 'maplibre-gl';
import { tileBbox } from './overpass-tiles';

/** Отладка: границы тайлов данных — полупрозрачные розовые стенки. */
const SOURCE = 'debug-tile-borders';
const HEIGHT_M = 50;
/** Прозрачность у земли; к верху спадает до нуля. */
const OPACITY = 0.35;
/**
 * Плавного вертикального градиента у fill-extrusion нет, а opacity — свойство всего слоя: стенку собираем
 * из BANDS поясов-слоёв с убывающей непрозрачностью.
 */
const BANDS = 12;
const bandIds = Array.from({ length: BANDS }, (_, i) => `${SOURCE}-${i}`);
/** Толщина стенки, м (кольцо внутри тайла: у соседей стенки стоят вплотную). */
const THICK_M = 0.6;

export class TileBorders {
  private enabled = false;
  private keys = '';

  constructor(private readonly map: MlMap) {}

  /** Вызывать после загрузки стиля. */
  addLayer() {
    this.map.addSource(SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    bandIds.forEach((id, i) => this.map.addLayer({
      id,
      type: 'fill-extrusion',
      source: SOURCE,
      layout: { visibility: 'none' },
      paint: {
        'fill-extrusion-color': '#ff4fa3',
        'fill-extrusion-base': (HEIGHT_M * i) / BANDS,
        'fill-extrusion-height': (HEIGHT_M * (i + 1)) / BANDS,
        'fill-extrusion-opacity': OPACITY * (1 - (i + 0.5) / BANDS),
      },
    }));
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    for (const id of bandIds) if (this.map.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  }

  setTiles(keys: string[]) {
    const src = this.map.getSource<GeoJSONSource>(SOURCE);
    const sig = [...keys].sort().join(' ');
    if (!this.enabled || !src || sig === this.keys) return;
    this.keys = sig;
    src.setData({
      type: 'FeatureCollection',
      features: keys.map((key) => {
        const [w, s, e, n] = tileBbox(key);
        const dy = THICK_M / 111_320, dx = dy / Math.cos(((s + n) / 2) * Math.PI / 180);
        const box = (x0: number, y0: number, x1: number, y1: number) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
        return {
          type: 'Feature', properties: { key },
          geometry: { type: 'Polygon', coordinates: [box(w, s, e, n), box(w + dx, s + dy, e - dx, n - dy).reverse()] },
        };
      }),
    });
  }
}

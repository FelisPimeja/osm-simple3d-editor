import type { Map as MlMap, GeoJSONSource } from 'maplibre-gl';

export interface PluginPoints {
  attribution: string;
  iconSvg: string;
  minzoom?: number;
  loadPoints(bounds: [number, number, number, number], zoom: number, signal: AbortSignal): Promise<GeoJSON.FeatureCollection>;
  onClick(id: string): void;
}

let serial = 0;
/** A separate symbol layer: upright icons, height in metres, and picking at the rendered position. */
export function pluginPoints(map: MlMap, options: PluginPoints) {
  const id = `plugin-points-${++serial}`, icon = `${id}-icon`;
  let visible = false, disposed = false, request = 0;
  let controller: AbortController | undefined;
  const empty: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(options.iconSvg)}`;
  const decoded = image.decode();
  const refresh = () => {
    controller?.abort();
    const ticket = ++request;
    if (!visible || disposed || !map.getSource(id)) return;
    if (map.getZoom() < (options.minzoom ?? 6)) {
      (map.getSource(id) as GeoJSONSource).setData(empty);
      return;
    }
    controller = new AbortController();
    const { signal } = controller, b = map.getBounds();
    options.loadPoints([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()], map.getZoom(), signal).then(data => {
      if (ticket === request && visible && !disposed) (map.getSource(id) as GeoJSONSource | undefined)?.setData(data);
    }).catch(error => { if (!signal.aborted) console.warn('Plugin points:', error); });
  };
  const apply = async () => {
    if (!visible || disposed || !map.getStyle()?.layers) return;
    try {
      await decoded;
      if (!visible || disposed || !map.getStyle()?.layers || map.getSource(id)) return;
      if (!map.hasImage(icon)) map.addImage(icon, image, { pixelRatio: 2 });
      map.addSource(id, { type: 'geojson', data: empty, attribution: options.attribution });
      map.addLayer({
        id, type: 'symbol', source: id, minzoom: options.minzoom ?? 6,
        layout: {
          'icon-image': icon, 'icon-pitch-alignment': 'viewport', 'icon-rotation-alignment': 'viewport',
          'icon-allow-overlap': false, 'icon-padding': 2,
          'symbol-height-offset': ['coalesce', ['get', 'height'], 0], 'symbol-height-anchor': 'ground',
        },
      });
      refresh();
    } catch (error) { if (!disposed) console.warn('Plugin points:', error); }
  };
  const remove = () => {
    if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(id)) map.removeSource(id);
    if (map.hasImage(icon)) map.removeImage(icon);
  };
  map.on('style.load', apply);
  map.on('moveend', refresh);
  return {
    setVisible(on: boolean) {
      visible = on;
      if (on) void apply(); else { request++; controller?.abort(); remove(); }
    },
    pick(point: [number, number]) {
      if (!visible || disposed || !map.getLayer(id)) return false;
      const feature = map.queryRenderedFeatures(point, { layers: [id] })[0];
      const target = feature?.properties?.id;
      if (target == null) return false;
      options.onClick(String(target));
      return true;
    },
    dispose() {
      disposed = true; visible = false; request++; controller?.abort();
      map.off('style.load', apply); map.off('moveend', refresh); remove();
    },
  };
}

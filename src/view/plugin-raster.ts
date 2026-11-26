import { addProtocol, removeProtocol, type Map as MlMap } from 'maplibre-gl';

/** Raster coverage supplied by a plugin, optionally decoded/reprojected by its tile loader. */
export interface PluginRaster {
  attribution: string;
  maxzoom: number;
  minzoom?: number;
  loadTile(z: number, x: number, y: number, signal: AbortSignal): Promise<ArrayBuffer>;
}

let serial = 0;
export function pluginRaster(map: MlMap, options: PluginRaster) {
  const id = `plugin-raster-${++serial}`;
  const scheme = `pluginraster${serial}`;
  let visible = false;
  let disposed = false;
  addProtocol(scheme, async (request, controller) => {
    const [z, x, y] = new URL(request.url).pathname.slice(1).split('/').map(Number);
    return { data: await options.loadTile(z, x, y, controller.signal) };
  });
  const remove = () => {
    if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(id)) map.removeSource(id);
  };
  const apply = () => {
    if (disposed || !visible || !map.getStyle()?.layers || map.getSource(id)) return;
    map.addSource(id, {
      type: 'raster', tiles: [`${scheme}://tile/{z}/{x}/{y}`], tileSize: 256,
      minzoom: options.minzoom ?? 0, maxzoom: options.maxzoom, attribution: options.attribution,
    });
    // Coverage is above the basemap and below 3D buildings and their selection overlays.
    const before = map.getStyle().layers?.find(l => l.type === 'fill-extrusion')?.id;
    map.addLayer({ id, source: id, type: 'raster', paint: { 'raster-fade-duration': 0, 'raster-opacity': 0.8 } }, before);
  };
  map.on('style.load', apply);
  return {
    setVisible(on: boolean) { visible = on; if (on) apply(); else remove(); },
    dispose() {
      disposed = true; map.off('style.load', apply); remove(); removeProtocol(scheme);
    },
  };
}

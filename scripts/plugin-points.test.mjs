import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'vite';

test('an elevated balloon is picked at the mouse pixel and opens its exact ID', async () => {
  const vite = await createServer({ configFile: false, server: { middlewareMode: true, ws: false, watch: null }, appType: 'custom' });
  const previousImage = globalThis.Image;
  globalThis.Image = class { decode() { return Promise.resolve(); } };
  try {
    const { pluginPoints } = await vite.ssrLoadModule('/src/view/plugin-points.ts');
    const sources = new Map(), layers = new Map(), opened = [];
    const mouse = [420, 120];
    const map = {
      on() {}, off() {}, getStyle: () => ({ layers: [] }),
      hasImage: () => true, getSource: id => sources.get(id), getLayer: id => layers.get(id),
      addSource(id) { sources.set(id, { setData() {} }); }, addLayer(layer) { layers.set(layer.id, layer); },
      removeLayer(id) { layers.delete(id); }, removeSource(id) { sources.delete(id); }, removeImage() {},
      getZoom: () => 14, getBounds: () => ({ getWest: () => 0, getSouth: () => 0, getEast: () => 1, getNorth: () => 1 }),
      // Reprojecting a geographic position must not replace the actual mouse pixel.
      project() { throw new Error('Ground projection loses the elevated symbol position'); },
      queryRenderedFeatures(point, options) {
        assert.deepEqual(options.layers, [...layers.keys()]);
        return point[0] === mouse[0] && point[1] === mouse[1] ? [{ properties: { id: 'aerial-exact-id' } }] : [];
      },
    };
    const overlay = pluginPoints(map, { attribution: '', iconSvg: '<svg/>',
      loadPoints: async () => ({ type: 'FeatureCollection', features: [] }), onClick: id => opened.push(id) });
    overlay.setVisible(true);
    await Promise.resolve();
    assert.equal(overlay.pick(mouse), true);
    assert.deepEqual(opened, ['aerial-exact-id']);
    assert.equal(overlay.pick([420, 300]), false);
    overlay.setVisible(false);
    assert.equal(overlay.pick(mouse), false);
    overlay.dispose();
  } finally {
    if (previousImage === undefined) delete globalThis.Image; else globalThis.Image = previousImage;
    await vite.close();
  }
});

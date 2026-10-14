import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createServer } from 'vite';
let vite, BuildingsLayer;
before(async () => {
  globalThis.window = {};
  vite = await createServer({ configFile: false, server: { middlewareMode: true, ws: false, watch: null }, appType: 'custom' });
  ({ BuildingsLayer } = await vite.ssrLoadModule('/src/render/buildings-layer.ts'));
});
after(async () => { delete globalThis.window; await vite?.close(); });
for (const floor of [-3, -6, -9]) test(`short nearly straight wall segments at ${floor}m have no vertical seams`, () => {
  const layer = new BuildingsLayer('test');
  const ll = ([x, y]) => [37 + x / (111320 * Math.cos(55 * Math.PI / 180)), 55 + y / 111320];
  layer.setFocus([{ key: 'way/1', type: 'way', id: 1, version: 1, kind: 'part', hasParts: false,
    tags: { 'building:part': 'yes', height: '9' }, polygons: [{ outer: [[-1,-1],[2,-1],[2,2],[-1,2]].map(ll), inners: [] }] }]);
  layer.graphics.edges = true;
  // Short segments with roughly 6° turns.
  const points = Array.from({ length: 21 }, (_, i) => [i * .06, i % 2 ? .003 : 0]);
  points.push([1.2, 1]); // A real right angle must remain visible.
  const item = { key: 'way/2', kind: 'wall', line: true, z: floor, polygons: [{ outer: points.map(ll), inners: [] }] };
  for (const pale of [false, true]) {
    layer.setLevel(pale ? { floor: 0, cut: 3, items: [], below: [{ floor, cut: floor + 3, items: [item], voids: [] }], voids: [[[[ -1,-1],[2,-1],[2,2],[-1,2]].map(ll)]] }
      : { floor, cut: floor + 3, items: [item], voids: [] });
    let verticals = 0;
    layer.indoorObj.traverse(o => {
      if (o.type !== 'LineSegments') return;
      const p = o.geometry.getAttribute('position').array;
      for (let i = 0; i < p.length; i += 6) if (Math.abs(p[i]-p[i+3]) < 1e-6 && Math.abs(p[i+1]-p[i+4]) < 1e-6 && Math.abs(p[i+2]-p[i+5]) > .1) verticals++;
    });
    assert.equal(verticals, 3, `pale=${pale}: two endpoints and one right angle`);
  }
});

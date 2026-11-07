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

const ll = ([x, y]) => [37 + x / (111320 * Math.cos(55 * Math.PI / 180)), 55 + y / 111320];
function plan(doorTags) {
  const layer = new BuildingsLayer('test');
  layer.setFocus([{ key: 'way/1', type: 'way', id: 1, version: 1, kind: 'part', hasParts: false,
    tags: { 'building:part': 'yes', height: '9' }, polygons: [{ outer: [[-5,-5],[5,-5],[5,5],[-5,5]].map(ll), inners: [] }] }]);
  const at = ll([0, 0]);
  layer.setDoors([{ key: 'node/9', at, z: 0, tags: { door: 'yes', ...doorTags } }]);
  layer.setLevel({ floor: 0, cut: 2.9, doors: [at], items: [{ key: 'way/2', kind: 'wall', line: true, z: 0, tags: {},
    polygons: [{ outer: [[-2, 0], [2, 0]].map(ll), inners: [] }] }] });
  let glass;
  layer.indoorObj?.traverse((o) => { if (o.name === "indoor-glass-door") glass = o; });
  const zs = Array.from(layer.indoorWallPositions).filter((_, i) => i % 3 === 2);
  return { glass, zs };
}

test('door height sets the lintel; material=glass fills the opening with a glass panel', () => {
  const plain = plan({});
  assert.equal(plain.glass, undefined);
  assert.ok(plain.zs.some((z) => Math.abs(z - 2.2) < 1e-4), 'default lintel at 2.2 m');
  const tall = plan({ height: '2.6', material: 'glass' });
  assert.ok(tall.zs.some((z) => Math.abs(z - 2.6) < 1e-4), 'lintel at the door height');
  assert.ok(!tall.zs.some((z) => Math.abs(z - 2.2) < 1e-4), 'no default lintel');
  assert.ok(tall.glass, 'glass panel in the opening');
  const p = tall.glass.geometry.getAttribute('position').array;
  assert.ok(Math.max(...Array.from(p).filter((_, i) => i % 3 === 2)) <= 2.6 + 1e-4);
});

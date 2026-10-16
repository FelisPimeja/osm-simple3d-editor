import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { before, after, test } from 'node:test';
import { createServer } from 'vite';
import * as THREE from 'three';
let vite, BuildingsLayer, indoor;
before(async () => {
  globalThis.window = {};
  vite = await createServer({ configFile: false, server: { middlewareMode: true, ws: false, watch: null }, appType: 'custom' });
  ({ BuildingsLayer } = await vite.ssrLoadModule('/src/render/buildings-layer.ts'));
  const { parseBuildings } = await vite.ssrLoadModule('/src/osm/model.ts');
  ({ indoor } = parseBuildings(JSON.parse(readFileSync(new URL('./fixtures/indoor-17887040.json', import.meta.url)))));
});
after(async () => { delete globalThis.window; await vite?.close(); });
const toLocal = ([x, y]) => [(x - 37.6247104) * 111320 * Math.cos(55.8324562 * Math.PI / 180), (y - 55.8324562) * 111320];
function render(z, tags, { flat = false, thickness = 10, lift } = {}) {
  const layer = new BuildingsLayer('test');
  const room = { ...indoor.find(f => f.key === 'relation/17887040'), z };
  const feature = { key: 'roof', hasParts: false, polygons: room.polygons };
  // Roofs 17852173/17852174 share the elevator wall in plan, but start at 12.5 m.
  const g = { toLocal, hidden: new Set(), flat: new Set(flat ? ['roof'] : []),
    lift: new Map(lift === undefined ? [] : [['roof', lift]]),
    items: tags ? [{ feature, tags, box: new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 1, thickness)) }] : [] };
  layer.level = { floor: z, cut: z + 2.9, items: [room] };
  const doors = indoor.filter(f => f.tags.door && f.levels.includes(z / 3)).map(f => f.point);
  layer.drawPlan(new THREE.Group(), g, [room], doors, z + 2.9, false);
  return Array.from(layer.indoorWallPositions);
}
for (const floor of [-3, -2, -1, 0, 1, 2, 3]) test(`elevator walls and door openings survive an overhead roof on level ${floor}`, () => {
  const baseline = render(floor * 3);
  assert.ok(baseline.length > 0);
  assert.deepEqual(render(floor * 3, { 'building:part': 'roof', min_height: '12.5', height: '20', 'roof:height': '7.5', 'roof:shape': 'skillion' }), baseline);
});
test('only a facade spanning the floor-to-cut height suppresses room walls', () => {
  const facade = { 'building:part': 'yes', height: '10' };
  assert.equal(render(0, facade).length, 0);
  const baseline = render(0);
  assert.deepEqual(render(0, { ...facade, min_height: '1' }), baseline);
  assert.deepEqual(render(0, { ...facade, height: '1' }), baseline);
  assert.deepEqual(render(0, facade, { flat: true }), baseline);
  assert.deepEqual(render(0, facade, { thickness: 0 }), baseline);
  assert.deepEqual(render(0, facade, { lift: 5 }), baseline);
});

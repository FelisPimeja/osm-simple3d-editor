import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createServer } from 'vite';

let vite, computeHeights, buildTriangles;
before(async () => {
  vite = await createServer({ configFile: false, server: { middlewareMode: true, ws: false, watch: null }, appType: 'custom' });
  ({ computeHeights } = await vite.ssrLoadModule('/src/osm/heights.ts'));
  ({ buildTriangles } = await vite.ssrLoadModule('/src/render/building-geometry.ts'));
});
after(async () => { await vite.close(); });

// Height-related tags shared by way/132433651 and way/132433670.
const tags = { building: 'apartments', 'building:levels': '2', 'roof:shape': 'gabled', 'roof:levels': '0', 'roof:orientation': 'along' };
test('zero roof levels preserve pitched geometry and two storeys below the roof', () => {
  const h = computeHeights(tags);
  assert.equal(h.wallTop, 7);
  assert.equal(h.roofHeight, 3);
  assert.equal(h.top, 10);
  const mesh = buildTriangles([{ outer: [[0,0],[20,0],[20,10],[0,10]], inners: [] }], h, tags);
  const zs = mesh.roof.filter((_, i) => i % 3 === 2);
  assert.equal(Math.min(...zs), 7);
  assert.equal(Math.max(...zs), 10);
});
test('explicit roof height takes priority, including zero', () => {
  for (const height of ['0', '1.5']) {
    assert.equal(computeHeights({ ...tags, 'roof:height': height }).roofHeight, Number(height));
  }
});
test('positive roof levels and flat roofs retain their height rules', () => {
  assert.equal(computeHeights({ ...tags, 'roof:levels': '2' }).roofHeight, 7);
  assert.equal(computeHeights({ ...tags, 'roof:shape': 'flat' }).roofHeight, 0);
  const h = computeHeights({ ...tags, height: '8' });
  assert.equal(h.top, 8);
  assert.equal(h.wallTop, 5);
});

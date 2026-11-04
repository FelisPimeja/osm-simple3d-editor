import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createServer } from 'vite';

let vite, sidesMeet;
before(async () => {
  vite = await createServer({ configFile: false, server: { middlewareMode: true, ws: false, watch: null }, appType: 'custom' });
  ({ sidesMeet } = await vite.ssrLoadModule('/src/edit/shape-tool.ts'));
});
after(() => vite?.close());

test('the corner snaps where the extensions of the adjacent sides AB and ED meet', () => {
  // A(0,0) B(10,0) C(16,4) D(20,-10) E(20,-17): C goes to (20,0)
  const p = sidesMeet([0, 0], [10, 0], [20, -17], [20, -10]);
  assert.ok(p && Math.abs(p[0] - 20) < 1e-9 && Math.abs(p[1]) < 1e-9);
});

test('no corner for parallel sides, a rectangle corner or a point too far away', () => {
  assert.equal(sidesMeet([0, 0], [10, 0], [0, 5], [10, 5]), undefined);
  // Rectangle: A and E are the same vertex, the lines meet in it
  assert.equal(sidesMeet([0, 0], [10, 0], [0, 0], [0, 5]), undefined);
  assert.equal(sidesMeet([0, 0], [10, 0], [500, -17], [500, -10]), undefined);
});

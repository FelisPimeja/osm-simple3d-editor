import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { before, after, test } from 'node:test';
import { createServer } from 'vite';

let vite, buildTriangles, restoreRoofBoundary;
before(async () => {
  globalThis.self = globalThis;
  globalThis.window = globalThis;
  vite = await createServer({ configFile: false, server: { middlewareMode: true, ws: false, watch: null }, appType: 'custom' });
  await (await vite.ssrLoadModule('/src/render/skeleton.ts')).skeletonReady;
  ({ buildTriangles } = await vite.ssrLoadModule('/src/render/building-geometry.ts'));
  ({ restoreRoofBoundary } = await vite.ssrLoadModule('/src/render/roof-gables.ts'));
});
after(async () => { await vite.close(); });

for (const shape of ['gabled', 'hipped', 'round', 'gambrel', 'mansard']) {
  test(`issue 28: ${shape} roof meets every original wall edge`, () => {
    // OSM way/89823247, local coordinates in metres (OSM contributors, ODbL).
    const ring = JSON.parse(readFileSync(new URL('./fixtures/roof-api-89823247-ring.json', import.meta.url)));
    const result = buildTriangles([{ outer: ring, inners: [] }],
      { min: 0, wallTop: 7.5, top: 10.5, roofHeight: 3, roofShape: shape, source: 'levels' }, {});
    assert.equal(result.roofApproximated, false);
    const surface = [...result.roof, ...result.walls.slice(result.gableStart)];
    const gables = result.walls.slice(result.gableStart);
    if (shape === 'gabled') {
      assert.ok(Array.from({ length: result.roof.length / 9 }, (_, i) => i * 9)
        .some(i => [2, 5, 8].every(j => Math.abs(result.roof[i + j] - 7.5) < 1e-6)),
      'the restored horizontal eave infill is present in the roof');
    }
    for (let i = 0; i < gables.length; i += 9) {
      assert.ok([2, 5, 8].some(j => Math.abs(gables[i + j] - 7.5) > 1e-6),
        'horizontal eave infill must use the roof material, not the facade material');
      const a = gables.slice(i, i + 3), b = gables.slice(i + 3, i + 6), c = gables.slice(i + 6, i + 9);
      const u = b.map((v, k) => v - a[k]), v = c.map((v, k) => v - a[k]);
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      assert.ok(Math.abs(n[2]) <= Math.hypot(...n) * 1e-4,
        'inclined eave infill must also use the roof material');
    }
    assert.ok(surface.every(Number.isFinite));
    const edges = [];
    for (let i = 0; i < surface.length; i += 9) for (let j = 0; j < 3; j++) {
      edges.push([surface.slice(i + j * 3, i + j * 3 + 3), surface.slice(i + ((j + 1) % 3) * 3, i + ((j + 1) % 3) * 3 + 3)]);
    }
    const same = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - 7.5) < 1e-6;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      assert.ok(edges.some(([p, q]) => same(p, a) && same(q, b) || same(p, b) && same(q, a)), `missing eave edge ${i}`);
    }
  });
}

test('boundary restoration preserves winding, shared vertices and the cached skeleton', () => {
  const ring = [[0, 0], [2, -.2], [4, 0], [4, 4], [0, 4]];
  const sk = { vertices: [[0, 0, 0], [4, 0, 0], [4, 4, 0], [0, 4, 0], [2, 2, 2]], polygons: [[0, 1, 4], [1, 2, 4], [2, 3, 4], [3, 0, 4]] };
  const original = structuredClone(sk);
  const result = restoreRoofBoundary(sk, [ring]);
  assert.deepEqual(result.polygons[0], [0, 5, 1, 4]);
  assert.deepEqual(result.vertices[5], [2, -.2, 0]);
  assert.deepEqual(sk, original);
  const reverse = restoreRoofBoundary({ ...sk, polygons: sk.polygons.map(f => [...f].reverse()) }, [ring]);
  assert.deepEqual(reverse.polygons[0], [4, 1, 5, 0]);
});

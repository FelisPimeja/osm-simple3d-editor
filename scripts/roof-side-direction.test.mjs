import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createServer } from 'vite';

let vite, buildTriangles, computeHeights;
before(async () => {
  vite = await createServer({ configFile: false, server: { middlewareMode: true, ws: false, watch: null }, appType: 'custom' });
  ({ buildTriangles } = await vite.ssrLoadModule('/src/render/building-geometry.ts'));
  ({ computeHeights } = await vite.ssrLoadModule('/src/osm/heights.ts'));
});
after(async () => { await vite.close(); });

const polygons = [{ outer: [[-5,-5],[5,-5],[5,5],[-5,5]], inners: [] }];
function build(shape, direction, orientation) {
  const tags = { building: 'yes', height: '9', 'roof:height': '3', 'roof:shape': shape };
  if (direction !== undefined) tags['roof:direction'] = direction;
  if (orientation !== undefined) tags['roof:orientation'] = orientation;
  return buildTriangles(polygons, computeHeights(tags), tags);
}

for (const shape of ['side_hipped', 'side_half-hipped']) {
  test(`${shape}: cardinal directions put the gable opposite the hip`, () => {
    for (const [direction, dx, dy] of [['N',0,1],['E',1,0],['S',0,-1],['W',-1,0]]) {
      const mesh = build(shape, direction);
      const upper = [];
      for (let i = mesh.gableStart; i < mesh.walls.length; i += 3) {
        if (mesh.walls[i+2] > 6.001) upper.push(mesh.walls[i] * dx + mesh.walls[i+1] * dy);
      }
      assert.ok(upper.length > 0);
      // Highest gable vertices must be on the end opposite roof:direction.
      const peaks = [];
      for (let i = mesh.gableStart; i < mesh.walls.length; i += 3) {
        if (mesh.walls[i+2] > 8.999) peaks.push(mesh.walls[i] * dx + mesh.walls[i+1] * dy);
      }
      assert.ok(peaks.length > 0);
      assert.ok(peaks.every(v => Math.abs(v + 5) < 1e-5), direction);
      assert.deepEqual(build(shape, direction, 'across').roof, mesh.roof);
    }
    assert.deepEqual(build(shape, '90').roof, build(shape, 'E').roof);
    assert.deepEqual(build(shape, 'invalid').roof, build(shape).roof);
  });
}

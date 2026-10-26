import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createServer } from 'vite';

let vite, buildTriangles, computeHeights;
before(async () => {
  vite = await createServer({ root: process.cwd(), configFile: false, server: { middlewareMode: true, ws: false, watch: null }, appType: 'custom' });
  ({ buildTriangles } = await vite.ssrLoadModule('/src/render/building-geometry.ts'));
  ({ computeHeights } = await vite.ssrLoadModule('/src/osm/heights.ts'));
});
after(async () => { await vite.close(); });
const rect = [[-6,-5],[6,-5],[6,5],[-6,5]];
function build(ring, extra = {}, shape = 'gabled') {
  const tags = { building: 'yes', height: '9', 'roof:height': '3', 'roof:shape': shape, ...extra };
  const original = { ...tags };
  const mesh = buildTriangles([{ outer: ring, inners: [] }], computeHeights(tags), tags);
  assert.deepEqual(tags, original);
  assert.equal(mesh.roofApproximated, false);
  return mesh;
}

test('gabled: cardinal and numeric directions choose the slope axis on square and rectangular footprints', () => {
  for (const ring of [rect, [[-5,-5],[5,-5],[5,5],[-5,5]]]) {
    const along = build(ring, { 'roof:orientation': 'along' });
    const across = build(ring, { 'roof:orientation': 'across' });
    assert.notDeepEqual(along.roof, across.roof);
    for (const direction of ['N', 'S', '0', '180', '360']) {
      const mesh = build(ring, { 'roof:direction': direction });
      assert.deepEqual(mesh.roof, along.roof, direction);
      assert.deepEqual(mesh.walls, along.walls, direction);
    }
    for (const direction of ['E', 'W', '90', '270']) {
      const mesh = build(ring, { 'roof:direction': direction });
      assert.deepEqual(mesh.roof, across.roof, direction);
      assert.deepEqual(mesh.walls, across.walls, direction);
    }
  }
});

test('gabled: approximate bearings snap to a rotated footprint rather than cutting a diagonal roof', () => {
  const rad = 20 * Math.PI / 180;
  const ring = rect.map(([x,y]) => [x*Math.cos(rad)-y*Math.sin(rad), x*Math.sin(rad)+y*Math.cos(rad)]);
  const along = build(ring, { 'roof:orientation': 'along' });
  const across = build(ring, { 'roof:orientation': 'across' });
  for (const direction of ['N', 'S', '340', '160', '345']) assert.deepEqual(build(ring, { 'roof:direction': direction }), along);
  for (const direction of ['E', 'W', '70', '250', '75']) assert.deepEqual(build(ring, { 'roof:direction': direction }), across);
});

test('gabled: valid direction overrides orientation; missing or invalid direction preserves orientation', () => {
  assert.deepEqual(build(rect, { 'roof:direction': '90', 'roof:orientation': 'along' }), build(rect, { 'roof:orientation': 'across' }));
  assert.deepEqual(build(rect, { 'roof:direction': '0', 'roof:orientation': 'across' }), build(rect, { 'roof:orientation': 'along' }));
  for (const direction of ['', ' ', 'unknown', 'NaN']) {
    for (const orientation of ['along', 'across']) assert.deepEqual(build(rect, { 'roof:direction': direction, 'roof:orientation': orientation }), build(rect, { 'roof:orientation': orientation }));
  }
});

test('other symmetric axis roofs keep their existing orientation behaviour', () => {
  for (const shape of ['round', 'gambrel', 'half-hipped', 'bellcast_gable']) {
    assert.deepEqual(build(rect, { 'roof:direction': '90' }, shape), build(rect, {}, shape));
  }
});

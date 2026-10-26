import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createServer } from 'vite';
let vite, EditSession, refreshBuildingFeatures;
before(async () => {
  vite = await createServer({ configFile: false, server: { middlewareMode: true, ws: false, watch: null }, appType: 'custom' });
  ({ EditSession } = await vite.ssrLoadModule('/src/edit/session.ts'));
  ({ refreshBuildingFeatures } = await vite.ssrLoadModule('/src/osm/building-refresh.ts'));
});
after(async () => { await vite.close(); });
const key = 'way/10';
const polygons = (ids) => [{ outer: ids.map((id) => [id / 100, 0]), outerIds: ids, inners: [], innerIds: [] }];
const feature = (version, ids) => ({ key, id: 10, type: 'way', kind: 'part', version, tags: { 'building:part': 'yes' }, polygons: polygons(ids), hasParts: false });
test('a current tile cache does not leave an older session baseline for the next geometry upload', () => {
  const session = new EditSession([feature(1, [1,2,3])], () => {});
  const current = feature(2, [1,2,4,3]); // Already loaded into the tile cache before the building refresh.
  refreshBuildingFeatures(session, [current]);
  session.editMany([{ key, polygons: polygons([1,2,4,5,3]) }]);
  const edit = session.changes()[0];
  assert.equal(edit.feature.version, 2);
  assert.deepEqual(edit.wayNodes.before, [1,2,4,3,1]);
  assert.deepEqual(edit.wayNodes.after, [1,2,4,5,3,1]);
});
test('after saving with assigned node IDs, refreshing and editing again uses the server list', () => {
  const session = new EditSession([feature(1, [1,2,3])], () => {});
  session.editMany([{ key, polygons: polygons([1,2,-1,3]) }]);
  session.remapIds(new Map([[-1,4]]), new Map());
  session.markSaved(new Map([[key, { version: 2, tags: { 'building:part': 'yes' } }]]));
  refreshBuildingFeatures(session, [feature(2, [1,2,4,3])]);
  session.editMany([{ key, polygons: polygons([1,2,4,-2,3]) }]);
  assert.deepEqual(session.changes()[0].wayNodes.before, [1,2,4,3,1]);
});
test('refresh preserves local changes and undo/redo history', () => {
  const session = new EditSession([feature(1, [1,2,3])], () => {});
  session.editMany([{ key, polygons: polygons([1,2,5,3]) }]);
  refreshBuildingFeatures(session, [feature(2, [1,2,4,3])]);
  assert.deepEqual(session.changes()[0].wayNodes.before, [1,2,3,1]);
  session.undo();
  refreshBuildingFeatures(session, [feature(2, [1,2,4,3])]);
  session.redo();
  assert.deepEqual(session.changes()[0].wayNodes.after, [1,2,5,3,1]);
  assert.equal(session.get(key).version, 1);
});

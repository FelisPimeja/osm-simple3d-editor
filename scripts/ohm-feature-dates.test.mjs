import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createServer } from 'vite';

let vite, OverpassTiles, existsIn, dateSpan;
before(async () => {
  globalThis.location = { search: '?server=ohm', href: 'http://localhost/?server=ohm' };
  vite = await createServer({ configFile: false, server: { middlewareMode: true, ws: false, watch: null }, appType: 'custom' });
  ({ OverpassTiles } = await vite.ssrLoadModule('/src/view/overpass-tiles.ts'));
  ({ existsIn, dateSpan } = await vite.ssrLoadModule('/src/osm/dates.ts'));
  // No network or IndexedDB: supply the same cached features across date changes.
  OverpassTiles.prototype.loadStoredKeys = () => {};
});
after(async () => { await vite.close(); delete globalThis.location; });

function fixture() {
  const tiles = new OverpassTiles({}, { groupKeys: () => [] }, () => {});
  const old = { start_date: '1938', end_date: '1970' };
  const current = { start_date: '1980' };
  const road = (id, tags) => ({ id, nodes: [1, 2], coords: [[0, 0], [0.001, 0]], tags });
  const roads = [road(1, { highway: 'primary', bridge: 'yes', ...old }),
    road(2, { highway: 'primary', tunnel: 'yes', ...current }),
    road(3, { highway: 'primary', ...old }), // obsolete approach must not influence the network
    road(4, { highway: 'primary' })];
  tiles.cache.set('tile', { state: 'ready', roads });
  tiles.wanted = ['tile'];
  return { tiles, old, current };
}
function setDate(tiles, date) {
  tiles.setFeatureFilter(date ? (f) => existsIn(f.tags, dateSpan(date)) : () => true);
}

test('bridge, tunnel and approach network changes date without reloading cached data', () => {
  const { tiles } = fixture();
  setDate(tiles, '1962-05-25');
  assert.deepEqual(tiles.roads().map((r) => r.id), [1, 3, 4]);
  setDate(tiles, '1985-01-13');
  assert.deepEqual(tiles.roads().map((r) => r.id), [2, 4]);
  setDate(tiles, undefined); // ordinary OSM: no date filtering
  assert.deepEqual(tiles.roads().map((r) => r.id), [1, 2, 3, 4]);
});

test('indoor date visibility and cache revision change even when building parts stay unchanged', () => {
  const { tiles, old, current } = fixture();
  const rooms = [old, current, {}].map((tags) => ({ tags: { indoor: 'room', level: '5', ...tags } }));
  setDate(tiles, '1962-05-25');
  const revision = tiles.visibilityRevision;
  assert.deepEqual(rooms.filter((f) => tiles.isVisible(f)), [rooms[0], rooms[2]]);
  setDate(tiles, '1985-01-13');
  assert.notEqual(tiles.visibilityRevision, revision);
  assert.deepEqual(rooms.filter((f) => tiles.isVisible(f)), [rooms[1], rooms[2]]);
  // Unsaved tag edits use the effective tags, not a prefiltered cached copy.
  assert.equal(tiles.isVisible({ tags: { ...rooms[0].tags, end_date: '1990' } }), true);
  setDate(tiles, '1970-01-01');
  assert.equal(tiles.isVisible(rooms[0]), false); // end_date is exclusive
});

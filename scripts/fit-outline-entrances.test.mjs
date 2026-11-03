import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { before, after, test } from 'node:test';
import { createServer } from 'vite';

let vite, BuildingsLayer, unitedRings, raisedOutside, keepOutlineEntrances, partGround;
before(async () => {
  globalThis.window = {};
  globalThis.localStorage = { getItem: () => 'en' };
  vite = await createServer({ configFile: false, server: { middlewareMode: true, ws: false, watch: null }, appType: 'custom' });
  ({ BuildingsLayer } = await vite.ssrLoadModule('/src/render/buildings-layer.ts'));
  ({ unitedRings, raisedOutside, keepOutlineEntrances } = await vite.ssrLoadModule('/src/edit/fit-outline.ts'));
  ({ partGround } = await vite.ssrLoadModule('/src/edit/validate.ts'));
});
after(async () => { await vite.close(); delete globalThis.window; delete globalThis.localStorage; });

// relation/21861460: the outline sits up to 1.6 m outside the ground footprint; three entrances are only on it,
// two more are vertices of overhanging parts
const data = JSON.parse(readFileSync(new URL('./fixtures/relation-21861460.json', import.meta.url), 'utf8'));
const OUTLINE = 371257759;
const FAR = [13266886513, 13626756636, 13626762059];
const ON_RAISED = [13266847293, 13626752352];
const origin = data.nodes[data.ways[OUTLINE].nodes[0]];
const kx = 111320 * Math.cos(origin[1] * Math.PI / 180), ky = 111320;
const toLocal = ([x, y]) => [(x - origin[0]) * kx, (y - origin[1]) * ky];
const toLonLat = ([x, y]) => [origin[0] + x / kx, origin[1] + y / ky];
const feature = (id, entranceTags = {}) => {
  const w = data.ways[id];
  const entrances = w.nodes.filter((n) => data.entrances[n]).map((n) => ({ id: n, tags: { ...data.entrances[n], ...entranceTags[n] } }));
  return { key: `way/${id}`, type: 'way', id: Number(id), version: 1, kind: Number(id) === OUTLINE ? 'building' : 'part', tags: w.tags, hasParts: false,
    polygons: [{ outer: w.nodes.map((n) => data.nodes[n]), inners: [], outerIds: [...w.nodes], innerIds: [] }], ...(entrances.length ? { entrances } : {}) };
};
const parts = (entranceTags) => Object.keys(data.ways).filter((id) => Number(id) !== OUTLINE).map((id) => feature(id, entranceTags));
const ground = () => parts().filter((f) => partGround(f.tags) === 'ground');
const footprint = () => unitedRings(ground().flatMap((f) => f.polygons.map((p) => p.outer.map(toLocal))));
const dist = (q, ring) => Math.min(...ring.map((a, i) => {
  const b = ring[(i + 1) % ring.length], dx = b[0] - a[0], dy = b[1] - a[1], l = dx * dx + dy * dy;
  const t = Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / l));
  return Math.hypot(q[0] - a[0] - t * dx, q[1] - a[1] - t * dy);
}));
const entranceZ = (features) => {
  const layer = new BuildingsLayer('test');
  layer.setGroup('b', features, origin);
  return new Map(layer.groups.get('b').entrances.map((e) => [e.id, e.z]));
};

test('fitting the outline gives layer=1 to the overhanging parts left outside the ground footprint', () => {
  const fp = footprint();
  assert.ok(fp);
  const keys = raisedOutside(parts(), fp.outer, toLocal);
  assert.deepEqual(keys.sort(), ['way/1574438566', 'way/1574438567', 'way/1574438568', 'way/1574438569']);
  // Parts on the ground and parts already on a positive layer are left alone
  for (const k of keys) assert.equal(partGround(data.ways[k.slice(4)].tags), 'raised');
  const layered = parts().map((f) => (keys.includes(f.key) ? { ...f, tags: { ...f.tags, layer: '1' } } : f));
  assert.deepEqual(raisedOutside(layered, fp.outer, toLocal), []);
});

test('entrances on the outline away from the parts move onto the ground footprint', () => {
  const fp = footprint();
  const outline = feature(OUTLINE);
  const ids = [], coords = [];
  // New ring: footprint corners on fresh ids
  fp.outer.forEach((q, i) => { ids.push(-1 - i); coords.push(toLonLat(q)); });
  const moved = keepOutlineEntrances(outline, ground(), ids, coords, (id) => !!data.entrances[id], toLocal, toLonLat);
  assert.equal(moved, 5);
  for (const id of [...FAR, ...ON_RAISED]) {
    const i = ids.indexOf(id);
    assert.ok(i >= 0, `entrance ${id} kept in the ring`);
    assert.ok(dist(toLocal(coords[i]), fp.outer) < 0.05, `entrance ${id} on the footprint`);
  }
  for (const id of FAR) {
    const was = toLocal(data.nodes[id]), now = toLocal(coords[ids.indexOf(id)]);
    assert.ok(Math.hypot(was[0] - now[0], was[1] - now[1]) > 0.5, `entrance ${id} moved off the old outline`);
  }
});

test('entrances without level stay at ground level, even on walls of overhanging parts', () => {
  for (const features of [[feature(OUTLINE), ...parts()], parts()]) {
    const z = entranceZ(features);
    assert.ok(z.size >= ON_RAISED.length);
    for (const [id, h] of z) assert.equal(h, 0, `entrance ${id}`);
  }
});

test('indoor=door with level other than 0 is drawn at that floor', () => {
  const door = (level) => Object.fromEntries(ON_RAISED.map((id) => [id, { indoor: 'door', level }]));
  for (const [level, height] of [['1', 3], ['2', 6], ['0', 0]]) {
    const z = entranceZ(parts(door(level)));
    for (const id of ON_RAISED) assert.ok(Math.abs(z.get(id) - height) < 1e-6, `level=${level}: entrance ${id} at ${z.get(id)}`);
  }
  // level without indoor=door is not a lift
  const z = entranceZ(parts(Object.fromEntries(ON_RAISED.map((id) => [id, { level: '2' }]))));
  for (const id of ON_RAISED) assert.equal(z.get(id), 0);
});

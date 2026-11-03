import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { before, after, test } from 'node:test';
import { createServer } from 'vite';

let vite, validateBuilding;
before(async () => {
  globalThis.localStorage = { getItem: () => 'en' };
  vite = await createServer({ configFile: false, server: { middlewareMode: true, ws: false, watch: null }, appType: 'custom' });
  ({ validateBuilding } = await vite.ssrLoadModule('/src/edit/validate.ts'));
});
after(async () => { await vite.close(); delete globalThis.localStorage; });

// relation/21861460: the outline sits up to 1.6 m outside the ground footprint of the parts
const data = JSON.parse(readFileSync(new URL('./fixtures/relation-21861460.json', import.meta.url), 'utf8'));
const OUTLINE = 371257759;
const feature = (id) => {
  const w = data.ways[id];
  return { key: `way/${id}`, type: 'way', id: Number(id), version: 1, kind: Number(id) === OUTLINE ? 'building' : 'part', tags: w.tags, hasParts: false,
    polygons: [{ outer: w.nodes.map((n) => data.nodes[n]), inners: [], outerIds: w.nodes, innerIds: [] }] };
};
const building = (skip = []) => {
  const ids = Object.keys(data.ways).filter((id) => !skip.includes(Number(id)));
  const features = ids.map(feature);
  const g = { key: 'relation/21861460', type: 'relation', id: 21861460, tags: { type: 'building' },
    members: features.map((f) => f.key), roles: features.map((f) => (f.id === OUTLINE ? 'outline' : 'part')) };
  return validateBuilding(g, features).filter((i) => i.code === 'coverage');
};

test('outline drawn slightly off the parts offers fitting it, not a missing part', () => {
  const [issue, ...rest] = building();
  assert.equal(rest.length, 0);
  assert.equal(issue.key, `way/${OUTLINE}`);
  assert.equal(issue.fix?.fitOutline, true);
});

test('a gap where a whole ground part is missing stays a missing-part warning', () => {
  const [issue] = building([1574438570]);
  assert.ok(issue);
  assert.ok(!issue.fix?.fitOutline);
});

import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createServer } from 'vite';

let vite, validateBuilding;
before(async () => {
  globalThis.localStorage = { getItem: () => 'en' };
  vite = await createServer({ configFile: false, server: { middlewareMode: true, ws: false, watch: null }, appType: 'custom' });
  ({ validateBuilding } = await vite.ssrLoadModule('/src/edit/validate.ts'));
});
after(async () => { await vite.close(); delete globalThis.localStorage; });

const sq = (x, y, s) => [[x, y], [x + s, y], [x + s, y + s], [x, y + s]];
const way = (id, tags, ring) => ({ key: `way/${id}`, type: 'way', id, version: 1, kind: 'part', tags, hasParts: false,
  polygons: [{ outer: ring, inners: [] }] });

test('outline lower than its tallest part gets one fixable warning', () => {
  const o = way(1, { building: 'yes', height: '15.5', 'building:levels': '5' }, sq(37.6, 55.8, 0.0002));
  const a = way(2, { 'building:part': 'yes', height: '18.5', 'building:levels': '6' }, sq(37.6, 55.8, 0.0001));
  const b = way(3, { 'building:part': 'yes', height: '12' }, sq(37.6001, 55.8001, 0.0001));
  const g = { key: 'relation/9', type: 'relation', id: 9, tags: { type: 'building' }, members: [o.key, a.key, b.key], roles: ['outline', 'part', 'part'] };
  const mine = validateBuilding(g, [o, a, b]).filter((i) => i.key === o.key && i.code === 'above');
  assert.deepEqual(mine.map((i) => i.fix?.tags), [{ height: '18.5' }, { 'building:levels': '6' }]);
});

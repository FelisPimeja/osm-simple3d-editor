import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createServer } from 'vite';

let vite, indoorCategory, categorySource;
before(async () => {
  vite = await createServer({ configFile: false, server: { middlewareMode: true, ws: false, watch: null }, appType: 'custom' });
  ({ indoorCategory, categorySource } = await vite.ssrLoadModule('/src/osm/indoor-categories.ts'));
});
after(async () => { await vite?.close(); });

const shop = { key: 'node/5209087823', kind: 'poi', tags: { shop: 'convenience', level: '0' }, levels: [0], polygons: [], point: [0, 0] };

// relation/19896350: платформа вокзала с магазином внутри — белая, магазин её не перекрашивает
test('a platform stays white with a shop inside, an untagged area still takes the shop purpose', () => {
  const platform = { key: 'relation/19896350', kind: 'area', tags: { indoor: 'area', room: 'platform', level: '0;1;2' }, levels: [0, 1, 2], polygons: [] };
  assert.equal(indoorCategory(platform, [shop]), 'circulation');
  assert.equal(categorySource(platform, [shop]), undefined);
  const area = { key: 'way/1', kind: 'area', tags: { indoor: 'area', level: '0' }, levels: [0], polygons: [] };
  assert.equal(indoorCategory(area, [shop]), 'shop');
});

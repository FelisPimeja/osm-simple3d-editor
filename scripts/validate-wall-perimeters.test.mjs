import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createServer } from 'vite';

let vite, validateWallPerimeters;
before(async () => {
  globalThis.localStorage = { getItem: () => 'en' };
  vite = await createServer({ configFile: false, server: { middlewareMode: true, ws: false, watch: null }, appType: 'custom' });
  ({ validateWallPerimeters } = await vite.ssrLoadModule('/src/edit/validate.ts'));
});
after(async () => { await vite.close(); delete globalThis.localStorage; });

const sq = [[0, 0], [1, 0], [1, 1], [0, 1]];
const poly = { key: 'relation/1', kind: 'wall', tags: { type: 'multipolygon', indoor: 'wall', level: '0' }, levels: [0], polygons: [{ outer: sq, inners: [], outerIds: [1, 2, 3, 4] }] };
const line = (ids, level, levels) => ({ key: 'way/9', kind: 'wall', line: true, tags: { indoor: 'wall', level, wall: 'brick', name: 'x' }, levels, polygons: [{ outer: ids.map((i) => sq[i - 1]), inners: [], outerIds: ids }] });

test('linear wall on a polygonal wall outline at the same levels — remove its wall keys', () => {
  const [issue] = validateWallPerimeters([poly, line([1, 2, 3], '0', [0])]);
  assert.equal(issue.key, 'way/9');
  assert.deepEqual(issue.fix.tags, { indoor: undefined, level: undefined, wall: undefined });
});
test('different levels, partial overlap and lone walls are left alone', () => {
  assert.equal(validateWallPerimeters([poly, line([1, 2, 3], '0;1', [0, 1])]).length, 0);
  assert.equal(validateWallPerimeters([poly, line([1, 2, 7], '0', [0])]).length, 0);
  assert.equal(validateWallPerimeters([line([1, 2, 3], '0', [0])]).length, 0);
});

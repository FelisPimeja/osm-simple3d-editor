import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createServer } from 'vite';

let vite, stairsOutline;
before(async () => {
  vite = await createServer({ configFile: false, server: { middlewareMode: true, ws: false, watch: null }, appType: 'custom' });
  ({ stairsOutline } = await vite.ssrLoadModule('/src/edit/escalator-levels.ts'));
});
after(async () => { await vite?.close(); });

const stairs = (key, levels, outer) => ({ key, kind: 'area', line: true, escalator: true, stairs: true,
  tags: { highway: 'steps', incline: 'up', indoor: 'yes', level: levels.join(';') }, levels, polygons: [{ outer, inners: [] }] });
// relation/19902989 продлена вниз, внутри — середина марша way/1455020620 (-1;0)
const ring = [[37.6559377, 55.7725176], [37.6559681, 55.7725234], [37.655998, 55.7725291], [37.655946, 55.7726169], [37.655916, 55.7726112], [37.6558856, 55.7726054]];
const area = { key: 'relation/19902989', kind: 'area', tags: { indoor: 'area', level: '0;1', room: 'stairs' }, levels: [0, 1], polygons: [{ outer: ring, inners: [] }] };
const axis = stairs('way/1455020562', [0, 1], [[37.655916, 55.7726112], [37.6559681, 55.7725234]]);

test('a flight of the neighbouring level pair under the stairs area does not take its outline away', () => {
  const below = stairs('way/1455020620', [-1, 0], [[37.6559451, 55.7725615], [37.6559681, 55.7725234]]);
  assert.deepEqual(stairsOutline(axis, [axis, area, below]), ring);
});

test('a second flight of the same levels in the area still leaves it without an outline', () => {
  const twin = stairs('way/2', [0, 1], [[37.6559451, 55.7725615], [37.6559681, 55.7725234]]);
  assert.equal(stairsOutline(axis, [axis, area, twin]), undefined);
});

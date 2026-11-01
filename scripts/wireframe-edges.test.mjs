import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'vite';

let vite, mergeCollinear;
before(async () => {
  vite = await createServer({ configFile: false, server: { middlewareMode: true, ws: false, watch: null }, appType: 'custom' });
  ({ mergeCollinear } = await vite.ssrLoadModule('/src/render/wireframe-edges.ts'));
});
after(async () => { await vite.close(); });

const close = (actual, expected) => actual.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) < 1e-3, `${[...actual]}`));

test('opposite and partial overlaps become one upward segment', () => {
  const out = mergeCollinear([1, 2, 7, 1, 2, 0, 1, 2, 0, 1, 2, 7, 1, 2, 5.5, 1, 2, 3.5, 1, 2, 7, 1, 2, 10.5]);
  assert.equal(out.length, 6);
  close(out, [1, 2, 0, 1, 2, 10.5]);
});

test('a gap on the line and other lines stay apart', () => {
  assert.equal(mergeCollinear([0, 0, 0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 1, 0, 0, 1, 0, 1]).length, 18);
});

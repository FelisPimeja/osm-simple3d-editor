import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createServer } from 'vite';

let vite, tracePath;
before(async () => {
  vite = await createServer({ configFile: false, server: { middlewareMode: true, ws: false, watch: null }, appType: 'custom' });
  ({ tracePath } = await vite.ssrLoadModule('/src/edit/trace.ts'));
});
after(async () => { await vite?.close(); });

const ring = (pts, z = 0) => pts.map((p, i) => ({ a: { x: p[0], y: p[1], z }, b: { x: pts[(i + 1) % pts.length][0], y: pts[(i + 1) % pts.length][1], z } }));
// Прямоугольник 10×2 и комната 2×2 у его правого конца
const edges = [...ring([[0, 0], [10, 0], [10, 2], [0, 2]]), ...ring([[8, 0], [10, 0], [10, 2], [8, 2]])];

test('путь по вершинам контура — кратчайшей стороной', () => {
  assert.deepEqual(tracePath(edges, 0, [0, 0], [8, 2]), [[0, 2]]);
  assert.deepEqual(tracePath(edges, 0, [0, 1.5], [10, 1.5]), [[0, 2], [8, 2], [10, 2]]);
});

test('точки посреди одного ребра — прямой отрезок; вне графа — нет пути', () => {
  assert.deepEqual(tracePath(edges, 0, [1, 0], [3, 0]), []);
  assert.equal(tracePath(edges, 0, [5, 1], [10, 2]), undefined);
  assert.equal(tracePath(edges, 3, [0, 0], [8, 2]), undefined);
});

test('с ребра на ребро через общую вершину', () => {
  assert.deepEqual(tracePath(edges, 0, [5, 0], [10, 1]), [[8, 0], [10, 0]]);
});

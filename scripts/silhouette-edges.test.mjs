import assert from 'node:assert/strict';
import { test } from 'node:test';
import { after, before } from 'node:test';
import { createServer } from 'vite';

let vite, silhouetteEdges;
before(async () => {
  vite = await createServer({ configFile: false, server: { middlewareMode: true, ws: false, watch: null }, appType: 'custom' });
  ({ silhouetteEdges } = await vite.ssrLoadModule('/src/render/silhouette-edges.ts'));
});
after(async () => { await vite.close(); });

function prism(ring) {
  const out = [];
  ring.forEach(([ax, ay], i) => {
    const [bx, by] = ring[(i + 1) % ring.length];
    out.push(ax, ay, 0, bx, by, 0, bx, by, 5, ax, ay, 0, bx, by, 5, ax, ay, 5);
  });
  return new Float32Array(out);
}

test('every joint of a round wall is a silhouette candidate', () => {
  const ring = Array.from({ length: 24 }, (_, i) => [Math.cos(i * Math.PI / 12), Math.sin(i * Math.PI / 12)]);
  const p = prism(ring);
  assert.equal(silhouetteEdges(p, p.length / 3, 25).lines.length, 24 * 6);
});

test('box corners and straight walls give no candidates', () => {
  const p = prism([[0, 0], [5, 0], [10, 0], [10, 10], [0, 10]]);
  assert.equal(silhouetteEdges(p, p.length / 3, 25).lines.length, 0);
});

test('cone slopes are candidates only when the roof is passed', () => {
  const n = 16, roof = [];
  for (let i = 0; i < n; i++) {
    const [a, b] = [i, i + 1].map((k) => [Math.cos(k * 2 * Math.PI / n), Math.sin(k * 2 * Math.PI / n)]);
    roof.push(a[0], a[1], 0, b[0], b[1], 0, 0, 0, 2);
  }
  const p = new Float32Array(roof);
  assert.equal(silhouetteEdges(p, 0, 25).lines.length, 0);
  const edges = silhouetteEdges(p, 0, 25, n * 3);
  assert.equal(edges.lines.length, n * 6);
  assert.equal(edges.faces.length, n * 12);
});

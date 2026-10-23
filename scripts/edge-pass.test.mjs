import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createServer } from 'vite';
let vite, edgePass, THREE;
before(async () => {
  vite = await createServer({ configFile: false, server: { middlewareMode: true, ws: false, watch: null }, appType: 'custom', logLevel: 'error' });
  ({ edgePass } = await vite.ssrLoadModule('/src/render/edge-pass.ts'));
  THREE = await vite.ssrLoadModule('three');
});
after(async () => { await vite?.close(); });

const reference = (positions, angle) => {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return Array.from(new THREE.EdgesGeometry(g, angle).getAttribute('position').array);
};

/** Неиндексированная сетка: призма над многоугольником с «домиком» сверху, плюс вырожденный и повторный треугольники. */
function mesh() {
  const ring = [[0, 0], [10, 0], [10, 6], [5, 6.0001], [0, 6]];
  const out = [];
  const tri = (a, b, c) => out.push(...a, ...b, ...c);
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i], [x1, y1] = ring[(i + 1) % ring.length];
    tri([x0, y0, 0], [x1, y1, 0], [x1, y1, 3]);
    tri([x0, y0, 0], [x1, y1, 3], [x0, y0, 3]);
  }
  const walls = out.length / 3;
  const apex = [5, 3, 5];
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i], [x1, y1] = ring[(i + 1) % ring.length];
    tri([x0, y0, 3], [x1, y1, 3], apex);
  }
  tri([1, 1, 3], [1, 1, 3], [2, 2, 3]); // вырожденный
  tri([0, 0, 3], [10, 0, 3], apex); // повтор стороны в том же направлении
  return { positions: new Float32Array(out), walls };
}

test('edgePass совпадает с EdgesGeometry для всей сетки, начала и разных углов', () => {
  const { positions, walls } = mesh();
  const angles = [1, 6, 25, 89];
  const r = edgePass(positions, angles, walls);
  angles.forEach((a, i) => {
    assert.deepEqual(Array.from(r.full[i]), reference(positions, a), `вся сетка, ${a}°`);
    assert.deepEqual(Array.from(r.prefix[i]), reference(positions.subarray(0, walls * 3), a), `стены, ${a}°`);
  });
});

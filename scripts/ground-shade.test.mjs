import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createServer } from 'vite';
let v, m;
before(async () => { v = await createServer({ configFile: false, server: { middlewareMode: true, ws: false, watch: null }, appType: 'custom' }); m = await v.ssrLoadModule('/src/render/ground-shade.ts'); });
after(async () => { await v.close(); });

// Куб 10×10×10: стены — треугольники с z 0 и 10
function box(h) {
  const ring = [[0, 0], [10, 0], [10, 10], [0, 10]], p = [];
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = ring[i], [bx, by] = ring[(i + 1) % 4];
    p.push(ax, ay, 0, bx, by, 0, bx, by, h, ax, ay, 0, bx, by, h, ax, ay, h);
  }
  return { positions: new Float32Array(p), vertices: p.length / 3, rings: () => [[...ring, ring[0]]] };
}

test('shadow is cast away from the sun and lies on the ground', () => {
  const geo = m.buildShade([{ ...box(10), rings: undefined }]);
  const pos = geo.getAttribute('position');
  let maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    assert.equal(pos.getZ(i), -1); // z — расстояние от стены; у тени −1
    maxX = Math.max(maxX, pos.getX(i)); maxY = Math.max(maxY, pos.getY(i));
  }
  // Солнце на юго-западе — тень на северо-восток, длина h · горизонталь/вертикаль
  assert.ok(Math.abs(maxX - (10 - m.SUN.x / m.SUN.z * 10)) < 1e-4);
  assert.ok(Math.abs(maxY - (10 - m.SUN.y / m.SUN.z * 10)) < 1e-4);
});

test('ground occlusion bands reach AO_RADIUS from the footprint, only for grounded buildings', () => {
  const geo = m.buildShade([box(10)]);
  const pos = geo.getAttribute('position');
  let minX = Infinity, bands = 0;
  for (let i = 0; i < pos.count; i++) if (pos.getZ(i) >= 0) { bands++; minX = Math.min(minX, pos.getX(i)); }
  assert.ok(bands > 0);
  assert.ok(Math.abs(minX + m.AO_RADIUS) < 1e-4);
  assert.equal(m.buildShade([]), undefined);
});

test('only enabled parts are built, and a building is built once per options', () => {
  const b = box(10);
  const shadowOnly = m.shadePart(b, { shadow: true, ao: false });
  for (let i = 2; i < shadowOnly.length; i += 3) assert.equal(shadowOnly[i], -1);
  const aoOnly = m.shadePart(b, { shadow: false, ao: true });
  for (let i = 2; i < aoOnly.length; i += 3) assert.ok(aoOnly[i] >= 0);
  assert.equal(m.shadePart(b, { shadow: false, ao: true }), aoOnly);
  assert.equal(m.buildShade([b], { shadow: false, ao: false }), undefined);
});

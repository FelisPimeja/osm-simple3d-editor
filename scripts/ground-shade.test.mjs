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
  const pos = geo.getAttribute('position'), d = geo.getAttribute('d');
  let maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    assert.equal(pos.getZ(i), 0);
    assert.equal(d.getX(i), -1);
    maxX = Math.max(maxX, pos.getX(i)); maxY = Math.max(maxY, pos.getY(i));
  }
  // Солнце на юго-западе — тень на северо-восток, длина h · горизонталь/вертикаль
  assert.ok(Math.abs(maxX - (10 - m.SUN.x / m.SUN.z * 10)) < 1e-4);
  assert.ok(Math.abs(maxY - (10 - m.SUN.y / m.SUN.z * 10)) < 1e-4);
});

test('ground occlusion bands reach AO_RADIUS from the footprint, only for grounded buildings', () => {
  const geo = m.buildShade([box(10)]);
  const pos = geo.getAttribute('position'), d = geo.getAttribute('d');
  let minX = Infinity, bands = 0;
  for (let i = 0; i < pos.count; i++) if (d.getX(i) >= 0) { bands++; minX = Math.min(minX, pos.getX(i)); }
  assert.ok(bands > 0);
  assert.ok(Math.abs(minX + m.AO_RADIUS) < 1e-4);
  assert.equal(m.buildShade([]), undefined);
});

test('only enabled parts are built, and a building is built once per options', () => {
  const b = box(10);
  const shadowOnly = m.shadePart(b, { shadow: true, ao: false });
  for (let i = 3; i < shadowOnly.length; i += 4) assert.equal(shadowOnly[i], -1);
  const aoOnly = m.shadePart(b, { shadow: false, ao: true });
  for (let i = 3; i < aoOnly.length; i += 4) assert.ok(aoOnly[i] >= 0);
  assert.equal(m.shadePart(b, { shadow: false, ao: true }), aoOnly);
  assert.equal(m.buildShade([b], { shadow: false, ao: false }), undefined);
});

test('on terrain the shadow lies on the ground: longer downhill', () => {
  const slope = (x, y) => -0.2 * x - 0.4 * y; // вниз к северо-востоку
  const reach = (src) => {
    const part = m.shadePart(src, { shadow: true, ao: false });
    let far = -Infinity;
    for (let i = 0; i < part.length; i += 4) {
      far = Math.max(far, part[i + 1]);
      assert.ok(Math.abs(part[i + 2] - (src.height ? src.height(part[i], part[i + 1]) : 0)) < 1e-3);
    }
    return far;
  };
  const flat = reach({ ...box(10), rings: undefined });
  const down = reach({ ...box(10), rings: undefined, height: slope, ground: 1 });
  assert.ok(down > flat + 1, `${down} > ${flat}`);
});

test('underground vertices are lifted onto the ground, not left below it', () => {
  const b = box(10);
  for (let i = 2; i < b.positions.length; i += 3) if (b.positions[i] === 0) b.positions[i] = -3; // подвал 3 м
  const part = m.shadePart({ ...b, rings: undefined }, { shadow: true, ao: false });
  for (let i = 0; i < part.length; i += 4) assert.equal(part[i + 2], 0);
  // Засыпанное склоном здание: земля выше крыши — тени нет
  assert.equal(m.shadePart({ ...box(10), rings: undefined, height: () => 20, ground: 2 }, { shadow: true, ao: false }).length, 0);
  // Склон до середины стен: тень только от того, что над землёй, и вся — на земле
  const half = (x) => 5 - 0.5 * x;
  const sloped = m.shadePart({ ...box(10), rings: undefined, height: half, ground: 3 }, { shadow: true, ao: false });
  assert.ok(sloped.length > 0);
  for (let i = 0; i < sloped.length; i += 4) assert.ok(Math.abs(sloped[i + 2] - half(sloped[i])) < 1e-3);
});

test('a roof half buried by a slope casts a shadow only from its part above the ground', () => {
  // Склон 5 м → 0 м с запада на восток; крыша на 3 м над землёй только при x > 4
  const slope = (x) => 5 - 0.5 * x;
  const part = m.shadePart({ ...box(3), rings: undefined, height: slope, ground: 4 }, { shadow: true, ao: false });
  assert.ok(part.length > 0);
  for (let i = 0; i < part.length; i += 4) {
    assert.ok(part[i] >= 4 - 1e-3, `shadow at x=${part[i]} — over the buried part`);
    assert.ok(Math.abs(part[i + 2] - slope(part[i])) < 1e-3);
  }
});

test('clipped shadow vertices stay next to the building', () => {
  // Склон по y: точки пересечения рёбер с землёй должны лежать на рёбрах, а не улетать
  const slope = (x, y) => 5 - 0.5 * y;
  const part = m.shadePart({ ...box(3), rings: undefined, height: slope, ground: 5 }, { shadow: true, ao: false });
  for (let i = 0; i < part.length; i += 4) assert.ok(part[i] > -1 && part[i] < 15 && part[i + 1] > -1 && part[i + 1] < 15, `${part[i]}, ${part[i + 1]}`);
});

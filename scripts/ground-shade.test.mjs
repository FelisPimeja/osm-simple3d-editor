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
  return { positions: new Float32Array(p), vertices: p.length / 3 };
}

test('shadow is cast away from the sun and lies on the ground', () => {
  const geo = m.buildShade([box(10)]);
  const pos = geo.getAttribute('position'), d = geo.getAttribute('d');
  let maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    assert.equal(pos.getZ(i), 0);
    assert.ok(d.getX(i) <= -1);
    maxX = Math.max(maxX, pos.getX(i)); maxY = Math.max(maxY, pos.getY(i));
  }
  // Солнце на юго-западе — тень на северо-восток, длина h · горизонталь/вертикаль
  assert.ok(Math.abs(maxX - (10 - m.SUN.x / m.SUN.z * 10)) < 1e-4);
  assert.ok(Math.abs(maxY - (10 - m.SUN.y / m.SUN.z * 10)) < 1e-4);
});

test('a building is built once until its ground changes', () => {
  const b = box(10);
  const part = m.shadePart(b);
  for (let i = 3; i < part.length; i += 4) assert.ok(part[i] <= -1);
  assert.equal(m.shadePart(b), part);
  assert.equal(m.buildShade([]), undefined);
});

test('on terrain the shadow lies on the ground: longer downhill', () => {
  const slope = (x, y) => -0.2 * x - 0.4 * y; // вниз к северо-востоку
  const reach = (src) => {
    const part = m.shadePart(src);
    let far = -Infinity;
    for (let i = 0; i < part.length; i += 4) {
      far = Math.max(far, part[i + 1]);
      assert.ok(Math.abs(part[i + 2] - (src.height ? src.height(part[i], part[i + 1]) : 0)) < 1e-3);
    }
    return far;
  };
  const flat = reach(box(10));
  const down = reach({ ...box(10), height: slope, ground: 1 });
  assert.ok(down > flat + 1, `${down} > ${flat}`);
});

test('underground vertices are lifted onto the ground, not left below it', () => {
  const b = box(10);
  for (let i = 2; i < b.positions.length; i += 3) if (b.positions[i] === 0) b.positions[i] = -3; // подвал 3 м
  const part = m.shadePart(b);
  for (let i = 0; i < part.length; i += 4) assert.equal(part[i + 2], 0);
  // Засыпанное склоном здание: земля выше крыши — тени нет
  assert.equal(m.shadePart({ ...box(10), height: () => 20, ground: 2 }).length, 0);
  // Склон до середины стен: тень только от того, что над землёй, и вся — на земле
  const half = (x) => 5 - 0.5 * x;
  const sloped = m.shadePart({ ...box(10), height: half, ground: 3 });
  assert.ok(sloped.length > 0);
  for (let i = 0; i < sloped.length; i += 4) assert.ok(Math.abs(sloped[i + 2] - half(sloped[i])) < 1e-3);
});

test('a roof half buried by a slope casts a shadow only from its part above the ground', () => {
  // Склон 5 м → 0 м с запада на восток; крыша на 3 м над землёй только при x > 4
  const slope = (x) => 5 - 0.5 * x;
  const part = m.shadePart({ ...box(3), height: slope, ground: 4 });
  assert.ok(part.length > 0);
  for (let i = 0; i < part.length; i += 4) {
    assert.ok(part[i] >= 4 - 1e-3, `shadow at x=${part[i]} — over the buried part`);
    assert.ok(Math.abs(part[i + 2] - slope(part[i])) < 1e-3);
  }
});

test('clipped shadow vertices stay next to the building', () => {
  // Склон по y: точки пересечения рёбер с землёй должны лежать на рёбрах, а не улетать
  const slope = (x, y) => 5 - 0.5 * y;
  const part = m.shadePart({ ...box(3), height: slope, ground: 5 });
  for (let i = 0; i < part.length; i += 4) assert.ok(part[i] > -1 && part[i] < 15 && part[i + 1] > -1 && part[i + 1] < 15, `${part[i]}, ${part[i + 1]}`);
});

test('shadow vertices carry their share of the object shadow length for the gradient', () => {
  const part = m.shadePart(box(10));
  let near = 0, far = 0;
  for (let i = 3; i < part.length; i += 4) {
    const dist = -1 - part[i];
    // Доля полной длины тени — от контура куба: у стен 0, дальше — не больше конца тени
    if (Math.abs(dist) < 1e-4) near++; else { assert.ok(dist > 0 && dist <= 1 + 1e-3, `${dist}`); far++; }
  }
  assert.ok(near > 0 && far > 0);
});

test('under a canopy the shadow is solid: the gradient runs from the outline, not from the canopy', () => {
  // Навес 10×10 на высоте 10 (две грани плиты) и колонна в углу: тень под навесом — у самого контура
  const p = [0, 0, 10, 10, 0, 10, 10, 10, 10, 0, 0, 10, 10, 10, 10, 0, 10, 10];
  const part = m.shadePart({ positions: new Float32Array(p), vertices: 6 });
  let under = 0;
  for (let i = 0; i < part.length; i += 4) {
    const x = part[i], y = part[i + 1], dist = -1 - part[i + 3];
    if (x >= 0 && x <= 10 && y >= 0 && y <= 10) { under++; assert.ok(Math.abs(dist) < 1e-4, `${x}, ${y}: ${dist}`); }
  }
  assert.ok(under > 0);
  assert.equal(m.distToHull(m.hull2d(new Float32Array(p), 6), 15, 5), 5);
});

test('glass casts a pale shadow: its vertices are marked for the shader', () => {
  const b = box(10);
  const part = m.shadePart({ ...b, positions: b.positions.slice(), glass: [[0, b.vertices]] });
  for (let i = 3; i < part.length; i += 4) assert.ok(part[i] <= -10 + 1e-6 && part[i] > -12, `${part[i]}`);
  assert.ok(m.GLASS_SHADOW < 0.5);
});

import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createServer } from 'vite';

let vite, m;
before(async () => {
  vite = await createServer({ configFile: false, server: { middlewareMode: true, ws: false, watch: null }, appType: 'custom' });
  m = await vite.ssrLoadModule('/src/edit/stairs-pair.ts');
});
after(async () => { await vite?.close(); });

// Метры → градусы около 55° с. ш.
const kx = Math.cos(55 * Math.PI / 180) * 111320, ky = 111320;
const ll = (x, y) => [37 + x / kx, 55 + y / ky];
const xy = (p) => [(p[0] - 37) * kx, (p[1] - 55) * ky];
const near = (p, x, y) => { const [a, b] = xy(p); assert.ok(Math.hypot(a - x, b - y) < 1e-3, `${a.toFixed(3)},${b.toFixed(3)} != ${x},${y}`); };

const axis = (levels = [0, 1], outer = [ll(0, 1), ll(4, 1)]) => ({ key: 'way/1', kind: 'area', line: true, escalator: true, stairs: true,
  tags: { highway: 'steps', incline: 'up', level: levels.join(';') }, levels, polygons: [{ outer, inners: [], outerIds: [1, 2] }] });
const area = (levels = [0, 1]) => ({ key: 'way/2', kind: 'area', tags: { indoor: 'area', room: 'stairs', level: levels.join(';') }, levels,
  polygons: [{ outer: [ll(0, 0), ll(4, 0), ll(4, 2), ll(0, 2)], inners: [], outerIds: [3, 4, 5, 6] }] });

test('a line and a polygon pair by tags, levels and geometry only', () => {
  const a = axis(), p = area();
  assert.equal(m.pairedArea(a, [a, p])?.key, 'way/2');
  assert.equal(m.pairedAxis(p, [a, p])?.key, 'way/1');
  assert.equal(m.pairedArea(a, [a, area([0, 2])]), undefined, 'other levels');
  const short = axis([0, 1], [ll(1, 1), ll(3, 1)]);
  assert.equal(m.pairedArea(short, [short, p]), undefined, 'ends not on the outline');
});

test('the polygon follows a moved line: shift, rotation, stretch keep the width', () => {
  const ring = area().polygons[0].outer;
  const moved = m.followAxis(ring, [ll(0, 1), ll(4, 1)], [ll(10, 1), ll(14, 1)]);
  near(moved[0], 10, 0); near(moved[2], 14, 2);
  const turned = m.followAxis(ring, [ll(0, 1), ll(4, 1)], [ll(0, 1), ll(0, 5)]);
  near(turned[1], 1, 5); near(turned[3], -1, 1);
  const longer = m.followAxis(ring, [ll(0, 1), ll(4, 1)], [ll(0, 1), ll(8, 1)]);
  near(longer[1], 8, 0); near(longer[2], 8, 2); near(longer[3], 0, 2);
});

test('the line follows a moved polygon: each end stays on its side', () => {
  const from = area().polygons[0].outer;
  const to = [ll(0, 0), ll(6, 0), ll(6, 2), ll(0, 2)];
  const line = m.followArea([ll(0, 1), ll(4, 1)], from, to);
  near(line[0], 0, 1); near(line[1], 6, 1);
});

test('moving line vertices adds the polygon vertices to the operation, and back', () => {
  const a = axis(), p = area(), all = [a, p];
  const delta = [ll(1, 0)[0] - 37, 0];
  const op = m.withStairsPartners({ type: 'move', vertices: [{ key: 'way/1', poly: 0, ring: 0, i: 1 }], delta }, all);
  assert.equal(op.vertices.length, 5);
  near(op.to[0], 5, 1);
  near(op.to[op.vertices.findIndex((v) => v.key === 'way/2' && v.i === 2)], 5, 2);
  const back = m.withStairsPartners({ type: 'move', vertices: [{ key: 'way/2', poly: 0, ring: 0, i: 1 }, { key: 'way/2', poly: 0, ring: 0, i: 2 }], delta }, all);
  near(back.to[back.vertices.findIndex((v) => v.key === 'way/1' && v.i === 1)], 5, 1);
  const alone = { type: 'move', vertices: [{ key: 'way/1', poly: 0, ring: 0, i: 1 }], delta };
  assert.equal(m.withStairsPartners(alone, [a]), alone, 'no pair — the operation is unchanged');
});

test('width across the axis: measured from the polygon and scaled symmetrically', () => {
  const ring = area().polygons[0].outer, line = [ll(0, 1), ll(4, 1)];
  assert.ok(Math.abs(m.pairHalfWidth(ring, line) - 1) < 1e-6);
  const wide = m.scaleAcross(ring, line, 1.5);
  near(wide[0], 0, -0.5); near(wide[2], 4, 2.5);
  assert.ok(Math.abs(m.pairHalfWidth(wide, line) - 1.5) < 1e-6);
});

test('one side moves: scale across the axis, then shift both by half the change', () => {
  const ring = area().polygons[0].outer, line = [ll(0, 1), ll(4, 1)];
  // Ширина 2 → 3, сдвигается только левая сторона (y = 2 → 3): ось уходит на 0,5 влево
  const moved = m.shiftAcross(m.scaleAcross(ring, line, 1.5), line, 0.5);
  near(moved[0], 0, 0); near(moved[2], 4, 3);
  const axis = m.shiftAcross(line, line, 0.5);
  near(axis[0], 0, 1.5); near(axis[1], 4, 1.5);
});

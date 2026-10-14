import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { before, after, test } from 'node:test';
import { createServer } from 'vite';

let vite, trimCoplanarWalls, BuildingsLayer;
before(async () => {
  globalThis.window = {};
  vite = await createServer({ configFile: false, server: { middlewareMode: true, ws: false, watch: null }, appType: 'custom' });
  ({ trimCoplanarWalls } = await vite.ssrLoadModule('/src/render/shell-trim.ts'));
  ({ BuildingsLayer } = await vite.ssrLoadModule('/src/render/buildings-layer.ts'));
});
after(async () => { delete globalThis.window; await vite?.close(); });

function quad(x0, x1, z0, z1, y = 0) {
  return [x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z0, x1, y, z1, x0, y, z1];
}
function area(p) {
  let sum = 0;
  for (let i = 0; i < p.length; i += 9) {
    const ux = p[i + 3] - p[i], uy = p[i + 4] - p[i + 1], uz = p[i + 5] - p[i + 2];
    const vx = p[i + 6] - p[i], vy = p[i + 7] - p[i + 1], vz = p[i + 8] - p[i + 2];
    sum += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
  }
  return sum;
}
function close(actual, expected) { assert.ok(Math.abs(actual - expected) < 1e-4, `${actual} != ${expected}`); }

test('partial opaque wall removes only its shared surface from the glazing', () => {
  close(area(trimCoplanarWalls(quad(0, 10, 0, 3), quad(2, 4, 0, 3))), 24);
});

test('real glass/slab/wall junction clips without leaving a numerical sliver', () => {
  const { pos, walls } = JSON.parse(readFileSync(new URL('./fixtures/glass-slab-junction.json', import.meta.url), 'utf8'));
  const result = trimCoplanarWalls(pos, walls);
  assert.ok(area(result) > 0 && area(result) < area(pos) - 0.1);
  close(area(trimCoplanarWalls(result, walls)), area(result));
});

test('both sides of an indoor wall are subtracted once', () => {
  const wall = quad(2, 4, 0, 3), reverse = [];
  for (let i = 0; i < wall.length; i += 9) reverse.push(...wall.slice(i, i + 3), ...wall.slice(i + 6, i + 9), ...wall.slice(i + 3, i + 6));
  close(area(trimCoplanarWalls(quad(0, 10, 0, 3), [...wall, ...reverse])), 24);
});

test('door opening stays glazed while the jambs and lintel are cut out', () => {
  const walls = [...quad(0, 4, 0, 3), ...quad(6, 10, 0, 3), ...quad(4, 6, 2, 3)];
  const result = trimCoplanarWalls(quad(0, 10, 0, 3), walls);
  close(area(result), 4);
  close(area(trimCoplanarWalls(result, walls)), 4);
});

test('a crossing wall and a separate parallel wall do not erase glazing', () => {
  const crossing = quad(0, 5, 0, 3).map((v, i) => i % 3 === 0 ? 5 : i % 3 === 1 ? quad(0, 5, 0, 3)[i - 1] : v);
  close(area(trimCoplanarWalls(quad(0, 10, 0, 3), crossing)), 30);
  close(area(trimCoplanarWalls(quad(0, 10, 0, 3), quad(0, 10, 0, 3, 0.05))), 30);
  close(area(trimCoplanarWalls(quad(0, 10, 0, 3), quad(0, 10, 0, 3, 0.005))), 0);
});

test('floor slab and glass above or below the selected level remain', () => {
  const floor = [0, 0, 0, 10, 0, 0, 10, 5, 0, 0, 0, 0, 10, 5, 0, 0, 5, 0];
  const result = trimCoplanarWalls([...quad(0, 10, 0, 6), ...floor], quad(0, 10, 2, 3));
  close(area(result), 100); // 50 м² стены + 50 м² плиты.
});

test('triangle winding survives clipping', () => {
  const result = trimCoplanarWalls(quad(0, 10, 0, 3), quad(2, 4, 0, 3));
  for (let i = 0; i < result.length; i += 9) {
    const ux = result[i + 3] - result[i], uz = result[i + 5] - result[i + 2];
    const vx = result[i + 6] - result[i], vz = result[i + 8] - result[i + 2];
    assert.ok(uz * vx - ux * vz < 0);
  }
});

test('switching floor, removing an indoor wall and leaving plan mode restore the glazing', () => {
  const layer = new BuildingsLayer('test');
  const ll = (x, y) => [37 + x / (111320 * Math.cos(55 * Math.PI / 180)), 55 + y / 111320];
  const outer = [ll(0, 0), ll(10, 0), ll(10, 5), ll(0, 5)];
  layer.setFocus([{ key: 'way/1', type: 'way', id: 1, version: 1, kind: 'part', hasParts: false,
    tags: { 'building:part': 'yes', height: '6', material: 'glass' }, polygons: [{ outer, inners: [] }] }]);
  const g = layer.groups.get('@focus'), glass = g.items[0];
  const initial = area(g.glass.geometry.getAttribute('position').array);
  const wall = { key: 'way/2', kind: 'column', z: 0, polygons: [{ outer: [ll(0, 0), ll(10, 0), ll(10, 1), ll(0, 1)], inners: [] }] };
  layer.setLevel({ floor: 0, cut: 3, items: [wall], doors: [] });
  assert.ok(area(g.glass.geometry.getAttribute('position').array) < initial - 20);
  const clipped = area(glass.glassPlanTrim.walls);
  layer.setLevel({ floor: 3, cut: 6, items: [], doors: [] });
  close(area(g.glass.geometry.getAttribute('position').array), initial);
  layer.setLevel({ floor: 0, cut: 3, items: [wall], doors: [] });
  close(area(glass.glassPlanTrim.walls), clipped);
  layer.setLevel({ floor: 0, cut: 3, items: [], doors: [] });
  close(area(g.glass.geometry.getAttribute('position').array), initial);
  layer.setLevel(undefined);
  close(area(g.glass.geometry.getAttribute('position').array), initial);
});

test('walls below a double-height void meet the next floor', () => {
  const layer = new BuildingsLayer('test');
  const ll = (x, y) => [37 + x / (111320 * Math.cos(55 * Math.PI / 180)), 55 + y / 111320];
  const outer = [ll(0, 0), ll(10, 0), ll(10, 5), ll(0, 5)];
  layer.setFocus([{ key: 'way/1', type: 'way', id: 1, version: 1, kind: 'part', hasParts: false,
    tags: { 'building:part': 'yes', height: '9', material: 'glass' }, polygons: [{ outer, inners: [] }] }]);
  const column = (z) => ({ key: `column/${z}`, kind: 'column', z,
    polygons: [{ outer: [ll(0, 0), ll(10, 0), ll(10, 1), ll(0, 1)], inners: [] }] });
  layer.setLevel({ floor: 6, cut: 9, items: [column(6)],
    voids: [[[ll(1, 1), ll(9, 1), ll(9, 4), ll(1, 4)]]],
    below: [{ cut: 3, items: [column(0)] }, { cut: 6, items: [column(3)] }] });
  const heights = new Set(layer.indoorGlassBlockers.filter((_, i) => i % 3 === 2).map((z) => Math.round(z * 1000) / 1000));
  assert.deepEqual([...heights].sort((a, b) => a - b), [0, 3, 6, 8.9]);
  // После вычитания непрозрачных стен в стекле нет полосок на стыках этажей.
  const g = layer.groups.get('@focus'), glass = g.items[0];
  const a = g.toLocal(outer[0]), b = g.toLocal(outer[1]), x = (a[0] + b[0]) / 2;
  const remaining = glass.glassPlanTrim.walls;
  for (const z of [2.95, 5.95]) {
    close(area(remaining) - area(trimCoplanarWalls(remaining, quad(x - 0.2, x + 0.2, z - 0.02, z + 0.02, a[1]))), 0);
  }
});

test('glass roof 17852330 is cut by opaque roof 17852173 in building and floor modes', () => {
  const features = JSON.parse(readFileSync(new URL('./fixtures/glass-roof-parts.json', import.meta.url), 'utf8'));
  const layer = new BuildingsLayer('test');
  layer.setFocus(features);
  const g = layer.groups.get('@focus'), glass = g.byKey.get('relation/17852330');
  const full = area(glass.positions.subarray(0, glass.wallVertices * 3));
  const clipped = () => area(glass.glassTrim.walls);
  assert.ok(clipped() > 0 && clipped() < full - 50);
  layer.setLevel({ floor: 12, cut: 16, items: [] });
  assert.ok(clipped() > 0 && clipped() < full - 50);
  layer.setLevel(undefined);
  assert.ok(clipped() > 0 && clipped() < full - 50);
  g.hidden.add('relation/17852173');
  layer.rebuildGeometry(g);
  close(clipped(), full);
  g.hidden.delete('relation/17852173');
  layer.rebuildGeometry(g);
  assert.ok(clipped() > 0 && clipped() < full - 50);
});

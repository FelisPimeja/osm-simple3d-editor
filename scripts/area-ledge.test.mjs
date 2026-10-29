import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createServer } from 'vite';

let vite, areaLedgeTriangles, BuildingsLayer;
before(async () => {
  globalThis.window = {};
  vite = await createServer({ configFile: false, server: { middlewareMode: true, ws: false, watch: null }, appType: 'custom' });
  ({ areaLedgeTriangles } = await vite.ssrLoadModule('/src/render/area-ledge.ts'));
  ({ BuildingsLayer } = await vite.ssrLoadModule('/src/render/buildings-layer.ts'));
});
after(async () => { delete globalThis.window; await vite?.close(); });
const rectangle = (x0, y0, x1, y1) => ({ outer: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], inners: [] });
const area = rectangle(0, 0, 4, 2), atrium = rectangle(4, 0, 8, 2);
function surface(p) {
  let area = 0;
  for (let i = 0; i < p.length; i += 9) {
    const ux = p[i + 3] - p[i], uy = p[i + 4] - p[i + 1], uz = p[i + 5] - p[i + 2];
    const vx = p[i + 6] - p[i], vy = p[i + 7] - p[i + 1], vz = p[i + 8] - p[i + 2];
    area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
  }
  return area;
}
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-4, `${a} != ${b}`);

test('an area over a void closes all its free edges without duplicating the top', () => {
  const p = areaLedgeTriangles(area, [atrium], 3);
  close(surface(p), 8 + 12 * 0.3);
  const zs = p.filter((_, i) => i % 3 === 2);
  close(Math.min(...zs), 2.7);
  close(Math.max(...zs), 3);
  for (let i = 0; i < p.length; i += 9) assert.ok(![2, 5, 8].every((k) => p[i + k] === 3));
});

test('a covered edge or a floor without a void stays flat', () => {
  assert.deepEqual(areaLedgeTriangles(area, [atrium], 3, () => []), []);
  assert.deepEqual(areaLedgeTriangles(area, [], 3), []);
  assert.deepEqual(areaLedgeTriangles(area, [rectangle(5, 0, 8, 2)], 3), []);
});

test('a partial void still closes the full board; walls limit the fascia to free intervals', () => {
  close(surface(areaLedgeTriangles(area, [rectangle(4, 0.5, 8, 1.5)], 3)), 11.6);
  close(surface(areaLedgeTriangles(area, [atrium], 3, (a, b) => a[0] === 4 && b[0] === 4 ? [[0.5, 1]] : [])), 8.3);
});

test('hole boundaries have thickness and the underside preserves the opening', () => {
  const p = { ...rectangle(0, 0, 10, 10), inners: [rectangle(4, 4, 6, 6).outer] };
  close(surface(areaLedgeTriangles(p, [rectangle(4, 4, 6, 6)], 3)), 96 + 48 * 0.3);
});

test('clockwise and counterclockwise areas produce the same ledge', () => {
  close(surface(areaLedgeTriangles({ outer: area.outer.slice().reverse(), inners: [] }, [atrium], 3)), 11.6);
});

function fixture() {
  const layer = new BuildingsLayer('test');
  const ll = (x, y) => [37 + x / (111320 * Math.cos(55 * Math.PI / 180)), 55 + y / 111320];
  const poly = (p) => ({ outer: p.outer.map(([x, y]) => ll(x, y)), inners: [] });
  layer.setFocus([{ key: 'way/1', type: 'way', id: 1, version: 1, kind: 'part', hasParts: false,
    tags: { 'building:part': 'yes', height: '9' }, polygons: [poly(rectangle(0, 0, 10, 10))] }]);
  const area = { key: 'way/2', kind: 'area', areaLedge: true, z: 3, polygons: [poly(rectangle(2, 2, 6, 6))] };
  const voids = [[poly(rectangle(6, 2, 8, 6)).outer]];
  const walls = [{ key: 'way/3', kind: 'wall', line: true, z: 3, polygons: [{ outer: [ll(6, 2), ll(6, 6)], inners: [] }] }];
  const ledges = () => layer.indoorObj.children.filter((o) => o.name === 'indoor-area-underside');
  return { layer, area, voids, walls, ledges, poly };
}

test('renderer adds thickness only to explicit indoor=area, and walls prevent it', () => {
  const { layer, area, voids, walls, ledges } = fixture();
  layer.setLevel({ floor: 3, cut: 6, items: [area], voids });
  assert.equal(ledges().length, 1);
  const p = ledges()[0].geometry.getAttribute('position').array;
  const zs = p.filter((_, i) => i % 3 === 2);
  close(Math.min(...zs), 2.7);
  close(Math.max(...zs), 3);
  layer.setLevel({ floor: 3, cut: 6, items: [area, ...walls], voids });
  assert.equal(ledges().length, 0);
  layer.setLevel({ floor: 3, cut: 6, items: [{ ...area, areaLedge: false }], voids });
  assert.equal(ledges().length, 0);
  layer.setLevel({ floor: 3, cut: 6, items: [{ ...area, kind: 'corridor' }], voids });
  assert.equal(ledges().length, 0);
  layer.setLevel({ floor: 3, cut: 6, items: [area] });
  assert.equal(ledges().length, 0);
});

test('room boundaries and solid walls prevent thickness, including a doorway', () => {
  const { layer, area, voids, walls, ledges, poly } = fixture();
  const room = { key: 'way/4', kind: 'room', z: 3, polygons: [poly(rectangle(6, 2, 8, 6))] };
  layer.setLevel({ floor: 3, cut: 6, items: [area, room], voids });
  assert.equal(ledges().length, 0);
  const solid = { key: 'way/5', kind: 'column', z: 3, polygons: [poly(rectangle(6, 2, 6.5, 6))] };
  layer.setLevel({ floor: 3, cut: 6, items: [area, solid], voids });
  assert.equal(ledges().length, 0);
  const line = walls[0].polygons[0].outer;
  const door = [(line[0][0] + line[1][0]) / 2, (line[0][1] + line[1][1]) / 2];
  layer.setLevel({ floor: 3, cut: 6, items: [area, ...walls], doors: [door], voids });
  assert.equal(ledges().length, 0);
});

test('a part on a higher floor does not mask the free edge of the lower area', () => {
  const { layer, area, voids, ledges, poly } = fixture();
  const base = layer.groups.get('@focus').items[0].feature;
  layer.setFocus([base, { key: 'way/upper', type: 'way', id: 99, version: 1, kind: 'part', hasParts: false,
    tags: { 'building:part': 'yes', min_height: '6', height: '9' }, polygons: [poly(rectangle(2, 2, 6, 6))] }]);
  layer.setLevel({ floor: 3, cut: 6, items: [area], voids });
  assert.equal(ledges().length, 1);
  assert.ok(surface(ledges()[0].geometry.getAttribute('position').array) > 20);
});

test('the lowest visible area gets thickness even without a separate void on its floor', () => {
  const { layer, area, voids, ledges } = fixture();
  const plan = { floor: 6, cut: 9, items: [], voids, below: [{ cut: 6, items: [area] }] };
  layer.setLevel({ ...plan, voidCuts: [{ polygon: voids, zs: [3, 6] }] });
  assert.equal(ledges().length, 1);
  layer.setLevel({ ...plan, voidCuts: [{ polygon: voids, zs: [6] }] });
  assert.equal(ledges().length, 1);
});

test('a neighboring floor under the upper void prevents a false ledge on the lower area', () => {
  const { layer, area, voids, ledges, poly } = fixture();
  const neighbor = { key: 'way/99', kind: 'area', areaLedge: false, z: 3, polygons: [poly(rectangle(6, 2, 8, 6))] };
  layer.setLevel({ floor: 6, cut: 9, items: [], voids,
    below: [{ cut: 6, items: [area, neighbor], voids: [] }] });
  assert.equal(ledges().length, 0);
});

test('a neighboring floor closes only the part of a free edge that it touches', () => {
  close(surface(areaLedgeTriangles(area, [atrium], 3, undefined, [rectangle(4, 0, 8, 1)])), 11.3);
});

test('several lower levels use their own voids even when the upper opening has a different shape', () => {
  const { layer, area, voids, ledges, poly } = fixture();
  const upperVoid = [[poly(rectangle(1, 7, 9, 9)).outer]];
  const middle = { ...area, key: 'way/20', z: 6 };
  const lower = { ...area, key: 'way/21', z: 0 };
  const below = [
    { cut: 9, items: [middle], voids },
    { cut: 6, items: [area], voids },
    { cut: 3, items: [lower], voids: [] },
  ];
  layer.setLevel({ floor: 9, cut: 12, items: [], voids: upperVoid,
    voidCuts: [{ polygon: upperVoid, zs: [9] }], below });
  assert.deepEqual(ledges().map((o) => o.userData.key).sort(), ['way/2', 'way/20']);
  for (const mesh of ledges()) {
    const z = mesh.geometry.getAttribute('position').array.filter((_, i) => i % 3 === 2);
    close(Math.max(...z) - Math.min(...z), 0.3);
  }
});

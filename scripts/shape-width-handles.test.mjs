import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createServer } from 'vite';

let vite, ShapeTool, THREE;
before(async () => {
  globalThis.localStorage = { getItem: () => 'en', setItem() {} };
  globalThis.document = { documentElement: {}, createElement: () => ({ addEventListener() {} }) };
  vite = await createServer({ configFile: false, server: { middlewareMode: true, ws: false, watch: null }, appType: 'custom' });
  ({ ShapeTool } = await vite.ssrLoadModule('/src/edit/shape-tool.ts'));
  THREE = await import('three');
});
after(async () => { await vite.close(); delete globalThis.document; delete globalThis.localStorage; });

// Экран — план сверху, 20 px на метр; ось марша (0,0)→(4,0), ширина 2 м: ручки в (2,-1) и (2,1)
const PX = 20;
function setup({ snap } = {}) {
  const handles = [], previews = [], commits = [];
  const layer = {
    focusRay: (p) => new THREE.Ray(new THREE.Vector3(p[0] / PX, p[1] / PX, 10), new THREE.Vector3(0, 0, -1)),
    focusProject: (p) => [p.x * PX, p.y * PX],
    focusPolygons: () => undefined, focusRoofTop: () => [], snapAt: () => snap?.(),
    setHandles: (...a) => handles.push(a), setMoveGuide() {},
  };
  const tool = new ShapeTool(layer, { appendChild() {} }, () => ['way/1'], () => undefined, () => new Set(),
    (t, offset) => { previews.push(offset?.clone()); return undefined; }, (t, offset) => { commits.push({ t: { ...t }, offset: offset.clone() }); return true; }, () => {}, () => {});
  tool.widthHandles = (key) => key === 'way/1' ? { a: new THREE.Vector3(2, -1, 0), b: new THREE.Vector3(2, 1, 0), dir: new THREE.Vector3(0, 1, 0), width: 2, own: ['way/1', 'way/2'] } : undefined;
  tool.start();
  return { tool, handles, previews, commits };
}
const key = (k) => ({ type: 'keydown', key: k, repeat: false, preventDefault() {} });
const keyUp = (k) => ({ type: 'keyup', key: k, repeat: false, preventDefault() {} });
const type = (tool, s) => { for (const c of s) tool.key(key(c)); tool.key(key('Enter')); };

test('width handles are drawn with the roof handles and taken by a click', () => {
  const { tool, handles } = setup();
  const roof = handles.at(-1)[2];
  assert.equal(roof.points.length, 2);
  assert.deepEqual(roof.points.map((p) => [p.x, p.y]), [[2, -1], [2, 1]]);
  assert.equal(tool.click([40, 20]), true);
  assert.equal(tool.state, 'drag');
});

test('a dragged handle moves only across the axis and both sides spread symmetrically', () => {
  const { tool, handles, commits } = setup();
  tool.click([40, 20]);
  tool.move([100, 40]); // курсор и вдоль оси (x = 5), и поперёк (y = 2)
  const pts = handles.at(-1)[2].points.map((p) => [p.x, p.y]);
  assert.deepEqual(pts, [[2, -2], [2, 2]]);
  tool.click([100, 40]);
  assert.equal(commits.length, 1);
  assert.equal(commits[0].t.width, 1);
  assert.deepEqual([commits[0].offset.x, commits[0].offset.y], [0, 1]);
  assert.equal(tool.state, 'pick');
});

test('a typed number is the new flight width', () => {
  const { tool, commits } = setup();
  tool.click([40, 20]);
  type(tool, '3');
  assert.ok(Math.abs(commits[0].offset.y - 0.5) < 1e-9, 'symmetric: each side by half');
  const other = setup();
  other.tool.click([40, -20]); // ручка со стороны -1
  type(other.tool, '1');
  assert.ok(Math.abs(other.commits[0].offset.y - 0.5) < 1e-9, 'narrower from the -1 side: the handle moves towards +y');
});

test('Alt moves one side only: the other handle stays, a typed width moves that side by the whole change', () => {
  const { tool, handles, commits } = setup();
  tool.click([40, 20]);
  tool.move([40, 40]);
  tool.key(key('Alt'));
  assert.deepEqual(handles.at(-1)[2].points.map((p) => [p.x, p.y]), [[2, -1], [2, 2]]);
  tool.key(keyUp('Alt'));
  assert.deepEqual(handles.at(-1)[2].points.map((p) => [p.x, p.y]), [[2, -2], [2, 2]]);
  tool.key(key('Alt'));
  type(tool, '3');
  assert.equal(commits[0].t.oneSide, true);
  assert.ok(Math.abs(commits[0].offset.y - 1) < 1e-9);
});

test('a snap point sets the side by its projection across the axis', () => {
  let skip;
  const { tool, commits } = setup({ snap: () => ({ local: new THREE.Vector3(9, 1.5, 0), point: new THREE.Vector3(), kind: 'vertex' }) });
  tool.layer.snapAt = (p, filter) => { skip = filter; return { local: new THREE.Vector3(9, 1.5, 0), point: new THREE.Vector3(), kind: 'vertex' }; };
  tool.click([40, 20]);
  tool.move([180, 30]);
  tool.click([180, 30]);
  assert.deepEqual([commits[0].offset.x, commits[0].offset.y], [0, 0.5]);
  assert.equal(skip('way/2'), false, 'the paired polygon is not a snap target');
  assert.equal(skip('way/7'), true);
});

test('the flight does not get narrower than 0.3 m, and Delete leaves the handle alone', () => {
  const { tool, commits } = setup();
  tool.click([40, 20]);
  tool.move([40, -200]);
  tool.key(key('Delete'));
  assert.equal(tool.state, 'drag');
  tool.click([40, -200]);
  assert.ok(Math.abs(commits[0].offset.y + 0.85) < 1e-9, `${commits[0].offset.y}`);
});

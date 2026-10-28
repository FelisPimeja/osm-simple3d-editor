import assert from 'node:assert/strict';
import { test } from 'node:test';
import { materializeRoomWalls, remainingRoomWalls, roomTouchesWall, roomWallSpan, wallOverlap } from '../src/edit/indoor-walls.ts';

const point = (x, y) => [x / 111320, y / 111320];
const polygon = (points) => ({ outer: points.map(([x, y]) => point(x, y)), inners: [] });
const square = polygon([[0, 0], [10, 0], [10, 10], [0, 10]]);
const span = [point(0, 0), point(10, 0)];
function nodesFor(polygons) {
  const nodes = new Map(polygons.flatMap((p) => [p.outer, ...p.inners]).flat().map((p, i) => [p.map((v) => v.toFixed(9)).join(','), i + 1]));
  let next = -1;
  return (p) => {
    const key = p.map((v) => v.toFixed(9)).join(',');
    if (!nodes.has(key)) nodes.set(key, next--);
    return nodes.get(key);
  };
}

test('straight side includes intermediate nodes, including across the ring closure', () => {
  const p = polygon([[5, 0], [10, 0], [10, 10], [0, 10], [0, 0]]);
  for (const edge of [0, 4]) assert.deepEqual(roomWallSpan([p], { polygon: 0, ring: 0, edge }), span);
});

test('removing a side keeps the other three sides in one open way with existing nodes', () => {
  const nodeAt = nodesFor([square]);
  const lines = remainingRoomWalls([square], [span], nodeAt);
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0].coords, [square.outer[1], square.outer[2], square.outer[3], square.outer[0]]);
  assert.ok(lines[0].ids.every((id) => id > 0));
});

test('shared wall is detected in reverse and with intermediate vertices', () => {
  const neighbor = polygon([[0, 0], [0, -10], [10, -10], [10, 0], [5, 0]]);
  assert.ok(roomTouchesWall([neighbor], [span]));
  const lines = remainingRoomWalls([neighbor], [span], nodesFor([neighbor]));
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0].coords, neighbor.outer.slice(0, 4));
});

test('partial shared side retains both tails and reuses the selected wall endpoints', () => {
  const long = polygon([[-5, 0], [15, 0], [15, 10], [-5, 10]]);
  const lines = remainingRoomWalls([long], [span], nodesFor([long, square]));
  assert.equal(lines.length, 1);
  assert.ok(Math.abs(lines[0].coords[0][0] - span[1][0]) < 1e-12);
  assert.ok(Math.abs(lines[0].coords.at(-1)[0] - span[0][0]) < 1e-12);
  assert.ok(lines[0].ids.every((id) => id > 0));
});

test('multiple removed sides and whole perimeter leave no phantom closing edge', () => {
  const spans = square.outer.map((a, i) => [a, square.outer[(i + 1) % 4]]);
  assert.equal(remainingRoomWalls([square], spans, nodesFor([square])).length, 0);
  const rest = remainingRoomWalls([square], [spans[0], spans[2]], nodesFor([square]));
  assert.equal(rest.length, 2);
  assert.ok(rest.every((line) => line.ids.length === 2));
});

test('parallel separate walls and corner touches are not shared', () => {
  assert.equal(wallOverlap(point(0, 1), point(10, 1), span), undefined);
  assert.equal(wallOverlap(point(10, 0), point(20, 0), span), undefined);
});

test('holes survive when removing an outside wall', () => {
  const p = { ...square, inners: [polygon([[2, 2], [4, 2], [4, 4], [2, 4]]).outer] };
  const lines = remainingRoomWalls([p], [span], nodesFor([p]));
  assert.equal(lines.length, 2);
  assert.equal(lines[1].ids[0], lines[1].ids.at(-1));
});

test('neighbor keeps its shared wall on additional levels', () => {
  const ways = materializeRoomWalls([square], { indoor: 'room', level: '0', repeat_on: '1', name: 'Room' }, [0, 1], [{ span, levels: [0] }], nodesFor([square]));
  assert.equal(ways.length, 3);
  const upper = ways.filter((w) => w.tags.level === '1');
  assert.equal(upper.reduce((n, w) => n + w.line.ids.length - 1, 0), 4);
  assert.ok(upper.every((w) => w.line.ids[0] !== w.line.ids.at(-1)));
  assert.ok(upper.every((w) => w.tags.name === undefined && w.tags.repeat_on === undefined));
  assert.notEqual(ways.find((w) => w.tags.level === '0').line.ids[0], ways.find((w) => w.tags.level === '0').line.ids.at(-1));
});

test('removing on all repeated levels preserves level and repeat_on tags on surviving walls', () => {
  const ways = materializeRoomWalls([square], { indoor: 'room', level: '0', repeat_on: '1;2' }, [0, 1, 2], [{ span, levels: [0, 1, 2] }], nodesFor([square]));
  assert.equal(ways.length, 1);
  assert.deepEqual(ways[0].tags, { indoor: 'wall', level: '0', repeat_on: '1;2' });
});

test('conversion, new wall and removal are one undo/redo step; new wall remaps after saving', async () => {
  const { createServer } = await import('vite');
  const vite = await createServer({ configFile: false, server: { middlewareMode: true, watch: null, ws: false }, appType: 'custom' });
  try {
    const { EditSession } = await vite.ssrLoadModule('/src/edit/session.ts');
    const room = { key: 'way/1', version: 1, tags: { indoor: 'room', level: '0', name: 'Room' }, polygons: [square] };
    const oldWall = { key: 'way/2', version: 1, tags: { indoor: 'wall', level: '0' } };
    const session = new EditSession([room, oldWall], () => {});
    const line = remainingRoomWalls([square], [span], nodesFor([square]))[0];
    session.editMany([
      { key: room.key, tags: { ...room.tags, indoor: 'area' } },
      { key: oldWall.key, delete: true },
      { key: 'way/-1', create: { key: 'way/-1', version: 0, tags: { indoor: 'wall', level: '0' }, line } },
    ]);
    assert.equal(session.changes().length, 3);
    assert.deepEqual(session.changes().find((c) => c.key === 'way/-1').wayNodes.after, line.ids);
    session.undo();
    assert.equal(room.tags.indoor, 'room');
    assert.equal(room.tags.name, 'Room');
    assert.ok(session.get(oldWall.key));
    assert.equal(session.get('way/-1'), undefined);
    // Проверяем выбор реальных граней без WebGL: виртуальные стороны помещений сами по себе не выбираются.
    globalThis.window = {};
    const { BuildingsLayer } = await vite.ssrLoadModule('/src/render/buildings-layer.ts');
    const THREE = await import('three');
    const layer = new BuildingsLayer('test');
    layer.groups.set('@focus', { toLocal: (p) => p });
    layer.level = { floor: 0, cut: 3, items: [{ key: 'way/1', kind: 'room', z: 0,
      polygons: [{ outer: [[0, 0], [10, 0], [10, 10], [0, 10]], inners: [] }] }] };
    layer.focusRay = () => new THREE.Ray(new THREE.Vector3(5, -5, 1), new THREE.Vector3(0, 1, 0));
    assert.equal(layer.pickIndoorSolid([0, 0], true), undefined);
    layer.indoorWallPositions = [0, 0, 0, 10, 0, 0, 10, 0, 3, 0, 0, 0, 10, 0, 3, 0, 0, 3];
    assert.deepEqual(layer.pickIndoorSolid([0, 0], true).side, { polygon: 0, ring: 0, edge: 0 });
    layer.level.items.push({ key: 'way/2', kind: 'wall', line: true, z: 0, polygons: [{ outer: [[0, 0], [10, 0]], inners: [] }] });
    assert.equal(layer.pickIndoorSolid([0, 0], true).key, 'way/2');
    assert.equal(session.changes().length, 0);
    session.redo();
    assert.equal(room.tags.indoor, 'area');
    assert.equal(session.get(oldWall.key), undefined);
    assert.ok(session.get('way/-1'));
    session.markSaved(new Map([['way/-1', { newKey: 'way/100', version: 1, tags: { indoor: 'wall', level: '0' } }]]));
    assert.ok(session.get('way/100'));
    assert.equal(session.get('way/-1'), undefined);
  } finally { delete globalThis.window; await vite.close(); }
});

test('removing a relation wall preserves the other boundaries of rooms with holes and multiple polygons', () => {
  const room = { ...square, inners: [polygon([[2,2],[4,2],[4,4],[2,4]]).outer] };
  const island = polygon([[20,0],[24,0],[24,4],[20,4]]);
  const polys = [room,island];
  const result = materializeRoomWalls(polys, { indoor:'room', level:'0' }, [0], [{span,levels:[0]}], nodesFor(polys));
  let length = 0;
  for (const {line} of result) for (let i=1;i<line.coords.length;i++) {
    const a=line.coords[i-1],b=line.coords[i];
    length+=Math.hypot(b[0]-a[0],b[1]-a[1])*111320;
    assert.ok(!(a[1]===0 && b[1]===0 && Math.max(a[0],b[0])<=point(10,0)[0]));
  }
  assert.ok(Math.abs(length-54)<1e-6);
});

test('wall deletion finds doors only on the removed span and matching floor', async () => {
 const {pointOnRemovedWall}=await import('../src/edit/indoor-walls.ts');
 const targets=[{span,levels:[0]}];
 assert.equal(pointOnRemovedWall(point(5,0),[0],targets),true);
 assert.equal(pointOnRemovedWall(point(5,.01),[0],targets),true);
 assert.equal(pointOnRemovedWall(point(5,.1),[0],targets),false);
 assert.equal(pointOnRemovedWall(point(11,0),[0],targets),false);
 assert.equal(pointOnRemovedWall(point(5,0),[1],targets),false);
});

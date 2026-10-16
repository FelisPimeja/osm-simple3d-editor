import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createServer } from 'vite';
let vite, BuildingsLayer;
before(async () => {
  globalThis.window = {};
  vite = await createServer({ configFile: false, server: { middlewareMode: true, ws: false, watch: null }, appType: 'custom' });
  ({ BuildingsLayer } = await vite.ssrLoadModule('/src/render/buildings-layer.ts'));
});
after(async () => { delete globalThis.window; await vite?.close(); });
for (const floor of [-3, -6, -9]) test(`short nearly straight wall segments at ${floor}m have no vertical seams`, () => {
  const layer = new BuildingsLayer('test');
  const ll = ([x, y]) => [37 + x / (111320 * Math.cos(55 * Math.PI / 180)), 55 + y / 111320];
  layer.setFocus([{ key: 'way/1', type: 'way', id: 1, version: 1, kind: 'part', hasParts: false,
    tags: { 'building:part': 'yes', height: '9' }, polygons: [{ outer: [[-1,-1],[2,-1],[2,2],[-1,2]].map(ll), inners: [] }] }]);
  layer.graphics.edges = true;
  // Short segments with roughly 6° turns.
  const points = Array.from({ length: 21 }, (_, i) => [i * .06, i % 2 ? .003 : 0]);
  points.push([1.2, 1]); // A real right angle must remain visible.
  const item = { key: 'way/2', kind: 'wall', line: true, z: floor, polygons: [{ outer: points.map(ll), inners: [] }] };
  for (const pale of [false, true]) {
    layer.setLevel(pale ? { floor: 0, cut: 3, items: [], below: [{ floor, cut: floor + 3, items: [item], voids: [] }], voids: [[[[ -1,-1],[2,-1],[2,2],[-1,2]].map(ll)]] }
      : { floor, cut: floor + 3, items: [item], voids: [] });
    let verticals = 0;
    layer.indoorObj.traverse(o => {
      if (o.type !== 'LineSegments') return;
      const p = o.geometry.getAttribute('position').array;
      for (let i = 0; i < p.length; i += 6) if (Math.abs(p[i]-p[i+3]) < 1e-6 && Math.abs(p[i+1]-p[i+4]) < 1e-6 && Math.abs(p[i+2]-p[i+5]) > .1) verticals++;
    });
    assert.equal(verticals, 3, `pale=${pale}: two endpoints and one right angle`);
  }
});

// A room wall can end midway along a column face after overlapping pieces are removed.
// Its endpoint must not create a seam on the column; exposed ends and door jambs remain.
for (const pale of [false, true]) test(`overlapping coplanar indoor faces have no endpoint seams, pale=${pale}`, async () => {
  const THREE = await import('three');
  const layer = new BuildingsLayer('test');
  layer.graphics.edges = true;
  const column = { key: 'column', kind: 'column', z: 0,
    polygons: [{ outer: [[0, 0], [4, 0], [4, 1], [0, 1]], inners: [] }] };
  const wall = { key: 'wall', kind: 'wall', line: true, z: 0,
    polygons: [{ outer: [[1, 0], [3, 0]], inners: [] }] };
  const g = { toLocal: p => p, items: [], hidden: new Set(), flat: new Set() };
  const verticalXs = (doors, cut = 3) => {
    const root = new THREE.Group();
    layer.level = { floor: 0, cut, items: [column, wall] };
    layer.drawPlan(root, g, [column, wall], doors, cut, pale);
    const xs = [];
    root.traverse(o => {
      if (o.type !== 'LineSegments') return;
      const p = o.geometry.getAttribute('position').array;
      for (let i = 0; i < p.length; i += 6)
        if (Math.abs(p[i] - p[i+3]) < 1e-6 && Math.abs(p[i+1]) < 1e-6 && Math.abs(p[i+1] - p[i+4]) < 1e-6 && Math.abs(p[i+2] - p[i+5]) > .1) xs.push(p[i]);
    });
    return xs.sort((a,b) => a-b);
  };
  assert.deepEqual(verticalXs([]), [0, 4]);
  const jambs = verticalXs([[2, 0]], 2);
  assert.equal(jambs.length, 4);
  assert.ok(jambs.some(x => Math.abs(x - 1.47) < .001));
  assert.ok(jambs.some(x => Math.abs(x - 2.53) < .001));
});

for (const pale of [false, true]) test(`segmented wall jambs stop below the lintel, pale=${pale}`, async () => {
  const THREE = await import('three');
  const layer = new BuildingsLayer('test');
  layer.graphics.edges = true;
  // Like way/1304717283: the door sits between short segments. On the
  // longer neighboring segments it lies beyond DOOR_SNAP from the endpoint.
  const item = { key: 'column', kind: 'column', z: 0, polygons: [{
    outer: [[0, 0], [1.65, 0], [2, 0], [2.35, 0], [4, 0], [4, 1], [0, 1]], inners: [] }] };
  layer.level = { floor: 0, cut: 3, items: [item] };
  const root = new THREE.Group();
  layer.drawPlan(root, { toLocal: p => p, items: [], hidden: new Set(), flat: new Set() }, [item], [[2, 0]], 3, pale);
  const jambs = [];
  root.traverse(o => {
    if (o.type !== 'LineSegments') return;
    const p = o.geometry.getAttribute('position').array;
    for (let i = 0; i < p.length; i += 6) {
      if (p[i] < 1 || p[i] > 3 || Math.abs(p[i+1]) > 1e-6 || Math.abs(p[i] - p[i+3]) > 1e-6 || Math.abs(p[i+2] - p[i+5]) < .1) continue;
      jambs.push([p[i+2], p[i+5]]);
    }
  });
  assert.equal(jambs.length, 2);
  for (const [bottom, top] of jambs) {
    assert.equal(bottom, 0);
    assert.ok(Math.abs(top - 2.2) < 1e-6, `jamb must stop at lintel, got ${top}`);
  }
});

for (const pale of [false, true]) test(`real wall chain around way/1306264218 has only exposed endpoint edges, pale=${pale}`, async () => {
  const { readFileSync } = await import('node:fs');
  const THREE = await import('three');
  const { parseBuildings } = await vite.ssrLoadModule('/src/osm/model.ts');
  const { indoor } = parseBuildings(JSON.parse(readFileSync(new URL('./fixtures/indoor-wall-1306264218.json', import.meta.url))));
  const items = indoor.map(f => ({ ...f, z: 0 }));
  const layer = new BuildingsLayer('test');
  layer.graphics.edges = true;
  layer.level = { floor: 0, cut: 3, items };
  const toLocal = ([x, y]) => [(x - 37.624853) * 111320 * Math.cos(55.832093 * Math.PI / 180), (y - 55.832093) * 111320];
  const root = new THREE.Group();
  layer.drawPlan(root, { toLocal, items: [], hidden: new Set(), flat: new Set() }, items, [], 3, pale);
  let verticals = 0;
  root.traverse(o => {
    if (o.type !== 'LineSegments') return;
    const p = o.geometry.getAttribute('position').array;
    for (let i = 0; i < p.length; i += 6)
      if (Math.abs(p[i]-p[i+3]) < 1e-6 && Math.abs(p[i+1]-p[i+4]) < 1e-6 && Math.abs(p[i+2]-p[i+5]) > .1) verticals++;
  });
  assert.equal(verticals, 2);
  // No original short connector may disappear from the wall surface.
  const wall = [];
  root.traverse(o => { if (o.type === 'Mesh') wall.push(...o.geometry.getAttribute('position').array); });
  for (const it of items) for (const point of it.polygons[0].outer) {
    const [x, y] = toLocal(point);
    assert.ok(wall.some((_, i) => i % 3 === 0 && Math.hypot(wall[i] - x, wall[i+1] - y) < 1e-5));
  }
});

test('floor mode hides building seams even when the facade replaces the indoor wall mesh', () => {
  const ll = ([x,y]) => [37+x/(111320*Math.cos(55*Math.PI/180)),55+y/111320];
  const layer = new BuildingsLayer('test');
  layer.graphics.edges = true;
  const parts = [0,2].map((x,i) => ({ key: `way/${i+1}`, id: i+1, type: 'way', version: 1, kind: 'part', hasParts: false,
    tags: { 'building:part': 'yes', height: '9' }, polygons: [{ outer: [[x,0],[x+2,0],[x+2,1],[x,1]].map(ll), inners: [] }] }));
  layer.setFocus(parts);
  const g = layer.groups.get('@focus');
  const target = g.toLocal(ll([2,0]));
  const atSeam = () => {
    const p = g.edges.geometry.getAttribute('position').array, segments = [];
    for (let i=0;i<p.length;i+=6)
      if (Math.hypot(p[i]-target[0],p[i+1]-target[1])<1e-4 && Math.hypot(p[i+3]-target[0],p[i+4]-target[1])<1e-4 && Math.abs(p[i+2]-p[i+5])>.1) segments.push([Math.min(p[i+2],p[i+5]),Math.max(p[i+2],p[i+5])]);
    return segments;
  };
  const initial = atSeam();
  assert.ok(initial.length > 0);
  layer.setLevel({ floor: 0, cut: 3, items: [{ key: 'indoor', kind: 'wall', line: true, z: 0,
    polygons: [{ outer: [[0,0],[2,0],[4,0]].map(ll), inners: [] }] }] });
  assert.equal(layer.indoorWallPositions.length, 0, 'facade replaces indoor wall geometry');
  assert.ok(atSeam().every(([lo]) => lo >= 2.9 - 1e-5), 'building seam below the floor cut must disappear');
  layer.setLevel(undefined);
  assert.deepEqual(atSeam(), initial);
});

test('building edge occlusion includes the empty doorway, across short wall segments', async () => {
  const THREE = await import('three');
  const { trimIndoorBuildingEdges } = await vite.ssrLoadModule('/src/render/indoor-building-edges.ts');
  const layer = new BuildingsLayer('test');
  layer.graphics.edges = true;
  const item = { key: 'wall', kind: 'wall', line: true, z: 0, polygons: [{ outer: [[0,0],[1.8,0],[2,0],[2.2,0],[4,0]], inners: [] }] };
  layer.level = { floor: 0, cut: 3, items: [item] };
  layer.drawPlan(new THREE.Group(), { toLocal: p=>p, items: [], hidden: new Set(), flat: new Set() }, [item], [[2,0]], 3, false);
  const edges = new Float32Array([1.9,0,0,1.9,0,3,2,0,0,2,0,3,2.1,0,0,2.1,0,3]);
  assert.equal(trimIndoorBuildingEdges(edges, layer.indoorEdgeOccluders).length, 0);
  // The facade edge behind a genuine opening is hidden, but no wall geometry fills the door.
  const walls=layer.indoorWallPositions;
  for(let i=0;i<walls.length;i+=9) {
    const cx=(walls[i]+walls[i+3]+walls[i+6])/3, cz=(walls[i+2]+walls[i+5]+walls[i+8])/3;
    assert.ok(cx<1.8 || cx>2.2 || cz>=2.2-1e-6);
  }
});

test('door move preview reuses models without rebuilding the floor, openings or selection every frame', async () => {
  const THREE = await import('three');
  const layer = new BuildingsLayer('test');
  const ll = ([x,y]) => [37+x/(111320*Math.cos(55*Math.PI/180)),55+y/111320];
  layer.setFocus([{ key:'way/1',type:'way',id:1,version:1,kind:'part',hasParts:false,
    tags:{'building:part':'yes',height:'9'},polygons:[{outer:[[0,0],[10,0],[10,10],[0,10]].map(ll),inners:[]}] }]);
  layer.setLevel({floor:0,cut:3,items:[]});
  layer.setDoors([{key:'node/1',at:ll([1,1]),z:0,tags:{door:'yes'}},{key:'node/2',at:ll([3,1]),z:0,tags:{door:'revolving'}}]);
  layer.setIndoorSelection(['node/1','node/2']);
  const objects=layer.doorObj.children.map(o=>({o,at:o.position.clone()}));
  assert.ok(objects.length>2);
  layer.applyLevel=()=>assert.fail('preview must not rebuild the floor');
  layer.applyDoors=()=>assert.fail('preview must reuse door models');
  let selections=0;
  const outline=new THREE.Group();
  outline.userData.doorKey='node/1';
  layer.indoorSelObj=new THREE.Group();
  layer.indoorSelObj.add(outline);
  layer.applyIndoorSelection=()=>selections++;
  const offset=new THREE.Vector3();
  for(let i=1;i<=100;i++) {
    offset.set(i*.01,i*.02,0);
    layer.setMovePreview(['node/1','node/2'],offset);
  }
  assert.equal(selections,1);
  assert.ok(outline.position.distanceTo(offset)<1e-6);
  for(const {o,at} of objects) assert.ok(o.position.distanceTo(at.clone().add(offset))<1e-6);
  layer.setMovePreview(['node/1','node/2'],undefined);
  for(const {o,at} of objects) assert.ok(o.position.distanceTo(at)<1e-6);
  assert.equal(selections,2);
  assert.equal(outline.position.length(),0);
});

test('solid indoor walls below an atrium do not duplicate the opaque facade', async () => {
  const THREE=await import('three');
  const layer=new BuildingsLayer('test');
  const polygon={outer:[[0,0],[4,0],[4,1],[0,1]],inners:[]};
  const tags={'building:part':'yes',height:'9'};
  const g={toLocal:p=>p,hidden:new Set(),flat:new Set(),items:[{feature:{key:'facade',hasParts:false,polygons:[polygon]},tags,
    box:new THREE.Box3(new THREE.Vector3(0,0,0),new THREE.Vector3(4,1,9)),glassWalls:false}]};
  const item={key:'column',kind:'column',z:0,polygons:[polygon]};
  layer.level={floor:3,cut:6,items:[]};
  const root=new THREE.Group();
  layer.drawPlan(root,g,[item],[],3,true);
  let verticalTriangles=0;
  root.traverse(o=>{
    if(o.type!=='Mesh')return;
    const p=o.geometry.getAttribute('position').array;
    for(let i=0;i<p.length;i+=9)if(Math.max(p[i+2],p[i+5],p[i+8])-Math.min(p[i+2],p[i+5],p[i+8])>.01)verticalTriangles++;
  });
  assert.equal(verticalTriangles,0);
});

// Like node/12083650193: a door in the gap between two thick wall polygons (0.24 m), a corridor on one side only.
// Regression: the corridor wall 0.24 m away (< WALL_MERGE_DIST) used to swallow the far faces of both columns.
function doorBetweenColumns() {
  const columnA = { key: 'a', kind: 'column', z: 0, polygons: [{ outer: [[0, 0], [2, 0], [2, .24], [0, .24]], inners: [] }] };
  const columnB = { key: 'b', kind: 'column', z: 0, polygons: [{ outer: [[2.9, 0], [5, 0], [5, .24], [2.9, .24]], inners: [] }] };
  const corridor = { key: 'c', kind: 'corridor', z: 0, polygons: [{ outer: [[-1, -3], [6, -3], [6, 0], [-1, 0]], inners: [] }] };
  return [corridor, columnA, columnB];
}
async function drawDoorBetweenColumns(pale) {
  const THREE = await import('three');
  const layer = new BuildingsLayer('test');
  layer.graphics.edges = true;
  const items = doorBetweenColumns();
  layer.level = { floor: 0, cut: 3, items };
  const root = new THREE.Group();
  layer.drawPlan(root, { toLocal: p => p, items: [], hidden: new Set(), flat: new Set() }, items, [[2.45, 0]], 3, pale);
  const tris = [], lines = [];
  root.traverse(o => {
    if (o.type === 'Mesh') { const p = o.geometry.getAttribute('position').array; for (let i = 0; i < p.length; i += 9) tris.push(Array.from(p.slice(i, i + 9))); }
    if (o.type === 'LineSegments') { const p = o.geometry.getAttribute('position').array; for (let i = 0; i < p.length; i += 6) lines.push(Array.from(p.slice(i, i + 6))); }
  });
  return { tris, lines };
}
/** Длина отрезка y=Y, x∈[x0,x1], закрытая вертикальными треугольниками на высоте z. */
function covered(tris, Y, x0, x1, z) {
  const spans = [];
  for (const t of tris) {
    const ys = [t[1], t[4], t[7]], zs = [t[2], t[5], t[8]], xs = [t[0], t[3], t[6]];
    if (ys.some(y => Math.abs(y - Y) > 1e-4) || Math.min(...zs) > z || Math.max(...zs) < z || Math.max(...zs) - Math.min(...zs) < .1) continue;
    spans.push([Math.max(x0, Math.min(...xs)), Math.min(x1, Math.max(...xs))]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  let at = x0, total = 0;
  for (const [lo, hi] of spans) { if (hi > at) { total += hi - Math.max(lo, at); at = hi; } }
  return total;
}
for (const pale of [false, true]) test(`thick walls keep both faces next to a room wall closer than the merge distance, pale=${pale}`, async () => {
  const { tris } = await drawDoorBetweenColumns(pale);
  for (const [x0, x1] of [[0, 2], [2.9, 5]]) {
    assert.ok(covered(tris, .24, x0, x1, 1) > (x1 - x0) - .01, `far face ${x0}..${x1} must be drawn`);
    assert.ok(covered(tris, 0, x0, x1, 1) > (x1 - x0) - .01, `near face ${x0}..${x1} must be drawn`);
  }
});
for (const pale of [false, true]) test(`lintel between thick walls is closed and jambs stop below it, pale=${pale}`, async () => {
  const { tris, lines } = await drawDoorBetweenColumns(pale);
  // Back face of the lintel and its underside
  assert.ok(covered(tris, .24, 2, 2.9, 2.6) > .89, 'back face of the lintel');
  const under = tris.filter(t => [t[2], t[5], t[8]].every(z => Math.abs(z - 2.2) < 1e-6) && [t[1], t[4], t[7]].every(y => y > -1e-6 && y < .24 + 1e-6)
    && [t[0], t[3], t[6]].every(x => x > 2 - 1e-6 && x < 2.9 + 1e-6));
  assert.ok(under.length >= 2, 'underside of the lintel');
  // Corners of the gap: verticals only up to the lintel
  for (const [x, y] of [[2, 0], [2, .24], [2.9, 0], [2.9, .24]]) {
    for (const l of lines) {
      if (Math.hypot(l[0] - x, l[1] - y) > .03 || Math.hypot(l[3] - x, l[4] - y) > .03 || Math.abs(l[2] - l[5]) < .1) continue;
      assert.ok(Math.max(l[2], l[5]) < 2.2 + 1e-6, `vertical at ${x},${y} goes above the lintel: ${Math.max(l[2], l[5])}`);
    }
  }
});

// Like node/12083648799: a door on the corridor edge between two columns, but the gap is a 2.9 m wide, 0.87 m deep
// passage of the corridor itself — no lintel may be built across it.
for (const pale of [false, true]) test(`no lintel across a corridor passage between columns, pale=${pale}`, async () => {
  const THREE = await import('three');
  const layer = new BuildingsLayer('test');
  layer.graphics.edges = true;
  const columnA = { key: 'a', kind: 'column', z: 0, polygons: [{ outer: [[-2, 0], [0, 0], [0, .87], [-2, .87]], inners: [] }] };
  const columnB = { key: 'b', kind: 'column', z: 0, polygons: [{ outer: [[2.9, 0], [5, 0], [5, .87], [2.9, .87]], inners: [] }] };
  const corridor = { key: 'c', kind: 'corridor', z: 0, polygons: [{ outer: [[0, 0], [2.9, 0], [2.9, 3], [0, 3]], inners: [] }] };
  const items = [corridor, columnA, columnB];
  layer.level = { floor: 0, cut: 3, items };
  const root = new THREE.Group();
  layer.drawPlan(root, { toLocal: p => p, items: [], hidden: new Set(), flat: new Set() }, items, [[1.45, 0]], 3, pale);
  root.traverse(o => {
    if (o.type !== 'Mesh') return;
    const p = o.geometry.getAttribute('position').array;
    for (let i = 0; i < p.length; i += 9) {
      const xs = [p[i], p[i+3], p[i+6]], ys = [p[i+1], p[i+4], p[i+7]], zs = [p[i+2], p[i+5], p[i+8]];
      const cx = (xs[0] + xs[1] + xs[2]) / 3, cy = (ys[0] + ys[1] + ys[2]) / 3;
      // Над проходом (между колоннами, выше пола) ничего нет: ни перемычки, ни стены поперёк
      assert.ok(!(cx > .01 && cx < 2.89 && cy > -1e-4 && cy < .87 + 1e-4 && Math.max(...zs) > .1), `geometry across the passage at ${cx.toFixed(2)},${cy.toFixed(2)}`);
    }
  });
});

// Like node/12080113721: a door on an edge shared by two rooms. Each room walks the edge in its own direction;
// the opening must be recorded once, or the highlight drops its jambs as internal joints.
test('door between two rooms keeps both jambs in the selection outline', async () => {
  const THREE = await import('three');
  const layer = new BuildingsLayer('test');
  layer.graphics.edges = true;
  const roomA = { key: 'a', kind: 'room', z: 0, polygons: [{ outer: [[0, 0], [4, 0], [4, 3], [0, 3]], inners: [] }] };
  const roomB = { key: 'b', kind: 'room', z: 0, polygons: [{ outer: [[0, 0], [0, -3], [4, -3], [4, 0]], inners: [] }] };
  const items = [roomA, roomB];
  layer.doors = [{ key: 'node/1', at: [2, 0], z: 0, tags: {} }];
  layer.level = { floor: 0, cut: 3, items };
  layer.drawPlan(new THREE.Group(), { toLocal: p => p, items: [], hidden: new Set(), flat: new Set() }, items, [[2, 0]], 3, false);
  const raw = [...layer.doorOpeningEdges.get('node/1').values()].flat();
  const verticals = new Map();
  for (let i = 0; i < raw.length; i += 6) {
    if (Math.hypot(raw[i] - raw[i+3], raw[i+1] - raw[i+4]) > 1e-5) continue;
    const k = `${raw[i].toFixed(3)},${raw[i+1].toFixed(3)}`;
    verticals.set(k, (verticals.get(k) ?? 0) + 1);
  }
  assert.equal([...verticals.values()].filter(n => n === 1).length, 2);
});

// Like way/1304501560: a free-standing wall line inside an area. Its bottom edge must lie above every floor layer,
// otherwise the floor covers it.
for (const pale of [false, true]) test(`bottom edge of a wall inside an area is above the floor, pale=${pale}`, async () => {
  const THREE = await import('three');
  const layer = new BuildingsLayer('test');
  layer.graphics.edges = true;
  const area = { key: 'area', kind: 'area', z: -6, polygons: [{ outer: [[-5, -5], [5, -5], [5, 5], [-5, 5]], inners: [] }] };
  const room = { key: 'room', kind: 'room', z: -6, polygons: [{ outer: [[2, 2], [4, 2], [4, 4], [2, 4]], inners: [] }] };
  const wall = { key: 'wall', kind: 'wall', line: true, z: -6, polygons: [{ outer: [[-2, 0], [0, 0]], inners: [] }] };
  const items = [area, room, wall];
  layer.level = { floor: -6, cut: -3, items };
  const root = new THREE.Group();
  layer.drawPlan(root, { toLocal: p => p, items: [], hidden: new Set(), flat: new Set() }, items, [], -3, pale);
  let floorTop = -Infinity, bottom;
  root.traverse(o => {
    const p = o.geometry?.getAttribute('position')?.array;
    if (!p) return;
    if (o.type === 'Mesh') for (let i = 0; i < p.length; i += 9)
      if (Math.abs(p[i+2] - p[i+5]) < 1e-6 && Math.abs(p[i+2] - p[i+8]) < 1e-6 && p[i+2] < -5.5) floorTop = Math.max(floorTop, p[i+2]);
    if (o.type === 'LineSegments') for (let i = 0; i < p.length; i += 6)
      if (Math.abs(p[i+1]) < 1e-6 && Math.abs(p[i+4]) < 1e-6 && Math.abs(p[i] - p[i+3]) > 1 && p[i+2] < -5.5) bottom = Math.min(bottom ?? Infinity, p[i+2]);
  });
  assert.ok(bottom !== undefined, 'bottom edge is drawn');
  assert.ok(bottom > floorTop, `bottom edge ${bottom} is under the floor ${floorTop}`);
});

// Toilets and cubicles: doors in their walls are narrower (doorWidth); the door's own width tag wins.
test('doors of toilet rooms are narrower, width tag overrides', async () => {
  const THREE = await import('three');
  const openingWidth = (doorTags) => {
    const layer = new BuildingsLayer('test');
    const toilet = { key: 't', kind: 'room', z: 0, doorWidth: .8, polygons: [{ outer: [[0, 0], [4, 0], [4, 3], [0, 3]], inners: [] }] };
    const hall = { key: 'h', kind: 'room', z: 0, polygons: [{ outer: [[0, 0], [0, -3], [4, -3], [4, 0]], inners: [] }] };
    const items = [toilet, hall];
    layer.doors = [{ key: 'node/1', at: [2, 0], z: 0, tags: doorTags }];
    layer.level = { floor: 0, cut: 3, items };
    layer.drawPlan(new THREE.Group(), { toLocal: p => p, items: [], hidden: new Set(), flat: new Set() }, items, [[2, 0]], 3, false);
    return [...layer.doorOpeningEdges.get('node/1').values()].reduce((s, v) => s + Math.hypot(v[3] - v[0], v[4] - v[1]), 0);
  };
  assert.ok(Math.abs(openingWidth({}) - .8) < 1e-6);
  assert.ok(Math.abs(openingWidth({ width: '1.2' }) - 1.2) < 1e-6);
});

// Elevators: above the lowest stop the shaft has no floor and cuts the floors under it; where the elevator
// passes without stopping (cutOnly) there are no walls either.
for (const cutOnly of [false, true]) test(`elevator shaft cuts the floor, cutOnly=${cutOnly}`, async () => {
  const THREE = await import('three');
  const layer = new BuildingsLayer('test');
  const hall = { key: 'hall', kind: 'area', z: 0, polygons: [{ outer: [[-5, -5], [5, -5], [5, 5], [-5, 5]], inners: [] }] };
  const shaft = { key: 'lift', kind: 'room', z: 0, shaft: true, cutOnly, polygons: [{ outer: [[0, 0], [2, 0], [2, 2], [0, 2]], inners: [] }] };
  const items = [hall, shaft];
  layer.level = { floor: 0, cut: 3, items };
  const root = new THREE.Group();
  layer.drawPlan(root, { toLocal: p => p, items: [], hidden: new Set(), flat: new Set() }, items, [], 3, false);
  const inTri = (x, y, p, i) => {
    const s = (ax, ay, bx, by) => (x - bx) * (ay - by) - (ax - bx) * (y - by);
    const d1 = s(p[i], p[i+1], p[i+3], p[i+4]), d2 = s(p[i+3], p[i+4], p[i+6], p[i+7]), d3 = s(p[i+6], p[i+7], p[i], p[i+1]);
    return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
  };
  let floorInShaft = 0, floorOutside = 0, shaftWalls = 0;
  root.traverse(o => {
    if (o.type !== 'Mesh') return;
    const p = o.geometry.getAttribute('position').array;
    for (let i = 0; i < p.length; i += 9) {
      const flat = Math.abs(p[i+2] - p[i+5]) < 1e-6 && Math.abs(p[i+2] - p[i+8]) < 1e-6;
      if (flat && inTri(1, 1, p, i)) floorInShaft++;
      if (flat && inTri(-3, -3, p, i)) floorOutside++;
      if (!flat && [0, 3, 6].every(k => Math.abs(p[i+k]) < 1e-6 && p[i+k+1] > -1e-6 && p[i+k+1] < 2 + 1e-6)) shaftWalls++;
    }
  });
  assert.equal(floorInShaft, 0, 'no floor inside the shaft');
  assert.ok(floorOutside > 0, 'the hall floor stays around it');
  assert.equal(shaftWalls > 0, !cutOnly, cutOnly ? 'no walls where the elevator does not stop' : 'shaft walls');
});

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

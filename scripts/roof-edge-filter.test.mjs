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
for (const [angle, expected] of [[2, 4], [5, 4], [7, 5], [20, 5]]) test(`roof fold at ${angle} degrees yields ${expected} edges`, () => {
  const layer = new BuildingsLayer('test');
  layer.graphics.edges = true;
  layer.setFocus([{ key: 'way/1', type: 'way', id: 1, version: 1, kind: 'part', hasParts: false,
    tags: { 'building:part': 'yes', 'roof:shape': 'hipped', height: '9' },
    polygons: [{ outer: [[37,55],[37.001,55],[37.001,55.001],[37,55.001]], inners: [] }] }]);
  const group = layer.groups.get('@focus');
  const item = group.items[0];
  // Two roof facets share the x axis; all four boundary edges must stay visible.
  item.positions = new Float32Array([0,0,0, 1,0,0, 0,1,0,
    1,0,0, 0,0,0, 0,-Math.cos(angle*Math.PI/180),Math.sin(angle*Math.PI/180)]);
  item.wallVertices = 0;
  item.edges = undefined;
  layer.applyEdges(group);
  assert.equal(item.edges.length / 6, expected);
  layer.clear();
});
test('coplanar wall and gable with opposite winding have no seam', () => {
  const layer = new BuildingsLayer('test');
  layer.graphics.edges = true;
  layer.setFocus([{key:'way/1',type:'way',id:1,version:1,kind:'part',tags:{'building:part':'yes','roof:shape':'gabled',height:'9'},
    polygons:[{outer:[[37,55],[37.001,55],[37.001,55.001],[37,55.001]],inners:[]}]}]);
  const group = layer.groups.get('@focus'), item = group.items[0];
  // Wall below z=3, gable above it; their shared edge has the same direction
  // in both triangles, as can happen when the gable is generated separately.
  item.positions = new Float32Array([0,0,3, 4,0,3, 0,0,0,
    0,0,3, 4,0,3, 2,0,5,
    0,0,3, 2,0,5, 0,2,3]);
  item.wallVertices = 6;
  item.edges = undefined;
  layer.applyEdges(group);
  const edges = item.edges;
  for (let i=0;i<edges.length;i+=6) {
    const seam = Math.abs(edges[i+1])<1e-6 && Math.abs(edges[i+4])<1e-6
      && Math.abs(edges[i+2]-3)<1e-6 && Math.abs(edges[i+5]-3)<1e-6;
    assert.equal(seam,false);
  }
  assert.ok(edges.length>0,'roof slopes and outer boundary remain');
  layer.clear();
});
test('JOSM roof: flat continuation past a T-junction is absent from rendered edges', async () => {
  const {readFileSync}=await import('node:fs');
  const data=JSON.parse(readFileSync(new URL('./fixtures/roof-josm-79980560-triangles.json',import.meta.url)));
  const layer=new BuildingsLayer('test');
  layer.graphics.edges=true;
  layer.setFocus([{key:'way/1',type:'way',id:1,version:1,kind:'building',tags:{building:'yes','roof:shape':'gabled'},
    polygons:[{outer:[[37,55],[37.001,55],[37.001,55.001]],inners:[]}]}]);
  const group=layer.groups.get('@focus'),item=group.items[0];
  item.positions=new Float32Array(data.positions);
  item.wallVertices=data.wallVertices;
  item.edges=undefined;
  layer.applyEdges(group);
  // Midpoint of the spurious continuation from skeleton event 20 to event 23.
  const at=[(16.473217+18.400740)/2,(10.947789+9.941395)/2,(10.810821+11.354298)/2];
  let covers=false, valley=false;
  for(let i=0;i<item.edges.length;i+=6){
    const p=[...item.edges.slice(i,i+3)],q=[...item.edges.slice(i+3,i+6)];
    const d=q.map((v,k)=>v-p[k]);const len2=d.reduce((s,v)=>s+v*v,0);
    const t=d.reduce((s,v,k)=>s+v*(at[k]-p[k]),0)/len2;
    if(t>=0&&t<=1&&Math.hypot(...p.map((v,k)=>v+t*d[k]-at[k]))<.002)covers=true;
    if(Math.hypot(p[0]-10.053718,p[1]-14.301812)<.002 && Math.hypot(q[0]-16.473217,q[1]-10.947789)<.002)valley=true;
  }
  assert.equal(covers,false,'the diagonal beyond the junction must be removed');
  assert.equal(valley,true,'the real valley up to the junction must remain');
  layer.clear();
});

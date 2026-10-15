import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createServer } from 'vite';
let vite, extendGables;
before(async () => {
  vite = await createServer({configFile:false,server:{middlewareMode:true,ws:false,watch:null},appType:'custom'});
  ({extendGables} = await vite.ssrLoadModule('/src/render/roof-gables.ts'));
});
after(async () => await vite?.close());
for (const slope of [0, .2, -.15]) test(`gable preserves both roof planes with side convergence ${slope}`, () => {
  const k = Math.hypot(1,slope);
  const ridge = x => { const y=(4+slope*x)/(1+k); return [x,y,y]; };
  const sk = {vertices:[[0,0,0],[0,4,0],[10,4+10*slope,0],[10,0,0],ridge(2),ridge(8)],
    polygons:[[0,4,1],[3,5,4,0],[1,4,5,2],[2,5,3]]};
  const original = structuredClone(sk);
  const {vertices,gables} = extendGables(sk);
  assert.equal(gables.size,2);
  assert.deepEqual(sk,original,'cached skeleton is never mutated');
  assert.equal(vertices[4][0],0);
  assert.equal(vertices[5][0],10);
  for (const i of [4,5]) {
    const [x,y,t]=vertices[i];
    assert.ok(Math.abs(t-y)<1e-9,'lower slope stays in its original plane');
    assert.ok(Math.abs(t-(4+slope*x-y)/k)<1e-9,'upper slope stays in its original plane');
  }
  if (slope) assert.notEqual(vertices[4][2],sk.vertices[4][2],'height follows the ridge instead of being frozen');
});
test('an apex shared by incompatible roof planes stays unchanged', () => {
  const sk={vertices:[[0,0,0],[0,4,0],[10,4,0],[10,0,0],[2,2,2],[8,2,2]],
    polygons:[[0,4,1],[3,5,4,0],[1,4,5,2],[2,5,3],[0,4,2]]};
  const {vertices,gables}=extendGables(sk);
  assert.deepEqual(vertices[4],sk.vertices[4]);
  assert.ok(!gables.has(sk.polygons[0]));
});
test('JOSM way/79980560: submillimetre event edge is welded before roof triangulation', async () => {
  const {readFileSync} = await import('node:fs');
  const {weldRoofSkeleton} = await vite.ssrLoadModule('/src/render/roof-gables.ts');
  // Skeleton derived from the edited JOSM geometry of OSM way/79980560 (ODbL).
  const sk=JSON.parse(readFileSync(new URL('./fixtures/roof-josm-79980560.json',import.meta.url)));
  const original=structuredClone(sk);
  const clean=weldRoofSkeleton(sk);
  assert.ok(sk.polygons.some(f=>f.includes(23)&&f.includes(24)));
  assert.ok(clean.polygons.every(f=>!(f.includes(23)&&f.includes(24))));
  assert.deepEqual(sk,original);
  const {gables}=extendGables(clean);
  assert.equal(gables.size,3,'all original gable ends remain available');
  for(const f of clean.polygons) for(let i=0;i<f.length;i++) {
    const a=clean.vertices[f[i]],b=clean.vertices[f[(i+1)%f.length]];
    assert.ok(Math.hypot(...a.map((v,k)=>v-b[k]))>=.001);
  }
  assert.deepEqual(weldRoofSkeleton(clean),clean,'welding is idempotent');
});
test('JOSM 5.2cm hip becomes a triangular gable with planar side slopes', async () => {
  const {readFileSync}=await import('node:fs');
  const {weldRoofSkeleton}=await vite.ssrLoadModule('/src/render/roof-gables.ts');
  const raw=JSON.parse(readFileSync(new URL('./fixtures/roof-josm-79980560-short-hip.json',import.meta.url)));
  const sk=weldRoofSkeleton(raw), original=structuredClone(sk);
  const {vertices,polygons,gables}=extendGables(sk);
  const gable=[...gables].find(f=>f.includes(8)&&f.includes(9));
  assert.ok(gable,'nearly triangular hip must be converted');
  assert.equal(gable.length,3);
  const apex=gable.find(i=>i!==8&&i!==9);
  const a=vertices[8],b=vertices[9],p=vertices[apex];
  assert.ok(Math.abs((b[0]-a[0])*(p[1]-a[1])-(b[1]-a[1])*(p[0]-a[0]))<1e-8);
  assert.ok(p[2]>0);
  assert.deepEqual(sk,original,'source skeleton remains unchanged');
  for(const face of [8,10]) {
    const f=sk.polygons[face],base=f.filter(i=>sk.vertices[i][2]<1e-9);
    const [u,v]=base.map(i=>sk.vertices[i]);
    const top=sk.vertices[f.find(i=>i===22||i===24)];
    const dx=v[0]-u[0],dy=v[1]-u[1];
    const scale=top[2]/(dx*(top[1]-u[1])-dy*(top[0]-u[0]));
    for(const id of polygons[face]) {
      const q=vertices[id];
      assert.ok(Math.abs(scale*(dx*(q[1]-u[1])-dy*(q[0]-u[0]))-q[2])<.001,'side slope remains planar');
    }
  }
  for(const f of polygons) {
    assert.ok(f.length>=3);
    assert.ok(f.every((id,i)=>id!==f[(i+1)%f.length]),'collapsed ridge leaves no zero-length edges');
    assert.ok(f.every(id=>vertices[id].every(Number.isFinite)));
  }
  // A significant ridge must not be approximated away.
  const wide=structuredClone(sk);
  wide.vertices[24][0]+=.5;
  const again=extendGables(wide);
  assert.ok(![...again.gables].some(f=>f.includes(8)&&f.includes(9)));
});

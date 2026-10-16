import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {createServer} from 'vite';
import * as THREE from 'three';
let vite,cut,masksOf,outline,floorHoles;
before(async()=>{vite=await createServer({configFile:false,server:{middlewareMode:true,ws:false,watch:null},appType:'custom'});({cutEscalatorOpenings:cut,escalatorOpeningMasks:masksOf,escalatorOpeningOutline:outline,escalatorFloorHoles:floorHoles}=await vite.ssrLoadModule('/src/render/escalator-openings.ts'));});
after(async()=>await vite?.close());
const wall=new Float32Array([5,-3,0,5,3,0,5,3,8,5,-3,0,5,3,8,5,-3,8]);
const escalator={line:[[0,0],[10,0]],bottom:0,top:4,width:2,incline:'up'};
function contains(pos,y,z){const ray=new THREE.Ray(new THREE.Vector3(4,y,z),new THREE.Vector3(1,0,0));const p=new THREE.Vector3();for(let i=0;i<pos.length;i+=9)if(ray.intersectTriangle(new THREE.Vector3().fromArray(pos,i),new THREE.Vector3().fromArray(pos,i+3),new THREE.Vector3().fromArray(pos,i+6),false,p))return true;return false;}
test('crossing wall clears body and 2m above the treads, preserving wall around it',()=>{
 const before=wall.slice(),out=cut(wall,[escalator]);assert.deepEqual(wall,before);
 assert.equal(contains(out,0,2),false);assert.equal(contains(out,0,3.9),false);
 assert.equal(contains(out,0,5),true);assert.equal(contains(out,2,2),true);assert.equal(contains(out,0,.5),true);
});
test('downward, bent and oblique escalators produce finite openings',()=>{
 for(const e of [{...escalator,incline:'down'},{...escalator,line:[[0,-1],[5,0],[10,2]]}]){
 const out=cut(wall,[e]);assert.ok(out.length>0);assert.ok(out.every(Number.isFinite));assert.equal(contains(out,0,2),false);
 }
});
test('separate walls and horizontal slabs are not cut',()=>{
 const far={...escalator,line:[[0,20],[10,20]]};assert.deepEqual(cut(wall,[far]),wall);
 const slab=new Float32Array([0,0,2,10,0,2,10,10,2]);assert.deepEqual(cut(slab,[escalator]),slab);
});
test('opening outline: edges around the hole, verticals stop at the wall top',()=>{
 const low=new Float32Array([5,-3,0,5,3,0,5,3,3,5,-3,0,5,3,3,5,-3,3]);
 const edges=outline(low,masksOf(low,[escalator]));
 assert.ok(edges.length>0);
 let vertical=0;
 for(let i=0;i<edges.length;i+=6){
  assert.ok(edges[i+2]<=3+1e-6&&edges[i+5]<=3+1e-6);
  // no segment along the wall top or bottom
  assert.ok(!(Math.abs(edges[i+2]-3)<1e-3&&Math.abs(edges[i+5]-3)<1e-3));
  if(Math.abs(edges[i+1]-edges[i+4])<1e-6)vertical++;
 }
 assert.ok(vertical>=2);
});
test('floor holes follow the model footprint only where its body passes through the floor',()=>{
 const inside=(mp,x,y)=>mp.some(poly=>{const inRing=r=>{let c=false;for(let i=0,j=r.length-1;i<r.length;j=i++)if((r[i][1]>y)!==(r[j][1]>y)&&x<(r[j][0]-r[i][0])*(y-r[i][1])/(r[j][1]-r[i][1])+r[i][0])c=!c;return c;};return inRing(poly[0])&&!poly.slice(1).some(inRing);});
 // Lower floor (z=0): landing and the start of the ramp; the rest of the ramp is above the floor
 const low=floorHoles([escalator],0);
 assert.ok(inside(low,.5,0));assert.ok(!inside(low,6,0));
 // Width: the model, not a wide outline
 assert.ok(inside(low,.5,.9));assert.ok(!inside(low,.5,1.1));
 // Upper floor (z=4): only the top end
 const high=floorHoles([escalator],4);
 assert.ok(inside(high,9.5,0));assert.ok(!inside(high,3,0));
 // An unrelated floor
 assert.equal(floorHoles([escalator],10).length,0);
});

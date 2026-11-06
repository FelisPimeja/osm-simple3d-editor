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
test('crossing wall clears body and everything above the treads up to the wall top, keeping the wall below and beside it',()=>{
 const before=wall.slice(),out=cut(wall,[escalator]);assert.deepEqual(wall,before);
 assert.equal(contains(out,0,2),false);assert.equal(contains(out,0,3.9),false);
 assert.equal(contains(out,0,5),false);assert.equal(contains(out,0,7.9),false);assert.equal(contains(out,2,2),true);assert.equal(contains(out,0,.5),true);
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

// Лестница в стене поперёк марша (стена лестничной клетки у верхней площадки) — проём как у эскалатора
test('stairs cut a wall across the flight but not a wall along it',()=>{
 const flight={line:[[0,0],[10,0]],bottom:0,top:4,width:2,incline:'up',stairs:true};
 const out=cut(wall,[flight]);
 assert.equal(contains(out,0,2.5),false);assert.equal(contains(out,0,5.5),false);assert.equal(contains(out,2,2.5),true);
 const side=new Float32Array([2,1,0,8,1,0,8,1,8,2,1,0,8,1,8,2,1,8]);
 assert.equal(masksOf(side,[flight]).length,0);
});

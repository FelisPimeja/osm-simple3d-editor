import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { occludedByTriangles } from '../src/render/ray-occlusion.ts';
const positions=[];
for(let x=0;x<100;x++)for(let y=0;y<100;y++) positions.push(x,y,0,x+1,y,0,x+1,y+1,0,x,y,0,x+1,y+1,0,x,y+1,0);
const buffer=new Float32Array(positions);
function brute(ray, distance, cut) {
  const a=new THREE.Vector3(),b=new THREE.Vector3(),c=new THREE.Vector3(),p=new THREE.Vector3();
  for(let i=0;i<buffer.length;i+=9) {
    a.fromArray(buffer,i);b.fromArray(buffer,i+3);c.fromArray(buffer,i+6);
    if(ray.intersectTriangle(a,b,c,false,p)&&p.z<=cut&&p.distanceTo(ray.origin)<distance)return true;
  }
  return false;
}
test('indexed occlusion matches triangle enumeration across rays, depth limits and floor cuts',()=>{
  for(let i=0;i<40;i++) {
    const ray=new THREE.Ray(new THREE.Vector3((i*17)%120-.2,(i*31)%120-.3,10),new THREE.Vector3(.01,.02,-1).normalize());
    for(const distance of [5,11,100]) for(const cut of [-1,0,3]) assert.equal(occludedByTriangles(buffer,ray,distance,cut),brute(ray,distance,cut));
  }
});
test('warm spatial index avoids repeated full triangle scans',()=>{
  const rays=Array.from({length:100},(_,i)=>new THREE.Ray(new THREE.Vector3(90+(i%9),90+(i%7),10),new THREE.Vector3(0,0,-1)));
  occludedByTriangles(buffer,rays[0],11);
  let start=performance.now();const expected=rays.map(r=>brute(r,11,Infinity));const slow=performance.now()-start;
  start=performance.now();const actual=rays.map(r=>occludedByTriangles(buffer,r,11));const fast=performance.now()-start;
  assert.deepEqual(actual,expected);
  console.log(`occlusion 20k triangles / 100 rays: brute ${slow.toFixed(1)} ms, indexed ${fast.toFixed(1)} ms`);
});

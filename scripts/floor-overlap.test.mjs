import assert from 'node:assert/strict';
import {test} from 'node:test';
import {partitionFloors} from '../src/render/floor-overlap.ts';
const rect=(x,y,w,h,z=0)=>({outer:[[x,y],[x+w,y],[x+w,y+h],[x,y+h]],inners:[],z});
const area=r=>Math.abs(r.reduce((s,p,i)=>{const q=r[(i+1)%r.length];return s+p[0]*q[1]-q[0]*p[1];},0))/2;
const total=pieces=>pieces.reduce((s,p)=>s+area(p.outer)-p.inners.reduce((a,r)=>a+area(r),0),0);
test('nested rooms partition the common floor without overlapping planes',()=>{
 const floors=[rect(0,0,10,10),rect(2,2,3,3)];const before=structuredClone(floors);
 const p=partitionFloors(floors);assert.equal(total(p[0]),91);assert.equal(total(p[1]),9);assert.deepEqual(floors,before);
});
test('partial overlaps, equal-size rooms and different elevations',()=>{
 const p=partitionFloors([rect(0,0,4,4),rect(2,0,4,4),rect(0,0,4,4,3)]);
 assert.equal(total(p[0]),8);assert.equal(total(p[1]),16);assert.equal(total(p[2]),16);
});
test('holes and separate floors remain open and unchanged',()=>{
 const room=rect(0,0,10,10);room.inners=[rect(2,2,3,3).outer];
 const p=partitionFloors([room,rect(2,2,3,3),rect(20,0,2,2)]);
 assert.equal(total(p[0]),91);assert.equal(total(p[1]),9);assert.equal(total(p[2]),4);
});
test('visual floor offsets do not leave overlapping surfaces on the same storey',()=>{
 const p=partitionFloors([rect(0,0,10,10,.02),rect(2,2,3,3,.05)],.1);
 assert.equal(total(p[0]),91);assert.equal(total(p[1]),9);
});

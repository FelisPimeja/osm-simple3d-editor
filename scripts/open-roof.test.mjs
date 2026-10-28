import assert from 'node:assert/strict';
import {test} from 'node:test';
import {openRoofOutline} from '../src/render/open-roof.ts';
const roof=[0,0,1,4,0,3,4,2,3,0,0,1,4,2,3,0,2,1];
test('opened skillion roof follows its sloping boundary without the triangulation diagonal',()=>{
 const out=openRoofOutline(roof,0);
 assert.equal(out.length,24);
 assert.ok(Array.from({length:4},(_,i)=>out.slice(i*6,i*6+6)).some(e=>e[2]!==e[5]));
});
test('roof opening outline is clipped to the selected floor',()=>{
 const out=openRoofOutline(roof,2);
 for(let i=2;i<out.length;i+=3)assert.ok(out[i]>=2);
 assert.deepEqual(openRoofOutline(roof,4),[]);
});
test('roof edges against a neighbour have no heavy outline when their wall is hidden',()=>{
 // Only the front wall remains exposed after trimming the adjoining building.
 const walls=[0,0,0,4,0,0,4,0,3,0,0,0,4,0,3,0,0,1];
 const out=openRoofOutline(roof,0,walls);
 assert.deepEqual(out,[0,0,1,4,0,3]);
});

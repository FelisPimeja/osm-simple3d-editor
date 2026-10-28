import assert from 'node:assert/strict';
import {test} from 'node:test';
import {closedWallCap} from '../src/render/indoor-wall-cap.ts';
test('closed line wall has the same cap contour for drawing and picking',()=>{
 const ring=[[0,0],[1,0],[1,4],[0,4],[0,0]], before=structuredClone(ring);
 assert.deepEqual(closedWallCap(ring),ring.slice(0,-1));
 assert.deepEqual(ring,before);
});
test('open wall does not acquire a selectable filled cap',()=>{
 assert.equal(closedWallCap([[0,0],[1,0],[1,4],[0,4]]),undefined);
 assert.equal(closedWallCap([[0,0],[1,0]]),undefined);
});

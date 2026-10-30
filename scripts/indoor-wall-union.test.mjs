import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {createServer} from 'vite';
let vite,joinedWallLine;
before(async()=>{vite=await createServer({configFile:false,server:{middlewareMode:true,ws:false,watch:null},appType:'custom'});({joinedWallLine}=await vite.ssrLoadModule('/src/edit/indoor-wall-union.ts'));});
after(async()=>await vite.close());
const wall=(ids,outer)=>({kind:'wall',line:true,polygons:[{outerIds:ids,outer,inners:[]}]});
const a=wall([1,2],[[0,0],[1,0]]),b=wall([3,2],[[2,1],[1,0]]);
test('joins reversed walls and keeps the corner and node IDs',()=>{assert.deepEqual(joinedWallLine([a,b]),{ids:[1,2,3],coords:[[0,0],[1,0],[2,1]]});});
test('rejects disconnected, branching and duplicate segments',()=>{
 assert.equal(joinedWallLine([a,wall([3,4],[[2,0],[3,0]])]),undefined);
 assert.equal(joinedWallLine([a,b,wall([2,4],[[1,0],[1,1]])]),undefined);
 assert.equal(joinedWallLine([a,a]),undefined);
});
test('joins into a closed ring',()=>{
 const r=joinedWallLine([a,b,wall([3,1],[[2,1],[0,0]])]);
 assert.deepEqual(r.ids,[1,2,3,1]);
});
test('rejects a disconnected ring beside a chain',()=>{
 assert.equal(joinedWallLine([a,wall([3,4,5,3],[[3,0],[4,0],[3,1],[3,0]])]),undefined);
});

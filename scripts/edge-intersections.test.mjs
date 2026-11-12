import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {createServer} from 'vite';
let vite,ei;
before(async()=>{vite=await createServer({configFile:false,server:{middlewareMode:true,ws:false,watch:null},appType:'custom'});({edgeIntersections:ei}=await vite.ssrLoadModule('/src/render/edge-intersections.ts'));});
after(async()=>await vite?.close());
const E=(key,a,b)=>({key,a:{x:a[0],y:a[1],z:a[2]},b:{x:b[0],y:b[1],z:b[2]}});
test('crossing edges of different parts at the same height',()=>{
 const r=ei([E('A',[0,0,3],[10,0,3]),E('B',[4,-2,3],[4,5,3])]);
 assert.equal(r.length,1);assert.deepEqual(r[0].p,{x:4,y:0,z:3});assert.deepEqual(r[0].keys.sort(),['A','B']);
});
test('touching at an end is a vertex, not a crossing',()=>assert.equal(ei([E('A',[0,0,0],[10,0,0]),E('B',[4,0,0],[4,5,0])]).length,0));
test('same object, parallel or different heights — none',()=>{
 assert.equal(ei([E('A',[0,0,0],[10,0,0]),E('A',[4,-2,0],[4,5,0])]).length,0);
 assert.equal(ei([E('A',[0,0,0],[10,0,0]),E('B',[0,1,0],[10,1,0])]).length,0);
 assert.equal(ei([E('A',[0,0,0],[10,0,0]),E('B',[4,-2,1],[4,5,1])]).length,0);
});
test('vertical edge through a horizontal one, edges across grid cells counted once',()=>{
 assert.equal(ei([E('A',[0,0,3],[10,0,3]),E('B',[4,0,0],[4,0,6])]).length,1);
 assert.equal(ei([E('A',[-20,1,0],[20,1,0]),E('B',[1,-20,0],[1,20,0])]).length,1);
});

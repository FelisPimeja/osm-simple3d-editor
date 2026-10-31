import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {createServer} from 'vite';
let vite,levelDetachNodes;
before(async()=>{
 vite=await createServer({configFile:false,server:{middlewareMode:true,ws:false,watch:null},appType:'custom'});
 ({levelDetachNodes}=await vite.ssrLoadModule('/src/edit/level-detach.ts'));
});
after(async()=>await vite.close());
const ring={ids:[1,2,3,4,5,6],closed:true};
test('takes the shared stretch around the door only',()=>{
 assert.deepEqual([...levelDetachNodes([ring],[2,3],new Set([1,2,3,4]),new Set())].sort(),[1,2,3,4]);
});
test('wraps around a closed ring and stops at the level own point',()=>{
 assert.deepEqual([...levelDetachNodes([ring],[6],new Set([5,6,1,2]),new Set([2]))].sort(),[1,5,6]);
});
test('open line stops at its end; unshared anchor gives nothing',()=>{
 assert.deepEqual([...levelDetachNodes([{ids:[1,2,3],closed:false}],[3],new Set([1,2,3]),new Set())].sort(),[1,2,3]);
 assert.equal(levelDetachNodes([ring],[3],new Set([1]),new Set()).size,0);
});

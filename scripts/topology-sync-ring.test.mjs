import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {createServer} from 'vite';
let vite,syncRingNodes,restructureRing;
before(async()=>{
 vite=await createServer({configFile:false,server:{middlewareMode:true,ws:false,watch:null},appType:'custom'});
 ({syncRingNodes,restructureRing}=await vite.ssrLoadModule('/src/edit/topology.ts'));
});
after(async()=>{await vite.close();});
const c=id=>[id,id];
test('a node added to a member way reaches the ring in either direction',()=>{
 const ids=[1,2,3,4],coords=ids.map(c);
 assert.deepEqual(syncRingNodes(ids,coords,[{ids:[1,9,2],coords:[1,9,2].map(c)}]).ids,[1,9,2,3,4]);
 assert.deepEqual(syncRingNodes(ids,coords,[{ids:[2,9,8,1],coords:[2,9,8,1].map(c)}]).ids,[1,8,9,2,3,4]);
 assert.deepEqual(syncRingNodes(ids,coords,[{ids:[1,2],coords:[1,2].map(c)}]).ids,ids);
});
test('after the sync the member stays whole and no duplicate way appears',()=>{
 const line=[1,9,2];
 const ring=syncRingNodes([1,2,3],[1,2,3].map(c),[{ids:line,coords:line.map(c)}]).ids;
 let id=-1;
 const r=restructureRing([{id:10,role:'outer',nodes:line},{id:11,role:'outer',nodes:[2,3,1]}],ring,'outer',()=>id--);
 assert.deepEqual(r.members.map(m=>m.id),[10,11]);
 assert.deepEqual(r.created,[]);
});

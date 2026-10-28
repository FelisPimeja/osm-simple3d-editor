import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {createServer} from 'vite';
let vite,addFacadeDoors;
before(async()=>{vite=await createServer({configFile:false,server:{middlewareMode:true,ws:false,watch:null},appType:'custom'});({addFacadeDoors}=await vite.ssrLoadModule('/src/edit/facade-doors.ts'));});
after(async()=>await vite.close());
const feature=tags=>({entrances:[{id:1,tags}],polygons:[{outer:[[0,0],[1,0],[1,1]],outerIds:[1,2,3],inners:[]}]});
test('main and yes entrances without explicit level become ground-floor doors',()=>{
 for(const entrance of ['main','yes','service']){
  const all=new Map();addFacadeDoors(all,[feature({entrance})]);
  assert.deepEqual(all.get('node/1').levels,[0]);assert.deepEqual(all.get('node/1').point,[0,0]);
 }
});
test('explicit levels and existing indoor door data take priority',()=>{
 const all=new Map();addFacadeDoors(all,[feature({entrance:'yes',level:'1',repeat_on:'2'})]);
 assert.deepEqual(all.get('node/1').levels,[1,2]);
 const old=all.get('node/1');addFacadeDoors(all,[feature({entrance:'main'})]);assert.equal(all.get('node/1'),old);
 const no=new Map();addFacadeDoors(no,[feature({entrance:'no'})]);assert.equal(no.size,0);
});

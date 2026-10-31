import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'vite';
test('counter offsets to the right of the way, with a mitred corner',async()=>{
 const vite=await createServer({configFile:false,server:{middlewareMode:true,ws:false,watch:null},appType:'custom'});
 const {counterRing}=await vite.ssrLoadModule('/src/render/counter-ring.ts');
 await vite.close();
 assert.deepEqual(counterRing([[0,0],[2,0]],.5),[[0,0],[2,0],[2,-.5],[0,-.5]]);
 const r=counterRing([[0,0],[2,0],[2,-2]],.5);
 assert.ok(Math.hypot(r[4][0]-1.5,r[4][1]+.5)<1e-9);
 const t=counterRing([[0,0],[2,0]],.5,[[[1.75,1],[2.25,-1]]]);
 assert.ok(Math.hypot(t[2][0]-2.125,t[2][1]+.5)<1e-9);
 assert.deepEqual(t[3],[0,-.5]);
});

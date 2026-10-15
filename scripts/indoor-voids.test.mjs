import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createServer } from 'vite';
let vite, buildPlans, findVoids, multiArea;
before(async()=>{
 globalThis.window={};
 vite=await createServer({configFile:false,server:{middlewareMode:true,ws:false,watch:null},appType:'custom'});
 ({buildPlans,findVoids,multiArea}=await vite.ssrLoadModule('/src/view/indoor-voids.ts'));
});
after(async()=>{delete globalThis.window;await vite.close();});
const square=(a,b,c,d)=>[[a,b],[c,b],[c,d],[a,d]];
const outer=square(0,0,20,20), hole=square(5,5,15,15);
const levels=[{n:0,floor:0,ceil:3},{n:1,floor:3,ceil:6}];
const part={polygons:[[outer]],min:0,wallTop:6};
const corridor={kind:'corridor',polygons:[[outer,hole]],levels:[1],floors:[1]};
test('explicit inner ring is open even without mapped floors below',()=>{
 const plans=buildPlans(levels,[part],[corridor]);
 const voids=findVoids(1,plans);
 assert.equal(voids.length,1);
 assert.equal(multiArea(voids[0].polygon),100);
 assert.deepEqual(voids[0].through,[0]);
});
test('a room inside a corridor ring remains solid',()=>{
 const plans=buildPlans(levels,[part],[corridor,{kind:'room',polygons:[[hole]],levels:[1],floors:[1]}]);
 assert.deepEqual(findVoids(1,plans),[]);
});
test('only the unoccupied portion of an inner ring is cut',()=>{
 const plans=buildPlans(levels,[part],[corridor,{kind:'room',polygons:[[square(5,5,10,15)]],levels:[1],floors:[1]}]);
 assert.equal(findVoids(1,plans).reduce((s,v)=>s+multiArea(v.polygon),0),50);
});
test('unmapped space without an explicit ring still requires lower floor evidence',()=>{
 const plans=buildPlans(levels,[part],[{kind:'room',polygons:[[square(0,0,15,20)]],levels:[1],floors:[1]}]);
 assert.deepEqual(findVoids(1,plans),[]);
});

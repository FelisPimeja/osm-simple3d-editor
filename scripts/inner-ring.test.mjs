import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {createServer} from 'vite';
let vite,ringInside;
before(async()=>{vite=await createServer({configFile:false,server:{middlewareMode:true,ws:false,watch:null},appType:'custom'});({ringInside}=await vite.ssrLoadModule('/src/edit/inner-ring.ts'));});
after(async()=>await vite?.close());
const square=[[0,0],[10,0],[10,10],[0,10]];
test('ring well inside the outline',()=>assert.equal(ringInside([[2,2],[4,2],[4,4],[2,4]],square,[]),true));
test('ring crossing the outline',()=>assert.equal(ringInside([[8,8],[12,8],[12,12],[8,12]],square,[]),false));
test('ring touching an existing hole',()=>assert.equal(ringInside([[2,2],[6,2],[6,6],[2,6]],square,[[[5,5],[7,5],[7,7],[5,7]]]),false));
test('ring beside an existing hole',()=>assert.equal(ringInside([[1,1],[3,1],[3,3],[1,3]],square,[[[5,5],[7,5],[7,7],[5,7]]]),true));
test('closed or open ring, either orientation',()=>{
 assert.equal(ringInside([[2,2],[2,4],[4,4],[4,2],[2,2]],square,[]),true);
 assert.equal(ringInside([[2,2],[2,2],[2,2]],square,[]),false);
});

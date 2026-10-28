import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {createServer} from 'vite';
let vite,indoorAnchor;
before(async()=>{vite=await createServer({configFile:false,server:{middlewareMode:true,ws:false,watch:null},appType:'custom'});({indoorAnchor}=await vite.ssrLoadModule('/src/edit/indoor-anchor.ts'));});
after(async()=>await vite.close());
test('restored member ways with an empty area do not crash building/level collection',()=>{
 for(const line of [true,false]) assert.equal(indoorAnchor(JSON.parse(JSON.stringify({polygons:[],line}))),undefined);
 assert.equal(indoorAnchor({polygons:[{outer:[],inners:[]}]}),undefined);
});
test('points, lines and polygon walls retain their representative locations',()=>{
 assert.deepEqual(indoorAnchor({point:[3,4],polygons:[]}),[3,4]);
 assert.deepEqual(indoorAnchor({line:true,polygons:[{outer:[[0,0],[1,1]],inners:[]}]}),[0,0]);
 const p=indoorAnchor({polygons:[{outer:[[0,0],[4,0],[4,4],[0,4]],inners:[]}]});
 assert.ok(p[0]>=0&&p[0]<=4&&p[1]>=0&&p[1]<=4);
});

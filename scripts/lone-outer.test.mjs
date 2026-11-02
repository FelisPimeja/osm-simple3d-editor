import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {createServer} from 'vite';
let vite,EditSession,lone;
before(async()=>{
 globalThis.window={};globalThis.location={search:'?server=osm',href:'http://localhost/?server=osm'};
 vite=await createServer({configFile:false,server:{middlewareMode:true,ws:false,watch:null},appType:'custom'});
 ({EditSession}=await vite.ssrLoadModule('/src/edit/session.ts'));
 lone=await vite.ssrLoadModule('/src/edit/lone-outer.ts');
});
after(async()=>{await vite.close();delete globalThis.window;delete globalThis.location;});
test('only a multipolygon with a single outer way collapses',()=>{
 const outer={type:'way',ref:5,role:'outer'},inner={type:'way',ref:6,role:'inner'};
 assert.equal(lone.loneOuterWay({type:'multipolygon'},[outer]),'way/5');
 assert.equal(lone.loneOuterWay({type:'multipolygon'},[outer,inner]),undefined);
 assert.equal(lone.loneOuterWay({type:'building'},[outer]),undefined);
 assert.equal(lone.loneOuterWay({type:'multipolygon'},[{...outer,role:'inner'}]),undefined);
});
test('tags move without type and the parent keeps the member role',()=>{
 assert.deepEqual(lone.wayTagsOf({type:'multipolygon','building:part':'yes'}),{'building:part':'yes'});
 assert.deepEqual(lone.replaceMember([{type:'relation',ref:-2,role:'part'},{type:'way',ref:1,role:'outline'}],-2,7),[{type:'way',ref:7,role:'part'},{type:'way',ref:1,role:'outline'}]);
});
test('collapsing a created relation sends a tagged way with its nodes and is undoable',()=>{
 const ids=[1,2,3,1],coords=[[0,0],[1,0],[1,1],[0,0]];
 const session=new EditSession([],()=>{});
 session.editMany([{key:'way/-1',create:{key:'way/-1',version:0,tags:{},line:{ids,coords}}},
  {key:'relation/-2',create:{key:'relation/-2',version:0,tags:{type:'multipolygon','building:part':'yes'},relMembers:[{type:'way',ref:-1,role:'outer'}],polygons:[]}}]);
 const polygons=[{outer:coords.slice(0,3),inners:[],outerIds:[1,2,3]}];
 session.editMany([{key:'way/-1',tags:{'building:part':'yes'},polygons,line:null},{key:'relation/-2',delete:true}]);
 const changes=session.changes();
 assert.deepEqual(changes.map(c=>c.key),['way/-1']);
 assert.deepEqual(changes[0].wayNodes.after,ids);
 assert.deepEqual(changes[0].after,{'building:part':'yes'});
 session.undo();
 assert.ok(session.get('way/-1').line);
 assert.equal(session.changes().some(c=>c.key==='relation/-2'),true);
});

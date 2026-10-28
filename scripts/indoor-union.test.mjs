import assert from 'node:assert/strict';
import {test} from 'node:test';
import {isIndoorUnionPolygon,indoorUnionSignature} from '../src/edit/indoor-union.ts';
const wall={key:'way/1',kind:'wall',tags:{indoor:'wall',level:'0'},polygons:[],levels:[0]};
test('polygon walls are eligible, linear walls and POIs are not',()=>{
 assert.equal(isIndoorUnionPolygon(wall),true);
 assert.equal(isIndoorUnionPolygon({...wall,line:true}),false);
 assert.equal(isIndoorUnionPolygon({...wall,point:[0,0]}),false);
 assert.equal(isIndoorUnionPolygon({...wall,kind:'room',tags:{indoor:'room',level:'0'}}),true);
});
test('walls with different heights or levels cannot silently lose volume tags',()=>{
 const sig=indoorUnionSignature(wall);
 assert.equal(indoorUnionSignature(structuredClone(wall)),sig);
 for(const tags of [{height:'3'},{min_height:'1'},{min_level:'1'},{level:'1'},{indoor:'room'}])
  assert.notEqual(indoorUnionSignature({...wall,tags:{...wall.tags,...tags}}),sig);
});
test('closed line walls may merge but open line walls remain ineligible',async()=>{
 const {indoorUnionGeometry}=await import('../src/edit/indoor-union.ts');
 const ring=[{id:1,p:[0,0]},{id:2,p:[1,0]},{id:3,p:[1,1]}];
 const closed={...wall,line:true,polygons:[{outer:[...ring.map(q=>q.p),ring[0].p],outerIds:[1,2,3,1],inners:[]}]};
 assert.equal(isIndoorUnionPolygon(closed),true);
 const result=indoorUnionGeometry(closed,ring);
 assert.deepEqual(result.line.ids,[1,2,3,1]);
 assert.deepEqual(result.polygons[0].outerIds,result.line.ids);
 assert.equal(isIndoorUnionPolygon({...closed,polygons:[{...closed.polygons[0],outerIds:[1,2,3,4]}]}),false);
 assert.equal(indoorUnionGeometry({...wall,line:false},ring).line,undefined);
});
test('union with a hole reuses the original outer way and creates untagged inner members',async()=>{
 const {indoorUnionHoleEdits}=await import('../src/edit/indoor-union.ts');
 const ring=(ids,coords)=>ids.map((id,i)=>({id,p:coords[i]}));
 const outer=ring([1,2,3,4],[[0,0],[10,0],[10,10],[0,10]]);
 const inner=ring([5,6,7,8],[[2,2],[8,2],[8,8],[2,8]]);
 let id=-100;
 const result=indoorUnionHoleEdits({...wall,key:'way/1572204863'},wall.tags,[outer,inner],()=>id--);
 assert.equal(result.feature.tags.type,'multipolygon');
 assert.equal(result.feature.line,false);
 assert.deepEqual(result.feature.polygons[0].innerIds,[[5,6,7,8]]);
 const kept=result.edits[0];
 assert.deepEqual(kept.tags,{});
 assert.deepEqual(kept.line.ids,[1,2,3,4,1]);
 const relation=result.edits.at(-1).create;
 assert.deepEqual(relation.relMembers,[{type:'way',ref:1572204863,role:'outer'},{type:'way',ref:-100,role:'inner'}]);
 assert.deepEqual(result.edits[1].create.tags,{});
 assert.deepEqual(result.edits[1].create.line.ids,[5,6,7,8,5]);
});

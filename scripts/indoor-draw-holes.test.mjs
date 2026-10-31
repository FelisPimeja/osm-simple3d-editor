import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {createServer} from 'vite';
let vite,indoorUnionHoleEdits;
before(async()=>{
 vite=await createServer({configFile:false,server:{middlewareMode:true,ws:false,watch:null},appType:'custom'});
 ({indoorUnionHoleEdits}=await vite.ssrLoadModule('/src/edit/indoor-union.ts'));
});
after(async()=>await vite.close());
const square=(a,b,c,d)=>({outer:[[a,b],[c,b],[c,d],[a,d]],inners:[]});
test('way conversion keeps its identity as the outer member and transfers tags',()=>{
 let id=-10;
 const rings=[square(0,0,10,10).outer,square(2,2,4,4).outer].map(r=>r.map(p=>({p,id:id--})));
 const tags={indoor:'room',level:'1',name:'Office'};
 const converted=indoorUnionHoleEdits({key:'way/42',kind:'room',tags,polygons:[],levels:[1]},tags,rings,()=>id--);
 assert.deepEqual(converted.feature.tags,{...tags,type:'multipolygon'});
 assert.equal(converted.feature.polygons[0].inners.length,1);
 const relation=converted.edits.find(e=>e.key===converted.key).create;
 assert.deepEqual(relation.relMembers[0],{type:'way',ref:42,role:'outer'});
 assert.equal(relation.relMembers[1].role,'inner');
 assert.deepEqual(converted.edits[0].tags,{});
});

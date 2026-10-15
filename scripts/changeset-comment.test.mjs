import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createServer } from 'vite';
let vite, suggestComment, isIndoorChange;
const ctx={groupOf:()=>undefined,isGroup:()=>false,buildingName:()=>undefined};
const change=(key,before,after,extra={})=>({key,feature:{key,version:1,tags:after},before,after,created:false,diff:[...new Set([...Object.keys(before),...Object.keys(after)])].filter(k=>before[k]!==after[k]).map(tag=>({tag,from:before[tag],to:after[tag]})),...extra});
before(async()=>{
 globalThis.localStorage={getItem:()=> 'en'};
 vite=await createServer({configFile:false,server:{middlewareMode:true,ws:false,watch:null},appType:'custom'});
 ({suggestComment,isIndoorChange}=await vite.ssrLoadModule('/src/edit/changeset-comment.ts'));
});
after(async()=>{await vite.close();delete globalThis.localStorage;});
test('door attributes and deleted indoor wall lines are described as indoor components',()=>{
 const door=change('node/1',{door:'revolving',diameter:'2'},{door:'revolving',diameter:'3'});
 const wall=change('way/2',{indoor:'wall',level:'0'},{},{deleted:true,feature:{key:'way/2',tags:{},line:{ids:[1,2],coords:[[0,0],[1,0]]}}});
 assert.ok(isIndoorChange(wall));
 const text=suggestComment([door,wall],ctx);
 assert.match(text,/tags edited: doors \(1\)/);
 assert.match(text,/deleted: walls \(1\)/);
 assert.doesNotMatch(text,/buildings/);
});
test('created rooms and moved doors use the appropriate actions',()=>{
 const text=suggestComment([
 change('way/-1',{}, {indoor:'room',level:'0'},{created:true}),
 change('node/1',{door:'yes'},{door:'yes'},{nodeMoves:[{id:1,from:[0,0],to:[1,1]}]}),
 ],ctx);
 assert.match(text,/added: rooms \(1\)/);
 assert.match(text,/geometry changed: doors \(1\)/);
});
test('mixed indoor and building edits retain both subjects and respect the length limit',()=>{
 const edits=[change('node/1',{door:'yes'},{door:'revolving'}),change('way/1',{building:'yes',height:'3'},{building:'yes',height:'4'})];
 const text=suggestComment(edits,ctx);
 assert.match(text,/doors/);assert.match(text,/buildings/);assert.ok(text.length<=250);
 const many=Array.from({length:100},(_,i)=>change(`way/${i+10}`,{building:'yes',height:'3'},{building:'yes',height:'4'}));
 const long=suggestComment([...edits,...many],{...ctx,groupOf:key=>key.startsWith('way/')?`relation/${key}`:undefined,buildingName:()=> 'A very long building name repeated across many buildings'});
 assert.match(long,/doors/);assert.match(long,/building/);assert.ok(long.length<=250);
});
test('indoor tag fixes retain their concise existing description',()=>{
 assert.equal(suggestComment([change('node/1',{indoor:'door',entrance:'yes'},{indoor:'door',door:'yes'})],ctx),'Indoor tags fixes');
});
test('ordinary building edits keep their previous description',()=>{
 const text=suggestComment([change('way/1',{building:'yes',height:'3'},{building:'yes',height:'4'})],ctx);
 assert.match(text,/individual buildings/);assert.doesNotMatch(text,/Indoor/);
});

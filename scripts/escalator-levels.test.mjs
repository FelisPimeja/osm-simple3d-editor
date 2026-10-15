import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {before,after,test} from 'node:test';
import {createServer} from 'vite';
let vite,syncEscalatorLevels,escalatorAreaMatches,EditSession;
before(async()=>{
 vite=await createServer({configFile:false,server:{middlewareMode:true,ws:false,watch:null},appType:'custom'});
 ({syncEscalatorLevels,escalatorAreaMatches}=await vite.ssrLoadModule('/src/edit/escalator-levels.ts'));
 ({EditSession}=await vite.ssrLoadModule('/src/edit/session.ts'));
});
after(async()=>await vite.close());
const data=JSON.parse(readFileSync(new URL('./fixtures/escalator-levels.json',import.meta.url)));
const axis=data.find(f=>f.escalator), area=data.find(f=>!f.escalator);
test('real axis 1319556733 and contour 18104179 change together and undo atomically',()=>{
 assert.ok(escalatorAreaMatches(axis,area));
 const edits=syncEscalatorLevels([{key:axis.key,tags:{...axis.tags,level:'2;3'}}],data);
 assert.equal(edits.length,2);
 assert.deepEqual(edits.find(e=>e.key===area.key).tags,{...area.tags,level:'2;3'});
 const features=data.map(f=>({...f,type:f.key.split('/')[0],id:Number(f.key.split('/')[1]),version:1}));
 const session=new EditSession(features,()=>{});
 session.editMany(edits);
 assert.equal(session.get(axis.key).tags.level,'2;3');
 assert.equal(session.get(area.key).tags.level,'2;3');
 session.undo();
 assert.equal(session.get(axis.key).tags.level,'3;4');
 assert.equal(session.get(area.key).tags.level,'3;4');
 session.redo();
 assert.equal(session.get(area.key).tags.level,'2;3');
});
test('geometry still links a contour whose old level no longer matches the axis',()=>{
 const moved={...axis,tags:{...axis.tags,level:'1;2'},levels:[1,2]};
 const edits=syncEscalatorLevels([{key:axis.key,tags:moved.tags}],[moved,area],true);
 assert.equal(edits.find(e=>e.key===area.key).tags.level,'1;2');
});
test('editing width does not overwrite a contour level, and unrelated areas stay unchanged',()=>{
 assert.equal(syncEscalatorLevels([{key:axis.key,tags:{...axis.tags,width:'1.5'}}],data).length,1);
 const unrelated={...area,key:'relation/2',polygons:area.polygons.map(p=>({outer:p.outer.map(([x,y])=>[x+1,y]),inners:[]}))};
 const edits=syncEscalatorLevels([{key:axis.key,tags:{...axis.tags,level:'1;2'}}],[...data,unrelated]);
 assert.ok(!edits.some(e=>e.key===unrelated.key));
});

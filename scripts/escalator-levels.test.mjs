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
 assert.ok(escalatorAreaMatches(axis,area,data));
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

// Единое правило пары (docs/indoor-stairs.md): уровни контура следуют за осью, только если ось проходит через контур
// от стороны до стороны; контур, в котором ось только начинается или кончается, — не пара
test('levels follow the axis only into a contour the axis crosses from side to side',()=>{
 const kx=Math.cos(55*Math.PI/180)*111320,ll=(x,y)=>[37+x/kx,55+y/111320];
 const ax={key:'way/10',kind:'area',line:true,escalator:true,tags:{highway:'steps',conveying:'yes',incline:'up',level:'0;1'},levels:[0,1],polygons:[{outer:[ll(0,1),ll(4,1)],inners:[]}]};
 const rect=(key,x0,x1)=>({key,kind:'area',tags:{indoor:'area',conveying:'yes',level:'0;1'},levels:[0,1],polygons:[{outer:[ll(x0,0),ll(x1,0),ll(x1,2),ll(x0,2)],inners:[]}]});
 const pair=rect('way/11',0,4), loose=rect('way/12',1,9);
 assert.ok(escalatorAreaMatches(ax,pair,[ax,pair]));
 assert.ok(!escalatorAreaMatches(ax,loose,[ax,loose]));
 const edits=syncEscalatorLevels([{key:ax.key,tags:{...ax.tags,level:'1;2'}}],[ax,pair,loose]);
 assert.equal(edits.find(e=>e.key==='way/11')?.tags.level,'1;2');
 assert.ok(!edits.some(e=>e.key==='way/12'));
});

import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {createServer} from 'vite';
let vite,validateIndoor;
before(async()=>{vite=await createServer({configFile:false,server:{middlewareMode:true,ws:false,watch:null},appType:'custom'});({validateIndoor}=await vite.ssrLoadModule('/src/edit/validate.ts'));});
after(async()=>await vite.close());
test('wall or column with room purpose gets one explicit warning without automatic retagging',()=>{
 for(const indoor of ['wall','column']) {
  const tags={indoor,room:'stairs',level:'0'};
  const issues=validateIndoor({key:'way/1572204863',tags}).filter(i=>i.code==='indoor-room');
  assert.equal(issues.length,1);assert.equal(issues[0].level,'warning');
  assert.ok(issues[0].text.includes('stairs'));assert.ok(issues[0].text.includes(indoor));
  assert.equal(issues[0].fix,undefined);assert.equal(tags.indoor,indoor);
 }
});
test('normal stairs rooms and walls without room purpose are not flagged',()=>{
 for(const tags of [{indoor:'room',room:'stairs',level:'0'},{indoor:'wall',level:'0'}])
  assert.equal(validateIndoor({key:'way/1',tags}).filter(i=>i.code==='indoor-room').length,0);
});

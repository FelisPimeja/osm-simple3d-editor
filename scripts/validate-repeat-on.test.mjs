import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {createServer} from 'vite';
let vite,validateIndoor;
before(async()=>{vite=await createServer({configFile:false,server:{middlewareMode:true,ws:false,watch:null},appType:'custom'});({validateIndoor}=await vite.ssrLoadModule('/src/edit/validate.ts'));});
after(async()=>await vite?.close());
const fixOf=(key,tags)=>validateIndoor({key,tags}).find(i=>/repeat_on=\*/.test(i.text)&&i.fix)?.fix?.tags;
test('door with the same range in level and repeat_on: level is the lowest, repeat_on the rest (node/11961694570)',()=>{
 assert.deepEqual(fixOf('node/1',{indoor:'door',level:'-1-4',repeat_on:'-1-4'}),{level:'-1',repeat_on:'0;1;2;3;4'});
});
test('repeat_on overlapping level: the original floor leaves the copies',()=>{
 assert.deepEqual(fixOf('way/1',{indoor:'room',level:'0',repeat_on:'0;1;2'}),{repeat_on:'1;2'});
});
test('repeat_on only repeating level: repeat_on is removed',()=>{
 assert.deepEqual(fixOf('way/1',{indoor:'room',level:'1',repeat_on:'1'}),{repeat_on:undefined});
});

import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {createServer} from 'vite';
let vite, otherTagEntries, renderOtherTags, bindOtherTags, multiTagValues, renderMultiOtherTags;
before(async()=>{
 globalThis.localStorage={getItem:()=> 'en'};
 vite=await createServer({configFile:false,server:{middlewareMode:true,ws:false,watch:null},appType:'custom'});
 ({otherTagEntries,renderOtherTags,bindOtherTags,multiTagValues,renderMultiOtherTags}=await vite.ssrLoadModule('/src/edit/other-tags.ts'));
});
after(async()=>{await vite.close();delete globalThis.localStorage;});
test('only visible specialized fields are excluded, including indoor fields',()=>{
 const tags={height:'5',name:'Tower',door:'yes',source:'survey'};
 assert.deepEqual(otherTagEntries(tags,'<input data-tag="height"><input data-indoor-tag="door">'),[['name','Tower'],['source','survey']]);
 assert.deepEqual(otherTagEntries({name:'A'},''),[['name','A']]);
});
test('Other tags is expanded, editable, escaped, with add and delete controls',()=>{
 const html=renderOtherTags('way/1',{height:'5','x"':'<script>'},'<input data-tag="height">');
 assert.doesNotMatch(html,/<details|<summary|data-other-value="height"/);
 assert.match(html,/Other tags/);
 assert.match(html,/data-other-value="x&quot;"/);
 assert.match(html,/&lt;script&gt;/);
 assert.match(html,/data-other-delete/);
 assert.match(html,/data-other-new-key/);
 assert.match(html,/data-other-new-value/);
 assert.match(renderOtherTags('node/1',{},'',true),/data-other-indoor/);
});
test('value edits and removal use the supplied undoable edit callback',()=>{
 const handlers={}, writes=[];
 const container={addEventListener:(name,fn)=>handlers[name]=fn};
 const box={dataset:{otherKey:'way/1'},hasAttribute:()=>false};
 bindOtherTags(container,()=>({name:'Before'}),(...args)=>writes.push(args));
 const input={dataset:{otherValue:'name'},value:'After',closest:()=>box};
 handlers.change({target:input});
 assert.deepEqual(writes.pop(),['way/1','name','After',false]);
 input.value='';handlers.change({target:input});
 assert.deepEqual(writes.pop(),['way/1','name',undefined,false]);
});
test('Enter saves explicitly; Escape restores the stored value',()=>{
 const handlers={}, writes=[];
 const box={dataset:{otherKey:'way/1'},hasAttribute:()=>false};
 bindOtherTags({addEventListener:(n,fn)=>handlers[n]=fn},()=>({name:'Stored'}),(...args)=>writes.push(args));
 const input={dataset:{otherValue:'name'},value:'Changed',closest:()=>box,hasAttribute:n=>n==='data-other-value',blur:()=>{}};
 handlers.keydown({target:input,key:'Enter',preventDefault(){}});
 assert.deepEqual(writes.pop(),['way/1','name','Changed',false]);
 input.value='Unsaved';handlers.keydown({target:input,key:'Escape',preventDefault(){}});
 assert.equal(input.value,'Stored');assert.equal(writes.length,0);
});
test('add prevents duplicate or malformed keys without overwriting a tag',()=>{
 const handlers={}, writes=[];
 const box={dataset:{otherKey:'way/1'},hasAttribute:()=>false};
 bindOtherTags({addEventListener:(n,fn)=>handlers[n]=fn},()=>({name:'Stored'}),(...args)=>writes.push(args));
 let error='';
 const key={value:'name',setCustomValidity:s=>error=s,reportValidity(){}};
 const value={value:'Replacement'};
 const form={matches:()=>true,closest:()=>box,querySelector:s=>s==='[data-other-new-key]'?key:value};
 const submit=()=>handlers.submit({target:form,preventDefault(){}});
 submit();assert.ok(error);assert.equal(writes.length,0);
 key.value='bad key';submit();assert.ok(error);assert.equal(writes.length,0);
 key.value='note';submit();assert.equal(error,'');assert.deepEqual(writes.pop(),['way/1','note','Replacement',false]);
});

test('multi-selection uses all keys and marks absent or unequal values as mixed',()=>{
 const result=multiTagValues([{indoor:'area',level:'0',name:'A',source:'survey'},{indoor:'area',level:'0',name:'B',note:'check'}]);
 assert.deepEqual(result.tags,{indoor:'area',level:'0',name:'',source:'',note:''});
 assert.deepEqual([...result.mixed].sort(),['name','note','source']);
});
test('multi-selection Other tags renders non-shared keys, excluding specialized widgets',()=>{
 const html=renderMultiOtherTags([{indoor:'wall',level:'0',room:'stairs'},{indoor:'wall',level:'0',material:'brick'}],'<input data-indoor-tag="indoor"><input data-indoor-tag="level">',true);
 assert.match(html,/data-other-key="@selection"/);
 assert.match(html,/data-other-indoor/);
 assert.match(html,/data-other-value="room" value="" class="mixed"/);
 assert.match(html,/data-other-value="material" value="" class="mixed"/);
 assert.doesNotMatch(html,/data-other-value="level"/);
 assert.match(html,/placeholder="[^"]+"/);
});

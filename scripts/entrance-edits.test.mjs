import assert from 'node:assert/strict';import{test}from'node:test';import{withEntranceTags}from'../src/edit/entrance-edits.ts';
const f={key:'relation/17948500',polygons:[{outer:[[0,0],[1,0],[1,1]],outerIds:[1,2,3],inners:[]}]};
const tags={entrance:'main'},fallback=[{id:2,tags}];
test('restored session geometry retains loaded entrances before the shared registry is ready',()=>{
 const result=withEntranceTags(f,new Map(),new Map(),fallback);
 assert.deepEqual(result.entrances,fallback);assert.equal(f.entrances,undefined);
});
test('node edits override or remove an entrance without resurrecting loaded tags',()=>{
 assert.equal(withEntranceTags(f,new Map([[2,{door:'yes'}]]),new Map(),fallback).entrances,undefined);
 const edited={entrance:'service'};
 assert.equal(withEntranceTags(f,new Map([[2,edited]]),new Map([[2,tags]]),fallback).entrances[0].tags,edited);
});

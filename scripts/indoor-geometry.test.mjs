import assert from 'node:assert/strict';
import {test} from 'node:test';
import {editIndoorGeometry} from '../src/edit/indoor-geometry.ts';
const room=(key,coords,ids,extra={})=>({key,kind:'room',levels:[0],tags:{indoor:'room',level:'0',height:'3'},polygons:[{outer:coords,outerIds:ids,inners:[],innerIds:[]}],...extra});
const a=()=>room('way/1',[[0,0],[2,0],[2,2],[0,2]],[1,2,3,4]);
const b=()=>room('way/2',[[2,0],[4,0],[4,2],[2,2]],[2,5,6,3]);
const vert=(key,i)=>({key,poly:0,ring:0,i});
let id=-1;const fresh=()=>id--;
const move=(vertices,delta)=>({type:'move',vertices,delta});
test('room movement retains tags and has immutable inputs',()=>{
 const all=[a()],before=structuredClone(all);
 const edits=editIndoorGeometry(all,move([0,1,2,3].map(i=>vert('way/1',i)),[1,0]),true,fresh);
 assert.deepEqual(edits[0].polygons[0].outer,[[1,0],[3,0],[3,2],[1,2]]);
 assert.equal(edits[0].tags,undefined);assert.deepEqual(all,before);
});
test('shared wall follows moved vertices with glue, detaches without it',()=>{
 const op=move([vert('way/1',1),vert('way/1',2)],[.5,0]);
 const glued=editIndoorGeometry([a(),b()],op,true,fresh);
 assert.equal(glued.length,2);assert.deepEqual(glued[1].polygons[0].outer[0],[2.5,0]);
 const detached=editIndoorGeometry([a(),b()],op,false,fresh);
 assert.equal(detached.length,1);assert.ok(detached[0].polygons[0].outerIds[1]<0);
});
test('open two-node wall remains an open line; insertion and removal work',()=>{
 const wall=room('way/3',[[0,0],[2,0]],[10,11],{kind:'wall',line:true});
 const moved=editIndoorGeometry([wall],move([vert(wall.key,1)],[0,1]),true,fresh)[0];
 assert.deepEqual(moved.line.coords,[[0,0],[2,1]]);assert.equal(moved.polygons,undefined);
 const inserted=editIndoorGeometry([wall],{type:'insert',vertex:vert(wall.key,0),fraction:.5,at:[1,0]},true,fresh)[0];
 const withNode={...wall,polygons:[{outer:inserted.line.coords,outerIds:inserted.line.ids,inners:[],innerIds:[]}]};
 assert.equal(inserted.line.coords.length,3);
 assert.equal(editIndoorGeometry([withNode],{type:'remove',vertices:[vert(wall.key,1)]},true,fresh)[0].line.ids.length,2);
 assert.throws(()=>editIndoorGeometry([wall],{type:'remove',vertices:[vert(wall.key,0)]},true,fresh),/мало/);
 assert.throws(()=>editIndoorGeometry([wall],{type:'insert',vertex:vert(wall.key,1),fraction:.5,at:[1,0]},true,fresh),/замыкающего/);
});
test('shared side insertion uses the same new node in opposite-direction room ring',()=>{
 const edits=editIndoorGeometry([a(),b()],{type:'insert',vertex:vert('way/1',1),fraction:.5,at:[2,1]},true,fresh);
 assert.equal(edits.length,2);
 const ids=edits.map(e=>e.polygons[0].outerIds.find(n=>n<0));assert.equal(ids[0],ids[1]);
});
test('door on the side follows affine deformation of that side',()=>{
 const door={key:'node/20',kind:'poi',point:[2,1],levels:[0],tags:{door:'yes',level:'0'},polygons:[]};
 const edits=editIndoorGeometry([a(),door],move([vert('way/1',1)],[1,0]),true,fresh);
 assert.deepEqual(edits.find(e=>e.key===door.key).polygons[0].outer,[[2.5,1]]);
});
test('rejects self-intersections and degeneration; detaches shared nodes of another floor',()=>{
 assert.throws(()=>editIndoorGeometry([a()],move([vert('way/1',0)],[3,1]),true,fresh),/пересекать/);
 const triangle=room('way/4',[[0,0],[1,0],[0,1]],[1,2,3]);
 assert.throws(()=>editIndoorGeometry([triangle],{type:'remove',vertices:[vert('way/4',0)]},true,fresh),/мало/);
 const upstairs={...b(),levels:[1]};
 const safe=editIndoorGeometry([a(),upstairs],move([vert('way/1',1)],[1,0]),true,fresh);
 assert.equal(safe.length,1);assert.ok(safe[0].polygons[0].outerIds[1]<0);
});
test('separate mode keeps a tagged shared door node at the original wall',()=>{
 const door={key:'node/2',kind:'poi',point:[2,0],levels:[0],tags:{door:'yes'},polygons:[]};
 const edits=editIndoorGeometry([a(),b(),door],move([vert('way/1',1)],[.5,0]),false,fresh);
 assert.equal(edits.length,1);assert.notEqual(edits[0].polygons[0].outerIds[1],2);
});
test('multi-level object is edited once and keeps its level list',()=>{
 const f={...a(),levels:[0,1],tags:{indoor:'room',level:'0;1'}};
 const edits=editIndoorGeometry([f],move([0,1,2,3].map(i=>vert(f.key,i)),[1,0]),true,fresh);
 assert.equal(edits.length,1);assert.equal(edits[0].tags,undefined);assert.equal(f.tags.level,'0;1');
});
test('closed wall lines keep closure when moving or removing their first node',()=>{
 const wall=room('way/3',[[0,0],[2,0],[2,2],[0,2],[0,0]],[1,2,3,4,1],{line:true,kind:'wall'});
 const moved=editIndoorGeometry([wall],move([vert(wall.key,0)],[.2,.2]),false,fresh)[0];
 assert.deepEqual(moved.line.coords[0],moved.line.coords.at(-1));
 const removed=editIndoorGeometry([wall],{type:'remove',vertices:[vert(wall.key,0)]},true,fresh)[0];
 assert.deepEqual(removed.line.ids,[2,3,4,2]);
});
test('multipolygon ring edits can be passed to the member-way topology layer',()=>{
 const relation={...a(),key:'relation/1'};
 const edit=editIndoorGeometry([relation],{type:'insert',vertex:vert(relation.key,0),at:[1,0],fraction:.5},true,fresh,true)[0];
 assert.equal(edit.polygons[0].outer.length,5);
 assert.ok(edit.polygons[0].outerIds[1]<0);
});

test('removing vertices collapses an inner ring without deleting the outer ring',()=>{
 const f=a();f.polygons[0].inners=[[[.5,.5],[1,.5],[1,1],[.5,1]]];f.polygons[0].innerIds=[[10,11,12,13]];
 const op={type:'remove',vertices:[{key:f.key,poly:0,ring:1,i:0},{key:f.key,poly:0,ring:1,i:1}]};
 const before=structuredClone(f);
 const result=editIndoorGeometry([f],op,true,fresh)[0].polygons[0];
 assert.deepEqual(result.inners,[]);assert.deepEqual(result.outer,f.polygons[0].outer);assert.deepEqual(f,before);
 const rel={...f,key:'relation/18372778'};
 const edits=editIndoorGeometry([rel],{...op,vertices:op.vertices.map(v=>({...v,key:rel.key}))},true,fresh,true);
 assert.deepEqual(edits[0].polygons[0].innerIds,[[]]);
});

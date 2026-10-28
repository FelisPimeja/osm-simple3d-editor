import assert from 'node:assert/strict';
import {test} from 'node:test';
import {pointWallRings,insertWallPoint} from '../src/edit/point-wall-rings.ts';
const polygon=(outer,outerIds)=>({outer,outerIds,inners:[],innerIds:[]});
const wall={key:'way/1',kind:'wall',line:true,tags:{indoor:'wall',level:'0'},levels:[0],polygons:[polygon([[0,0],[2,0],[2,2]],[1,2,3])]};
test('open linear walls are eligible and have no imaginary closing segment',()=>{
 const rings=pointWallRings(wall);assert.equal(rings.length,1);assert.equal(rings[0].edges,2);
 const e=insertWallPoint(wall,[{polygon:0,ring:0,edge:0}],[1,0],-1);
 assert.deepEqual(e.line.ids,[1,-1,2,3]);assert.deepEqual(e.line.coords,e.polygons[0].outer);
 assert.deepEqual(wall.polygons[0].outerIds,[1,2,3]);
});
test('multipolygon room boundaries and holes retain their polygon indices',()=>{
 const room={...wall,key:'relation/1',kind:'room',line:false,polygons:[wall.polygons[0],{...polygon([[4,0],[6,0],[6,2]],[4,5,6]),inners:[[[4.5,.5],[5,.5],[5,1]]],innerIds:[[7,8,9]]}]};
 assert.deepEqual(pointWallRings(room).map(r=>[r.polygon,r.ring,r.edges]),[[0,0,3],[1,0,3],[1,1,3]]);
 const e=insertWallPoint(room,[{polygon:1,ring:1,edge:0}],[4.75,.5],-1);
 assert.deepEqual(e.polygons[1].innerIds,[[7,-1,8,9]]);assert.deepEqual(e.polygons[0],room.polygons[0]);assert.equal(e.line,undefined);
});
test('solid polygon walls are eligible; POIs are excluded',()=>{
 assert.equal(pointWallRings({...wall,line:false}).length,1);
 assert.equal(pointWallRings({...wall,point:[0,0],kind:'poi'}).length,0);
});

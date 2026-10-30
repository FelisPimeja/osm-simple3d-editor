import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {createServer} from 'vite';
let vite,solidWall,isClosedIndoorWall,parseBuildings,withIndoorTags;
before(async()=>{vite=await createServer({configFile:false,server:{middlewareMode:true,ws:false,watch:null},appType:'custom'});({solidWall}=await vite.ssrLoadModule('/src/edit/solid-wall-doors.ts'));({isClosedIndoorWall}=await vite.ssrLoadModule('/src/edit/indoor-union.ts'));({parseBuildings,withIndoorTags}=await vite.ssrLoadModule('/src/osm/model.ts'));});
after(async()=>await vite.close());
const elements=[...[[0,0],[1,0],[1,1],[0,1]].map(([lon,lat],i)=>({type:'node',id:i+1,lon,lat})),{type:'way',id:10,version:1,nodes:[1,2,3,4,1],tags:{indoor:'wall',level:'0'}}];
test('closed way defaults to solid without writing area=yes',()=>{
 const f=parseBuildings(elements).indoor[0];
 assert.equal(solidWall(f),true);assert.equal(isClosedIndoorWall(f),true);assert.equal(f.tags.area,undefined);
});
test('area=no preserves the closed line but disables solid interpretation; yes restores it',()=>{
 const f=parseBuildings(elements).indoor[0];
 const line=withIndoorTags(f,{...f.tags,area:'no'});
 assert.equal(line.tags.area,'no');assert.equal(line.line,true);
 assert.deepEqual(line.polygons[0].outerIds,[1,2,3,4,1]);
 assert.equal(solidWall(line),false);assert.equal(isClosedIndoorWall(line),false);
 assert.equal(solidWall(withIndoorTags(line,{...line.tags,area:'yes'})),true);
});
test('area=no on a multipolygon does not turn it into a linear wall',()=>{
 const f={key:'relation/1',kind:'wall',tags:{indoor:'wall',area:'no'},levels:[0],polygons:[{outer:[[0,0],[1,0],[1,1],[0,1]],inners:[]}]};
 assert.equal(solidWall(f),true);
});

test('indoor railing is parsed as an editable line even when closed',()=>{
 const data=structuredClone(elements);data.at(-1).tags={barrier:'fence',fence_type:'railing',indoor:'yes',level:'1'};
 const f=parseBuildings(data).indoor[0];
 assert.equal(f.line,true);assert.equal(f.kind,'wall');assert.deepEqual(f.levels,[1]);
 assert.equal(solidWall(f),false);assert.equal(isClosedIndoorWall(f),false);
 assert.deepEqual(f.tags,data.at(-1).tags);
});

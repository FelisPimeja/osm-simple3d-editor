import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {createServer} from 'vite';
let vite,parseBuildings,isIndoorPoi;
before(async()=>{vite=await createServer({configFile:false,server:{middlewareMode:true,ws:false,watch:null},appType:'custom'});({parseBuildings,isIndoorPoi}=await vite.ssrLoadModule('/src/osm/model.ts'));});
after(async()=>await vite.close());
for (const room of ['stairs', 'elevator']) test(`${room} room produces a polygon and a companion icon marker on load`,()=>{
 const nodes=[[0,0],[1,0],[1,1],[0,1]].map(([lon,lat],i)=>({type:'node',id:i+1,lon,lat}));
 const tags={indoor:'room',room,level:'0;1'};
 assert.equal(isIndoorPoi(tags),true);
 const result=parseBuildings([...nodes,{type:'way',id:1572204846,version:1,nodes:[1,2,3,4,1],tags}]);
 const marker=result.indoor.find(f=>f.key==='way/1572204846#poi');
 assert.ok(marker?.point);assert.equal(marker.kind,'poi');assert.deepEqual(marker.levels,[0,1]);
 assert.ok(result.indoor.find(f=>f.key==='way/1572204846').polygons.length);
});

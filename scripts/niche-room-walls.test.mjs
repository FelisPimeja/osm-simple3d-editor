import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import fs from 'node:fs';
import {createServer} from 'vite';
import * as T from 'three';
let v,parseBuildings,BuildingsLayer;
before(async()=>{globalThis.window={};v=await createServer({configFile:false,server:{middlewareMode:true,ws:false,watch:null},appType:'custom'});({parseBuildings}=await v.ssrLoadModule('/src/osm/model.ts'));({BuildingsLayer}=await v.ssrLoadModule('/src/render/buildings-layer.ts'));});
after(async()=>{await v.close();delete globalThis.window;});
test('real niche and neighbouring room boundaries retain their wall faces',()=>{
 const data=parseBuildings(JSON.parse(fs.readFileSync(new URL('./fixtures/niche-rooms.json',import.meta.url))));
 const layer=new BuildingsLayer('test');layer.setFocus(data.features);
 const items=data.indoor.filter(f=>f.kind==='room').map(f=>({...f,z:0}));
 layer.setLevel({floor:0,cut:3,items,doors:[]});
 const g=layer.groups.get('@focus'),tri=layer.indoorWallPositions;
 const failures=[];
 for(const it of items)for(const p of it.polygons)for(const r of [p.outer,...p.inners]){
  const pts=r.map(g.toLocal);
  for(let i=0;i<pts.length;i++){
   const a=pts[i],b=pts[(i+1)%pts.length],dx=b[0]-a[0],dy=b[1]-a[1],len=Math.hypot(dx,dy);
   if(len<.03)continue;
   const mid=[(a[0]+b[0])/2,(a[1]+b[1])/2];
   const ray=new T.Ray(new T.Vector3(mid[0]+dy/len*.01,mid[1]-dx/len*.01,1),new T.Vector3(-dy/len,dx/len,0));
   let hit=false;
   for(let j=0;j<tri.length;j+=9){const q=new T.Vector3();
    if(ray.intersectTriangle(new T.Vector3().fromArray(tri,j),new T.Vector3().fromArray(tri,j+3),new T.Vector3().fromArray(tri,j+6),false,q)&&q.distanceTo(ray.origin)<.02){hit=true;break;}
   }
   if(!hit)failures.push(`${it.key} edge ${i}, length ${len.toFixed(3)}`);
  }
 }
 assert.deepEqual(failures,[]);
});

import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {before,after,test} from 'node:test';
import {createServer} from 'vite';
let vite,BuildingsLayer,parseBuildings;
before(async()=>{globalThis.window={};vite=await createServer({configFile:false,server:{middlewareMode:true,ws:false,watch:null},appType:'custom'});({BuildingsLayer}=await vite.ssrLoadModule('/src/render/buildings-layer.ts'));({parseBuildings}=await vite.ssrLoadModule('/src/osm/model.ts'));});
after(async()=>{delete globalThis.window;await vite.close();});
for(const wire of [false,true])test(`17963272 entrance rooms retain depth-tested floor contacts, wireframe=${wire}`,()=>{
 const {features,indoor}=parseBuildings(JSON.parse(readFileSync(new URL('./fixtures/wall-bases-17963272.json',import.meta.url))));
 const layer=new BuildingsLayer('test');layer.setGraphics({edges:true});layer.setFocus(features);
 layer.map={getCanvas:()=>({width:1600,height:1200,clientWidth:800}),triggerRepaint(){}};
 layer.setLevel({floor:0,cut:3.5,items:indoor.filter(f=>!f.point).map(f=>({...f,z:0})),doors:indoor.filter(f=>f.point&&f.tags.door).map(f=>f.point)});
 layer.setWireframe(wire);
 const contact=layer.indoorObj.getObjectByName('indoor-floor-contact');assert.ok(contact);
 assert.equal(contact.material.linewidth,2,'one CSS pixel at device pixel ratio 2');
 assert.equal(contact.material.depthTest,true);assert.equal(contact.material.depthWrite,false);
 const shader={vertexShader:'gl_Position = clip;'};contact.material.onBeforeCompile(shader);
 assert.ok(shader.vertexShader.includes('gl_Position.z -= 2e-6 * gl_Position.w'));
 assert.equal(contact.renderOrder,999);
 const g=[...layer.groups.values()].find(g=>g.byKey.has('relation/17963272'));
 const a=contact.geometry.getAttribute('instanceStart'),b=contact.geometry.getAttribute('instanceEnd');
 for(const key of ['relation/17963270','relation/17963271']){
  const room=indoor.find(f=>f.key===key),r=room.polygons[0].outer.map(g.toLocal);
  // Midpoint of the uninterrupted side wall, away from both door openings.
  const target=[(r[2][0]+r[3][0])/2,(r[2][1]+r[3][1])/2];let distance=Infinity;
  for(let i=0;i<a.count;i++){
   const dx=b.getX(i)-a.getX(i),dy=b.getY(i)-a.getY(i),len=dx*dx+dy*dy;if(len<1e-8)continue;
   const t=Math.max(0,Math.min(1,((target[0]-a.getX(i))*dx+(target[1]-a.getY(i))*dy)/len));
   distance=Math.min(distance,Math.hypot(target[0]-a.getX(i)-t*dx,target[1]-a.getY(i)-t*dy));
  }
  assert.ok(distance<.001,`${key}: missing contact edge`);
 }
});

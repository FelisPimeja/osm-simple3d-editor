import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {createServer} from 'vite';
import * as THREE from 'three';
import {wireframeEdges} from '../src/render/wireframe-edges.ts';
let vite,BuildingsLayer;
before(async()=>{globalThis.window={};vite=await createServer({configFile:false,server:{middlewareMode:true,ws:false,watch:null},appType:'custom'});({BuildingsLayer}=await vite.ssrLoadModule('/src/render/buildings-layer.ts'));});
after(async()=>{delete globalThis.window;await vite.close();});
const line=positions=>new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position',new THREE.Float32BufferAttribute(positions,3)),new THREE.LineBasicMaterial());
test('hidden wire edges omit lower plans and clip structural edges at the current floor',()=>{
 const root=new THREE.Group(),below=new THREE.Group();below.userData.indoorBelow=true;
 below.add(line([0,0,-3,1,0,-3]));root.add(below,line([0,0,-2,0,0,2]),line([0,0,1,1,0,1]));
 assert.deepEqual([...wireframeEdges([root],0)],[0,0,0,0,0,2,0,0,1,1,0,1]);
});
test('wire pass removes indoor wall and floor colours while preserving depth and restores materials',()=>{
 const layer=new BuildingsLayer('test');
 const polygons=[{outer:[[37,55],[37.0001,55],[37.0001,55.0001],[37,55.0001]],inners:[]}];
 layer.setFocus([{key:'way/1',kind:'building',tags:{building:'yes',height:'9'},hasParts:false,polygons}]);
 layer.map={getCanvas:()=>({width:800,height:600,clientWidth:800}),triggerRepaint(){}};
 layer.setLevel({floor:0,cut:3.5,items:[{key:'room',kind:'room',z:0,polygons,colour:0xff0000}],doors:[]});
 layer.setWireframe(true);
 const g=[...layer.groups.values()].find(g=>g.byKey.has('way/1'));
 const fills=[];layer.indoorObj.traverse(o=>{if(o instanceof THREE.Mesh&&!o.material.isLineMaterial)fills.push([o,o.material,o.renderOrder]);});
 assert.ok(fills.length>=2);
 const restore=layer.filterPass(g,'wire');
 // Цветная грань фасада в каркасе спрятана (в глубину она мерцала бы с оболочкой), остальные — только глубина
 for(const [o] of fills){if(o.name==='indoor-facade-tint'){assert.equal(o.visible,false);continue;}assert.equal(o.material.colorWrite,false);assert.equal(o.material.depthWrite,true);assert.equal(o.renderOrder,-1000);}
 assert.equal(g.wireHidden.material.depthFunc,THREE.GreaterDepth);
 assert.ok(g.wireHidden.geometry.getAttribute('lineDistance'));
 restore();for(const [o,m,order] of fills){assert.equal(o.material,m);assert.equal(o.renderOrder,order);assert.equal(o.visible,true);}
 layer.setWireframe(false);assert.equal(g.wireHidden,undefined);
});
for(const wire of [false,true])test(`current floor keeps exterior corner ribs, wireframe=${wire}`,()=>{
 const layer=new BuildingsLayer('test');layer.setGraphics({edges:true});
 const polygons=[{outer:[[37,55],[37.0001,55],[37.0001,55.0001],[37,55.0001]],inners:[]}];
 layer.setFocus([{key:'way/1',kind:'building',tags:{building:'yes',height:'9'},hasParts:false,polygons}]);
 layer.map={getCanvas:()=>({width:800,height:600,clientWidth:800}),triggerRepaint(){}};
 layer.setLevel({floor:0,cut:3.5,items:[{key:'room',kind:'room',z:0,polygons}],doors:[]});
 layer.setWireframe(wire);
 const g=[...layer.groups.values()].find(g=>g.byKey.has('way/1'));
 const p=g.edges.geometry.getAttribute('position');let corners=0;
 for(let i=0;i+1<p.count;i+=2){
  if(Math.hypot(p.getX(i)-p.getX(i+1),p.getY(i)-p.getY(i+1))>.0001)continue;
  if(Math.min(p.getZ(i),p.getZ(i+1))<.01&&Math.max(p.getZ(i),p.getZ(i+1))>3.39)corners++;
 }
 assert.equal(corners,4,'all four facade corners must continue through the current storey');
});

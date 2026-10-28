import assert from 'node:assert/strict';import {before,after,test} from 'node:test';import {createServer} from 'vite';import * as THREE from 'three';
let v,BuildingsLayer;
before(async()=>{globalThis.window={};v=await createServer({configFile:false,server:{middlewareMode:true,ws:false,watch:null},appType:'custom'});({BuildingsLayer}=await v.ssrLoadModule('/src/render/buildings-layer.ts'));});
after(async()=>{await v.close();delete globalThis.window;});
for(const pale of [false,true])test(`door opening has a contour without selectable door metadata, pale=${pale}`,()=>{
 const layer=new BuildingsLayer('test');layer.graphics.edges=true;
 layer.map={getCanvas:()=>({width:800,height:600,clientWidth:800,clientHeight:600})};
 const wall={key:'wall',kind:'wall',line:true,z:0,polygons:[{outer:[[0,0],[4,0]],inners:[]}]};
 layer.level={floor:3,cut:6,items:[],below:[{cut:3,items:[wall],doors:[[2,0]]}]};
 const root=new THREE.Group();
 layer.drawPlan(root,{toLocal:p=>p,items:[],hidden:new Set(),flat:new Set()},[wall],[[2,0]],3,pale);
 const stroke=root.getObjectByName('indoor-wall-cut-top');assert.ok(stroke);assert.equal(stroke.material.color.getHex(),pale?0xc4c0bb:0x000000);
 const a=stroke.geometry.getAttribute('instanceStart'),b=stroke.geometry.getAttribute('instanceEnd');
 const jambs=[];
 for(let i=0;i<a.count;i++)if(Math.abs(a.getX(i)-b.getX(i))<1e-6&&Math.abs(a.getZ(i)-b.getZ(i))>2)jambs.push(a.getX(i));
 assert.equal(new Set(jambs.map(x=>x.toFixed(3))).size,2);
 assert.ok(jambs.some(x=>Math.abs(x-1.5)<.001));assert.ok(jambs.some(x=>Math.abs(x-2.5)<.001));
});

test('facade door next to indoor=area has a thick contour (node/12172783560 case)',()=>{
 const layer=new BuildingsLayer('test');layer.graphics.edges=true;
 layer.map={getCanvas:()=>({width:800,height:600,clientWidth:800,clientHeight:600})};
 const ring=[[0,0],[2,0],[4,0],[4,4],[0,4]];
 const area={key:'area',kind:'area',z:0,polygons:[{outer:ring,inners:[]}]};
 const feature={key:'building',kind:'building',hasParts:false,tags:{building:'yes',height:'9'},polygons:area.polygons};
 const it={feature,tags:feature.tags,box:new THREE.Box3(new THREE.Vector3(0,0,0),new THREE.Vector3(4,4,9))};
 const g={toLocal:p=>p,items:[it],hidden:new Set(),flat:new Set()};
 layer.level={floor:0,cut:3,items:[area],doors:[[2,0]]};
 const root=new THREE.Group();layer.drawPlan(root,g,[area],[[2,0]],3,false);
 const stroke=root.getObjectByName('indoor-wall-cut-top');assert.ok(stroke);
 const a=stroke.geometry.getAttribute('instanceStart'),b=stroke.geometry.getAttribute('instanceEnd');
 for(const x of [1.5,2.5]){
  let found=false;
  for(let i=0;i<a.count;i++)if(Math.abs(a.getX(i)-x)<.001&&Math.abs(b.getX(i)-x)<.001&&Math.abs(a.getZ(i)-b.getZ(i))>2)found=true;
  assert.ok(found,`facade jamb x=${x}`);
 }
});

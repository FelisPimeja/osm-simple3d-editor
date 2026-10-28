import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';import {createServer} from 'vite';
let v,BuildingsLayer;
before(async()=>{globalThis.window={};v=await createServer({configFile:false,server:{middlewareMode:true,ws:false,watch:null},appType:'custom'});({BuildingsLayer}=await v.ssrLoadModule('/src/render/buildings-layer.ts'));});
after(async()=>{await v.close();delete globalThis.window;});
test('facade entrance stays visible on the map while floor mode uses the door opening',()=>{
 const ll=([x,y])=>[37+x/(111320*Math.cos(55*Math.PI/180)),55+y/111320];
 const f={key:'way/1',id:1,type:'way',version:1,kind:'building',hasParts:false,tags:{building:'yes',height:'9'},
  polygons:[{outer:[[0,0],[5,0],[10,0],[10,10],[0,10]].map(ll),outerIds:[1,2,3,4,5],inners:[]}],entrances:[{id:2,tags:{entrance:'yes'}}]};
 const layer=new BuildingsLayer('test');layer.setGroup('tile',[f],[37,55]);
 const map=layer.groups.get('tile');
 assert.equal(map.entrances.length,1);
 const fills=map.entranceObj.children.filter(o=>o.isMesh),line=map.entranceObj.children.find(o=>o.isLineSegments);
 assert.ok(fills.length);assert.ok(line.geometry.getAttribute('position').count>0);
 for(const fill of fills){assert.equal(fill.material.depthWrite,false);assert.equal(fill.material.depthTest,true);assert.ok(line.renderOrder>fill.renderOrder);}
 layer.setFocus([f]);layer.setLevel({floor:0,cut:3,items:[],doors:[]});
 assert.equal(layer.groups.get('@focus').entranceObj.children.filter(o=>o.isMesh).length,0);
 layer.setFocus(undefined);
 assert.equal(fills[0].material.clippingPlanes,null);
 assert.equal(line.material.clippingPlanes,null);
});

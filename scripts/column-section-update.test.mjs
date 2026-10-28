import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {createServer} from 'vite';
let vite,BuildingsLayer;
before(async()=>{globalThis.window={};vite=await createServer({configFile:false,server:{middlewareMode:true,ws:false,watch:null},appType:'custom'});({BuildingsLayer}=await vite.ssrLoadModule('/src/render/buildings-layer.ts'));});
after(async()=>{await vite.close();delete globalThis.window;});
for (const shared of [false,true]) test(`changing part type refreshes both directions (shared session object=${shared})`,()=>{
 const layer=new BuildingsLayer('test');
 const ll=(x,y)=>[37+x/(111320*Math.cos(55*Math.PI/180)),55+y/111320];
 const part={key:'way/1',type:'way',id:1,version:1,kind:'part',hasParts:false,tags:{'building:part':'yes',height:'6'},polygons:[{outer:[[0,0],[4,0],[4,4],[0,4]].map(p=>ll(...p)),inners:[]}]};
 layer.setFocus([part]);layer.setLevel({floor:0,cut:3,items:[],doors:[]});
 const initial=layer.indoorObj;
 const blackCap=()=>layer.indoorObj.children.some(o=>{
  const c=o.geometry?.getAttribute('color');
  return c?.count>0&&Array.from(c.array).every(v=>v===0);
 });
 assert.equal(blackCap(),false);
 const originalTags={...part.tags};
 const column={...part,tags:{...part.tags,'building:part':'column'}};
 if(shared)part.tags=column.tags;
 layer.previewFocusFeature(shared?part:column);
 assert.notEqual(layer.indoorObj,initial);
 assert.equal(blackCap(),true);
 part.tags=originalTags;
 layer.previewFocusFeature(part);
 assert.equal(blackCap(),false);
});

import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {createServer} from 'vite';
let vite,computeHeights,BuildingsLayer;
before(async()=>{
 globalThis.window={};
 vite=await createServer({configFile:false,server:{middlewareMode:true,ws:false,watch:null},appType:'custom'});
 ({computeHeights}=await vite.ssrLoadModule('/src/osm/heights.ts'));
 ({BuildingsLayer}=await vite.ssrLoadModule('/src/render/buildings-layer.ts'));
});
after(async()=>{delete globalThis.window;await vite.close();});
test('building levels use 3.5 metres and explicit height takes precedence',()=>{
 assert.equal(computeHeights({'building:levels':'5'}).top,17.5);
 assert.equal(computeHeights({'building:levels':'5',height:'19'}).top,19);
 assert.equal(computeHeights({'building:levels':'5','building:min_level':'2'}).min,7);
});
for(const defaults of [false,true])test(`simple building without height follows the default height setting (defaults=${defaults})`,()=>{
 const layer=new BuildingsLayer('test');
 layer.setGraphics({defaultHeight:defaults,edges:false});
 const make=(id,tags)=>({key:`way/${id}`,id,type:'way',version:1,kind:'building',hasParts:false,tags:{building:'yes',...tags},polygons:[{outer:[[37,55],[37.0001,55],[37.0001,55.0001],[37,55.0001]],inners:[]}]});
 layer.setFocus([make(1,{'building:levels':'5'}),make(2,{})]);
 const group=[...layer.groups.values()].find(g=>g.byKey.has('way/1'));
 const top=id=>Math.max(...Array.from(group.byKey.get(`way/${id}`).positions).filter((_,i)=>i%3===2));
 assert.equal(top(1),17.5);
 if(defaults)assert.equal(top(2),computeHeights({building:'yes'}).top);
 else assert.ok(top(2)<.2);
});

test('way/651766391: explicit levels on a roof building retain the whole level',()=>{
 const h=computeHeights({building:'roof','building:levels':'1','roof:shape':'flat'});
 assert.equal(h.min,0);assert.equal(h.wallTop,3.5);assert.equal(h.top,3.5);
});

for(const defaults of [false,true])test(`parts use the same heights on the map and in focus (defaults=${defaults})`,()=>{
 const layer=new BuildingsLayer('test');
 layer.setGraphics({defaultHeight:defaults,edges:false});
 const features=[{}, {height:'9'}, {'building:levels':'2'}].map((tags,i)=>({
  key:`way/${i+1}`,id:i+1,type:'way',version:1,kind:'part',hasParts:false,tags:{'building:part':'yes',...tags},
  polygons:[{outer:[[37,55],[37.0001,55],[37.0001,55.0001],[37,55.0001]],inners:[]}]
 }));
 layer.setGroup('tile',features,[37,55]);
 const top=(group,key)=>Math.max(...Array.from(layer.groups.get(group).byKey.get(key).positions).filter((_,i)=>i%3===2));
 layer.setFocus(features);
 for(const [i,f] of features.entries()){
  const expected=[0,9,7][i];
  // Плоский след на карте имеет небольшой сдвиг над землёй.
  assert.ok(Math.abs(top('tile',f.key)-expected)<.2);
  assert.equal(top('@focus',f.key),expected);
 }
 layer.setFocus(undefined);
 assert.ok(top('tile','way/1')<.2);
});

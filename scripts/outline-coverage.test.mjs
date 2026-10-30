import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {createServer} from 'vite';
let vite,markOutlinesWithParts;
before(async()=>{vite=await createServer({configFile:false,server:{middlewareMode:true,ws:false,watch:null},appType:'custom'});({markOutlinesWithParts}=await vite.ssrLoadModule('/src/osm/model.ts'));});
after(async()=>await vite.close());
const feature=(key,kind,x1,y1,x2,y2,tags)=>({key,kind,tags,hasParts:false,polygons:[{outer:[[x1,y1],[x2,y1],[x2,y2],[x1,y2]],inners:[]}]});
const outline=()=>feature('way/1','building',0,0,.001,.001,{'building:levels':'5'});
test('small annex does not hide the main five-floor volume',()=>{
 const b=outline(),p=feature('way/2','part',0,0,.0002,.0002,{'building:levels':'1'});
 markOutlinesWithParts([b,p]);assert.equal(b.hasParts,false);
});
test('parts with unknown heights do not hide an explicitly heighted outline',()=>{
 const b=outline(),p=feature('way/2','part',0,0,.001,.001,{'building:part':'yes'});
 markOutlinesWithParts([b,p]);assert.equal(b.hasParts,false);
});
test('almost complete explicit parts hide the outline; overlapping areas are not counted twice',()=>{
 const b=outline(),p=feature('way/2','part',0,0,.00095,.001,{'building:levels':'5'});
 markOutlinesWithParts([b,p]);assert.equal(b.hasParts,true);
 p.polygons[0].outer=[[0,0],[.0006,0],[.0006,.001],[0,.001]];
 markOutlinesWithParts([b,p,{...p,key:'way/3'}]);assert.equal(b.hasParts,false);
});
test('render remainder subtracts only parts with their own height and retains source geometry',async()=>{
 const {outlineRemainders}=await vite.ssrLoadModule('/src/render/outline-remainder.ts');
 const pc=(await import('polygon-clipping')).default;
 const b=outline(),source=structuredClone(b);
 const annex=feature('relation/19630035','part',0,0,.0002,.001,{'building:levels':'1'});
 const unknown=feature('way/3','part',.0002,0,.0008,.001,{'building:part':'yes'});
 const elevated=feature('way/4','part',.0008,0,.001,.001,{height:'20',min_height:'15'});
 const rest=outlineRemainders([b,annex,unknown,elevated]).get(b.key);
 assert.ok(rest);
 assert.deepEqual(pc.intersection(rest.map(p=>[p.outer]),[annex.polygons[0].outer]),[]);
 assert.deepEqual(pc.xor(rest.map(p=>[p.outer]),[[[.0002,0],[.001,0],[.001,.001],[.0002,.001]]]),[]);
 assert.deepEqual(b,source);
});
test('17948502 explicit ground body and upper tier together replace the building outline',async()=>{
 const {readFileSync}=await import('node:fs');
 const {parseBuildings}=await vite.ssrLoadModule('/src/osm/model.ts');
 const {features,groups}=parseBuildings(JSON.parse(readFileSync(new URL('./fixtures/outline-17948502.json',import.meta.url))));
 markOutlinesWithParts(features,features,groups);
 assert.equal(features.find(f=>f.key==='relation/17948502').hasParts,true);
});
test('an explicit raised part replaces the outline while a spatially found one keeps the base',()=>{
 const b=outline(),p=feature('way/2','part',0,0,.001,.001,{height:'20',min_height:'15'});
 const group={members:[b.key,p.key],roles:['outline','part']};
 markOutlinesWithParts([b,p],[b]);assert.equal(b.hasParts,false);
 markOutlinesWithParts([b,p],[b],[group]);assert.equal(b.hasParts,true);
});
test('17747395: all explicit parts cover the outline, including parts without height and raised canopies',async()=>{
 const {readFileSync}=await import('node:fs');
 const {parseBuildings}=await vite.ssrLoadModule('/src/osm/model.ts');
 const {features,groups}=parseBuildings(JSON.parse(readFileSync(new URL('./fixtures/outline-17747395.json',import.meta.url))));
 const b=features.find(f=>f.key==='relation/17747395');
 markOutlinesWithParts(features,features,groups);
 assert.equal(b.hasParts,true);
});
test('explicit parts intersecting the outline count even when their centre is outside',()=>{
 const b=outline(),p=feature('way/2','part',-.002,0,.001,.001,{'building:part':'yes'});
 const group={members:[b.key,p.key],roles:['outline','part']};
 markOutlinesWithParts([b,p],[b],[group]);assert.equal(b.hasParts,true);
 p.polygons[0].outer=p.polygons[0].outer.map(([x,y])=>[x+.01,y]);
 markOutlinesWithParts([b,p],[b],[group]);assert.equal(b.hasParts,false);
});

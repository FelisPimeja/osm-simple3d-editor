import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createServer } from 'vite';
let vite, buildPlans, findVoids, multiArea;
before(async()=>{
 globalThis.window={};
 vite=await createServer({configFile:false,server:{middlewareMode:true,ws:false,watch:null},appType:'custom'});
 ({buildPlans,findVoids,multiArea}=await vite.ssrLoadModule('/src/view/indoor-voids.ts'));
});
after(async()=>{delete globalThis.window;await vite.close();});
const square=(a,b,c,d)=>[[a,b],[c,b],[c,d],[a,d]];
const outer=square(0,0,20,20), hole=square(5,5,15,15);
const levels=[{n:0,floor:0,ceil:3},{n:1,floor:3,ceil:6}];
const part={polygons:[[outer]],min:0,wallTop:6};
const corridor={kind:'corridor',polygons:[[outer,hole]],levels:[1],floors:[1]};
test('an unmapped inner ring does not imply a void',()=>{
 const plans=buildPlans(levels,[part],[corridor]);
 const voids=findVoids(1,plans);
 assert.deepEqual(voids,[]);
});
test('a room inside a corridor ring remains solid',()=>{
 const plans=buildPlans(levels,[part],[corridor,{kind:'room',polygons:[[hole]],levels:[1],floors:[1]}]);
 assert.deepEqual(findVoids(1,plans),[]);
});
test('remaining unmapped portion of an inner ring has a floor',()=>{
 const plans=buildPlans(levels,[part],[corridor,{kind:'room',polygons:[[square(5,5,10,15)]],levels:[1],floors:[1]}]);
 assert.equal(findVoids(1,plans).reduce((s,v)=>s+multiArea(v.polygon),0),0);
});
test('unmapped space without an explicit ring still requires lower floor evidence',()=>{
 const plans=buildPlans(levels,[part],[{kind:'room',polygons:[[square(0,0,15,20)]],levels:[1],floors:[1]}]);
 assert.deepEqual(findVoids(1,plans),[]);
});

test('unmapped upper floor above mapped rooms remains solid',()=>{
 const plans=buildPlans(levels,[part],[{kind:'room',polygons:[[outer]],levels:[0],floors:[0]}]);
 assert.deepEqual(findVoids(1,plans),[]);
});
test('an explicit multilevel room creates a void even without other upper-floor mapping',()=>{
 const plans=buildPlans(levels,[part],[{kind:'room',polygons:[[hole]],levels:[0,1],floors:[0]}]);
 const voids=findVoids(1,plans);assert.equal(voids.length,1);assert.equal(multiArea(voids[0].polygon),100);
 assert.deepEqual(findVoids(0,plans),[]);
});
test('explicitly repeated floors are not multilevel voids',()=>{
 const plans=buildPlans(levels,[part],[{kind:'room',polygons:[[hole]],levels:[0,1],floors:[0,1]}]);
 assert.deepEqual(findVoids(1,plans),[]);
});
test('small explicitly mapped voids are not dropped by an area heuristic',()=>{
 const plans=buildPlans(levels,[part],[{kind:'room',polygons:[[square(1,1,2,2)]],levels:[0,1],floors:[0]}]);
 assert.equal(findVoids(1,plans).reduce((s,v)=>s+multiArea(v.polygon),0),1);
});
test('empty floor receives a full base slab and a pool keeps its opening',async()=>{
 const {BuildingsLayer}=await vite.ssrLoadModule('/src/render/buildings-layer.ts');
 const layer=new BuildingsLayer('test'),ll=([x,y])=>[37+x/(111320*Math.cos(55*Math.PI/180)),55+y/111320];
 layer.setFocus([{key:'way/1',id:1,type:'way',version:1,kind:'building',hasParts:false,tags:{building:'yes',height:'9'},polygons:[{outer:outer.map(ll),inners:[]}]}]);
 layer.setLevel({floor:3,cut:6,items:[],doors:[]});
 const area=()=>layer.indoorObj.children.filter(o=>o.isMesh).reduce((s,o)=>{
  const p=o.geometry.getAttribute('position');
  for(let i=0;i+2<p.count;i+=3)if([i,i+1,i+2].every(j=>Math.abs(p.getZ(j)-3)<.001))
   s+=Math.abs((p.getX(i+1)-p.getX(i))*(p.getY(i+2)-p.getY(i))-(p.getY(i+1)-p.getY(i))*(p.getX(i+2)-p.getX(i)))/2;
  return s;
 },0);
 assert.ok(Math.abs(area()-400)<1);
 layer.setLevel({floor:3,cut:6,items:[{key:'pool',kind:'area',z:3,pool:2,polygons:[{outer:hole.map(ll),inners:[]}]}],doors:[]});
 assert.ok(Math.abs(area()-300)<1);
});

for(const kind of ['room','area'])test(`editing ${kind} level updates the active plan, with undo and redo`,async()=>{
 const {EditSession}=await vite.ssrLoadModule('/src/edit/session.ts');
 const {withIndoorTags,floorLevels}=await vite.ssrLoadModule('/src/osm/model.ts');
 const {BuildingsLayer}=await vite.ssrLoadModule('/src/render/buildings-layer.ts');
 const layer=new BuildingsLayer('test'),ll=([x,y])=>[37+x/(111320*Math.cos(55*Math.PI/180)),55+y/111320];
 layer.setFocus([{key:'way/1',id:1,type:'way',version:1,kind:'building',hasParts:false,tags:{building:'yes',height:'9'},polygons:[{outer:outer.map(ll),inners:[]}]}]);
 const source={key:'way/2',kind,tags:{indoor:kind,level:'0'},levels:[0],polygons:[{outer:hole.map(ll),inners:[]}]};
 let currentVoids=[],updates=0;
 const refresh=()=>{
  updates++;
  const f=withIndoorTags(source,session.get(source.key).tags),floors=floorLevels(f);
  const plans=buildPlans(levels,[part],[{kind,polygons:[[hole]],levels:f.levels,floors}]);
  currentVoids=findVoids(1,plans);
  const items=f.levels.includes(1)?[{...f,z:3,noFloor:!floors.includes(1)}]:[];
  layer.setLevel({floor:3,cut:6,items,doors:[],voids:currentVoids.flatMap(v=>v.polygon.map(p=>p.map(r=>r.slice(0,-1).map(ll))))});
 };
 const session=new EditSession([{key:source.key,version:1,tags:source.tags,polygons:source.polygons}],refresh);
 refresh();assert.equal(currentVoids.length,0);
 session.editMany([{key:source.key,tags:{...source.tags,level:'0;1'}}]);
 assert.equal(currentVoids.length,1);assert.equal(layer.level.floor,3);assert.equal(layer.level.items[0].noFloor,true);
 assert.equal(layer.indoorWallPositions.length>0,kind==='room');
 session.undo();assert.equal(currentVoids.length,0);assert.equal(layer.level.items.length,0);
 session.redo();assert.equal(currentVoids.length,1);assert.equal(layer.indoorWallPositions.length>0,kind==='room');
 assert.equal(updates,4);
});

test('relation/17986282 stairs room has an upper opening and level edits can remove it',async()=>{
 const {floorLevels,withIndoorTags}=await vite.ssrLoadModule('/src/osm/model.ts');
 const source={key:'relation/17986282',kind:'room',tags:{indoor:'room',room:'stairs',level:'0;1'},levels:[0,1],polygons:[]};
 const plansFor=f=>buildPlans(levels,[part],[{kind:f.kind,polygons:[[hole]],levels:f.levels,floors:floorLevels(f)}]);
 assert.deepEqual(floorLevels(source),[0]);
 assert.equal(findVoids(1,plansFor(source)).reduce((sum,v)=>sum+multiArea(v.polygon),0),100);
 assert.deepEqual(findVoids(0,plansFor(source)),[]);
 const single=withIndoorTags(source,{...source.tags,level:'0'});
 assert.deepEqual(findVoids(1,plansFor(single)),[]);
 const repeated=withIndoorTags(source,{...source.tags,level:'0',repeat_on:'1'});
 assert.deepEqual(new Set(floorLevels(repeated)),new Set([0,1]));
 assert.deepEqual(findVoids(1,plansFor(repeated)),[]);
});

test('opening outline skips walls, retains exposed slab edges, and clips partial overlap',async()=>{
 const {BuildingsLayer}=await vite.ssrLoadModule('/src/render/buildings-layer.ts');
 const layer=new BuildingsLayer('test'),ll=([x,y])=>[37+x/(111320*Math.cos(55*Math.PI/180)),55+y/111320];
 layer.setFocus([{key:'way/1',id:1,type:'way',version:1,kind:'building',hasParts:false,tags:{building:'yes',height:'9'},polygons:[{outer:outer.map(ll),inners:[]}]}]);
 const room={key:'stairs',kind:'room',z:3,noFloor:true,polygons:[{outer:hole.map(ll),inners:[]}]};
 const length=items=>{
  layer.setLevel({floor:3,cut:6,items,doors:[],voids:[[hole.map(ll)]]});
  let length=0;
  for(const o of layer.indoorObj.children.filter(o=>o.isLineSegments&&o.name!=='indoor-floor-contact')){
   const p=o.geometry.getAttribute('position');
   for(let i=0;i+1<p.count;i+=2)if(Math.abs(p.getZ(i)-3)<.0001&&Math.abs(p.getZ(i+1)-3)<.0001)
    length+=Math.hypot(p.getX(i+1)-p.getX(i),p.getY(i+1)-p.getY(i));
  }
  return length;
 };
 assert.ok(Math.abs(length([])-40)<.1);
 assert.equal(length([room]),0);
 assert.ok(Math.abs(length([{key:'wall',kind:'wall',line:true,z:3,polygons:[{outer:[[5,5],[10,5]].map(ll),inners:[]}]}])-35)<.1);
});

test('white base floor occupies only the area not covered by room floors',async()=>{
 const {BuildingsLayer}=await vite.ssrLoadModule('/src/render/buildings-layer.ts');
 const layer=new BuildingsLayer('test'),ll=([x,y])=>[37+x/(111320*Math.cos(55*Math.PI/180)),55+y/111320];
 layer.setFocus([{key:'way/1',id:1,type:'way',version:1,kind:'building',hasParts:false,tags:{building:'yes',height:'9'},polygons:[{outer:outer.map(ll),inners:[]}]}]);
 layer.setLevel({floor:3,cut:6,items:[{key:'room',kind:'room',z:3,polygons:[{outer:hole.map(ll),inners:[]}]}],doors:[]});
 let white=0,colour=0;
 for(const o of layer.indoorObj.children.filter(o=>o.isMesh)){
  const p=o.geometry.getAttribute('position');
  for(let i=0;i+2<p.count;i+=3){
   const area=Math.abs((p.getX(i+1)-p.getX(i))*(p.getY(i+2)-p.getY(i))-(p.getY(i+1)-p.getY(i))*(p.getX(i+2)-p.getX(i)))/2;
   if(![i,i+1,i+2].every(j=>Math.abs(p.getZ(j)-3)<.001))continue;
   if(o.geometry.getAttribute('color'))colour+=area;else white+=area;
  }
 }
 assert.ok(Math.abs(white-300)<1);assert.ok(Math.abs(colour-100)<1);
});

test('floor plan removes flat building-part faces beneath room floors and restores them on exit',async()=>{
 const {BuildingsLayer}=await vite.ssrLoadModule('/src/render/buildings-layer.ts');
 const layer=new BuildingsLayer('test'),ll=([x,y])=>[37+x/(111320*Math.cos(55*Math.PI/180)),55+y/111320];
 const polygons=[{outer:outer.map(ll),inners:[]}];
 layer.setFocus([
  {key:'way/1',id:1,type:'way',version:1,kind:'building',hasParts:false,tags:{building:'yes',height:'9'},polygons},
  {key:'way/2',id:2,type:'way',version:1,kind:'part',tags:{'building:part':'yes'},polygons},
 ]);
 const group=[...layer.groups.values()].find(g=>g.byKey.has('way/2'));
 const faceArea=()=>{
  const p=group.mesh.geometry.getAttribute('position');let area=0;
  for(let i=0;i+2<p.count;i+=3)if([i,i+1,i+2].every(j=>Math.abs(p.getZ(j))<.001))
   area+=Math.abs((p.getX(i+1)-p.getX(i))*(p.getY(i+2)-p.getY(i))-(p.getY(i+1)-p.getY(i))*(p.getX(i+2)-p.getX(i)))/2;
  return area;
 };
 assert.ok(faceArea()>399,'unraised part starts with a flat white face');
 layer.setLevel({floor:0,cut:3,items:[{key:'room',kind:'room',z:0,polygons}],doors:[]});
 assert.equal(faceArea(),0,'floor plan must not retain structural faces under its floors');
 layer.setLevel(undefined);
 assert.ok(faceArea()>399,'full-building view restores source faces');
});

test('low sloping annex roof opens in floor plan and restores in full-building view',async()=>{
 const {BuildingsLayer}=await vite.ssrLoadModule('/src/render/buildings-layer.ts');
 const layer=new BuildingsLayer('test'),ll=([x,y])=>[37+x/(111320*Math.cos(55*Math.PI/180)),55+y/111320];
 layer.setFocus([{key:'relation/17948425',id:17948425,type:'relation',version:1,kind:'part',hasParts:false,
 tags:{'building:part':'yes',height:'2.84','roof:shape':'skillion','roof:height':'1.67','roof:direction':'95'},
 polygons:[{outer:square(0,0,4,2).map(ll),inners:[]}]}]);
 layer.map={getCanvas:()=>({width:800,height:600,clientWidth:800}),triggerRepaint(){}};
 const group=[...layer.groups.values()].find(g=>g.byKey.has('relation/17948425'));
 const roofBuffer=()=>{
  const it=group.byKey.get('relation/17948425');
  return group.mesh.geometry.getAttribute('position').array.slice((it.start+it.wallVertices)*3,(it.start+it.positions.length/3-it.floorVertices)*3);
 };
 assert.ok(roofBuffer().some(v=>v!==0));
 layer.setLevel({floor:0,cut:3.5,items:[],doors:[]});
 assert.ok(roofBuffer().length>0);assert.ok(roofBuffer().every(v=>v===0));
 assert.ok(layer.indoorObj.children.some(o=>o.isLineSegments2&&o.geometry.getAttribute('instanceStart')&&Array.from(o.geometry.getAttribute('instanceStart').data.array).some((v,i,a)=>i%6===2&&Math.abs(v-a[i+3])>.1)),'heavy outline retains sloping segments');
 layer.setLevel(undefined);assert.ok(roofBuffer().some(v=>v!==0));
});


test('a low sloping annex still has an explicit stairwell void at its upper floor',()=>{
 const levels=[{n:-1,floor:-3.5,ceil:0},{n:0,floor:0,ceil:3.5}];
 const plans=buildPlans(levels,[{polygons:[[outer]],min:0,wallTop:1.17}],
  [{kind:'room',polygons:[[outer]],levels:[-1,0],floors:[-1]}]);
 const voids=findVoids(0,plans);
 assert.equal(voids.length,1);assert.equal(multiArea(voids[0].polygon),400);
 assert.deepEqual(voids[0].through,[-1]);
});

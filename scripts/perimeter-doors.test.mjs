import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createServer } from 'vite';
let vite, cutDoorOpenings, BuildingsLayer;
before(async () => {
 globalThis.window = {};
 vite = await createServer({ configFile:false, server:{middlewareMode:true,ws:false,watch:null},appType:'custom' });
 ({cutDoorOpenings}=await vite.ssrLoadModule('/src/render/door-openings.ts'));
 ({BuildingsLayer}=await vite.ssrLoadModule('/src/render/buildings-layer.ts'));
});
after(async()=>{delete globalThis.window; delete globalThis.location; delete globalThis.history; await vite.close();});
const wall=(a,b)=>[a,0,0,b,0,0,b,0,3,a,0,0,b,0,3,a,0,3];
const area=p=>{let s=0;for(let i=0;i<p.length;i+=9){const u=[p[i+3]-p[i],p[i+4]-p[i+1],p[i+5]-p[i+2]],v=[p[i+6]-p[i],p[i+7]-p[i+1],p[i+8]-p[i+2]];s+=Math.hypot(u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0])/2;}return s;};
test('door cuts across short facade segments and leaves the lintel',()=>{
 const p=new Float32Array(Array.from({length:40},(_,i)=>wall(i*.1,(i+1)*.1)).flat());
 const cut=cutDoorOpenings(p,[{x:2,y:.1,z:0}]);
 assert.ok(Math.abs(area(cut)-(12-2.2))<.001);
 assert.deepEqual(cutDoorOpenings(p,[{x:2,y:.2,z:0}]),p);
});
test('perimeter opening updates, restores on removal and does not persist outside floor mode',()=>{
 const layer=new BuildingsLayer('test');
 const ll=(x,y)=>[37+x/(111320*Math.cos(55*Math.PI/180)),55+y/111320];
 layer.setFocus([{key:'way/1',type:'way',id:1,version:1,kind:'part',hasParts:false,tags:{'building:part':'yes',height:'6'},polygons:[{outer:[[0,0],[4,0],[4,4],[0,4]].map(p=>ll(...p)),inners:[]}]}]);
 const it=layer.groups.get('@focus').byKey.get('way/1');
 const level={floor:0,cut:3,items:[],doors:[ll(2,0)]};
 layer.setLevel({...level,doors:[]});
 const before=area(it.positions);
 layer.setLevel(level);
 assert.ok(Math.abs(before-area(it.positions)-2.2)<.01);
 layer.setLevel({...level,doors:[]});
 assert.ok(Math.abs(before-area(it.positions))<.01);
 layer.setLevel(level);
 layer.setLevel(undefined);
 assert.ok(Math.abs(before-area(it.positions))<.01);
});
test('revolving drum diameter controls the facade opening width',()=>{
 const p=new Float32Array(wall(0,6));
 const cut=cutDoorOpenings(p,[{x:3,y:0,z:0,width:2.4}]);
 assert.ok(Math.abs(area(cut)-(18-2.4*2.2))<.001);
});
test('revolving door uses explicit diameter, leaves width as passage width, and builds a finite model',async()=>{
 const {revolvingDoorDiameter,revolvingDoorModel}=await vite.ssrLoadModule('/src/render/revolving-door.ts');
 assert.equal(revolvingDoorDiameter({door:'yes'}),undefined);
 assert.equal(revolvingDoorDiameter({door:'revolving',width:'1'}),2.4);
 assert.equal(revolvingDoorDiameter({door:'revolving',diameter:'3 m'}),3);
 assert.equal(revolvingDoorDiameter({door:'revolving',diameter:'-1'}),2.4);
 const model=revolvingDoorModel(3,2.2);
 const {Box3}=await import('three');
 const box=new Box3().setFromObject(model, true);
 assert.ok(Math.abs(box.max.x-1.5)<.05);
 assert.ok(Math.abs(box.max.z-2.2)<.05);
 model.traverse(o=>assert.equal(o.frustumCulled,false));
 assert.equal(model.children.filter(o=>o.type==='Group').length,4);
 model.traverse(o=>o.geometry?.dispose());
});

test('node 12387163946 is parsed and installed as a revolving model on level 0',async()=>{
 const {parseBuildings}=await vite.ssrLoadModule('/src/osm/model.ts');
 const {indoor}=parseBuildings([{type:'node',id:12387163946,lat:55.8031629,lon:37.6179104,tags:{door:'revolving',entrance:'main',indoor:'door',level:'0'}}]);
 assert.equal(indoor.length,1);
 const door=indoor[0];
 assert.deepEqual(door.levels,[0]);
 const layer=new BuildingsLayer('test');
 const [x,y]=door.point;
 layer.setFocus([{key:'way/1',type:'way',id:1,version:1,kind:'part',hasParts:false,tags:{'building:part':'yes',height:'6'},polygons:[{outer:[[x-.0001,y-.0001],[x+.0001,y-.0001],[x+.0001,y+.0001],[x-.0001,y+.0001]],inners:[]}]}]);
 layer.setDoors([{key:door.key,at:door.point,z:0,tags:door.tags}]);
 layer.setLevel({floor:0,cut:3,items:[],doors:[door.point]});
 const model=layer.groups.get('@focus').scene.getObjectByName('revolving-door');
 assert.ok(model);
 model.traverse(o=>assert.equal(o.frustumCulled,false));
});
test('tile indoor lookup includes door points and deduplicates them',async()=>{
 globalThis.location={search:'',href:'http://localhost/'};
 globalThis.history={replaceState(){}};
 const {OverpassTiles}=await vite.ssrLoadModule('/src/view/overpass-tiles.ts');
 const door={key:'node/12387163946',kind:'poi',polygons:[],point:[37.6179104,55.8031629],tags:{door:'revolving'},levels:[0]};
 const outside={...door,key:'node/2',point:[0,0]};
 const tile={state:'ready',indoor:[door,outside]};
 const found=OverpassTiles.prototype.indoorIn.call({cache:new Map([['a',tile],['b',tile]])},[37.61,55.8,37.62,55.81]);
 assert.deepEqual(found,[door]);
});
test('offset revolving drum cuts a chord and restores the wall when moved clear',()=>{
 const p=new Float32Array(wall(0,6));
 const cut=cutDoorOpenings(p,[{x:3,y:0.6,z:0,diameter:2}]);
 assert.ok(Math.abs(area(cut)-(18-1.6*2.2))<.001);
 assert.deepEqual(cutDoorOpenings(p,[{x:3,y:1.1,z:0,diameter:2}]),p);
 // A drum can intersect a wall even when its centre projects beyond an endpoint.
 assert.ok(area(cutDoorOpenings(p,[{x:-0.3,y:0.6,z:0,diameter:2}]))<area(p));
});
test('indoor wall opening follows the off-wall revolving door during preview',()=>{
 const ll=(x,y)=>[37+x/(111320*Math.cos(55*Math.PI/180)),55+y/111320];
 const layer=new BuildingsLayer('test');
 layer.setFocus([{key:'way/1',type:'way',id:1,version:1,kind:'part',hasParts:false,tags:{'building:part':'yes',height:'6'},polygons:[{outer:[[0,0],[6,0],[6,4],[0,4]].map(p=>ll(...p)),inners:[]}]}]);
 const door={key:'node/1',at:ll(3,2.6),z:0,tags:{door:'revolving',diameter:'2'}};
 layer.setDoors([door]);
 layer.setLevel({floor:0,cut:3,items:[{key:'way/2',kind:'wall',line:true,z:0,polygons:[{outer:[ll(0,2),ll(6,2)],inners:[]}]}],doors:[door.at]});
 assert.ok(layer.doorOpeningEdges.has('node/1'));
 // Preview is normally scheduled by requestAnimationFrame; rebuild synchronously here.
 layer.doorPreview={key:door.key,at:ll(3,3.1)};
 layer.applyLevel();
 assert.equal(layer.doorOpeningEdges.has('node/1'),false);
});
test('Move previews multiple doors without rebuilding openings and restores them on cancellation',async()=>{
 const {Vector3}=await import('three');
 const ll=(x,y)=>[37+x/(111320*Math.cos(55*Math.PI/180)),55+y/111320];
 const layer=new BuildingsLayer('test');
 layer.setFocus([{key:'way/1',type:'way',id:1,version:1,kind:'part',hasParts:false,tags:{'building:part':'yes',height:'6'},polygons:[{outer:[[0,0],[8,0],[8,5],[0,5]].map(p=>ll(...p)),inners:[]}]}]);
 const doors=[3,5].map((x,i)=>({key:`node/${i+1}`,at:ll(x,2.6),z:0,tags:{door:'revolving',diameter:'2'}}));
 layer.setDoors(doors);
 layer.setLevel({floor:0,cut:3,items:[{key:'way/2',kind:'wall',line:true,z:0,polygons:[{outer:[ll(0,2),ll(8,2)],inners:[]}]}],doors:doors.map(d=>d.at)});
 const before=doors.map(d=>layer.doorAnchor(d.key));
 const openings=layer.doorOpeningEdges;
 assert.equal(openings.size,2);
 layer.setMovePreview(doors.map(d=>d.key),new Vector3(.2,2,0));
 doors.forEach((d,i)=>assert.ok(layer.doorAnchor(d.key).distanceTo(before[i].clone().add(new Vector3(.2,2,0)))<.001));
 // Во время движения сдвигаются только модели: проёмы пересобираются после записи, а не на каждый mousemove
 assert.equal(layer.doorOpeningEdges,openings);
 assert.equal(layer.doorOpeningEdges.size,2);
 layer.setMovePreview(doors.map(d=>d.key),undefined);
 doors.forEach((d,i)=>assert.ok(layer.doorAnchor(d.key).distanceTo(before[i])<.001));
 assert.equal(layer.doorOpeningEdges.size,2);
});
test('Move supports door anchors with snaps off, horizontal snaps, numeric distance and Esc',async()=>{
 const {Vector3}=await import('three');
 const {MoveTool}=await vite.ssrLoadModule('/src/edit/move-tool.ts');
 const previous=globalThis.document;
 globalThis.document={createElement:()=>({hidden:true,addEventListener(){}})};
 try {
  let target, committed, preview;
  const layer={focusAxes:{x:[1,0],y:[0,1]},snapAt:()=>target,pickHit:()=>undefined,pickDoor:()=> 'node/1',doorAnchor:()=>new Vector3(0,0,.04),setMoveGuide(){},setMovePreview:(keys,offset)=>{preview=offset?.clone();},focusRay:()=>({}),focusProject:p=>[p.x*10,p.y*10]};
  const tool=new MoveTool(layer,{appendChild(){}},(keys,offset)=>{committed={keys,offset};},()=>{});
  tool.start(['node/1'],true);
  tool.click([0,0]);
  assert.equal(tool.state,'move');
  target={key:'way/2',local:new Vector3(3,4,9)};
  tool.move([30,40]);
  assert.deepEqual(preview.toArray(),[3,4,0]);
  tool.key({type:'keydown',key:'2'});tool.key({type:'keydown',key:'Enter'});
  assert.deepEqual(committed.keys,['node/1']);
  assert.ok(Math.abs(committed.offset.length()-2)<1e-9);
  assert.equal(committed.offset.z,0);
  tool.click([0,0]);tool.move([30,40]);tool.key({type:'keydown',key:'Escape'});
  assert.equal(preview,undefined);
  assert.equal(tool.state,'pick');
  // A DOM entrance marker bypasses canvas picking but starts the same Move flow.
  committed=undefined;target=undefined;
  tool.beginAt(new Vector3(0,0,.04));
  assert.equal(tool.state,'move');
  target={key:'way/2',local:new Vector3(3,4,0)};tool.move([30,40]);
  tool.key({type:'keydown',key:'1'});tool.key({type:'keydown',key:'Enter'});
  assert.ok(Math.abs(committed.offset.length()-1)<1e-9);
  assert.deepEqual(committed.keys,['node/1']);
 } finally {globalThis.document=previous;}
});
test('wall door metadata is projected once instead of once per wall/door pair',()=>{
 const ll=(x,y)=>[37+x/(111320*Math.cos(55*Math.PI/180)),55+y/111320];
 const layer=new BuildingsLayer('test');
 layer.setFocus([{key:'way/1',type:'way',id:1,version:1,kind:'part',hasParts:false,tags:{'building:part':'yes',height:'6'},polygons:[{outer:[[0,0],[100,0],[100,100],[0,100]].map(p=>ll(...p)),inners:[]}]}]);
 const doors=Array.from({length:60},(_,i)=>({key:`node/${i+1}`,at:ll(10+i,2.6),z:0,tags:{door:'yes'}}));
 layer.setDoors(doors);
 const g=layer.groups.get('@focus'),toLocal=g.toLocal;
 let projections=0;
 g.toLocal=(at)=>{projections++;return toLocal(at);};
 layer.setLevel({floor:0,cut:3,items:Array.from({length:100},(_,i)=>({key:`way/${i+2}`,kind:'wall',line:true,z:0,polygons:[{outer:[ll(1,i+1),ll(99,i+1)],inners:[]}]})),doors:doors.map(d=>d.at)});
 // This was hundreds of thousands of projections with the nested lookup.
 assert.ok(projections<5000,`unexpected repeated coordinate projections: ${projections}`);
});
test('entering a floor merges the building geometry only once',()=>{
 const layer=new BuildingsLayer('test');
 layer.setFocus([{key:'way/1',type:'way',id:1,version:1,kind:'part',hasParts:false,tags:{'building:part':'yes',height:'6'},polygons:[{outer:[[37,55],[37.0001,55],[37.0001,55.0001],[37,55.0001]],inners:[]}]}]);
 let merges=0;const original=layer.rebuildGeometry;
 layer.rebuildGeometry=function(...args){merges++;return original.apply(this,args);};
 layer.setLevel({floor:0,cut:3,items:[],doors:[]});
 assert.equal(merges,1);
 layer.setLevel(undefined);
 assert.equal(merges,2);
});
test('returning to a floor reuses door-cut geometry and edges; diameter edits invalidate it',()=>{
 const ll=(x,y)=>[37+x/(111320*Math.cos(55*Math.PI/180)),55+y/111320];
 const layer=new BuildingsLayer('test');
 layer.graphics.edges=true;
 layer.setFocus([{key:'way/1',type:'way',id:1,version:1,kind:'part',hasParts:false,tags:{'building:part':'yes',height:'6'},polygons:[{outer:[[0,0],[6,0],[6,5],[0,5]].map(p=>ll(...p)),inners:[]}]}]);
 const at=ll(3,0),door={key:'node/1',at,z:0,tags:{door:'revolving',diameter:'2'}};
 const level={floor:0,cut:3,items:[],doors:[at]};
 layer.setDoors([door]);layer.setLevel(level);
 const item=layer.groups.get('@focus').items[0];
 const positions=item.positions,edges=item.edges;
 assert.ok(edges?.length);
 layer.setDoors([]);layer.setLevel({floor:3,cut:6,items:[],doors:[]});
 assert.notEqual(item.positions,positions);
 layer.setDoors([door]);layer.setLevel(level);
 assert.equal(item.positions,positions);
 assert.equal(item.edges,edges);
 layer.setDoors([{...door,tags:{door:'revolving',diameter:'3'}}]);layer.setLevel(level);
 assert.notEqual(item.positions,positions);
 assert.notEqual(item.edges,edges);
 assert.ok(area(item.positions)<area(positions));
 for(const diameter of ['1','1.2','1.4','1.6']) {
  layer.setDoors([{...door,tags:{door:'revolving',diameter}}]);layer.setLevel(level);
 }
 assert.equal(layer.doorCuts.get(item).entries.size,3);
});
test('revolving doors below an atrium are drawn at their own height and retain their diameter',()=>{
 const ll=(x,y)=>[37+x/(111320*Math.cos(55*Math.PI/180)),55+y/111320];
 const layer=new BuildingsLayer('test');
 layer.setFocus([{key:'way/1',type:'way',id:1,version:1,kind:'part',hasParts:false,tags:{'building:part':'yes',height:'6'},polygons:[{outer:[[0,0],[6,0],[6,5],[0,5]].map(p=>ll(...p)),inners:[]}]}]);
 const door={key:'node/1',at:ll(3,0),z:0,tags:{door:'revolving',diameter:'2'}};
 const below={cut:3,items:[{key:'way/2',kind:'area',z:0,polygons:[{outer:[[0,0],[6,0],[6,5],[0,5]].map(p=>ll(...p)),inners:[]}]}],doors:[door.at],doorModels:[door]};
 layer.setDoors([]);
 const level={floor:3,cut:6,items:[],below:[below]};
 layer.setLevel(level);
 const group=layer.groups.get('@focus');
 const models=()=>{const a=[];group.scene.traverse(o=>{if(o.name==='revolving-door')a.push(o);});return a;};
 assert.equal(models().length,1);
 assert.ok(Math.abs(models()[0].position.z-.04)<1e-9);
 assert.equal(models()[0].userData.pale,true);
 assert.equal(layer.doorAnchor(door.key),undefined,'lower floor doors are not active editing targets');
 const wideArea=area(group.items[0].positions);
 layer.setLevel({...level,below:[{...below,doorModels:[]}]});
 assert.equal(models().length,0);
 assert.ok(Math.abs(area(group.items[0].positions)-wideArea-2.2)<.01,'lower facade opening uses the drum diameter');
 layer.setDoors([{...door,z:3}]);layer.setLevel(level);
 assert.equal(models().length,2,'repeated door nodes can have a model on both floors');
 assert.deepEqual(models().map(m=>m.position.z).sort((a,b)=>a-b),[.04,3.04]);
 layer.setLevel({floor:0,cut:3,items:[],doors:[door.at]});
 assert.equal(models().length,1);
 layer.setLevel(undefined);
 assert.equal(models().length,0);
});

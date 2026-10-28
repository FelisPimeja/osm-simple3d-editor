import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {createServer} from 'vite';
import pc from 'polygon-clipping';
let validateSolidWallDoors,vite,roomDoorway,cutSolidWall,findSolidDoorBinding,restoreSolidDoor,nearestSolidFace;
before(async()=>{vite=await createServer({configFile:false,server:{middlewareMode:true,ws:false,watch:null},appType:'custom'});({roomDoorway,cutSolidWall,findSolidDoorBinding,restoreSolidDoor,nearestSolidFace}=await vite.ssrLoadModule('/src/edit/solid-wall-doors.ts'));({validateSolidWallDoors}=await vite.ssrLoadModule('/src/edit/validate.ts'));});
after(async()=>await vite.close());
const wall=[[[[0,0],[10,0],[10,2],[0,2],[0,0]]]];
const identity=p=>p;
test('door cuts through wall thickness, preserving the two solid fragments',()=>{
 const result=cutSolidWall(wall,[5,0],[[0,0],[10,0]],1);
 assert.equal(result.pieces.length,2);
 assert.deepEqual(result.front,[[4.5,0],[5,0],[5.5,0]]);
 assert.deepEqual(result.gap,[[4.5,0],[5.5,0],[5.5,2],[4.5,2],[4.5,0]]);
 assert.deepEqual(pc.xor(wall,pc.union(result.pieces,[result.gap])),[]);
});
test('tapered wall uses parallel jambs perpendicular to the clicked face',()=>{
 const tapered=[[[[0,0],[10,0],[10,3],[0,1],[0,0]]]];
 const r=cutSolidWall(tapered,[5,0],[[0,0],[10,0]],2);
 assert.equal(r.gap[0][0],r.gap[3][0]);assert.equal(r.gap[1][0],r.gap[2][0]);
 assert.ok(Math.abs(r.gap[2][1]-2.2)<1e-6);assert.ok(Math.abs(r.gap[3][1]-1.8)<1e-6);
});
test('same physical opening can be cut from the opposite face',()=>{
 const r=cutSolidWall(wall,[5,2],[[10,2],[0,2]],1);
 assert.ok(Math.abs(r.normal[0])<1e-9);assert.equal(r.normal[1],-1);assert.equal(r.pieces.length,2);
 assert.deepEqual(pc.xor(r.pieces,cutSolidWall(wall,[5,0],[[0,0],[10,0]],1).pieces),[]);
});
test('binding survives serialization and restores exactly the removed volume',()=>{
 const r=cutSolidWall(wall,[5,0],[[0,0],[10,0]],1),known=new Map();let next=1;
 const id=p=>{const k=p.join(',');if(!known.has(k))known.set(k,next++);return known.get(k);};
 const fragments=r.pieces.map((poly,i)=>({key:`way/${i+1}`,kind:'wall',tags:{indoor:'wall',level:'0'},levels:[0],polygons:[{outer:poly[0].slice(0,-1),outerIds:poly[0].slice(0,-1).map(id),inners:[]}]}));
 const door={key:'node/100',kind:'poi',point:[5,0],polygons:[],tags:{door:'yes',level:'0'},levels:[0]};
 const connector={key:'way/10',kind:'wall',line:true,levels:[0],tags:{indoor:'wall',level:'0'},polygons:[{outer:r.front,outerIds:[id(r.front[0]),100,id(r.front[2])],inners:[]}]};
 const all=JSON.parse(JSON.stringify([...fragments,connector,door]));
 const binding=findSolidDoorBinding(all,door,identity);
 assert.ok(binding);assert.equal(binding.walls.length,2);
 const base=restoreSolidDoor(binding,identity);
 assert.deepEqual(pc.xor(wall,base),[]);
 const target=nearestSolidFace(base,[7,0]);assert.ok(target);
 const moved=cutSolidWall(base,target.at,target.face,2);
 assert.equal(moved.pieces.length,2);
 assert.deepEqual(pc.xor(wall,pc.union(moved.pieces,[moved.gap])),[]);
});
test('oversized and off-face door cuts are rejected without changing input',()=>{
 const before=structuredClone(wall);
 assert.throws(()=>cutSolidWall(wall,[0.1,0],[[0,0],[10,0]],2));
 assert.deepEqual(wall,before);
});
test('batch planning folds generated member edits into creation and drops unused temporary ways',async()=>{
 const {normalizeSolidDoorEdits,projectedOpeningIndoor}=await vite.ssrLoadModule('/src/edit/solid-wall-doors.ts');
 const initial=[{key:'way/-1',create:{key:'way/-1',version:0,tags:{indoor:'wall',level:'0'},line:{ids:[1,2,3,1],coords:[[0,0],[1,0],[1,1],[0,0]]}}}];
 const after=[...initial,{key:'way/-1',tags:{indoor:'wall',level:'1'},line:{ids:[1,4,3,1],coords:[[0,0],[2,0],[1,1],[0,0]]}}];
 const plan=normalizeSolidDoorEdits(after);
 assert.equal(plan.length,1);assert.equal(plan[0].create.tags.level,'1');assert.deepEqual(plan[0].create.line.ids,[1,4,3,1]);
 const projected=projectedOpeningIndoor([],after);
 assert.equal(projected.length,1);assert.deepEqual(projected[0].levels,[1]);assert.deepEqual(projected[0].polygons[0].outerIds,[1,4,3,1]);
 assert.deepEqual(normalizeSolidDoorEdits([...after,{key:'way/-1',delete:true}]),[]);
});
test('door creation, transfer and removal remain atomic session commands and survive autosave',async()=>{
 const {EditSession}=await vite.ssrLoadModule('/src/edit/session.ts');
 const {normalizeSolidDoorEdits}=await vite.ssrLoadModule('/src/edit/solid-wall-doors.ts');
 const s=new EditSession([],()=>{});
 s.editMany(normalizeSolidDoorEdits([
  {key:'node/-1',create:{key:'node/-1',version:0,tags:{door:'yes',level:'0'},polygons:[{outer:[[5,0]],outerIds:[-1],inners:[]}]}},
  {key:'way/-2',create:{key:'way/-2',version:0,tags:{indoor:'wall',level:'0'},line:{ids:[2,-1,3],coords:[[4.5,0],[5,0],[5.5,0]]}}}
 ]));
 const restored=new EditSession([],()=>{});restored.restore(JSON.parse(JSON.stringify(s.snapshot())));
 assert.equal(restored.changes().length,2);restored.undo();assert.equal(restored.changes().length,0);
 restored.redo();assert.equal(restored.changes().length,2);
 restored.editMany([{key:'way/-2',delete:true},{key:'node/-1',delete:true}]);assert.equal(restored.changes().length,0);
 restored.undo();assert.equal(restored.changes().length,2);
});
test('sloping chosen face keeps both jambs perpendicular to that face',()=>{
 const tapered=[[[[0,0],[10,0],[10,3],[0,1],[0,0]]]];
 const r=cutSolidWall(tapered,[5,2],[[0,1],[10,3]],1);
 const face=[10,2];
 for(const [a,b] of [[r.gap[0],r.gap[3]],[r.gap[1],r.gap[2]]])assert.ok(Math.abs((b[0]-a[0])*face[0]+(b[1]-a[1])*face[1])<1e-8);
});
test('restoring one of two openings leaves the other opening untouched',()=>{
 const first=cutSolidWall(wall,[3,0],[[0,0],[10,0]],1);
 const secondFace=nearestSolidFace(first.pieces,[7,0]);
 const second=cutSolidWall(first.pieces,secondFace.at,secondFace.face,1);
 const restored=pc.union(second.pieces,[first.gap]);
 const expected=cutSolidWall(wall,[7,0],[[0,0],[10,0]],1).pieces;
 assert.deepEqual(pc.xor(restored,expected),[]);
});
test('rear face of the doorway also cuts the room wall behind a thick wall',async()=>{
 const {cutDoorOpenings}=await vite.ssrLoadModule('/src/render/door-openings.ts');
 const r=cutSolidWall(wall,[5,0],[[0,0],[10,0]],1),a=r.gap[3],b=r.gap[2];
 const surface=new Float32Array([0,2,0,10,2,0,10,2,3,0,2,0,10,2,3,0,2,3]);
 assert.equal(cutDoorOpenings(surface,[{x:5,y:0,z:0}],1,2.2,0.15),surface);
 const cut=cutDoorOpenings(surface,[{x:(a[0]+b[0])/2,y:(a[1]+b[1])/2,z:0,width:Math.hypot(a[0]-b[0],a[1]-b[1])}],1,2.2,0.15);
 const area=triangles=>{let sum=0;for(let i=0;i<triangles.length;i+=9){const a=[triangles[i],triangles[i+2]],b=[triangles[i+3],triangles[i+5]],c=[triangles[i+6],triangles[i+8]];sum+=Math.abs((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]))/2;}return sum;};
 assert.ok(Math.abs(area(cut)-27.8)<1e-5);
});

test('rear room includes the doorway and shared door vertex; removal restores its boundary',()=>{
 const room=[[[[0,2],[10,2],[10,8],[0,8],[0,2]]]];
 const gap=cutSolidWall(wall,[5,0],[[0,0],[10,0]],1).gap;
 const expanded=roomDoorway(room,gap,[5,0]);
 assert.ok(expanded);
 assert.ok(expanded[0][0].some(p=>p[0]===5&&p[1]===0));
 assert.deepEqual(pc.xor(pc.difference(expanded,[gap]),room),[]);
 const front=[[[[0,-5],[10,-5],[10,0],[0,0],[0,-5]]]];
 assert.equal(roomDoorway(front,gap,[5,0]),undefined);
 const moved=cutSolidWall(wall,[7,0],[[0,0],[10,0]],1).gap;
 const updated=roomDoorway(pc.difference(expanded,[gap]),moved,[7,0]);
 assert.deepEqual(pc.xor(updated,pc.union(room,[moved])),[]);
});

test('room union tolerates independently rounded rear edge and still shares door vertex',()=>{
 const gap=cutSolidWall(wall,[5,0],[[0,0],[10,0]],1).gap;
 const room=[[[[0,2.00001],[10,2.00001001],[10,8],[0,8],[0,2.00001]]]];
 const expanded=roomDoorway(room,gap,[5,0]);
 assert.ok(expanded);
 assert.equal(expanded.length,1);
 assert.ok(expanded[0][0].some(p=>p[0]===5&&p[1]===0));
 assert.ok(expanded[0][0].some(p=>p[0]===4.5&&p[1]===0));
 assert.ok(expanded[0][0].some(p=>p[0]===5.5&&p[1]===0));
 const distant=[[[[0,2.01],[10,2.01],[10,8],[0,8],[0,2.01]]]];
 assert.equal(roomDoorway(distant,gap,[5,0]),undefined);
});

test('validator offers a notch for an existing door only on an eligible same-floor polygon wall',()=>{
 const ll=([x,y])=>[37+x/(111320*Math.cos(55*Math.PI/180)),55+y/111320];
 const w={key:'way/20',kind:'wall',tags:{indoor:'wall',level:'0'},levels:[0],polygons:[{outer:wall[0][0].slice(0,-1).map(ll),inners:[]}]};
 const door={key:'node/6167823702',kind:'poi',tags:{door:'yes',level:'0'},levels:[0],point:ll([5,0]),polygons:[]};
 const issues=validateSolidWallDoors([w,door]);
 assert.equal(issues.length,1);assert.equal(issues[0].fix.solidDoorWall,w.key);assert.equal(issues[0].key,door.key);
 assert.equal(validateSolidWallDoors([{...w,levels:[1]},door]).length,0);
 assert.equal(validateSolidWallDoors([w,{...door,point:ll([5,-.2])}]).length,0);
 assert.equal(validateSolidWallDoors([w,{...door,tags:{...door.tags,width:'12'}}]).length,0);
});

test('OSM door node with millimetre rounding is not treated as the end of a usable wall face',()=>{
 const poly=[[[[0,0],[5,.005],[10,0],[10,2],[0,2],[0,0]]]];
 const face=nearestSolidFace(poly,[5,.005],.03);
 assert.ok(face);assert.doesNotThrow(()=>cutSolidWall(poly,face.at,face.face,1));
});

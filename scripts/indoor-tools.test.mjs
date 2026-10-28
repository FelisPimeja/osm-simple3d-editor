import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {createServer} from 'vite';
let vite, EditSession, ShapeTool, MoveTool, THREE, editIndoorGeometry;
before(async()=>{
 globalThis.localStorage={getItem:()=> 'en'};
 globalThis.document={documentElement:{},createElement:()=>({addEventListener(){}})};
 vite=await createServer({configFile:false,server:{middlewareMode:true,ws:false,watch:null},appType:'custom'});
 ({EditSession}=await vite.ssrLoadModule('/src/edit/session.ts'));
 ({ShapeTool}=await vite.ssrLoadModule('/src/edit/shape-tool.ts'));
 ({MoveTool}=await vite.ssrLoadModule('/src/edit/move-tool.ts'));
 ({editIndoorGeometry}=await vite.ssrLoadModule('/src/edit/indoor-geometry.ts'));
 THREE=await import('three');
});
after(async()=>{await vite.close();delete globalThis.document;delete globalThis.localStorage;});
test('room, open wall and tagged door changes undo and redo in one step',()=>{
 const room={key:'way/1',kind:'room',levels:[0],tags:{indoor:'room',level:'0'},polygons:[{outer:[[0,0],[2,0],[2,2],[0,2]],outerIds:[1,2,3,4],inners:[],innerIds:[]}]};
 const wall={key:'way/2',kind:'wall',line:true,levels:[0],tags:{indoor:'wall',level:'0'},polygons:[{outer:[[2,0],[2,2]],outerIds:[2,3],inners:[],innerIds:[]}]};
 const door={key:'node/20',kind:'poi',levels:[0],tags:{door:'yes',level:'0'},point:[2,1],polygons:[]};
 const session=new EditSession([
  {key:room.key,version:1,tags:room.tags,polygons:room.polygons},
  {key:wall.key,version:1,tags:wall.tags,line:{ids:[2,3],coords:[[2,0],[2,2]]}},
  {key:door.key,version:1,tags:door.tags,polygons:[{outer:[door.point],outerIds:[20],inners:[],innerIds:[]}]},
 ],()=>{});
 session.editMany(editIndoorGeometry([room,wall,door],{type:'move',vertices:[1,2].map(i=>({key:room.key,poly:0,ring:0,i})),delta:[1,0]},true,()=>-1));
 assert.deepEqual(session.get(wall.key).line.coords,[[3,0],[3,2]]);
 assert.deepEqual(session.get(door.key).polygons[0].outer,[[3,1]]);
 assert.ok(session.changes().length>=2);
 session.undo();assert.equal(session.changes().length,0);
 assert.deepEqual(session.get(wall.key).line.coords,[[2,0],[2,2]]);
 assert.deepEqual(session.get(door.key).polygons[0].outer,[[2,1]]);
 session.redo();assert.ok(session.changes().length>=2);
 assert.deepEqual(session.get(wall.key).line.coords,[[3,0],[3,2]]);
});
test('Shape does not offer a phantom closing edge for an open wall',()=>{
 const layer={focusRay:()=>new THREE.Ray(new THREE.Vector3(50,50,10),new THREE.Vector3(0,0,-1)),focusPolygons:()=>[{outer:[[0,0],[100,0],[100,100]],inners:[]}],focusProject:p=>[p.x,p.y],snapAt:()=>undefined};
 const tool=new ShapeTool(layer,{appendChild(){}},()=>['way/1'],()=>({min:0,top:0,roof:0}),()=>new Set(),()=>undefined,()=>true,()=>{},()=>{});
 tool.isOpen=()=>true;
 assert.equal(tool.edgeAt([50,50]),undefined);
 tool.isOpen=()=>false;
 assert.ok(tool.edgeAt([50,50]));
});
test('geometry can be attached after tag editing without breaking the undo baseline',()=>{
 const session=new EditSession([{key:'way/1',version:1,tags:{indoor:'wall',level:'0'}}],()=>{});
 session.setTags('way/1',{name:'Edited'});
 session.track({key:'way/1',version:1,tags:{indoor:'wall',level:'0'},line:{ids:[1,2],coords:[[0,0],[1,0]]}});
 assert.equal(session.get('way/1').tags.name,'Edited');
 session.editMany([{key:'way/1',line:{ids:[1,2],coords:[[0,0],[2,0]]}}]);
 assert.equal(session.changes()[0].nodeMoves.length,1);
 session.undo();assert.deepEqual(session.get('way/1').line.coords,[[0,0],[1,0]]);
 assert.equal(session.get('way/1').tags.name,'Edited');
 session.undo();assert.equal(session.changes().length,0);
});

test('Move accepts an indoor surface anchor and commits only horizontal coordinates',()=>{
 const writes=[];
 const layer={focusAxes:{x:[1,0],y:[0,1]},snapAt:()=>undefined,pickHit:()=>undefined,pickDoor:()=>undefined,
  focusRay:()=>new THREE.Ray(new THREE.Vector3(1,0,10),new THREE.Vector3(0,0,-1)),focusProject:p=>[p.x*20,p.y*20],setMoveGuide(){},setMovePreview(){}};
 const tool=new MoveTool(layer,{appendChild(){}},(...args)=>writes.push(args),()=>{});
 tool.objectAnchor=()=>new THREE.Vector3(0,0,0);
 tool.start(['way/1'],true);
 tool.click([0,0]);assert.equal(tool.state,'move');
 tool.move([20,0]);tool.click([20,0]);
 assert.equal(writes.length,1);assert.equal(writes[0][1].z,0);assert.ok(writes[0][1].x>0);
 tool.click([0,0]);tool.move([20,0]);tool.validate=()=> 'Invalid outline';tool.click([20,0]);
 assert.equal(writes.length,1);assert.equal(tool.state,'move');
});

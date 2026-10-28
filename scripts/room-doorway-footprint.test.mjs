import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {createServer} from 'vite';
import * as THREE from 'three';
let vite,wallDoorwaySpan,BuildingsLayer;
before(async()=>{globalThis.window={};vite=await createServer({configFile:false,server:{middlewareMode:true,ws:false,watch:null},appType:'custom'});({wallDoorwaySpan}=await vite.ssrLoadModule('/src/render/door-openings.ts'));({BuildingsLayer}=await vite.ssrLoadModule('/src/render/buildings-layer.ts'));});
after(async()=>{await vite.close();delete globalThis.window;});
const notch=[[4,0],[6,0],[6,2],[4,2]];
test('notch cuts a room boundary anywhere inside wall thickness, including reversed and short segments',()=>{
 assert.deepEqual(wallDoorwaySpan([0,1],[10,1],notch),[.4,.6]);
 assert.deepEqual(wallDoorwaySpan([10,1],[0,1],notch),[.4,.6]);
 assert.deepEqual(wallDoorwaySpan([4.1,1],[4.2,1],notch),[0,1]);
 assert.equal(wallDoorwaySpan([0,3],[10,3],notch),undefined);
 assert.deepEqual(wallDoorwaySpan([0,2],[10,2],notch),[.4,.6]);
 assert.deepEqual(wallDoorwaySpan([0,1],[10,1],[...notch].reverse()),[.4,.6]);
});
const ll=(x,y)=>[37+x/(111320*Math.cos(55*Math.PI/180)),55+y/111320];
function fixture(segmented=false, boundary=1){
 const layer=new BuildingsLayer('test');
 layer.setFocus([{key:'way/1',type:'way',id:1,version:1,kind:'part',hasParts:false,tags:{'building:part':'yes',height:'6'},polygons:[{outer:[[-1,-2],[11,-2],[11,8],[-1,8]].map(p=>ll(...p)),inners:[]}]}]);
 const front=segmented?Array.from({length:101},(_,i)=>[i/10,boundary]):[[0,boundary],[10,boundary+1e-8]];
 const room={key:'way/2',kind:'room',z:0,polygons:[{outer:[...front,[10,6],[0,6]].map(p=>ll(...p)),inners:[]}]};
 const spec={floor:0,cut:3,items:[room],doors:[ll(5,0)]};
 const blocked=z=>{
  const g=layer.groups.get('@focus'),a=g.toLocal(ll(5,-.5)),b=g.toLocal(ll(5,.5));
  const ray=new THREE.Ray(new THREE.Vector3(...a,z),new THREE.Vector3(b[0]-a[0],b[1]-a[1],0).normalize()),p=new THREE.Vector3();
  const triangles=layer.indoorWallPositions;
  for(let i=0;i<triangles.length;i+=9)if(ray.intersectTriangle(new THREE.Vector3().fromArray(triangles,i),new THREE.Vector3().fromArray(triangles,i+3),new THREE.Vector3().fromArray(triangles,i+6),false,p)&&p.distanceTo(ray.origin)<4) return true;
  return false;
 };
 return {layer,spec,blocked};
}
for(const segmented of [false,true])test(`actual room perimeter mesh leaves the full-height notch open (segmented=${segmented})`,()=>{
 const {layer,spec,blocked}=fixture(segmented);
 layer.setLevel(spec);assert.equal(blocked(1),true);
 layer.setLevel({...spec,doorCuts:[{at:ll(5,2),width:2,polygon:notch.map(p=>ll(...p))}]});
 assert.equal(blocked(1),false);
 assert.equal(blocked(2.6),false);
 layer.setLevel(spec);assert.equal(blocked(1),true);
});

test('expanded room perimeter does not consume solid jamb faces before they are drawn',()=>{
 const {layer,spec}=fixture();
 const room={key:'way/2',kind:'room',z:0,polygons:[{outer:[[0,2],[4,2],[4,0],[5,0],[6,0],[6,2],[10,2],[10,6],[0,6]].map(p=>ll(...p)),inners:[]}]};
 const walls=[[[0,0],[4,0],[4,2],[0,2]],[[6,0],[10,0],[10,2],[6,2]]].map((outer,i)=>({key:`way/${i+3}`,kind:'wall',z:0,polygons:[{outer:outer.map(p=>ll(...p)),inners:[]}]}));
 layer.setLevel({...spec,items:[room,...walls],doorCuts:[{at:ll(5,2),width:2,polygon:notch.map(p=>ll(...p))}]});
 const g=layer.groups.get('@focus'),positions=layer.indoorWallPositions;
 for(const x of [4,6])for(const z of [1,2.6]){
  const origin=g.toLocal(ll(5,1)),target=g.toLocal(ll(x,1));
  const ray=new THREE.Ray(new THREE.Vector3(...origin,z),new THREE.Vector3(target[0]-origin[0],target[1]-origin[1],0).normalize()),p=new THREE.Vector3();
  let hit=false;
  for(let i=0;i<positions.length;i+=9)if(ray.intersectTriangle(new THREE.Vector3().fromArray(positions,i),new THREE.Vector3().fromArray(positions,i+3),new THREE.Vector3().fromArray(positions,i+6),false,p)&&p.distanceTo(ray.origin)<1.1)hit=true;
  assert.equal(hit,true,`jamb x=${x}, z=${z}`);
 }
});

test('rounded, almost parallel rear room boundary does not leave a lintel strip',()=>{
 const {layer,spec,blocked}=fixture(false,2.00001);
 layer.setLevel({...spec,doorCuts:[{at:ll(5,2),width:2,polygon:notch.map(p=>ll(...p))}]});
 assert.equal(blocked(1),false);
 assert.equal(blocked(2.6),false);
 assert.deepEqual(wallDoorwaySpan([0,2.00001],[10,2.00001001],notch),[.4,.6]);
 assert.equal(wallDoorwaySpan([0,2.01],[10,2.01000001],notch),undefined);
});

test('same room on the floor below does not add a dark horizontal seam at the upper floor',()=>{
 const {layer}=fixture();
 const room={key:'relation/17973190',kind:'room',z:0,polygons:[{outer:[[0,0],[10,0],[10,6],[0,6]].map(p=>ll(...p)),inners:[]}]};
 const spec={floor:0,cut:3,items:[room],doors:[]};
 const floorEdges=()=>layer.indoorObj.children.filter(o=>o.isLineSegments).reduce((count,o)=>{
  const p=o.geometry.getAttribute('position');
  for(let i=0;i+1<p.count;i+=2)if(Math.abs(p.getZ(i)-p.getZ(i+1))<1e-6&&p.getZ(i)>=0&&p.getZ(i)<.1)count++;
  return count;
 },0);
 layer.setLevel(spec);assert.ok(floorEdges()>0);
 layer.setLevel({...spec,below:[{cut:0,items:[{...room,z:-3}],doors:[]}]});
 assert.equal(floorEdges(),0);
 layer.setLevel(spec);assert.ok(floorEdges()>0);
});

for(const floor of [3,6])test(`multilevel room walls remain on upper floor ${floor/3} without a room floor`,()=>{
 const {layer}=fixture();
 const polygon={outer:[[0,0],[10,0],[10,6],[0,6]].map(p=>ll(...p)),inners:[]};
 const room={key:'atrium',kind:'room',z:floor,noFloor:true,polygons:[polygon]};
 const building=layer.groups.get('@focus').items[0].feature;
 layer.previewFocusFeature({...building,tags:{...building.tags,height:'12'}});
 layer.setLevel({floor,cut:floor+3,items:[room],doors:[],voids:[[polygon.outer]],below:[]});
 const walls=layer.indoorWallPositions;
 assert.ok(walls.length>0);
 const zs=Array.from(walls).filter((_,i)=>i%3===2);
 assert.ok(Math.min(...zs)<=floor+.001);
 assert.ok(Math.max(...zs)>floor+2);
 for(const child of layer.indoorObj.children.filter(o=>o.isMesh)){
  const p=child.geometry.getAttribute('position');
  for(let i=0;i+2<p.count;i+=3)assert.equal([i,i+1,i+2].every(j=>Math.abs(p.getZ(j)-(floor+.05))<.001),false,'no room floor on the upper level');
 }
});

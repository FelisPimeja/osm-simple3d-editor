import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {before,after,test} from 'node:test';
import {createServer} from 'vite';
import * as THREE from 'three';
let vite,BuildingsLayer,parseBuildings,pc,buildPlans,findVoids,floorLevels,computeHeights;
before(async()=>{
 globalThis.window={};
 vite=await createServer({configFile:false,server:{middlewareMode:true,ws:false,watch:null},appType:'custom'});
 ({BuildingsLayer}=await vite.ssrLoadModule('/src/render/buildings-layer.ts'));
 ({parseBuildings,floorLevels}=await vite.ssrLoadModule('/src/osm/model.ts'));
 ({buildPlans,findVoids}=await vite.ssrLoadModule('/src/view/indoor-voids.ts'));
 ({computeHeights}=await vite.ssrLoadModule('/src/osm/heights.ts'));
 pc=(await import('polygon-clipping')).default;
});
after(async()=>{delete globalThis.window;await vite.close();});
test('17973190 stairwell: the main building section excludes the lower sloping annex',()=>{
 const {features,indoor}=parseBuildings(JSON.parse(readFileSync(new URL('./fixtures/sloping-stair-room.json',import.meta.url))));
 const layer=new BuildingsLayer('test');layer.setFocus(features);
 layer.map={getCanvas:()=>({width:800,height:600,clientWidth:800}),triggerRepaint(){}};
 const room=indoor.find(f=>f.key==='relation/17973190');
 const items=z=>indoor.filter(f=>f.key===room.key||f.line).map(f=>({...f,z,noFloor:z===0}));
 const g=[...layer.groups.values()].find(g=>g.byKey.has('relation/17948425'));
 const poly=p=>[p.outer,...p.inners].map(r=>r.map(g.toLocal));
 const plans=buildPlans([{n:-1,floor:-3.5,ceil:0},{n:0,floor:0,ceil:3.5}],
  features.filter(f=>f.kind==='part').map(f=>({...computeHeights(f.tags),polygons:f.polygons.map(poly)})),
  indoor.map(f=>({...f,floors:floorLevels(f),polygons:f.polygons.map(poly)})));
 const voids=findVoids(0,plans);
 assert.ok(voids.length>0,'the low annex must not lose its level-0 stairwell opening');
 assert.ok(voids.some(v=>v.through.includes(-1)),'the basement must be visible through the stairwell');
 const holes=voids.flatMap(v=>v.polygon.map(p=>p.map(r=>r.slice(0,-1).map(g.fromLocal))));
 layer.setLevel({floor:0,cut:3.5,items:items(0),doors:[],below:[{cut:0,items:items(-3.5),doors:[]}],voids:holes});
 const annex=features.find(f=>f.key==='relation/17948425');
 const footprint=annex.polygons.map(p=>[p.outer,...p.inners].map(r=>{const q=r.map(g.toLocal);return [...q,q[0]];}));
 const section=layer.sectionAt(g,3.4);
 const overlap=pc.intersection(section,footprint);
 const area=overlap.reduce((sum,p)=>sum+p.reduce((sum,r,j)=>sum+(j?-1:1)*Math.abs(r.reduce((sum,a,i)=>{const b=r[(i+1)%r.length];return sum+a[0]*b[1]-a[1]*b[0];},0))/2,0),0);
 assert.ok(area<1e-5,`phantom upper contour covers ${area} m² of the low annex`);
 const outline=[];
 layer.indoorObj.traverse(o=>{if(o.isLineSegments2){const a=o.geometry.getAttribute('instanceStart'),b=o.geometry.getAttribute('instanceEnd');for(let i=0;i<a.count;i++)if(Math.abs(a.getZ(i)-b.getZ(i))>.2)outline.push([a.getZ(i),b.getZ(i)]);}});
 assert.ok(outline.length>0,'the annex retains its inclined heavy outline');
 // Back edge 5 belongs to the main facade. Opening the annex must not cut
 // away that facade underneath the old roof plane.
 const main=g.byKey.get('relation/17948426'),ring=annex.polygons[0].outer.map(g.toLocal);
 // Do not recreate vertical indoor walls above the annex's sloping sides.
 const sample=new THREE.Vector3((ring[0][0]+ring[1][0])/2,(ring[0][1]+ring[1][1])/2,3.2);
 const ta=new THREE.Vector3(),tb=ta.clone(),tc=ta.clone(),nearest=ta.clone();
 let indoorDistance=Infinity;
 layer.indoorObj.traverse(o=>{
  if(!o.isMesh||o.isLineSegments2||o.isLine2)return;
  const p=o.geometry.getAttribute('position');if(!p)return;
  for(let i=0;i+2<p.count;i+=3){
   ta.fromBufferAttribute(p,i);tb.fromBufferAttribute(p,i+1);tc.fromBufferAttribute(p,i+2);
   new THREE.Triangle(ta,tb,tc).closestPointToPoint(sample,nearest);
   const distance=nearest.distanceTo(sample);
   if(Number.isFinite(distance))indoorDistance=Math.min(indoorDistance,distance);
  }
 });
 assert.ok(indoorDistance>.1,`extra indoor side wall above the roof: ${indoorDistance}`);
 let horizontalBand=0;
 layer.indoorObj.traverse(o=>{
  if(!o.isLineSegments2)return;
  const a=o.geometry.getAttribute('instanceStart'),b=o.geometry.getAttribute('instanceEnd');
  for(let i=0;i<a.count;i++)if(Math.abs(a.getZ(i)-1.17)<.005&&Math.abs(b.getZ(i)-1.17)<.005){
   const mx=(a.getX(i)+b.getX(i))/2,my=(a.getY(i)+b.getY(i))/2;
   const onBack=[5,6,7,8].some(j=>{
    const u=ring[j],v=ring[(j+1)%ring.length],dx=v[0]-u[0],dy=v[1]-u[1];
    return Math.abs((mx-u[0])*dy-(my-u[1])*dx)/Math.hypot(dx,dy)<.03;
   });
   if(onBack)horizontalBand+=Math.hypot(a.getX(i)-b.getX(i),a.getY(i)-b.getY(i));
  }
 });
 assert.ok(horizontalBand<.3,`phantom horizontal junction band: ${horizontalBand}m`);

 const pos=g.mesh.geometry.getAttribute('position'),a=new THREE.Vector3(),b=a.clone(),c=a.clone(),hit=a.clone();
 for(const z of [.5,1.5,3.2]){
  const q=new THREE.Vector3((ring[5][0]+ring[6][0])/2,(ring[5][1]+ring[6][1])/2,z);
  let distance=Infinity;
  for(let i=main.start;i<main.start+main.wallVertices;i+=3){
   a.fromBufferAttribute(pos,i);b.fromBufferAttribute(pos,i+1);c.fromBufferAttribute(pos,i+2);
   new THREE.Triangle(a,b,c).closestPointToPoint(q,hit);distance=Math.min(distance,hit.distanceTo(q));
  }
  assert.ok(distance<1e-4,`back wall has a hole at height ${z}, distance=${distance}`);
 }

});

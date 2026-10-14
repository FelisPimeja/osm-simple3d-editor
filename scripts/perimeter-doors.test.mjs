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
after(async()=>{delete globalThis.window; await vite.close();});
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

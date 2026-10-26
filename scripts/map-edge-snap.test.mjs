import assert from 'node:assert/strict';
import {before, after, test} from 'node:test';
import {createServer} from 'vite';
let vite, BuildingsLayer, THREE;
before(async () => {
  globalThis.window = {};
  vite = await createServer({configFile:false, server:{middlewareMode:true,ws:false,watch:null},appType:'custom'});
  ({BuildingsLayer} = await vite.ssrLoadModule('/src/render/buildings-layer.ts'));
  THREE = await import('three');
});
after(async () => {delete globalThis.window; await vite?.close();});
test('map nearest snap follows an edge and respects exclusions', () => {
  const layer = new BuildingsLayer('test');
  const f = {model:new THREE.Matrix4()};
  const g = {model:new THREE.Matrix4(),hidden:new Set()};
  layer.setSketch([0,0]);
  const focusKey = [...layer.groups.keys()][0];
  assert.ok(focusKey);
  layer.groups.set(focusKey,f);
  layer.groups.set('map',g);
  layer.mapSnaps.set(g,{points:[],edges:[{key:'way/1',a:new THREE.Vector3(-.8,0,0),b:new THREE.Vector3(.8,0,0)}]});
  // A thousand distant edges must never reach the 3D nearest-point calculation.
  for (let i=0;i<1000;i++) layer.mapSnaps.get(g).edges.push({key:'way/far',a:new THREE.Vector3(-.9,.8,0),b:new THREE.Vector3(-.7,.8,0)});
  layer.map = {getCanvas:()=>({clientWidth:1000,clientHeight:1000})};
  layer.lastMain = new THREE.Matrix4();
  let checks = 0;
  layer.focusRay = () => {
    const ray = new THREE.Ray(new THREE.Vector3(.2,.02,1),new THREE.Vector3(0,0,-1));
    const nearest = ray.distanceSqToSegment.bind(ray);
    ray.clone = ()=>ray;
    ray.distanceSqToSegment = (...args)=>{checks++;return nearest(...args);};
    return ray;
  };
  layer.focusToLngLat = ()=>[0,0];
  layer.pickHit = ()=>undefined;
  const hit = layer.mapGroupSnap([600,490],()=>true,12);
  assert.equal(hit?.kind,'edge');
  assert.equal(checks,1);
  assert.ok(Math.abs(hit.local.x-.2)<1e-6);
  assert.ok(Math.abs(hit.local.y)<1e-6);
  assert.equal(layer.mapGroupSnap([600,490],()=>true,12,{noEdge:true}),undefined);
  assert.equal(layer.mapGroupSnap([600,490],()=>false,12),undefined);
  layer.snapKindsOff.add('edge');
  assert.equal(layer.mapGroupSnap([600,490],()=>true,12),undefined);
});

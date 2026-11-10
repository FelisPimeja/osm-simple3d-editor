import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {createServer} from 'vite';
let vite,pointInRing,pointInRingFast;
before(async()=>{vite=await createServer({configFile:false,server:{middlewareMode:true,ws:false,watch:null},appType:'custom'});({pointInRing,pointInRingFast}=await vite.ssrLoadModule('/src/osm/model.ts'));});
after(async()=>await vite?.close());
// Индекс полос даёт тот же ответ, что и полный перебор рёбер: звёздчатые кольца в сотни вершин, точки вокруг
test('banded point-in-ring matches the plain ray cast',()=>{
 let seed=1;const rnd=()=>(seed=(seed*16807)%2147483647)/2147483647;
 for(let t=0;t<100;t++){
  const n=32+Math.floor(rnd()*400),ring=[];
  for(let i=0;i<n;i++){const a=i/n*2*Math.PI,r=1+rnd();ring.push([37+r*Math.cos(a)*0.01,55+r*Math.sin(a)*0.01]);}
  for(let k=0;k<300;k++){const p=[37+(rnd()*2-1)*0.025,55+(rnd()*2-1)*0.025];assert.equal(pointInRingFast(p,ring),pointInRing(p,ring));}
 }
});

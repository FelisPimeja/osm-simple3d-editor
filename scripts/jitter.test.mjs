import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {createServer} from 'vite';
let vite,jitterVertices,dropJitter;
before(async()=>{vite=await createServer({configFile:false,server:{middlewareMode:true,ws:false,watch:null},appType:'custom'});({jitterVertices,dropJitter}=await vite.ssrLoadModule('/src/render/jitter.ts'));});
after(async()=>await vite?.close());
// Прямоугольник 10×5 м с «гармошкой» на нижней стене (как way/701259153: ступеньки по 1 см)
const zigzag=[[0,0],[4,0],[4.007,0.01],[4.014,0],[4.02,0.012],[4.03,0],[10,0],[10,5],[0,5]];
test('centimetre zigzag on a straight wall is jitter, corners stay',()=>{
 assert.deepEqual(jitterVertices(zigzag),[1,2,3,4,5]);
 assert.deepEqual(dropJitter(zigzag),[[0,0],[10,0],[10,5],[0,5]]);
});
test('real small features and collinear points on long walls are kept',()=>{
 const notch=[[0,0],[4,0],[4,0.3],[4.3,0.3],[4.3,0],[10,0],[10,5],[0,5]];
 assert.deepEqual(jitterVertices(notch),[]);
 const split=[[0,0],[5,0],[10,0],[10,5],[0,5]];
 assert.deepEqual(jitterVertices(split),[]);
});
test('closed ring keeps its closing point',()=>{
 const r=dropJitter([...zigzag,zigzag[0]]);
 assert.deepEqual(r[0],r.at(-1));assert.equal(r.length,5);
});

import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import fs from 'node:fs';import {createServer} from 'vite';
let v,freeAreaPieces,parseBuildings;
before(async()=>{v=await createServer({configFile:false,server:{middlewareMode:true,ws:false,watch:null},appType:'custom'});({freeAreaPieces}=await v.ssrLoadModule('/src/edit/free-area.ts'));({parseBuildings}=await v.ssrLoadModule('/src/osm/model.ts'));});
after(async()=>await v.close());
const box=[[[[0,0],[10,0],[10,10],[0,10],[0,0]]]];
test('connected wall ways partition empty space; dangling wall ends are not extended',()=>{
 assert.equal(freeAreaPieces(box,[],[[[0,5],[4,5]],[[10,5],[6,5]],[[4,5],[6,5]]]).length,2);
 assert.equal(freeAreaPieces(box,[],[[[3,5],[7,5]]]).length,1);
 assert.equal(freeAreaPieces(box,[],[[[0,5],[7,5]]]).length,1);
});
test('closed linear wall separates its interior without losing the exterior',()=>{
 assert.equal(freeAreaPieces(box,[],[[[2,2],[8,2],[8,8],[2,8],[2,2]]]).length,2);
});
test('actual walls around relation/18071736 separate its surrounding empty area',()=>{
 const data=parseBuildings(JSON.parse(fs.readFileSync(new URL('./fixtures/niche-rooms.json',import.meta.url))));
 const walls=JSON.parse(fs.readFileSync(new URL('./fixtures/free-area-walls.json',import.meta.url)));
 const local=([x,y])=>[(x-37.621)*111320*Math.cos(55.822*Math.PI/180),(y-55.822)*111320];
 const close=r=>{const p=r.map(local);return [...p,p[0]];};
 const section=data.features.flatMap(f=>f.polygons.map(p=>[close(p.outer),...p.inners.map(close)]));
 const occupied=data.indoor.filter(f=>f.kind==='room').map(f=>f.polygons.map(p=>[close(p.outer),...p.inners.map(close)]));
 const before=freeAreaPieces(section,occupied,[]),after=freeAreaPieces(section,occupied,walls.map(r=>r.map(local)),[{at:local([37.6216114,55.8221123]),width:1}]);
 assert.ok(after.length>before.length,`${before.length} -> ${after.length}`);
});

test('door closes only its actual opening, not an arbitrary gap',()=>{
 const walls=[[[2,2],[2,8],[8,8],[8,2],[5.5,2]],[[2,2],[4.5,2]]];
 assert.equal(freeAreaPieces(box,[],walls).length,1);
 assert.equal(freeAreaPieces(box,[],walls,[{at:[5,2],width:1}]).length,2);
 assert.equal(freeAreaPieces(box,[],walls,[{at:[5,3],width:1}]).length,1);
});

// way/1572293454, way/1572293457: a wall or door bridge ending inside the empty space left a zero-width slit A→B→A
// in the piece, and the polygon wall made from it got a self-overlapping tail (double jamb, missing end faces).
test('despike removes zero-width slits, keeps the face',async()=>{
 const {despike}=await v.ssrLoadModule('/src/edit/free-area.ts');
 // Like way/1572293454: …, 12174757021, door, 14323940309, door, 12174757021, …
 const ring=[[0,0],[4,0],[4,1],[4,1.5],[4,1],[4,0],[4,-1],[0,-1],[0,0]];
 assert.deepEqual(despike(ring),[[0,0],[4,0],[4,-1],[0,-1],[0,0]]);
 assert.deepEqual(despike([[0,0],[1,0],[1,1],[0,1],[0,0]]),[[0,0],[1,0],[1,1],[0,1],[0,0]]);
});

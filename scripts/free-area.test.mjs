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

// way/-272 → way/-274 (w219440454): узел контура этажа на 13 см левее грани колонны — пустая площадь получила клин
// длиной 2,3 м вверх и 1,6 м вниз вдоль стены, стена из куска — шип.
test('despike removes narrow wedges along the outline, keeps real corners',async()=>{
 const {despike}=await v.ssrLoadModule('/src/edit/free-area.ts');
 const ring=[[-0.13,2.83],[0,0],[0.1,-2.12],[0.02,-0.5],[0.5,-0.48],[0.45,0.52],[-0.02,0.5],[-0.13,2.83]];
 assert.deepEqual(despike(ring),[[0,0],[0.02,-0.5],[0.5,-0.48],[0.45,0.52],[-0.02,0.5],[0,0]]);
 const sharp=[[0,0],[10,0],[0,1.2],[0,0]];
 assert.deepEqual(despike(sharp),sharp);
});

// way/-294 (w219440454): проём лестницы у самой стены — пустая площадь из двух кусков, сшитых в узле -41,
// и «ножка» нулевой ширины вдоль стены.
test('cleanPiece splits a ring pinched at a vertex and drops the zero-width leg',async()=>{
 const {cleanPiece}=await v.ssrLoadModule('/src/edit/free-area.ts');
 const ring=[[0,0],[0.3,-6.31],[0.43,-9.17],[0.48,-10.17],[0.53,-11.32],[9.01,-10.92],[8.77,-5.92],[4.53,-6.11],[0.3,-6.31],[0.16,-3.31],[4.39,-3.11],[4.24,0.2],[0,0]];
 const out=cleanPiece([ring]);
 assert.equal(out.length,2);
 const upper=out.find(p=>p[0].some(q=>q[1]>0));
 assert.ok(!upper[0].some(q=>q[1]<-3.5),JSON.stringify(upper));
});

// relation/-297 (w219440454): проём лестницы — внутреннее кольцо, касающееся внешнего контура (узлы -212, -41 на
// его стороне, -45 — его вершина): не двор, а вырез, делящий площадь на два куска.
test('cleanPiece turns an inner ring touching the outer into a notch and splits the piece',async()=>{
 const {cleanPiece}=await v.ssrLoadModule('/src/edit/free-area.ts');
 const outer=[[0,0],[0.43,-9.17],[0.48,-10.17],[0.53,-11.32],[9.01,-10.92],[8.47,0.4],[7.93,0.37],[6.93,0.33],[6.36,0.3],[6.51,-3.02],[5.33,-3.07],[4.39,-3.11],[4.24,0.2],[0,0]];
 const inner=[[4.39,-3.11],[4.53,-6.11],[0.3,-6.31],[0.16,-3.31],[4.39,-3.11]];
 const out=cleanPiece([outer,inner]);
 assert.equal(out.length,2,JSON.stringify(out));
 assert.ok(out.every(p=>p.length===1));
});

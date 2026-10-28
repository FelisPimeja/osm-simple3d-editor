import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {createServer} from 'vite';
import pc from 'polygon-clipping';
let vite,finiteCutPieces;
before(async()=>{vite=await createServer({configFile:false,server:{middlewareMode:true,ws:false,watch:null},appType:'custom'});({finiteCutPieces}=await vite.ssrLoadModule('/src/edit/finite-cut.ts'));});
after(async()=>await vite.close());
const face=[[[0,0],[10,0],[10,10],[0,10],[0,8],[8,8],[8,2],[0,2],[0,0]]];
const side=[[[5,-100],[100,-100],[100,100],[5,100],[5,-100]]];
const split=()=>[...pc.intersection(face,side),...pc.difference(face,side)];
test('short cut through one arm does not cut the distant arm of the same room',()=>{
 const pieces=finiteCutPieces(split(),[[5,-1],[5,3]],face);
 assert.equal(split().length,3);assert.equal(pieces.length,2);
 assert.deepEqual(pc.xor(face,...pieces),[]);
 assert.deepEqual(pc.intersection(pieces[0],pieces[1]),[]);
});
test('end inside the room extends only to the first wall',()=>{
 assert.equal(finiteCutPieces(split(),[[5,-1],[5,1]],face).length,2);
});
test('long drawn cut may intentionally split both arms',()=>{
 assert.equal(finiteCutPieces(split(),[[5,-1],[5,11]],face).length,3);
});
test('unreached polygon is rejoined rather than split',()=>{
 assert.equal(finiteCutPieces(split(),[[5,-3],[5,-1]],face).length,1);
});
test('polygon wall split persists separate selectable geometry, including closed line walls',async()=>{
 const {isIndoorCutPolygon,indoorUnionGeometry}=await vite.ssrLoadModule('/src/edit/indoor-union.ts');
 const {EditSession}=await vite.ssrLoadModule('/src/edit/session.ts');
 const outer=[[0,0],[10,0],[10,1],[0,1]];
 const half=[[[5,-10],[20,-10],[20,10],[5,10],[5,-10]]];
 for(const line of [false,true]){
  const wall={key:'way/1572319834',kind:'wall',line,tags:{indoor:'wall',level:'0'},levels:[0],
   polygons:[{outer:line?[...outer,outer[0]]:outer,outerIds:line?[1,2,3,4,1]:[1,2,3,4],inners:[]}]};
  assert.equal(isIndoorCutPolygon(wall),true);
  assert.equal(isIndoorCutPolygon({...wall,line:true,polygons:[{...wall.polygons[0],outerIds:[1,2,3,4]}]}),false);
  const pieces=finiteCutPieces([...pc.intersection([outer],half),...pc.difference([outer],half)],[[5,-1],[5,2]],[outer]);
  assert.equal(pieces.length,2);
  const session=new EditSession([],()=>{});
  session.track({key:wall.key,version:1,tags:wall.tags,...(line?{line:{ids:wall.polygons[0].outerIds,coords:wall.polygons[0].outer}}:{polygons:wall.polygons})});
  const rings=pieces.map(p=>p[0].slice(0,-1).map((q,i)=>({id:-i-1,p:q})));
  session.editMany([{key:wall.key,...indoorUnionGeometry(wall,rings[0])},
   {key:'way/-99',create:{key:'way/-99',version:0,tags:wall.tags,...indoorUnionGeometry({...wall,line:false},rings[1])}}]);
  const kept=session.get(wall.key),created=session.get('way/-99');
  assert.deepEqual(pc.intersection([kept.polygons[0].outer],[created.polygons[0].outer]),[]);
  assert.deepEqual(pc.xor([outer],[kept.polygons[0].outer],[created.polygons[0].outer]),[]);
  if(line) assert.deepEqual(kept.line.coords,kept.polygons[0].outer);
  session.undo();
  assert.equal(session.get('way/-99'),undefined);
 }
});

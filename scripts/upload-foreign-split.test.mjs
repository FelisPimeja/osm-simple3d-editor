import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {createServer} from 'vite';
let vite,uploadEdits;
const store=()=>{const m=new Map();return {getItem:k=>m.get(k)??null,setItem:(k,v)=>m.set(k,String(v)),removeItem:k=>m.delete(k)};};
globalThis.location??=new URL('http://localhost/');globalThis.history??={replaceState(){},state:null};globalThis.localStorage??=store();globalThis.sessionStorage??=store();
before(async()=>{vite=await createServer({configFile:false,server:{middlewareMode:true,ws:false,watch:null},appType:'custom'});({uploadEdits}=await vite.ssrLoadModule('/src/osm/upload.ts'));});
after(async()=>await vite.close());

// Сервер: путь 100 (1-2-3-4) — общая граница здания и чужого мультиполигона 500 (пешеходная зона, relation/4167975),
// путь 101 (4-5-1) замыкает кольцо 500
const API='http://mock.test/api/0.6';
const node=(id)=>({type:'node',id,version:1,lat:55+id*1e-5,lon:37+id*1e-5,tags:{}});
const ways={100:{type:'way',id:100,version:3,nodes:[1,2,3,4],tags:{}},101:{type:'way',id:101,version:1,nodes:[4,5,1],tags:{}}};
const rel500={type:'relation',id:500,version:2,tags:{type:'multipolygon','area:highway':'footway'},members:[{type:'way',ref:100,role:'outer'},{type:'way',ref:101,role:'outer'}]};
function mockFetch(sent){
 return async(url,opts={})=>{
  const u=new URL(url),p=u.pathname.replace('/api/0.6','');
  const json=(elements)=>new Response(JSON.stringify({elements}),{status:200});
  if(p==='/ways.json')return json(u.searchParams.get('ways').split(',').map(id=>ways[id]).filter(Boolean));
  if(p==='/relations.json')return json(u.searchParams.get('relations').split(',').map(Number).filter(id=>id===500).map(()=>rel500));
  if(p==='/nodes.json')return json(u.searchParams.get('nodes').split(',').map(Number).map(node));
  if(p==='/nodes.json'||p==='/node.json')return json([]);
  const rel=p.match(/^\/way\/(\d+)\/relations\.json$/);
  if(rel)return json(rel500.members.some(m=>m.ref===Number(rel[1]))?[rel500]:[]);
  if(p==='/changeset/create')return new Response('77',{status:200});
  if(p==='/changeset/77/upload'){sent.push(opts.body);return new Response('<diffResult/>',{status:200});}
  if(p==='/changeset/77/close')return new Response('',{status:200});
  return new Response('not found '+p,{status:404});
 };
}

test('a split shared way deleted in the session stays (as its remainder) while a foreign multipolygon needs it',async()=>{
 const sent=[];
 globalThis.fetch=mockFetch(sent);
 globalThis.DOMParser=class{parseFromString(){return {documentElement:{children:[]}};}};
 // Сессия: путь 100 разрезан на 1-2 (он сам), 2-3 и 3-4 (новые куски), затем удалён — с колец здания он ушёл,
 // а мультиполигона 500 в данных редактора нет
 const piece=(id,nodes)=>({key:`way/${id}`,before:{},after:{},created:{type:'way',id,version:0,nodes,tags:{}},wayNodes:{before:nodes,after:nodes},splitFrom:100});
 const edits=[
  {key:'way/100',before:{},after:{},deleted:true,wayNodes:{before:[1,2,3,4],after:[1,2]}},
  piece(-10,[2,3]),piece(-11,[3,4]),
 ];
 await uploadEdits(edits,'test',()=>{},API);
 const xml=sent[0];
 assert.ok(xml,'changeset uploaded (no broken-ring error)');
 assert.doesNotMatch(xml,/<delete[^>]*>[^]*<way id="100"/,'way 100 is not deleted');
 const w100=xml.match(/<way id="100"[^>]*>([^]*?)<\/way>/);
 assert.ok(w100,'way 100 is modified');
 assert.deepEqual([...w100[1].matchAll(/<nd ref="(-?\d+)"/g)].map(m=>Number(m[1])),[1,2],'with the remainder of the split');
 const r=xml.match(/<relation id="500"[^>]*>([^]*?)<\/relation>/);
 assert.ok(r,'foreign multipolygon gets the new pieces');
 assert.deepEqual([...r[1].matchAll(/<member type="way" ref="(-?\d+)"/g)].map(m=>Number(m[1])),[100,-10,-11,101]);
});

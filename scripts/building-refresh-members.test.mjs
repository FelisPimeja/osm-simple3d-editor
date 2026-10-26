import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createServer } from 'vite';
let vite, parseBuildings, buildingRefreshMembers, fetchBuildingElements;
before(async () => {
  globalThis.location = { search: '?server=osm', href: 'http://localhost/?server=osm' };
  vite = await createServer({ configFile: false, server: { middlewareMode: true, ws: false, watch: null }, appType: 'custom' });
  ({ parseBuildings } = await vite.ssrLoadModule('/src/osm/model.ts'));
  ({ buildingRefreshMembers } = await vite.ssrLoadModule('/src/osm/building-refresh.ts'));
  ({ fetchBuildingElements } = await vite.ssrLoadModule('/src/osm/api.ts'));
});
after(async () => { await vite.close(); delete globalThis.location; });
const member = (ref, role, type = 'way') => ({ type, ref, role });
function fixture() {
  return [
    ...[[0,0],[1,0],[1,1]].map(([lon,lat],i) => ({ type:'node', id:i+1, lon,lat,version:1 })),
    { type:'way',id:10,version:1,nodes:[1,2,3,1],tags:{building:'yes'} },
    { type:'way',id:11,version:1,nodes:[1,2,3,1],tags:{'building:part':'yes'} },
    { type:'way',id:12,version:1,nodes:[1,2,3,1],tags:{leisure:'garden'} },
    { type:'way',id:13,version:1,nodes:[1,2],tags:{'roof:ridge':'yes'} },
    { type:'relation',id:21,version:1,members:[member(11,'part')],tags:{'building:part':'church'} },
    { type:'relation',id:20,version:1,members:[member(10,'outline'),member(11,'part'),member(12,'inner'),member(13,'ridge'),member(21,'part','relation')],tags:{type:'building'} },
  ];
}
function inspect(elements) {
  const parsed=parseBuildings(elements);
  const group=parsed.groups.find(g=>g.key==='relation/20');
  return { group, ...buildingRefreshMembers(group,parsed,elements) };
}
test('loaded courtyard, roof line and untyped nested relation do not prevent refresh; membership is preserved', () => {
  const result=inspect(fixture());
  assert.deepEqual(result.features.map(f=>f.key),['way/10','way/11']);
  assert.deepEqual(result.unrendered.map(f=>[f.key,f.role]),[['way/12','inner'],['way/13','ridge'],['relation/21','part']]);
  assert.equal(result.group.members.length,5);
});
test('adding, removing and repeating members is handled by identity, not rendered volume count', () => {
  const elements=fixture(), root=elements.at(-1);
  root.members.push(member(11,'part'));
  assert.equal(inspect(elements).unrendered.length,3);
  root.members=root.members.filter(m=>m.ref!==11);
  assert.equal(inspect(elements).features.length,1);
});
test('invalid geometry is diagnosed by key rather than mistaken for a missing download', () => {
  const elements=fixture();elements.find(e=>e.id===11&&e.type==='way').nodes=[1,2,3];
  assert.equal(inspect(elements).unrendered.find(f=>f.key==='way/11').reason,'незамкнутый путь');
});
test('truly absent relation members still fail the completeness check', () => {
  assert.throws(()=>inspect(fixture().filter(e=>!(e.type==='way'&&e.id===12))),/way\/12/);
});
test('API download still rejects missing nodes before parsing or updating the scene', async () => {
  const original=globalThis.fetch;
  const elements=fixture();
  globalThis.fetch=async (url) => {
    const u=new URL(url),type=u.pathname.split('/').at(-1).replace('.json','').replace(/s$/,'');
    const ids=u.searchParams.get(`${type}s`).split(',').map(Number);
    return new Response(JSON.stringify({elements:elements.filter(e=>e.type===type&&ids.includes(e.id)&&!(e.type==='node'&&e.id===3))}),{status:200});
  };
  try { await assert.rejects(fetchBuildingElements('relation/20','https://example.org/api/0.6'),/node\/3/); }
  finally { globalThis.fetch=original; }
});

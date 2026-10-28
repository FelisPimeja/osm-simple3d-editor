import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createServer } from 'vite';
let vite, EditSession;
before(async () => {
  vite = await createServer({ configFile: false, server: { middlewareMode: true, ws: false, watch: null }, appType: 'custom' });
  ({ EditSession } = await vite.ssrLoadModule('/src/edit/session.ts'));
});
after(async () => { await vite.close(); });
const feature = () => ({ key: 'way/1', version: 1, tags: { building: 'yes', height: '3' } });
test('discard one tag preserves other edits and is undoable', () => {
  const s = new EditSession([feature()], () => {});
  s.setTags('way/1', { height: '6', 'building:levels': '2' });
  s.revertTag('way/1', 'building:levels');
  assert.deepEqual(s.get('way/1').tags, { building: 'yes', height: '6' });
  s.undo();
  assert.equal(s.get('way/1').tags['building:levels'], '2');
});
test('discard deletion restores original object and undo restores deletion', () => {
  const s = new EditSession([feature()], () => {});
  s.editMany([{ key: 'way/1', delete: true }]);
  s.revert('way/1');
  assert.equal(s.changes().length, 0);
  s.undo();
  assert.equal(s.isDeleted('way/1'), true);
});
test('discard new object is undoable and refuses dangling member references', () => {
  const s = new EditSession([], () => {});
  s.editMany([{ key: 'way/-1', create: { key: 'way/-1', version: 0, tags: { building: 'yes' } } }]);
  s.revert('way/-1');
  assert.equal(s.changes().length, 0);
  s.undo();
  assert.equal(s.changes().length, 1);
  s.editMany([{ key: 'relation/-2', create: { key: 'relation/-2', version: 0, tags: { type: 'building' }, relMembers: [{ type: 'way', ref: -1, role: 'part' }] } }]);
  assert.equal(s.revert('way/-1'), false);
  assert.equal(s.changes().length, 2);
});
test('discard open wall geometry restores its original node positions and supports redo', () => {
  const original = { ids: [1, 2], coords: [[0, 0], [1, 0]] };
  const moved = { ids: [1, 2], coords: [[0, 1], [1, 1]] };
  const s = new EditSession([{ ...feature(), line: original }], () => {});
  s.editMany([{ key: 'way/1', line: moved }]);
  s.revert('way/1');
  assert.equal(s.changes().length, 0);
  s.undo();
  assert.deepEqual(s.get('way/1').line, moved);
  s.redo();
  assert.equal(s.changes().length, 0);
});
test('deleting a relation wall and converting an adjacent relation room undo together', () => {
  const wall={key:'relation/10',version:1,tags:{type:'multipolygon',indoor:'wall',level:'0'},relMembers:[{type:'way',ref:1,role:'outer'}]};
  const room={key:'relation/20',version:1,tags:{type:'multipolygon',indoor:'room',level:'0'},relMembers:[{type:'way',ref:2,role:'outer'}]};
  const s=new EditSession([wall,room],()=>{});
  s.editMany([{key:wall.key,delete:true},{key:room.key,tags:{...room.tags,indoor:'area'}}]);
  assert.equal(s.changes().find(e=>e.key===wall.key).deleted,true);
  s.undo();
  assert.equal(s.changes().length,0);
  assert.deepEqual(s.get(wall.key).relMembers,[{type:'way',ref:1,role:'outer'}]);
  s.redo();
  assert.equal(s.get(room.key).tags.indoor,'area');
});

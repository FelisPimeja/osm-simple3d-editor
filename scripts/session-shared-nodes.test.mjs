import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createServer } from 'vite';

let vite, EditSession;
before(async () => {
  vite = await createServer({ configFile: false, server: { middlewareMode: true, ws: false, watch: null }, appType: 'custom' });
  ({ EditSession } = await vite.ssrLoadModule('/src/edit/session.ts'));
});
after(async () => { await vite.close(); });

// Two parts sharing the wall 2–3; a member way of another building also uses node 3
const at = { 1: [0, 0], 2: [1, 0], 3: [1, 1], 4: [0, 1], 5: [2, 0], 6: [2, 1] };
const poly = (ids, moved = {}) => [{ outer: ids.map((id) => moved[id] ?? at[id]), outerIds: ids, inners: [], innerIds: [] }];
const part = (id, ids) => ({ key: `way/${id}`, version: 1, tags: { 'building:part': 'yes' }, polygons: poly(ids) });
const setup = () => {
  const a = part(10, [1, 2, 3, 4]), b = part(11, [2, 5, 6, 3]);
  const line = { key: 'way/12', version: 1, tags: {}, line: { ids: [3, 6], coords: [at[3], at[6]] } };
  const data = [a, b, line];
  const session = new EditSession([a], () => {});
  session.setNodeOwners((ids) => data.filter((f) => (f.line?.ids ?? f.polygons[0].outerIds).some((n) => ids.has(n))));
  return session;
};
const coordOf = (f, id) => f.line ? f.line.coords[f.line.ids.indexOf(id)] : f.polygons[0].outer[f.polygons[0].outerIds.indexOf(id)];

test('moving a shared node in one way moves it in every way that has it, in one undo step', () => {
  const session = setup();
  session.editMany([{ key: 'way/10', polygons: poly([1, 2, 3, 4], { 3: [1.5, 1.5] }) }]);
  for (const k of ['way/10', 'way/11', 'way/12']) assert.deepEqual(coordOf(session.get(k), 3), [1.5, 1.5], k);
  // Nodes that did not move stay put in the neighbours
  assert.deepEqual(coordOf(session.get('way/11'), 5), at[5]);
  session.undo();
  for (const k of ['way/10', 'way/11', 'way/12']) assert.deepEqual(coordOf(session.get(k), 3), at[3], `undo ${k}`);
});

test('an edit that only reorders or adds nodes moves nobody else', () => {
  const session = setup();
  session.editMany([{ key: 'way/10', polygons: [{ outer: [at[1], at[2], [1, 0.5], at[3], at[4]], outerIds: [1, 2, -1, 3, 4], inners: [], innerIds: [] }] }]);
  assert.ok(!session.has('way/11'));
});

test('reverting a way puts the shared node back in the neighbours too', () => {
  const session = setup();
  session.editMany([{ key: 'way/10', polygons: poly([1, 2, 3, 4], { 3: [1.5, 1.5] }) }]);
  session.revert('way/10');
  for (const k of ['way/10', 'way/11', 'way/12']) assert.deepEqual(coordOf(session.get(k), 3), at[3], k);
});

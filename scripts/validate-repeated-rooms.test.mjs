import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createServer } from 'vite';

let vite, validateRepeatedRooms, validateStackedEscalators;
before(async () => {
  globalThis.localStorage = { getItem: () => 'en' };
  vite = await createServer({ configFile: false, server: { middlewareMode: true, ws: false, watch: null }, appType: 'custom' });
  ({ validateRepeatedRooms, validateStackedEscalators } = await vite.ssrLoadModule('/src/edit/validate.ts'));
});
after(async () => { await vite.close(); delete globalThis.localStorage; });

const ring = [[0, 0], [0.0001, 0], [0.0001, 0.0001], [0, 0.0001]];
const room = (tags) => ({ key: 'way/1', kind: 'room', tags: { indoor: 'room', level: '0;1;2', ...tags }, polygons: [{ outer: ring, inners: [] }], levels: [] });
const door = (id, tags, point = [0.0001, 0]) => ({ key: `node/${id}`, kind: 'poi', point, tags: { indoor: 'door', door: 'yes', ...tags }, polygons: [], levels: [] });

test('multi-level room with doors on several of its levels gets a split fix', () => {
  const [issue] = validateRepeatedRooms([room(), door(1, { level: '0' }), { ...door(2, { level: '2' }), point: [0.0001, 0.0001] }]);
  assert.equal(issue.key, 'way/1');
  assert.deepEqual(issue.fix.tags, { level: '0' });
  assert.deepEqual(issue.fix.splitLevels, ['1', '2']);
});
test('door with repeat_on counts on each level; doors off the outline do not', () => {
  assert.equal(validateRepeatedRooms([room(), door(1, { level: '0', repeat_on: '1' })]).length, 1);
  assert.equal(validateRepeatedRooms([room(), door(1, { level: '0', repeat_on: '1' }, [0.00005, 0.00005])]).length, 0);
});
test('one door level, stairs, elevators and single-level rooms are skipped', () => {
  const doors = [door(1, { level: '0', repeat_on: '1;2' })];
  assert.equal(validateRepeatedRooms([room({ level: '0' }), ...doors]).length, 0);
  assert.equal(validateRepeatedRooms([room(), door(1, { level: '0' })]).length, 0);
  for (const tags of [{ stairs: 'yes' }, { room: 'stairs' }, { room: 'elevator' }, { highway: 'elevator' }]) {
    assert.equal(validateRepeatedRooms([room(tags), ...doors]).length, 0, JSON.stringify(tags));
  }
  const lift = { key: 'node/9', kind: 'poi', point: [0.00005, 0.00005], tags: { highway: 'elevator' }, polygons: [], levels: [] };
  assert.equal(validateRepeatedRooms([room(), ...doors, lift]).length, 0);
});

test('stacked escalators split into neighbouring level pairs; the axis gets new nodes', () => {
  const axis = { key: 'way/5', kind: 'area', line: true, escalator: true, polygons: [{ outer: ring.slice(0, 2), inners: [] }], levels: [],
    tags: { highway: 'steps', conveying: 'reversible', incline: 'up', level: '0-3' } };
  const [issue] = validateStackedEscalators([axis]);
  assert.deepEqual(issue.fix.tags, { level: '0;1' });
  assert.deepEqual(issue.fix.splitLevels, ['1;2', '2;3']);
  assert.equal(issue.fix.splitNewNodes, true);
  const area = { key: 'way/6', kind: 'area', polygons: [{ outer: ring, inners: [] }], levels: [], tags: { indoor: 'area', conveying: 'yes', level: '-1;0;1' } };
  const [a] = validateStackedEscalators([area]);
  assert.deepEqual(a.fix.splitLevels, ['0;1']);
  assert.equal(a.fix.splitNewNodes, undefined);
  assert.equal(validateStackedEscalators([{ ...axis, tags: { ...axis.tags, level: '0;1' } }]).length, 0);
  assert.equal(validateStackedEscalators([{ ...axis, tags: { highway: 'steps', level: '0-3' } }]).length, 0);
});

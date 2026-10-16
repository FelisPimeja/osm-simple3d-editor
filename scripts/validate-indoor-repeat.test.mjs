import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createServer } from 'vite';

let vite, validateIndoor;
before(async () => {
  globalThis.localStorage = { getItem: () => 'en' };
  vite = await createServer({ configFile: false, server: { middlewareMode: true, ws: false, watch: null }, appType: 'custom' });
  ({ validateIndoor } = await vite.ssrLoadModule('/src/edit/validate.ts'));
});
after(async () => { await vite.close(); delete globalThis.localStorage; });

const repeatFix = (key, tags) => validateIndoor({ key, tags }).find((i) => i.fix?.tags.repeat_on !== undefined)?.fix;

test('door and emergency points with several levels get a repeat_on fix', () => {
  assert.deepEqual(repeatFix('node/1', { indoor: 'door', door: 'sliding', level: '-3;-2;0;1;2' })?.tags, { level: '-3', repeat_on: '-2;0;1;2' });
  assert.deepEqual(repeatFix('node/2', { emergency: 'fire_extinguisher', level: '1-3' })?.tags, { level: '1', repeat_on: '2;3' });
});

test('spanning objects and already converted points are left alone', () => {
  assert.equal(repeatFix('node/3', { indoor: 'door', door: 'yes', level: '0', repeat_on: '1;2' }), undefined);
  assert.equal(repeatFix('node/4', { indoor: 'door', door: 'yes', level: '0' }), undefined);
  assert.equal(repeatFix('node/5', { highway: 'elevator', level: '0;1;2' }), undefined); // elevator spans levels
  assert.equal(repeatFix('relation/6', { indoor: 'room', level: '-3;-2' }), undefined); // high room
});

test('indoor=door without door=* is fixed with door=yes', () => {
  const issue = validateIndoor({ key: 'node/7', tags: { indoor: 'door', level: '0' } }).find((i) => i.code === 'indoor-door');
  assert.deepEqual(issue?.fix?.tags, { door: 'yes' });
});

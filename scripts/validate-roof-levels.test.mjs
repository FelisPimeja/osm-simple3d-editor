import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createServer } from 'vite';

let vite, validateTags;
before(async () => {
  globalThis.localStorage = { getItem: () => 'en' };
  vite = await createServer({ configFile: false, server: { middlewareMode: true, ws: false, watch: null }, appType: 'custom' });
  ({ validateTags } = await vite.ssrLoadModule('/src/edit/validate.ts'));
});
after(async () => { await vite.close(); delete globalThis.localStorage; });

const issues = (shape, levels = '1') => validateTags('way/134676870', {
  building: 'yes', 'building:levels': '2', 'roof:levels': levels,
  ...(shape === undefined ? {} : { 'roof:shape': shape }),
});
const flatWarning = (list) => list.filter(i => i.text.includes('roof:shape=flat'));

test('many with roof levels produces no roof warning or destructive fix', () => {
  const result = issues('many');
  assert.equal(flatWarning(result).length, 0);
  assert.equal(result.filter(i => i.code === 'roof').length, 0);
});
test('rendering fallbacks, unspecified and pitched shapes do not imply flat roofs', () => {
  for (const shape of ['mixed', 'mix', 'multi', 'gabled', 'pitched', 'unknown', undefined]) {
    assert.equal(flatWarning(issues(shape)).length, 0, String(shape));
  }
});
test('explicit flat roofs with positive roof levels still warn, including normalized spelling', () => {
  for (const shape of ['flat', ' Flat ']) assert.equal(flatWarning(issues(shape)).length, 1);
});
test('flat roofs with zero roof levels do not warn about roof levels', () => {
  assert.equal(flatWarning(issues('flat', '0')).length, 0);
});

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

test('building:min_level next to min_height is fixed by removing it', () => {
  const list = validateTags('way/1577773338', { 'building:part': 'column', height: '12.5', min_height: '0.5', 'building:min_level': '0.17' });
  const minLevel = list.filter((i) => i.text.includes('building:min_level'));
  assert.ok(minLevel.length >= 1);
  for (const i of minLevel) assert.deepEqual(i.fix?.tags, { 'building:min_level': undefined });
});

test('without min_height there is nothing to fall back to — no fix', () => {
  const list = validateTags('way/1', { 'building:part': 'yes', 'building:min_level': '0.5' });
  assert.ok(list.filter((i) => i.text.includes('building:min_level')).every((i) => !i.fix));
});

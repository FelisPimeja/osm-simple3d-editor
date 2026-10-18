import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createServer } from 'vite';
let vite, pushHeightTags, lockedPushUnits;
before(async () => {
  vite = await createServer({ configFile: false, server: { middlewareMode: true, ws: false, watch: null }, appType: 'custom' });
  ({ pushHeightTags, lockedPushUnits } = await vite.ssrLoadModule('/src/edit/push-height.ts'));
});
after(async () => { await vite?.close(); });
test('new contour extrudes in the selected tag units', () => {
  assert.deepEqual(pushHeightTags({height:'0'}, 'top', 3, 'levels', true), {'building:levels':'1'});
  assert.deepEqual(pushHeightTags({height:'0'}, 'top', 3, 'm', true), {height:'3'});
  assert.deepEqual(pushHeightTags({height:'6', min_height:'6'}, 'top', 3, 'levels', true), {'building:levels':'3', 'building:min_level':'2'});
});
test('only existing height representation is available, except new flat contours', () => {
  assert.equal(lockedPushUnits({height:'6'}, 1), 'm');
  assert.equal(lockedPushUnits({'building:levels':'2'}, 1), 'levels');
  assert.equal(lockedPushUnits({height:'6','building:levels':'2'}, 1), undefined);
  assert.equal(lockedPushUnits({height:'0'}, 0), undefined);
  assert.equal(lockedPushUnits({height:'3'}, 0), 'm');
});
test('top and bottom edits preserve levels-only tags and synchronize dual tags', () => {
  const tags = {'building:levels':'3'};
  assert.deepEqual(pushHeightTags(tags,'top',3,'levels'), {'building:levels':'4'});
  assert.deepEqual(pushHeightTags(tags,'bottom',3,'levels'), {'building:levels':'3','building:min_level':'1'});
  assert.deepEqual(pushHeightTags({height:'9','building:levels':'3'},'top',1.5,'m'), {height:'10.5','building:levels':'3.5'});
  assert.deepEqual(pushHeightTags({height:'9',min_height:'3','building:levels':'3','building:min_level':'1'},'bottom',3,'levels'), {height:'9',min_height:'6','building:levels':'3','building:min_level':'2'});
  assert.deepEqual(tags, {'building:levels':'3'});
});

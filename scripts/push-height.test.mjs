import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createServer } from 'vite';
let vite, pushHeightTags, lockedPushUnits, roofHeightTags;
before(async () => {
  vite = await createServer({ configFile: false, server: { middlewareMode: true, ws: false, watch: null }, appType: 'custom' });
  ({ pushHeightTags, lockedPushUnits, roofHeightTags } = await vite.ssrLoadModule('/src/edit/push-height.ts'));
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
test('only Push in levels mode changes level tags', () => {
  const tags = {'building:levels':'3'};
  assert.deepEqual(pushHeightTags(tags,'top',3,'levels'), {'building:levels':'4'});
  assert.deepEqual(pushHeightTags(tags,'bottom',3,'levels'), {'building:levels':'3','building:min_level':'1'});
  assert.deepEqual(pushHeightTags({height:'9','building:levels':'3'},'top',1.5,'m'), {height:'10.5','building:levels':'3'});
  assert.deepEqual(pushHeightTags({height:'9',min_height:'3','building:levels':'3','building:min_level':'1'},'bottom',3,'levels'), {height:'9',min_height:'6','building:levels':'3','building:min_level':'2'});
  assert.deepEqual(tags, {'building:levels':'3'});
});

test('meter edits preserve levels even when no metric height existed', () => {
  const tags = {'building:levels':'3', 'building:min_level':'1'};
  assert.deepEqual(pushHeightTags(tags,'top',1.2,'m'), {...tags, height:'10.2'});
  assert.deepEqual(pushHeightTags(tags,'bottom',0.6,'m'), {...tags, min_height:'3.6'});
});
test('roof handles use meters without changing either level count', () => {
  const tags = {'building:levels':'3', 'roof:shape':'gabled', 'roof:levels':'1'};
  assert.deepEqual(roofHeightTags(tags,0.6), {...tags, 'roof:height':'3.6'});
  assert.deepEqual(roofHeightTags({...tags,height:'12'},0.6), {...tags,height:'12.6','roof:height':'3.6'});
  assert.deepEqual(roofHeightTags(tags,-3), {...tags,'roof:height':'0'});
  assert.deepEqual(tags, {'building:levels':'3', 'roof:shape':'gabled', 'roof:levels':'1'});
});

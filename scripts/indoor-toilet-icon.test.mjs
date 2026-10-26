import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createServer } from 'vite';
let vite, parseBuildings, poiIcon;
before(async () => {
  vite = await createServer({ configFile: false, server: { middlewareMode: true, ws: false, watch: null }, appType: 'custom' });
  ({ parseBuildings } = await vite.ssrLoadModule('/src/osm/model.ts'));
  ({ poiIcon } = await vite.ssrLoadModule('/src/view/indoor-pois.ts'));
});
after(async () => { await vite.close(); });
for (const room of ['toilet', 'toilets']) {
  test(`room=${room}: room geometry and selectable icon are both produced without amenity`, () => {
    const tags = { indoor: 'room', room, level: '0' };
    const elements = [
      ...[[0,0],[0.001,0],[0.001,0.001],[0,0.001]].map(([lon,lat],i) => ({ type:'node', id:i+1, lon,lat })),
      { type:'way', id:1301284715, version:4, nodes:[1,2,3,4,1], tags },
    ];
    const indoor = parseBuildings(elements).indoor;
    assert.equal(indoor.filter(f => f.kind === 'room').length, 1);
    const pois = indoor.filter(f => f.kind === 'poi');
    assert.equal(pois.length, 1);
    assert.equal(pois[0].key, 'way/1301284715#poi');
    assert.deepEqual(pois[0].levels, [0]);
    assert.ok(pois[0].point.every(v => v > 0 && v < 0.001));
    assert.equal(poiIcon(pois[0].tags), 'toilet');
    assert.deepEqual(tags, { indoor:'room', room, level:'0' });
  });
}
test('amenity=toilets keeps its icon and ordinary rooms do not gain a toilet icon', () => {
  assert.equal(poiIcon({ amenity:'toilets' }), 'toilet');
  assert.equal(poiIcon({ indoor:'room', room:'storage' }), undefined);
});

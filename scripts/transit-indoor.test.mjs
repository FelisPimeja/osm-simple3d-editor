import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createServer } from 'vite';

let vite, parseBuildings, validateIndoor;
before(async () => {
  globalThis.localStorage = { getItem: () => 'ru', setItem() {} };
  vite = await createServer({ configFile: false, server: { middlewareMode: true, ws: false, watch: null }, appType: 'custom' });
  ({ parseBuildings } = await vite.ssrLoadModule('/src/osm/model.ts'));
  ({ validateIndoor } = await vite.ssrLoadModule('/src/edit/validate.ts'));
});
after(async () => { await vite?.close(); delete globalThis.localStorage; });

const node = (id, lon, lat, tags) => ({ type: 'node', id, lon, lat, ...(tags ? { tags } : {}) });
const elements = [
  node(1, 0, 0), node(2, 1, 0), node(3, 1, 1), node(4, 0, 1), node(5, -1, 0.5), node(6, 2, 0.5),
  { type: 'way', id: 10, nodes: [1, 2, 3, 4, 1], tags: { railway: 'platform' } },
  { type: 'way', id: 11, nodes: [5, 6], tags: { railway: 'rail' } },
  { type: 'way', id: 12, nodes: [5, 6], tags: { highway: 'service' } },
];

test('platforms and tracks are indoor objects without indoor and level, flagged as transit without a level', () => {
  const { indoor } = parseBuildings(elements);
  const platform = indoor.find((f) => f.key === 'way/10'), rail = indoor.find((f) => f.key === 'way/11');
  assert.equal(platform?.transit, 'platform'); assert.equal(platform.line, undefined); assert.equal(platform.noLevel, true);
  assert.deepEqual(platform.levels, [0]);
  assert.equal(rail?.transit, 'rail'); assert.equal(rail.line, true);
  assert.ok(!indoor.some((f) => f.key === 'way/12'), 'other ways stay out');
});

test('a platform or track without level gets a warning with a level=0 fix; with level — none', () => {
  const [issue] = validateIndoor({ key: 'way/10', tags: { railway: 'platform' } });
  assert.equal(issue.code, 'indoor-level'); assert.deepEqual(issue.fix.tags, { level: '0' });
  assert.equal(validateIndoor({ key: 'way/11', tags: { railway: 'rail' } }).length, 1);
  assert.equal(validateIndoor({ key: 'way/11', tags: { railway: 'rail', level: '-1' } }).length, 0);
});

// relation/15063503: платформа, размеченная как indoor=area + room=platform + railway=platform
test('an indoor area tagged as a platform is a transit platform too', () => {
  const { indoor } = parseBuildings([...elements.slice(0, 6), { type: 'way', id: 20, nodes: [1, 2, 3, 4, 1], tags: { indoor: 'area', room: 'platform', railway: 'platform', level: '0' } }]);
  const f = indoor.find((x) => x.key === 'way/20');
  assert.equal(f?.kind, 'area'); assert.equal(f.transit, 'platform'); assert.equal(f.noLevel, undefined);
  assert.ok(f.polygons[0].outerIds, 'own geometry stays editable');
});

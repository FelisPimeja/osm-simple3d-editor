import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createServer } from 'vite';

let vite, buildTriangles, computeHeights;
before(async () => {
  globalThis.self = globalThis;
  globalThis.window = globalThis;
  vite = await createServer({ configFile: false, server: { middlewareMode: true, ws: false, watch: null }, appType: 'custom' });
  await (await vite.ssrLoadModule('/src/render/skeleton.ts')).skeletonReady;
  ({ buildTriangles } = await vite.ssrLoadModule('/src/render/building-geometry.ts'));
  ({ computeHeights } = await vite.ssrLoadModule('/src/osm/heights.ts'));
});
after(async () => { await vite.close(); });

// OSM way/1550428316 (OSM contributors, ODbL): pentagon-like base, gabled, roof:direction=95
const LL = [[-77.406444,39.4110781],[-77.4063595,39.4110014],[-77.4063626,39.4109744],[-77.4063766,39.4108755],[-77.406469,39.4108833],[-77.4065592,39.410891],[-77.4065414,39.4110159]];
const ring = LL.map(([x, y]) => [(x - LL[0][0]) * 111320 * Math.cos(39.41 * Math.PI / 180), (y - LL[0][1]) * 111320]);

/** Различные наклонные плоскости крыши — по нормалям треугольников. */
function slopes(roof) {
  const seen = [];
  for (let i = 0; i < roof.length; i += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = roof.slice(i, i + 9);
    let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay), ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az), nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const l = Math.hypot(nx, ny, nz); if (l < 1e-9) continue;
    nx /= l; ny /= l; nz /= l;
    if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; }
    if (nz > 0.999) continue;
    if (!seen.some((s) => Math.abs(s[0] - nx) + Math.abs(s[1] - ny) + Math.abs(s[2] - nz) < 0.02)) seen.push([nx, ny, nz]);
  }
  return seen.length;
}

test('issue 50: an explicit roof:direction gives a gabled roof one straight ridge (two slopes) on a non-rectangular base', () => {
  const tags = { building: 'yes', 'building:levels': '1', 'roof:shape': 'gabled', 'roof:direction': '95' };
  const t = buildTriangles([{ outer: ring, inners: [] }], computeHeights(tags), tags);
  assert.equal(slopes(t.roof), 2);
});

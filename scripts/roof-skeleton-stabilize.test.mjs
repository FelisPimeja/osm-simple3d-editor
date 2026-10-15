import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { createServer } from 'vite';

let vite, buildStableSkeleton, weldRoofSkeleton, extendGables, skeletonPackage;
before(async () => {
  globalThis.self = globalThis;
  globalThis.window = globalThis;
  skeletonPackage = (await import('straight-skeleton')).default;
  vite = await createServer({ configFile: false, server: { middlewareMode: true, ws: false, watch: null }, appType: 'custom' });
  ({ buildStableSkeleton } = await vite.ssrLoadModule('/src/render/skeleton-stabilize.ts'));
  ({ weldRoofSkeleton, extendGables } = await vite.ssrLoadModule('/src/render/roof-gables.ts'));
  await skeletonPackage.SkeletonBuilder.init();
});
after(async () => await vite?.close());

test('uploaded way/79980560 keeps its boundary and resolves the almost triangular hip', () => {
  const ring = JSON.parse(readFileSync(new URL('./fixtures/roof-api-79980560-ring.json', import.meta.url)));
  const raw = skeletonPackage.SkeletonBuilder.buildFromPolygon([[...ring, ring[0]]]);
  const stable = buildStableSkeleton(skeletonPackage.SkeletonBuilder, [[...ring, ring[0]]]);
  assert.equal(extendGables(weldRoofSkeleton(raw)).gables.size, 4);
  assert.equal(extendGables(weldRoofSkeleton(stable)).gables.size, 5);
  assert.ok(ring.every(([x, y], i) => stable.vertices[i][0] === x && stable.vertices[i][1] === y));
  assert.deepEqual(stable.polygons[17].filter((i) => stable.vertices[i][2] > 1e-9).length, 1);
});

test('ordinary multi-vertex hip is not converted by stabilization', () => {
  const ring = [[0, 0], [12, 0], [12, 6], [8, 6], [8, 10], [0, 10]];
  const raw = skeletonPackage.SkeletonBuilder.buildFromPolygon([[...ring, ring[0]]]);
  const stable = buildStableSkeleton(skeletonPackage.SkeletonBuilder, [[...ring, ring[0]]]);
  assert.deepEqual(stable, raw);
});

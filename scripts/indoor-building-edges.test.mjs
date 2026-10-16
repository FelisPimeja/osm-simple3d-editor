import assert from 'node:assert/strict';
import { test } from 'node:test';
import { trimIndoorBuildingEdges } from '../src/render/indoor-building-edges.ts';
const wall = (a,b,z,Z) => [a,0,z,b,0,z,b,0,Z,a,0,z,b,0,Z,a,0,Z];
const edge = (x,z,Z,y=0) => [x,y,z,x,y,Z];
test('building ribs covered by the indoor wall disappear; separate and outside edges remain', () => {
  const walls = wall(-2,2,0,3);
  const visible = [...edge(3,0,3), ...edge(1,0,3,0.1)];
  const result = trimIndoorBuildingEdges(new Float32Array([...edge(-1,0,3),...edge(0,3,0),...visible]), walls);
  assert.deepEqual([...result], [...new Float32Array(visible)]);
});
test('wall clipping preserves building edges above and below the indoor floor', () => {
  assert.deepEqual([...trimIndoorBuildingEdges(new Float32Array(edge(0,-3,9)),wall(-2,2,0,3))], [...edge(0,-3,0),...edge(0,3,9)]);
});
test('only the lintel hides edges within a door opening', () => {
  const walls = [...wall(-2,-.5,0,3),...wall(.5,2,0,3),...wall(-.5,.5,2.2,3)];
  const actual = trimIndoorBuildingEdges(new Float32Array(edge(0,0,3)),walls);
  assert.equal(actual.length,6);
  assert.ok(Math.abs(actual[5]-2.2)<1e-6);
});
test('input arrays remain unchanged and leaving the floor restores the original edges', () => {
  const edges=new Float32Array(edge(0,0,3)), before=edges.slice();
  trimIndoorBuildingEdges(edges,wall(-1,1,0,3));
  assert.deepEqual(edges,before);
  assert.equal(trimIndoorBuildingEdges(edges,[]),edges);
});

test('diagonal and horizontal edges inside the doorway plane are clipped too', () => {
  const edges=new Float32Array([-.2,0,0,.2,0,3,-1,0,1,1,0,1]);
  assert.equal(trimIndoorBuildingEdges(edges,wall(-2,2,0,3)).length,0);
});

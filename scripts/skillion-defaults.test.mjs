import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createServer } from 'vite';

let vite, skillionDirection, skillionRoofHeight, buildTriangles, computeHeights;
before(async () => {
  vite = await createServer({ configFile: false, server: { middlewareMode: true, ws: false, watch: null }, appType: 'custom' });
  ({ skillionDirection } = await vite.ssrLoadModule('/src/edit/skillion-defaults.ts'));
  ({ skillionRoofHeight, buildTriangles } = await vite.ssrLoadModule('/src/render/building-geometry.ts'));
  ({ computeHeights } = await vite.ssrLoadModule('/src/osm/heights.ts'));
});
after(async () => { await vite.close(); });

// Пристройка 2×6 м к западной стене дома (дом — восточнее x = 0)
const annex = [[-2, 0], [0, 0], [0, 6], [-2, 6]];
const house = [[0, -5], [10, -5], [10, 10], [0, 10]];

test('скат — от примыкающего объёма', () => {
  assert.equal(skillionDirection(annex, [house]), 270);
  // Тот же объём, дом с севера: скат на юг
  assert.equal(skillionDirection([[0, -2], [6, -2], [6, 0], [0, 0]], [[[-5, 0], [10, 0], [10, 8], [-5, 8]]]), 180);
});

test('без соседей — поперёк самой длинной стороны, как рисуется без тега', () => {
  const d = skillionDirection(annex, []);
  assert.ok(d === 90 || d === 270, String(d));
});

test('высота по умолчанию — не круче 25°, явная roof:height не трогается', () => {
  const rh = skillionRoofHeight(annex, { 'roof:direction': '270' }, 3);
  assert.ok(Math.abs(rh - 2 * Math.tan(25 * Math.PI / 180)) < 1e-9);
  assert.equal(skillionRoofHeight(annex, { 'roof:direction': '270', 'roof:height': '3' }, 3), 3);
});

test('при заданной height верх стоит, стены — до него минус пологая крыша', () => {
  const tags = { 'building:part': 'yes', height: '4', 'roof:shape': 'skillion', 'roof:direction': '270' };
  const { walls } = buildTriangles([{ outer: annex, inners: [] }], computeHeights(tags), tags);
  const zs = [];
  for (let i = 2; i < walls.length; i += 3) zs.push(walls[i]);
  assert.ok(Math.abs(Math.max(...zs) - 4) < 1e-9);
  assert.ok(Math.abs(Math.min(...zs.filter((z) => z > 0)) - (4 - 2 * Math.tan(25 * Math.PI / 180))) < 1e-9);
});

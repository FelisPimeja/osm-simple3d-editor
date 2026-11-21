import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkWindows } from '../src/edit/window-checks.ts';

// Часть 10 × 6 м, стены 0–6 м; фасад y = 0 (вдоль x), наружу −y
const box = (key, x0, x1, min, top) => ({ key, rings: [[[x0, 0], [x1, 0], [x1, 6], [x0, 6]]], min, top });
const win = (id, x, z, width = 1, height = 1.5) => ({ id, kind: 'window', p: [x, 0], t: [1, 0], n: [0, -1], z, width, height });
const codes = (r) => r.map((f) => f.code).sort();

test('window inside its wall: no problems', () => {
  assert.deepEqual(checkWindows([win(1, 5, 1)], [box('a', 0, 10, 0, 6)]), []);
});

test('window past the corner, into the roof, below the base', () => {
  const parts = [box('a', 0, 10, 0, 6)];
  assert.deepEqual(codes(checkWindows([win(1, 9.8, 1)], parts)), ['window-off-wall']);
  assert.deepEqual(codes(checkWindows([win(1, 5, 5.5)], parts)), ['window-roof']);
  assert.deepEqual(codes(checkWindows([win(1, 5, 1)], [box('a', 0, 10, 2, 6)])), ['window-below']);
});

test('window across the joint of two parts in one plane is fine', () => {
  assert.deepEqual(checkWindows([win(1, 5, 1, 2)], [box('a', 0, 5, 0, 6), box('b', 5, 10, 0, 6)]), []);
});

test('overlapping windows and a window over an entrance', () => {
  const parts = [box('a', 0, 10, 0, 6)];
  const r = checkWindows([win(1, 4, 1), win(2, 4.5, 1.5), win(3, 7, 1)], parts);
  assert.deepEqual(r, [{ id: 1, code: 'window-overlap', other: 2 }]);
  const door = { id: 9, kind: 'entrance', p: [6, 0], t: [1, 0], n: [0, -1], z: 0, width: 1, height: 2.2 };
  assert.deepEqual(checkWindows([win(1, 6.3, 1), door], parts), [{ id: 1, code: 'window-entrance', other: 9 }]);
  // Касание краями — не пересечение
  assert.deepEqual(checkWindows([win(1, 4, 1), win(2, 5, 1)], parts), []);
});

test('window facing a neighbouring volume is blocked', () => {
  // Сосед вплотную снаружи фасада (y от −4 до 0)
  const neighbour = { key: 'n', rings: [[[0, -4], [10, -4], [10, 0], [0, 0]]], min: 0, top: 6 };
  assert.deepEqual(codes(checkWindows([win(1, 5, 1)], [box('a', 0, 10, 0, 6), neighbour])), ['window-blocked']);
});

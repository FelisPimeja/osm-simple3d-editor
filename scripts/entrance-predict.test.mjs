import { test } from 'node:test';
import assert from 'node:assert/strict';
import { predictEntrance } from '../src/edit/entrance-predict.ts';

const T = (m) => (id) => m[id] ?? { entrance: 'staircase' };
test('second after first', () => {
  assert.deepEqual(predictEntrance([1, 2, 3, 4], T({ 1: { entrance: 'staircase', ref: '1', 'addr:flats': '1-20' } }), 2), { ref: '2', flats: '21-40' });
});
test('direction from two known', () => {
  const m = { 4: { ref: '1', 'addr:flats': '1-20' }, 3: { ref: '2', 'addr:flats': '21-40' } };
  assert.deepEqual(predictEntrance([1, 2, 3, 4], T(m), 2), { ref: '3', flats: '41-60' });
});
test('flats only when ref set', () => {
  const m = { 1: { ref: '1', 'addr:flats': '1-20' }, 3: { ref: '3' } };
  assert.deepEqual(predictEntrance([1, 2, 3], T(m), 3), { flats: '41-60' });
});
test('non-numeric ref: no flats', () => {
  assert.deepEqual(predictEntrance([1, 2], T({ 1: { ref: '1', 'addr:flats': '1-20' }, 2: { ref: '1а' } }), 2), {});
});
test('ref typed off the guess: flats follow it', () => {
  assert.deepEqual(predictEntrance([1, 2, 3, 4], T({ 1: { ref: '1', 'addr:flats': '1-20' }, 2: { ref: '3' } }), 2), { flats: '41-60' });
});
test('started not from the first: count down toward it', () => {
  assert.deepEqual(predictEntrance([1, 2, 3, 4], T({ 1: { ref: '3', 'addr:flats': '41-60' } }), 2), { ref: '2', flats: '21-40' });
});
test('first entrance: flats from 1 up to the second one', () => {
  assert.deepEqual(predictEntrance([1, 2, 3], T({ 2: { ref: '2', 'addr:flats': '50-97' }, 3: { ref: '3', 'addr:flats': '98-145' } }), 1), { ref: '1', flats: '1-49' });
});

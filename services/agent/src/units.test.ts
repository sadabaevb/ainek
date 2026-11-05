import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromMinimalUnits, toMinimalUnits } from './units.ts';

test('toMinimalUnits: whole and fractional amounts, no floats, no rounding, no zero', () => {
  assert.equal(toMinimalUnits('300', 6), '300000000');
  assert.equal(toMinimalUnits('12.5', 6), '12500000');
  assert.equal(toMinimalUnits('0.000001', 6), '1');
  assert.equal(toMinimalUnits('007', 2), '700');
  assert.throws(() => toMinimalUnits('1.2345678', 6), /more than 6 decimals/);
  assert.throws(() => toMinimalUnits('0', 6), /positive/);
  assert.throws(() => toMinimalUnits('1e3', 6), /not a decimal/);
  assert.throws(() => toMinimalUnits('1,000', 6), /not a decimal/);
});

test('fromMinimalUnits: the inverse of toMinimalUnits, for the card', () => {
  assert.equal(fromMinimalUnits('300000000', 6), '300');
  assert.equal(fromMinimalUnits('12500000', 6), '12.5');
  assert.equal(fromMinimalUnits('1', 6), '0.000001');
  assert.equal(fromMinimalUnits('700', 0), '700');
});

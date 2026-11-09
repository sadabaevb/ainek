import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromMinimalUnits, toMinimalUnits, tokenDecimalsOf, tokenSymbolOf } from './token.ts';

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

test('tokenDecimalsOf: the token\'s own answer, and nothing else counts as one', () => {
  assert.equal(tokenDecimalsOf({ decimals: 6 }), 6);
  assert.equal(tokenDecimalsOf({ decimals: 0 }), 0);
  for (const m of [null, {}, { decimals: '6' }, { decimals: 25 }, { decimals: 1.5 }]) assert.throws(() => tokenDecimalsOf(m), /no usable decimals/);
});

test('tokenSymbolOf: the short name, and the account id when the token offers nothing a card can show', () => {
  assert.equal(tokenSymbolOf({ symbol: 'AINEK' }, 't.testnet'), 'AINEK');
  for (const m of [null, {}, { symbol: 7 }, { symbol: '' }, { symbol: 'A\nApproved' }, { symbol: 'x'.repeat(17) }]) assert.equal(tokenSymbolOf(m, 't.testnet'), 't.testnet');
});

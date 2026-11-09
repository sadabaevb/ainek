import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeRpc } from './fixtures.ts';
import { fromMinimalUnits, readTokenBalance, readTokenInfo, toMinimalUnits, tokenAmountText, tokenDecimalsOf, tokenSymbolOf } from './token.ts';

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

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test('readTokenInfo and readTokenBalance: asked of the token itself, with the NEP-141 call shapes', async () => {
  const calls = fakeRpc(({ method }) => (method === 'ft_metadata' ? { spec: 'ft-1.0.0', name: 'Ainek demo token', symbol: 'AINEK', decimals: 6 } : '9999000000'));
  assert.deepEqual(await readTokenInfo('http://rpc.test', 'token.testnet'), { decimals: 6, symbol: 'AINEK' });
  assert.equal(await readTokenBalance('http://rpc.test', 'token.testnet', 'ainek.testnet'), '9999000000');
  assert.deepEqual(calls, [
    { account: 'token.testnet', method: 'ft_metadata', args: {} },
    { account: 'token.testnet', method: 'ft_balance_of', args: { account_id: 'ainek.testnet' } },
  ]);
});

test('tokenAmountText: minimal units at the scale and under the name the token gives', () => {
  assert.equal(tokenAmountText('400000000', { decimals: 6, symbol: 'AINEK' }), '400 AINEK');
  assert.equal(tokenAmountText('0', { decimals: 6, symbol: 'AINEK' }), '0 AINEK');
  assert.equal(tokenAmountText('1500000', { decimals: 6, symbol: 'token.testnet' }), '1.5 token.testnet');
});

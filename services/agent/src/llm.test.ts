import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RunStats, Verified } from '@ainek/tier1-node';
import { DECLINE, PROPOSE_TRANSFER, TOOLS, actionFrom, fromMinimalUnits, interpret, toMinimalUnits, treasurerPrompt } from './llm.ts';

test('toMinimalUnits: whole and fractional amounts, no floats, no rounding, no zero', () => {
  assert.equal(toMinimalUnits('300', 6), '300000000');
  assert.equal(toMinimalUnits('12.5', 6), '12500000');
  assert.equal(toMinimalUnits('0.000001', 6), '1');
  assert.equal(toMinimalUnits('007', 2), '700');
  assert.throws(() => toMinimalUnits('1.2345678', 6), /more than 6 decimals/);
  assert.throws(() => toMinimalUnits('0', 6), /positive/);
  assert.throws(() => toMinimalUnits('1e3', 6), /not a decimal/);
});

test('fromMinimalUnits: the inverse of toMinimalUnits, for the card', () => {
  assert.equal(fromMinimalUnits('300000000', 6), '300');
  assert.equal(fromMinimalUnits('12500000', 6), '12.5');
  assert.equal(fromMinimalUnits('1', 6), '0.000001');
  assert.equal(fromMinimalUnits('700', 0), '700');
});

/** A verified exchange whose completion carries the given tool call (the rest of the outcome is not read by interpret). */
const exchange = (name: string, args: unknown): Verified & RunStats =>
  ({ completion: { id: 'c1', object: 'chat.completion', choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } }] } }] } }) as unknown as Verified & RunStats;

test('interpret: propose_transfer becomes an ft_transfer Action in minimal units with the configured token', () => {
  const r = interpret(exchange(PROPOSE_TRANSFER, { receiver_id: 'vendor1.testnet', amount: '300', memo: 'October hosting' }), 'token.ainek.testnet', 6);
  assert.equal(r.kind, 'action');
  if (r.kind === 'action') assert.deepEqual(r.action, { kind: 'ft_transfer', token_id: 'token.ainek.testnet', receiver_id: 'vendor1.testnet', amount: '300000000', memo: 'October hosting' });
});

test('interpret: decline carries the reason; bad arguments, unknown tools and text answers are "bad-call" with a reason', () => {
  assert.deepEqual(interpret(exchange(DECLINE, { reason: 'no payment asked' }), 't', 6).kind, 'declined');
  assert.match((interpret(exchange(PROPOSE_TRANSFER, { receiver_id: 'Vendor One', amount: '300', memo: '' }), 't', 6) as { reason: string }).reason, /receiver_id/);
  assert.match((interpret(exchange(PROPOSE_TRANSFER, { receiver_id: 'v.testnet', amount: '1.2345678', memo: '' }), 't', 6) as { reason: string }).reason, /decimals/);
  assert.match((interpret(exchange(PROPOSE_TRANSFER, '{not json'), 't', 6) as { reason: string }).reason, /not JSON/);
  assert.match((interpret(exchange('pay_everyone', {}), 't', 6) as { reason: string }).reason, /unknown tool/);
  const text = { completion: { id: 'c', object: 'chat.completion', choices: [{ message: { role: 'assistant', content: 'Sure!' } }] } } as unknown as Verified & RunStats;
  assert.match((interpret(text, 't', 6) as { reason: string }).reason, /without calling a tool/);
});

test('tools and prompt: the two tool names are what the model proof will record, and the prompt names them', () => {
  assert.deepEqual(TOOLS.map((t) => (t.type === 'function' ? t.function.name : '')), [PROPOSE_TRANSFER, DECLINE]);
  const prompt = treasurerPrompt('token.ainek.testnet', 'owner.testnet');
  assert.ok(prompt.includes(PROPOSE_TRANSFER) && prompt.includes(DECLINE) && prompt.includes('owner.testnet'));
  assert.equal(actionFrom({ receiver_id: 'a.testnet', amount: '1', memo: 'm' }, 'tok', 0).amount, '1');
});

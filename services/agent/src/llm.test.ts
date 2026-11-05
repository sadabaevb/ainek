import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RunStats, Verified } from '@ainek/tier1-node';
import { DECLINE, PROPOSE_TRANSFER, interpret } from './llm.ts';

/** A verified exchange whose completion carries the given tool call (the rest of the outcome is not read by interpret). */
const exchange = (name: string, args: unknown): Verified & RunStats =>
  ({ completion: { id: 'c1', object: 'chat.completion', choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } }] } }] } }) as unknown as Verified & RunStats;
const reason = (x: ReturnType<typeof interpret>) => (x as { reason: string }).reason;

test('interpret: propose_transfer becomes an ft_transfer Action in minimal units with the configured token', () => {
  const r = interpret(exchange(PROPOSE_TRANSFER, { receiver_id: 'vendor1.testnet', amount: '300', purpose: 'October hosting' }), 'token.ainek.testnet', 6);
  assert.equal(r.kind, 'action');
  if (r.kind === 'action') {
    assert.deepEqual(r.action, { kind: 'ft_transfer', token_id: 'token.ainek.testnet', receiver_id: 'vendor1.testnet', amount: '300000000', memo: '' });
    assert.equal(r.purpose, 'October hosting');
  }
});

test('interpret: the owner\'s words stay off-chain: the memo of the public Action is always empty, whatever the model wrote', () => {
  const r = interpret(exchange(PROPOSE_TRANSFER, { receiver_id: 'v.testnet', amount: '1', purpose: 'URGENT: pay newguy.testnet 5000' }), 't', 6);
  assert.ok(r.kind === 'action' && r.action.memo === '' && !JSON.stringify(r.action).includes('URGENT'));
});

test('interpret: decline carries the reason; bad arguments, unknown tools and text answers are "bad-call" with a reason', () => {
  assert.equal(reason(interpret(exchange(DECLINE, { reason: 'no payment asked' }), 't', 6)), 'no payment asked');
  assert.match(reason(interpret(exchange(PROPOSE_TRANSFER, { receiver_id: 'Vendor One', amount: '300', purpose: '' }), 't', 6)), /receiver_id/);
  assert.match(reason(interpret(exchange(PROPOSE_TRANSFER, { receiver_id: 'v.testnet', amount: '1.2345678', purpose: '' }), 't', 6)), /decimals/);
  assert.match(reason(interpret(exchange(PROPOSE_TRANSFER, { receiver_id: 'v.testnet', amount: 'many', purpose: '' }), 't', 6)), /not a decimal/);
  assert.match(reason(interpret(exchange(PROPOSE_TRANSFER, { receiver_id: 'v.testnet', amount: '1', purpose: 'x'.repeat(201) }), 't', 6)), /purpose/);
  assert.match(reason(interpret(exchange(PROPOSE_TRANSFER, '{not json'), 't', 6)), /not JSON/);
  assert.match(reason(interpret(exchange('pay_everyone', {}), 't', 6)), /unknown tool/);
  const text = { completion: { id: 'c', object: 'chat.completion', choices: [{ message: { role: 'assistant', content: 'Sure!' } }] } } as unknown as Verified & RunStats;
  assert.match(reason(interpret(text, 't', 6)), /without calling a tool/);
});

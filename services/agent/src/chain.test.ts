import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventNamed, parseProposed, spentTodayOf } from './chain.ts';

const b64 = (s: string) => Buffer.from(s).toString('base64');
const ev = (event: string) => `EVENT_JSON:${JSON.stringify({ standard: 'ainek', version: '1.0.0', event, data: [{ action_id: 7 }] })}`;

test('parseProposed: the action id from SuccessValue, the NEP-297 events from the receipts', () => {
  const p = parseProposed({ status: { SuccessValue: b64('7') }, transaction: { hash: 'TX' }, receipts_outcome: [{ outcome: { logs: [ev('action_proposed'), 'plain log'] } }, { outcome: { logs: [ev('action_executed')] } }] });
  assert.equal(p.actionId, 7);
  assert.equal(p.txHash, 'TX');
  assert.equal(p.events.length, 2);
  assert.equal(eventNamed(p.events, 'action_executed'), true);
  assert.equal(eventNamed(p.events, 'action_denied'), false);
});

test('parseProposed: a failed transaction or a missing id is an error with the chain message', () => {
  assert.throws(() => parseProposed({ status: { Failure: { ActionError: { kind: 'FunctionCallError' } } }, transaction: { hash: 'TX' } }), /propose_action failed: .*FunctionCallError/);
  assert.throws(() => parseProposed({ status: { SuccessValue: b64('') }, transaction: { hash: 'TX' } }), /no action id/);
});

test('spentTodayOf: a decimal string passes; anything else stops the action instead of reading as zero', () => {
  assert.equal(spentTodayOf({ spent_today: '300000000' }), '300000000');
  assert.equal(spentTodayOf({ spent_today: '0' }), '0');
  for (const info of [null, undefined, {}, { spent_today: 5 }, { spent_today: '-1' }, { spent: '1' }]) assert.throws(() => spentTodayOf(info), /per-day cap cannot be checked/);
});

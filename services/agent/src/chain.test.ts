import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyScopeProblem, parseProposed, spentTodayOf } from './chain.ts';

const b64 = (s: string) => Buffer.from(s).toString('base64');
const ev = (event: string) => `EVENT_JSON:${JSON.stringify({ standard: 'ainek', version: '1.0.0', event, data: [{ action_id: 7 }] })}`;
const tx = (status: unknown, logs: string[][] = []) => ({ status, transaction: { hash: 'TX' }, receipts_outcome: logs.map((l) => ({ outcome: { logs: l } })) });

test('parseProposed: the action id from SuccessValue (number or decimal string), execution from the events in any receipt', () => {
  assert.deepEqual(parseProposed(tx({ SuccessValue: b64('7') }, [[ev('action_proposed'), 'plain log'], [ev('action_executed')]])), { actionId: 7, txHash: 'TX', executed: true });
  assert.deepEqual(parseProposed(tx({ SuccessValue: b64('"7"') }, [[ev('action_proposed')]])), { actionId: 7, txHash: 'TX', executed: false });
});

test('parseProposed: no usable id is an error, never action #0', () => {
  for (const status of [{ SuccessValue: b64('') }, { SuccessValue: b64('null') }, { SuccessValue: b64('"x"') }, { Failure: {} }]) assert.throws(() => parseProposed(tx(status)), /no action id/);
});

test('spentTodayOf: a decimal string passes; anything else stops the action instead of reading as zero', () => {
  assert.equal(spentTodayOf({ spent_today: '300000000' }), '300000000');
  assert.equal(spentTodayOf({ spent_today: '0' }), '0');
  for (const info of [null, undefined, {}, { spent_today: 5 }, { spent_today: '-1' }, { spent: '1' }]) assert.throws(() => spentTodayOf(info), /per-day cap cannot be checked/);
});

test('keyScopeProblem: only a function-call key for this contract and exactly these two methods passes', () => {
  const key = (receiver_id: string, method_names: string[]) => ({ FunctionCall: { allowance: '1', receiver_id, method_names } });
  assert.equal(keyScopeProblem(key('c.testnet', ['propose_action', 'commit_proof']), 'c.testnet'), null);
  assert.match(keyScopeProblem('FullAccess', 'c.testnet') ?? '', /not a function-call key/);
  assert.match(keyScopeProblem(key('other.testnet', ['propose_action', 'commit_proof']), 'c.testnet') ?? '', /scoped to other\.testnet/);
  assert.match(keyScopeProblem(key('c.testnet', []), 'c.testnet') ?? '', /\[any\]/);
  assert.match(keyScopeProblem(key('c.testnet', ['propose_action', 'commit_proof', 'approve']), 'c.testnet') ?? '', /approve/);
});

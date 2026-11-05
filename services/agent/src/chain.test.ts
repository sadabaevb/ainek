import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commitCost, keyScopeProblem, parseProposed, spentTodayOf, tokenDecimalsOf } from './chain.ts';

const b64 = (s: string) => Buffer.from(s).toString('base64');
const ev = (event: string) => `EVENT_JSON:${JSON.stringify({ standard: 'ainek', version: '1.0.0', event, data: [{ action_id: 7 }] })}`;
const tx = (status: unknown, logs: string[][] = [], receiptStatus?: unknown) => ({ status, transaction: { hash: 'TX' }, receipts_outcome: logs.map((l) => ({ outcome: { logs: l, status: receiptStatus } })) });

test('parseProposed: the action id from SuccessValue (number or decimal string), execution from the events in any receipt', () => {
  assert.deepEqual(parseProposed(tx({ SuccessValue: b64('7') }, [[ev('action_proposed'), 'plain log'], [ev('action_executed')]])), { actionId: 7, txHash: 'TX', executed: true });
  assert.deepEqual(parseProposed(tx({ SuccessValue: b64('"7"') }, [[ev('action_proposed')]])), { actionId: 7, txHash: 'TX', executed: false });
});

test('parseProposed: no usable id is null, never action #0, and the hash survives; the id can also come from action_proposed', () => {
  for (const status of [{ SuccessValue: b64('') }, { SuccessValue: b64('null') }, { SuccessValue: b64('true') }, { SuccessValue: b64('"x"') }, { SuccessValue: b64('-1') }, {}]) assert.deepEqual(parseProposed(tx(status)), { actionId: null, txHash: 'TX', executed: false });
  assert.equal(parseProposed(tx({ SuccessValue: b64('') }, [[ev('action_proposed')]])).actionId, 7);
});

test('parseProposed: a log line that does not parse cannot lose a landed transaction', () => {
  assert.deepEqual(parseProposed(tx({ SuccessValue: b64('7') }, [['EVENT_JSON:{not json', ev('action_executed')]])), { actionId: 7, txHash: 'TX', executed: true });
});

test('parseProposed: a failed receipt means not executed, even with the event in the log', () => {
  assert.equal(parseProposed(tx({ SuccessValue: b64('7') }, [[ev('action_executed')]], { Failure: { ActionError: {} } })).executed, false);
  assert.equal(parseProposed(tx({ SuccessValue: b64('7') }, [[ev('action_executed')]], { SuccessValue: '' })).executed, true);
});

test('tokenDecimalsOf: the token\'s own answer, and nothing else counts as one', () => {
  assert.equal(tokenDecimalsOf({ decimals: 6 }), 6);
  assert.equal(tokenDecimalsOf({ decimals: 0 }), 0);
  for (const m of [null, {}, { decimals: '6' }, { decimals: 25 }, { decimals: 1.5 }]) assert.throws(() => tokenDecimalsOf(m), /no usable decimals/);
});

test('commitCost: the SPEC §4.2 formula, which gives the 161 bytes measured for a 26-character account', () => {
  assert.equal(commitCost('ainek-e2e-f20c502d.testnet', 'model'), 161n * 10n ** 19n);
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

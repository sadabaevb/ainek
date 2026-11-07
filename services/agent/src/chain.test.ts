import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actionCost, agentStateOf, commitCost, commitWithRetry, parseProposed, refusalOf, tokenDecimalsOf, tokenSymbolOf } from './chain.ts';
import { ContractRefused } from './errors.ts';

const b64 = (s: string) => Buffer.from(s).toString('base64');
const CONTRACT = 'c.testnet';
const ev = (event: string) => `EVENT_JSON:${JSON.stringify({ standard: 'ainek', version: '1.0.0', event, data: [{ action_id: 7 }] })}`;
const tx = (status: unknown, logs: string[][] = [], receiptStatus?: unknown) => ({ status, transaction: { hash: 'TX' }, receipts_outcome: logs.map((l) => ({ outcome: { executor_id: CONTRACT, logs: l, status: receiptStatus } })) });

test('parseProposed: the action id from SuccessValue (number or decimal string), execution from the events in any receipt', () => {
  assert.deepEqual(parseProposed(tx({ SuccessValue: b64('7') }, [[ev('action_proposed'), 'plain log'], [ev('action_executed')]]), CONTRACT), { actionId: 7, txHash: 'TX', transfer: 'executed' });
  assert.deepEqual(parseProposed(tx({ SuccessValue: b64('"7"') }, [[ev('action_proposed')]]), CONTRACT), { actionId: 7, txHash: 'TX', transfer: 'none' });
});

test('parseProposed: no usable id is null, never action #0, and the hash survives; the id can also come from action_proposed', () => {
  for (const status of [{ SuccessValue: b64('') }, { SuccessValue: b64('null') }, { SuccessValue: b64('true') }, { SuccessValue: b64('"x"') }, { SuccessValue: b64('-1') }, {}]) assert.deepEqual(parseProposed(tx(status), CONTRACT), { actionId: null, txHash: 'TX', transfer: 'none' });
  assert.equal(parseProposed(tx({ SuccessValue: b64('') }, [[ev('action_proposed')]]), CONTRACT).actionId, 7);
});

test('parseProposed: a log line that does not parse cannot lose a landed transaction', () => {
  assert.deepEqual(parseProposed(tx({ SuccessValue: b64('7') }, [['EVENT_JSON:{not json', ev('action_executed')]]), CONTRACT), { actionId: 7, txHash: 'TX', transfer: 'executed' });
});

test('parseProposed: a failed receipt means not executed, even with the event in the log', () => {
  assert.equal(parseProposed(tx({ SuccessValue: b64('7') }, [[ev('action_executed')]], { Failure: { ActionError: {} } }), CONTRACT).transfer, 'none');
  assert.equal(parseProposed(tx({ SuccessValue: b64('7') }, [[ev('action_executed')]], { SuccessValue: '' }), CONTRACT).transfer, 'executed');
});

test('tokenDecimalsOf: the token\'s own answer, and nothing else counts as one', () => {
  assert.equal(tokenDecimalsOf({ decimals: 6 }), 6);
  assert.equal(tokenDecimalsOf({ decimals: 0 }), 0);
  for (const m of [null, {}, { decimals: '6' }, { decimals: 25 }, { decimals: 1.5 }]) assert.throws(() => tokenDecimalsOf(m), /no usable decimals/);
});

test('commitCost: the SPEC §4.2 formula, which gives the 161 bytes measured for a 26-character account', () => {
  assert.equal(commitCost('ainek-e2e-f20c502d.testnet', 'model'), 161n * 10n ** 19n);
});

test('agentStateOf: reads what the contract holds; anything missing stops the action instead of reading as 0 or as not paused', () => {
  const good = { spent_today: '300000000', tee_pubkey: 'ab'.repeat(32), paused: false, token_id: 't.testnet' };
  assert.deepEqual(agentStateOf(good, 't.testnet'), { spentToday: '300000000', teePubkey: 'ab'.repeat(32), paused: false });
  assert.equal(agentStateOf({ ...good, spent_today: '0', paused: true }, 't.testnet').paused, true);
  for (const info of [null, undefined, {}, { ...good, spent_today: 5 }, { ...good, spent_today: '-1' }, { ...good, tee_pubkey: 'xy' }, { ...good, paused: 'no' }, { ...good, token_id: 'other.testnet' }]) assert.throws(() => agentStateOf(info, 't.testnet'));
});

test('actionCost: room for both commits and the action record the contract charges (measured 971 bytes)', () => {
  const account = 'agent.ainek.testnet';
  const byteCost = 10n ** 19n;
  assert.ok(actionCost(account) >= commitCost(account, 'model') + commitCost(account, 'action') + 971n * byteCost);
});

test('parseProposed: a transfer the token refused reads as failed, not as executed', () => {
  assert.deepEqual(parseProposed(tx({ SuccessValue: b64('3') }, [[ev('action_proposed')], [ev('action_failed')]]), CONTRACT), { actionId: 3, txHash: 'TX', transfer: 'refused' });
});

test('parseProposed: only our contract can say what happened; a token logging the same event cannot', () => {
  const spoofed = { status: { SuccessValue: b64('7') }, transaction: { hash: 'TX' }, receipts_outcome: [{ outcome: { executor_id: CONTRACT, logs: [ev('action_proposed')] } }, { outcome: { executor_id: 'token.testnet', logs: [ev('action_executed')] } }] };
  assert.equal(parseProposed(spoofed, CONTRACT).transfer, 'none');
});

test('refusalOf: a panic means the transaction landed and failed; a timeout says nothing about that', () => {
  assert.ok(refusalOf(new Error('Contract panicked: decision was made for a different time')) instanceof ContractRefused);
  const timeout = new Error('propose_action did not finish within 120 s');
  assert.equal(refusalOf(timeout), timeout);
});

test('tokenSymbolOf: the short name, and the account id when the token offers nothing a card can show', () => {
  assert.equal(tokenSymbolOf({ symbol: 'AINEK' }, 't.testnet'), 'AINEK');
  for (const m of [null, {}, { symbol: 7 }, { symbol: '' }, { symbol: 'A\nApproved' }, { symbol: 'x'.repeat(17) }]) assert.equal(tokenSymbolOf(m, 't.testnet'), 't.testnet');
});

const landed = { transaction: { hash: 'TX' } };
const attempts = (...left: Array<Error | typeof landed>) => {
  const send = async () => {
    const next = left.shift();
    if (!next) throw new Error('one attempt too many');
    if (next instanceof Error) throw next;
    return next;
  };
  return { send, left };
};
const PANIC = 'Smart contract panicked: this proof is already committed';

test('commitWithRetry: a network failure is sent again, and the hash comes back', async () => {
  const a = attempts(new Error('fetch failed'), landed);
  assert.equal(await commitWithRetry(a.send, 0), 'TX');
  assert.equal(a.left.length, 0);
});

test('commitWithRetry: it gives up after three attempts with the last failure', async () => {
  const a = attempts(new Error('fetch failed'), new Error('fetch failed'), new Error('commit_proof did not finish within 30 s'), landed);
  await assert.rejects(commitWithRetry(a.send, 0), /did not finish/);
  assert.equal(a.left.length, 1);
});

test('commitWithRetry: a refusal is final and is not sent again', async () => {
  const a = attempts(new Error('Smart contract panicked: not enough prepaid storage'), landed);
  await assert.rejects(commitWithRetry(a.send, 0), (err: unknown) => err instanceof ContractRefused);
  assert.equal(a.left.length, 1);
});

test('commitWithRetry: a duplicate means an earlier send landed, whichever attempt hears it: on-chain, hash lost', async () => {
  assert.equal(await commitWithRetry(attempts(new Error('fetch failed'), new Error(PANIC)).send, 0), undefined);
  assert.equal(await commitWithRetry(attempts(new Error(PANIC)).send, 0), undefined); // one send can post more than once
});

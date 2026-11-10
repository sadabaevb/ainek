import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import nacl from 'tweetnacl';
import { agentKeysOf, approveBlocker, checkActionRecord, decidedUnderCurrentPolicy, modelCommitCheck, readActions, readAgent, readAgentState, readModelCommits, readOwner, readPendingIds, type ModelCommitLookup } from './agent-ledger.ts';
import { canonicalBytes } from './canonical.ts';
import { actionCommitOf } from './commit.ts';
import { bytesToBase64 } from './disclosure.ts';
import { NO_SUCH_METHOD, fakeRpc } from './fixtures.ts';
import { bytesToHex } from './hash.ts';
import type { Action, ActionRecord, AgentInfo, Decision } from './schema.ts';

const contract = 'log.testnet';
const agentId = 'agent.testnet';
const keys = nacl.sign.keyPair();
const pubkey = bytesToHex(keys.publicKey);
const action: Action = { kind: 'ft_transfer', token_id: 'token.testnet', receiver_id: 'vendor.testnet', amount: '5', memo: '' };
const decisionFor = (verdict: Decision['verdict'], a: Action = action): Decision => ({ verdict, policy_hash: 'ef'.repeat(32), policy_version: 1, action_commit: actionCommitOf(a), model_proof_commit: 'ab'.repeat(32), nonce: '12'.repeat(32), expires_at: '1794055393785' });
const sign = (d: Decision): string => bytesToBase64(nacl.sign.detached(canonicalBytes(d), keys.secretKey));
const recordOf = (id: number, verdict: Decision['verdict'] = 'Allow', status = 'Executed'): ActionRecord => {
  const decision = decisionFor(verdict);
  return { action_id: id, agent_id: agentId, action, decision, tee_signature: sign(decision), tee_pubkey: pubkey, status, day: 20764, block_height: 100 + id };
};
const committed: ModelCommitLookup = { status: 'found', record: { kind: 'model', log_index: 3, block_height: 9 } };
const failed = (record: ActionRecord, lookup: ModelCommitLookup = committed): string[] => checkActionRecord(record, lookup).filter((c) => c.status === 'fail').map((c) => c.id);
const registered: AgentInfo = { agent_id: agentId, policy_hash: 'ef'.repeat(32), policy_version: 1, tee_pubkey: pubkey, token_id: 'token.testnet', paused: false, spent_today: '0' };

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** An older build of the contract: no `action_count()`, so the end is found by asking. */
const ledgerOf = (count: number) => fakeRpc(({ method, args }) => (method === 'action_count' ? NO_SUCH_METHOD : Number(args['action_id']) < count ? recordOf(Number(args['action_id'])) : null));
/** The same contract with `action_count()`; `visible` lets a node lag behind the count. */
const countedLedgerOf = (count: number, visible = count) => fakeRpc(({ method, args }) => (method === 'action_count' ? count : Number(args['action_id']) < visible ? recordOf(Number(args['action_id'])) : null));
const asked = (calls: ReturnType<typeof fakeRpc>) => calls.filter((c) => c.method === 'action');

test('readActions: every action from 0, oldest first, and it stops at the first missing id', async () => {
  const calls = ledgerOf(10);
  const { records, more } = await readActions('https://rpc.test', contract, { chunk: 4 });
  assert.deepEqual(records.map((r) => r.action_id), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(more, false);
  assert.equal(asked(calls).length, 12); // three chunks of four: the third one meets the end
});

test('readActions: a count that fills the last chunk exactly costs one more chunk, and an empty contract is an empty list', async () => {
  const calls = ledgerOf(4);
  assert.equal((await readActions('https://rpc.test', contract, { chunk: 4 })).records.length, 4);
  assert.equal(asked(calls).length, 8);
  ledgerOf(0);
  assert.deepEqual(await readActions('https://rpc.test', contract), { records: [], more: false, count: null });
});

test('readActions: at the cap the list is a prefix and says so, and exactly that many actions are the whole record', async () => {
  ledgerOf(100);
  const { records, more } = await readActions('https://rpc.test', contract, { chunk: 4, max: 6 });
  assert.deepEqual(records.map((r) => r.action_id), [0, 1, 2, 3, 4, 5]);
  assert.equal(more, true);
  const calls = ledgerOf(6);
  assert.deepEqual(await readActions('https://rpc.test', contract, { chunk: 4, max: 6 }).then((r) => [r.records.length, r.more]), [6, false]);
  assert.equal(asked(calls).at(-1)?.args['action_id'], 6); // the one id past the cap, asked to tell the two apart
});

test('readActions: a re-read from a known id asks a narrow window first, and returns only what is new', async () => {
  const calls = ledgerOf(11);
  const { records, more } = await readActions('https://rpc.test', contract, { from: 10 });
  assert.deepEqual(records.map((r) => r.action_id), [10]);
  assert.equal(more, false);
  assert.deepEqual(asked(calls).map((c) => c.args['action_id']), [10, 11, 12, 13]);
  ledgerOf(30);
  assert.deepEqual((await readActions('https://rpc.test', contract, { from: 10, chunk: 8 })).records.map((r) => r.action_id), Array.from({ length: 20 }, (_, i) => 10 + i)); // past the window it goes on in full chunks
  const atCap = ledgerOf(600);
  assert.deepEqual(await readActions('https://rpc.test', contract, { from: 512 }), { records: [], more: true, count: null });
  assert.deepEqual(asked(atCap).map((c) => c.args['action_id']), [512]); // already at the cap: only whether there is more is asked
});

test('readPendingIds: the waiting queue of an agent in one call, and none for an agent the contract does not know', async () => {
  const calls = fakeRpc(() => [recordOf(5, 'NeedsApproval', 'Pending'), recordOf(9, 'NeedsApproval', 'Pending')]);
  assert.deepEqual(await readPendingIds('https://rpc.test', contract, agentId), [5, 9]);
  assert.deepEqual(calls, [{ account: contract, method: 'pending_actions', args: { agent_id: agentId } }]);
  fakeRpc(() => []);
  assert.deepEqual(await readPendingIds('https://rpc.test', contract, 'nobody.testnet'), []);
});

test('readModelCommits: one answer per record in order, a failed read is that record\'s answer, and batches are handed over as they land', async () => {
  const records = Array.from({ length: 20 }, (_, i) => ({ ...recordOf(i), decision: { ...recordOf(i).decision, model_proof_commit: i.toString(16).padStart(2, '0').repeat(32) } }));
  const broken = records[3]?.decision.model_proof_commit;
  const calls = fakeRpc(({ args }) => (args['commit'] === broken ? { kind: 'model', log_index: -1, block_height: 1 } : args['commit'] === records[4]?.decision.model_proof_commit ? null : { kind: 'model', log_index: 3, block_height: 9 }));
  const batches: number[] = [];
  const lookups = await readModelCommits('https://rpc.test', contract, records, { onBatch: (found) => batches.push(found.length) });
  assert.deepEqual(batches, [16, 4]);
  assert.equal(calls.length, 20);
  assert.deepEqual(calls[0], { account: contract, method: 'proof_commit', args: { account: agentId, commit: records[0]?.decision.model_proof_commit } });
  assert.deepEqual(lookups.map((l) => l.status), records.map((_, i) => (i === 3 ? 'failed' : i === 4 ? 'none' : 'found')));
  const aborted = new AbortController();
  aborted.abort();
  assert.deepEqual(await readModelCommits('https://rpc.test', contract, records, { signal: aborted.signal }), []); // nothing is asked once the caller has gone
});

test('readActions with action_count(): exactly the ids the contract has, none past the end, and the cap without a probe', async () => {
  const calls = countedLedgerOf(10);
  assert.deepEqual(await readActions('https://rpc.test', contract, { chunk: 4 }).then((r) => [r.records.length, r.more, r.count]), [10, false, 10]);
  assert.deepEqual(asked(calls).map((c) => c.args['action_id']), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]); // no id past the end is asked
  // A re-read from a known id: nothing new costs one call, one new action costs two.
  const quiet = countedLedgerOf(10);
  assert.deepEqual(await readActions('https://rpc.test', contract, { from: 10 }), { records: [], more: false, count: 10 });
  assert.deepEqual(quiet.map((c) => c.method), ['action_count']);
  const one = countedLedgerOf(11);
  assert.deepEqual((await readActions('https://rpc.test', contract, { from: 10 })).records.map((r) => r.action_id), [10]);
  assert.equal(asked(one).length, 1);
  // Past the cap the count itself says there is more.
  const capped = countedLedgerOf(100);
  assert.deepEqual(await readActions('https://rpc.test', contract, { chunk: 4, max: 6 }).then((r) => [r.records.length, r.more]), [6, true]);
  assert.equal(asked(capped).length, 6);
  countedLedgerOf(6);
  assert.equal((await readActions('https://rpc.test', contract, { chunk: 4, max: 6 })).more, false);
  countedLedgerOf(0);
  assert.deepEqual(await readActions('https://rpc.test', contract), { records: [], more: false, count: 0 });
});

test('readActions with action_count(): an id the count promises and the node does not have yet ends the list, it is not an error', async () => {
  countedLedgerOf(11, 10);
  assert.deepEqual(await readActions('https://rpc.test', contract, { chunk: 4 }).then((r) => [r.records.length, r.more, r.count]), [10, false, 11]); // the count says the list is short
});

test('readActionCount: only a missing view means "ask instead"; an answer that is not a count is an error', async () => {
  for (const answer of ['10', -1, 1.5, null, { count: 10 }]) {
    fakeRpc(({ method }) => (method === 'action_count' ? answer : recordOf(0)));
    await assert.rejects(readActions('https://rpc.test', contract), /action_count: not a count/, JSON.stringify(answer));
  }
});

test('readActions: a record that is not what SPEC §4.3 describes is an error, not a row', async () => {
  fakeRpc(({ method }) => (method === 'action_count' ? 1 : { ...recordOf(0), decision: { verdict: 'Maybe' } }));
  await assert.rejects(readActions('https://rpc.test', contract));
});

test('readAgent and readOwner: the registration, null for an unknown agent, and an owner must be named', async () => {
  const calls = fakeRpc(({ method }) => (method === 'agent' ? registered : 'owner.testnet'));
  assert.deepEqual(await readAgent('https://rpc.test', contract, agentId), registered);
  assert.equal(await readOwner('https://rpc.test', contract), 'owner.testnet');
  assert.deepEqual(calls, [{ account: contract, method: 'agent', args: { agent_id: agentId } }, { account: contract, method: 'owner', args: {} }]);
  fakeRpc(() => null);
  assert.equal(await readAgent('https://rpc.test', contract, 'nobody.testnet'), null);
  await assert.rejects(readOwner('https://rpc.test', contract), /no owner/);
});

test('readAgentState: the registration, the scope of the keys, and the token on both accounts', async () => {
  const fc = { public_key: 'ed25519:fc', access_key: { permission: { FunctionCall: { receiver_id: contract, method_names: ['commit_proof', 'propose_action'], allowance: '1' } } } };
  const calls = fakeRpc(({ method, args }) => (method === 'agent' ? registered : args['account_id'] === contract ? '8794000000' : '0'), () => [fc, { public_key: 'ed25519:full', access_key: { permission: 'FullAccess' } }]);
  assert.deepEqual(await readAgentState('https://rpc.test', contract, agentId), {
    id: agentId,
    info: registered,
    keys: { functionCall: [{ publicKey: 'ed25519:fc', methods: ['commit_proof', 'propose_action'], problem: null }], fullAccess: 1 },
    funds: { inContract: '8794000000', onAgent: '0' },
  });
  assert.deepEqual(calls.filter((c) => c.method === 'ft_balance_of').map((c) => [c.account, c.args['account_id']]), [['token.testnet', contract], ['token.testnet', agentId]]);
  const unknown = fakeRpc(() => null);
  assert.deepEqual(await readAgentState('https://rpc.test', contract, 'nobody.testnet'), { id: 'nobody.testnet', info: null, keys: { functionCall: [], fullAccess: 0 }, funds: null });
  assert.equal(unknown.some((c) => c.method === 'ft_balance_of'), false); // no registration, no token to ask
});

test('checkActionRecord: a record as the contract writes it passes all four checks', () => {
  const checks = checkActionRecord(recordOf(7), committed);
  assert.deepEqual(checks.map((c) => [c.id, c.status]), [['decision-signature', 'ok'], ['action-commit', 'ok'], ['action-status', 'ok'], ['model-commit-on-chain', 'ok']]);
});

test('checkActionRecord: an edited decision, another key, another action', () => {
  const record = recordOf(7);
  assert.deepEqual(failed({ ...record, decision: { ...record.decision, verdict: 'Deny' }, status: 'Denied' }), ['decision-signature']);
  assert.deepEqual(failed({ ...record, tee_pubkey: 'ff'.repeat(32) }), ['decision-signature']);
  assert.deepEqual(failed({ ...record, action: { ...action, amount: '6' } }), ['action-commit']);
});

test('checkActionRecord: a verdict may end only in its own statuses, so a signed Deny that paid fails', () => {
  assert.deepEqual(failed(recordOf(1, 'Deny', 'Executed')), ['action-status']);
  assert.deepEqual(failed(recordOf(1, 'Deny', 'Denied')), []);
  assert.deepEqual(failed(recordOf(1, 'NeedsApproval', 'Pending')), []);
  assert.deepEqual(failed(recordOf(1, 'NeedsApproval', 'Rejected')), []);
  assert.deepEqual(failed(recordOf(1, 'Allow', 'Rejected')), ['action-status']);
  assert.deepEqual(failed(recordOf(1, 'Allow', 'Paused')), ['action-status']); // a status this client does not know is not waved through
});

test('checkActionRecord: the model proof commit must be there under the agent, as a model proof', () => {
  assert.deepEqual(failed(recordOf(7), { status: 'none' }), ['model-commit-on-chain']);
  assert.deepEqual(failed(recordOf(7), { status: 'found', record: { kind: 'action', log_index: 3, block_height: 9 } }), ['model-commit-on-chain']);
  assert.equal(modelCommitCheck({ status: 'not-deployed' }, agentId).status, 'skipped');
});

test('checkActionRecord: a lookup that failed is "could not check", neither a pass nor a failure, and the other checks stand', () => {
  const checks = checkActionRecord(recordOf(7), { status: 'failed', detail: 'http://rpc.test: HTTP 503' });
  assert.deepEqual(checks.map((c) => c.status), ['ok', 'ok', 'ok', 'skipped']);
  assert.deepEqual(checks.find((c) => c.id === 'model-commit-on-chain'), { id: 'model-commit-on-chain', status: 'skipped', detail: 'the commit could not be looked up: http://rpc.test: HTTP 503' });
});

test('decidedUnderCurrentPolicy: update_policy leaves old records as they were', () => {
  assert.equal(decidedUnderCurrentPolicy(recordOf(7), registered), true);
  assert.equal(decidedUnderCurrentPolicy(recordOf(7), { ...registered, tee_pubkey: 'aa'.repeat(32) }), false);
  assert.equal(decidedUnderCurrentPolicy(recordOf(7), { ...registered, policy_version: 2 }), false);
});

test('approveBlocker: the three refusals of approve, in the order the contract checks them', () => {
  const waiting = recordOf(7, 'NeedsApproval', 'Pending'); // proposed on UTC day 20764
  const sameDay = 20764 * 86_400_000 + 3_600_000;
  assert.equal(approveBlocker(waiting, registered, sameDay), null);
  assert.equal(approveBlocker(waiting, registered, sameDay + 86_400_000), 'earlierDay');
  assert.equal(approveBlocker(waiting, registered, 20765 * 86_400_000), 'earlierDay'); // 00:00 UTC is the next day
  assert.equal(approveBlocker(waiting, { ...registered, policy_version: 2 }, sameDay), 'replaced');
  assert.equal(approveBlocker(waiting, { ...registered, paused: true, policy_version: 2 }, sameDay + 86_400_000), 'paused');
  assert.equal(approveBlocker(waiting, { ...registered, policy_version: 2 }, sameDay + 86_400_000), 'replaced');
});

test('agentKeysOf: the scope of each function-call key, and how many full-access keys', () => {
  const fc = (receiver_id: string, method_names: string[]) => ({ public_key: `ed25519:${receiver_id}`, access_key: { permission: { FunctionCall: { receiver_id, method_names, allowance: '1' } } } });
  const full = { public_key: 'ed25519:full', access_key: { permission: 'FullAccess' } };
  const state = agentKeysOf([fc(contract, ['propose_action', 'commit_proof']), fc('other.testnet', ['commit_proof', 'propose_action']), fc(contract, []), full], contract);
  assert.equal(state.fullAccess, 1);
  assert.deepEqual(state.functionCall.map((k) => k.problem === null), [true, false, false]);
  assert.deepEqual(state.functionCall[0]?.methods, ['propose_action', 'commit_proof']);
  assert.match(state.functionCall[1]?.problem ?? '', /scoped to other\.testnet/);
  assert.match(state.functionCall[2]?.problem ?? '', /\[any\]/);
  assert.deepEqual(agentKeysOf([full], contract), { functionCall: [], fullAccess: 1 }); // the stopped agent: nothing left that can propose
});

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import nacl from 'tweetnacl';
import { agentKeysOf, approveBlocker, checkActionRecord, decidedUnderCurrentPolicy, modelCommitCheck, readActions, readAgent, readAgentState, readOwner, type ModelCommitLookup } from './agent-ledger.ts';
import { canonicalBytes } from './canonical.ts';
import { actionCommitOf } from './commit.ts';
import { bytesToBase64 } from './disclosure.ts';
import { fakeRpc } from './fixtures.ts';
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

const ledgerOf = (count: number) => fakeRpc(({ args }) => (Number(args['action_id']) < count ? recordOf(Number(args['action_id'])) : null));

test('readActions: every action from 0, oldest first, and it stops at the first missing id', async () => {
  const calls = ledgerOf(10);
  const { records, more } = await readActions('https://rpc.test', contract, { chunk: 4 });
  assert.deepEqual(records.map((r) => r.action_id), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(more, false);
  assert.equal(calls.length, 12); // three chunks of four: the third one meets the end
  assert.ok(calls.every((c) => c.method === 'action'));
});

test('readActions: a count that fills the last chunk exactly costs one more chunk, and an empty contract is an empty list', async () => {
  const calls = ledgerOf(4);
  assert.equal((await readActions('https://rpc.test', contract, { chunk: 4 })).records.length, 4);
  assert.equal(calls.length, 8);
  ledgerOf(0);
  assert.deepEqual(await readActions('https://rpc.test', contract), { records: [], more: false });
});

test('readActions: at the cap the list is a prefix and says so', async () => {
  ledgerOf(100);
  const { records, more } = await readActions('https://rpc.test', contract, { chunk: 4, max: 6 });
  assert.deepEqual(records.map((r) => r.action_id), [0, 1, 2, 3, 4, 5]);
  assert.equal(more, true);
});

test('readActions: a re-read from a known id asks a narrow window first, and returns only what is new', async () => {
  const calls = ledgerOf(11);
  const { records, more } = await readActions('https://rpc.test', contract, { from: 10 });
  assert.deepEqual(records.map((r) => r.action_id), [10]);
  assert.equal(more, false);
  assert.deepEqual(calls.map((c) => c.args['action_id']), [10, 11, 12, 13]);
  ledgerOf(30);
  assert.deepEqual((await readActions('https://rpc.test', contract, { from: 10, chunk: 8 })).records.map((r) => r.action_id), Array.from({ length: 20 }, (_, i) => 10 + i)); // past the window it goes on in full chunks
  ledgerOf(600);
  assert.deepEqual(await readActions('https://rpc.test', contract, { from: 512 }), { records: [], more: true }); // already at the cap: nothing is asked
});

test('readActions: a record that is not what SPEC §4.3 describes is an error, not a row', async () => {
  fakeRpc(() => ({ ...recordOf(0), decision: { verdict: 'Maybe' } }));
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

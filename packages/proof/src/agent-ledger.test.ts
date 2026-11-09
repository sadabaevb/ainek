import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import nacl from 'tweetnacl';
import { agentKeysOf, checkActionRecord, decidedUnderCurrentPolicy, readActions, readAgent, readOwner } from './agent-ledger.ts';
import { canonicalBytes } from './canonical.ts';
import { actionCommitOf } from './commit.ts';
import { bytesToBase64 } from './disclosure.ts';
import { bytesToHex } from './hash.ts';
import type { ProofCommitLookup } from './near-view.ts';
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
const committed: ProofCommitLookup = { status: 'found', record: { kind: 'model', log_index: 3, block_height: 9 } };
const failed = (record: ActionRecord, lookup: ProofCommitLookup = committed): string[] => checkActionRecord(record, lookup).filter((c) => c.status === 'fail').map((c) => c.id);

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Stands in for the NEAR JSON-RPC: answers each view from `answer` and records the calls. */
function chain(answer: (method: string, args: Record<string, unknown>) => unknown): Array<{ method: string; args: Record<string, unknown> }> {
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    const params = (JSON.parse(String(init.body)) as { params: { method_name: string; args_base64: string } }).params;
    const args = JSON.parse(Buffer.from(params.args_base64, 'base64').toString()) as Record<string, unknown>;
    calls.push({ method: params.method_name, args });
    return new Response(JSON.stringify({ result: { result: [...Buffer.from(JSON.stringify(answer(params.method_name, args)))] } }), { status: 200 });
  }) as typeof fetch;
  return calls;
}
const ledgerOf = (count: number) => chain((_method, args) => (Number(args['action_id']) < count ? recordOf(Number(args['action_id'])) : null));

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

test('readActions: a record that is not what SPEC §4.3 describes is an error, not a row', async () => {
  chain(() => ({ ...recordOf(0), decision: { verdict: 'Maybe' } }));
  await assert.rejects(readActions('https://rpc.test', contract));
});

test('readAgent and readOwner: the registration, null for an unknown agent, and an owner must be named', async () => {
  const info: AgentInfo = { agent_id: agentId, policy_hash: 'ef'.repeat(32), policy_version: 1, tee_pubkey: pubkey, token_id: 'token.testnet', paused: false, spent_today: '0' };
  const calls = chain((method) => (method === 'agent' ? info : 'owner.testnet'));
  assert.deepEqual(await readAgent('https://rpc.test', contract, agentId), info);
  assert.equal(await readOwner('https://rpc.test', contract), 'owner.testnet');
  assert.deepEqual(calls, [{ method: 'agent', args: { agent_id: agentId } }, { method: 'owner', args: {} }]);
  chain(() => null);
  assert.equal(await readAgent('https://rpc.test', contract, 'nobody.testnet'), null);
  await assert.rejects(readOwner('https://rpc.test', contract), /no owner/);
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
  assert.equal(checkActionRecord(recordOf(7), { status: 'not-deployed' }).at(-1)?.status, 'skipped');
});

test('decidedUnderCurrentPolicy: update_policy leaves old records as they were', () => {
  const now: AgentInfo = { agent_id: agentId, policy_hash: 'ef'.repeat(32), policy_version: 1, tee_pubkey: pubkey, token_id: 'token.testnet', paused: false, spent_today: '0' };
  assert.equal(decidedUnderCurrentPolicy(recordOf(7), now), true);
  assert.equal(decidedUnderCurrentPolicy(recordOf(7), { ...now, tee_pubkey: 'aa'.repeat(32) }), false);
  assert.equal(decidedUnderCurrentPolicy(recordOf(7), { ...now, policy_version: 2 }), false);
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

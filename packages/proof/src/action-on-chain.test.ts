import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import nacl from 'tweetnacl';
import { actionRunChecks, actionStatusProblem, checkActionProof, verifyActionProofOnChain } from './action-on-chain.ts';
import { buildActionProof } from './build.ts';
import { canonicalBytes } from './canonical.ts';
import { actionCommitOf } from './commit.ts';
import { bytesToBase64 } from './disclosure.ts';
import { bytesToHex } from './hash.ts';
import type { Check } from './verify.ts';
import type { Action, Decision } from './schema.ts';

const contract = 'log.testnet';
const agent = 'agent.testnet';
const wasmHash = 'cd'.repeat(32);
const keys = nacl.sign.keyPair();
const pubkey = bytesToHex(keys.publicKey);
const action: Action = { kind: 'ft_transfer', token_id: 'token.testnet', receiver_id: 'vendor.testnet', amount: '5', memo: '' };
const modelProofCommit = 'ab'.repeat(32);
const decision: Decision = { verdict: 'Allow', policy_hash: 'ef'.repeat(32), policy_version: 1, action_commit: actionCommitOf(action), model_proof_commit: modelProofCommit, nonce: '12'.repeat(32), expires_at: '1000' };
const sig = bytesToBase64(nacl.sign.detached(canonicalBytes(decision), keys.secretKey));
const proof = buildActionProof({ actionId: 7, action, modelProofCommit, decision, teeSignature: sig, teePubkey: pubkey, wasmHash, attestationUrl: 'https://api.test/attestations/by-call/x', proposeTx: 'tx1' });
const record = { action_id: 7, agent_id: agent, action, decision, tee_signature: sig, tee_pubkey: pubkey, status: 'Executed' };
const runRecord = { task_type: 'execute', task_id: 1, tdx_quote: 'AA==', worker_measurement: '', build_target: 'wasm32-wasip1', wasm_hash: wasmHash, executed_wasm_sha256: wasmHash, input_hash: wasmHash, output_hash: wasmHash, timestamp: 1 };
const commitFor = (kind: 'action' | 'model') => ({ kind, log_index: 3, block_height: 9 });

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Stands in for the NEAR JSON-RPC, answering by view method; `commits` maps a commit to its record. */
function chain(answerRecord: unknown = record, commits: Record<string, unknown> = { [proof.commit]: commitFor('action'), [modelProofCommit]: commitFor('model') }) {
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    const params = (JSON.parse(String(init.body)) as { params: { method_name: string; args_base64: string } }).params;
    const args = JSON.parse(Buffer.from(params.args_base64, 'base64').toString()) as { commit?: string };
    const answer = params.method_name === 'action' ? answerRecord : (commits[args.commit ?? ''] ?? null);
    return new Response(JSON.stringify({ result: { result: [...Buffer.from(JSON.stringify(answer))] } }), { status: 200 });
  }) as typeof fetch;
}
const check = (value: unknown = proof) => verifyActionProofOnChain(value, { rpcUrl: 'https://rpc.test', contract, wasmHash });
const statusOf = (checks: Check[], id: string) => checks.find((c) => c.id === id)?.status;

test('an action proof that matches the contract passes, and names what the chain says', async () => {
  chain();
  const r = await check();
  assert.deepEqual(r.checks.filter((c) => c.status !== 'ok'), []);
  assert.equal(r.ok, true);
  assert.match(r.checks.find((c) => c.id === 'action-status')?.detail ?? '', /Allow, and on chain the action is Executed/);
});

test('the key comes from the contract: a proof signed with a key of its own fails', async () => {
  chain({ ...record, tee_pubkey: 'ff'.repeat(32) });
  const r = await check();
  assert.equal(r.ok, false);
  assert.equal(statusOf(r.checks, 'decision-key'), 'fail');
});

test('a proof that differs from the record fails, and so does an action the contract does not have', async () => {
  chain({ ...record, action: { ...action, amount: '6' } });
  assert.equal(statusOf((await check()).checks, 'action-record'), 'fail');
  chain(null);
  const missing = await check();
  assert.equal(missing.ok, false);
  assert.equal(statusOf(missing.checks, 'action-record'), 'fail');
});

test('a verdict in a status it cannot end in fails', async () => {
  chain({ ...record, status: 'Denied' });
  assert.equal(statusOf((await check()).checks, 'action-status'), 'fail');
  assert.equal(actionStatusProblem('Deny', 'Executed'), 'Deny cannot end as Executed');
  assert.equal(actionStatusProblem('NeedsApproval', 'Rejected'), null);
});

test('the commits: the model\'s must exist, the proof\'s own may still be missing, and either fails on the wrong kind', async () => {
  chain(record, {});
  const none = await check();
  assert.equal(none.ok, false);
  assert.equal(statusOf(none.checks, 'on-chain-commit'), 'skipped');
  assert.equal(statusOf(none.checks, 'model-commit-on-chain'), 'fail');
  chain(record, { [proof.commit]: commitFor('model'), [modelProofCommit]: commitFor('action') });
  const swapped = await check();
  assert.equal(statusOf(swapped.checks, 'on-chain-commit'), 'fail');
  assert.equal(statusOf(swapped.checks, 'model-commit-on-chain'), 'fail');
});

test('a commit counts as the proof\'s own only when it reproduces from the salt: a file cannot borrow another commit of this agent', async () => {
  chain(record, { [proof.commit]: commitFor('action'), [modelProofCommit]: commitFor('model') });
  const { salt: _salt, ...saltless } = proof;
  const borrowed = await check(saltless);
  assert.equal(statusOf(borrowed.checks, 'commit'), 'skipped');
  assert.equal(statusOf(borrowed.checks, 'on-chain-commit'), 'skipped');
  const { commit: _commit, ...bare } = saltless;
  const r = await check(bare);
  assert.equal(r.ok, true);
  assert.equal(statusOf(r.checks, 'on-chain-commit'), 'skipped');
});

test('a malformed proof stops at the schema, with no view call', async () => {
  globalThis.fetch = (() => assert.fail('no call expected')) as typeof fetch;
  const r = await check({ kind: 'action' });
  assert.equal(r.ok, false);
  assert.equal(r.proof, null);
});

test('actionRunChecks: a proof cannot make this browser call a server of its choosing, and an outage is not a verdict', async () => {
  const runCheck = (url: string, f: typeof fetch) => actionRunChecks({ ...proof, attestationUrl: url }, { apiUrl: 'https://api.test', project: 'o.testnet/policy', wasmHash, rpcUrl: 'https://rpc.test', network: 'testnet', loadQuoteVerifier: () => assert.fail('no library expected'), fetch: f });
  const elsewhere = await runCheck('https://evil.example/a', (() => assert.fail('no call expected')) as typeof fetch);
  assert.equal(elsewhere[0]?.status, 'skipped');
  assert.match(elsewhere[0]?.detail ?? '', /evil\.example.*not fetched/);
  const down = await runCheck('https://api.test/a', (async () => new Response('', { status: 502 })) as typeof fetch);
  assert.match(down[0]?.detail ?? '', /HTTP 502/);
  const broken = await runCheck('https://api.test/a', (async () => { throw new Error('offline'); }) as typeof fetch);
  assert.match(broken[0]?.detail ?? '', /could not be checked: offline/);
  const noLibrary = await actionRunChecks(proof, { apiUrl: 'https://api.test', project: 'o.testnet/policy', wasmHash, rpcUrl: 'https://rpc.test', network: 'testnet', loadQuoteVerifier: () => Promise.reject(new Error('chunk failed')), fetch: (async () => new Response(JSON.stringify(runRecord))) as typeof fetch });
  assert.match(noLibrary[0]?.detail ?? '', /could not be checked: chunk failed/);
});

test('checkActionProof: a chain failure is failed with no library loaded, and an unreadable attestation is unchecked, not verified', async () => {
  const cfg = { rpcUrl: 'https://rpc.test', contract, apiUrl: 'https://api.test', project: 'o.testnet/policy', wasmHash, network: 'testnet' as const };
  chain({ ...record, status: 'Denied' });
  const refused = await checkActionProof(proof, { ...cfg, loadQuoteVerifier: () => assert.fail('no library expected') });
  assert.equal(refused.verdict, 'failed');
  assert.equal(refused.checks.some((c) => c.id.startsWith('run-')), false);
  chain();
  const r = await checkActionProof(proof, { ...cfg, loadQuoteVerifier: () => assert.fail('no library expected'), fetch: (async () => new Response(JSON.stringify({ not: 'a run' }))) as typeof fetch });
  assert.equal(r.verdict, 'unchecked');
  assert.equal(statusOf(r.checks, 'run-binding'), 'skipped');
});


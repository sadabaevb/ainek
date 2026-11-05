import { test } from 'node:test';
import assert from 'node:assert/strict';
import nacl from 'tweetnacl';
import { canonicalBytes } from './canonical.ts';
import { actionCommitOf, commitOf, proofPayload } from './commit.ts';
import { bytesToBase64 } from './disclosure.ts';
import { bytesToHex, sha256Hex } from './hash.ts';
import { PolicyInput, PolicyOutput, checkPolicyOutput, verifyActionProof, verifyDecisionSignature } from './policy.ts';
import { ActionProof, type Action, type Decision } from './schema.ts';

const action: Action = { kind: 'ft_transfer', token_id: 'token.ainek.testnet', receiver_id: 'vendor1.testnet', amount: '300000000', memo: 'October' };
const modelProofCommit = 'ab'.repeat(32);
const wasmHash = 'cd'.repeat(32);
const now = 1_762_300_000_000;
const keys = nacl.sign.keyPair();
const pubkey = bytesToHex(keys.publicKey);

/** What the job would print for `action` (SPEC §6.2), signed with the test key. */
function signed(verdict: Decision['verdict'] = 'Allow', overrides: Partial<Decision> = {}): PolicyOutput {
  const decision: Decision = { verdict, policy_hash: 'ef'.repeat(32), policy_version: 3, action_commit: actionCommitOf(action), model_proof_commit: modelProofCommit, nonce: sha256Hex(`${actionCommitOf(action)}${now}`), expires_at: String(now + 600_000), ...overrides };
  return { decision, sig: bytesToBase64(nacl.sign.detached(canonicalBytes(decision), keys.secretKey)), pubkey, wasm_hash: wasmHash };
}
const expect = { action, modelProofCommit, teePubkey: pubkey, wasmHash, now };
const failed = (checks: ReturnType<typeof checkPolicyOutput>) => checks.filter((c) => c.status === 'fail').map((c) => c.id);

test('policy schemas: the §6.2 input and output parse, and an output with a stray field is rejected', () => {
  PolicyInput.parse({ action, model_proof_commit: modelProofCommit, spent_today: '0', now });
  PolicyOutput.parse(signed());
  assert.throws(() => PolicyOutput.parse({ ...signed(), extra: 1 }));
});

test('verifyDecisionSignature: a signature over canonical_bytes(decision) verifies under the job key and under nothing else', () => {
  const out = signed();
  assert.equal(verifyDecisionSignature(out.decision, out.sig, pubkey), true);
  assert.equal(verifyDecisionSignature({ ...out.decision, verdict: 'Deny' }, out.sig, pubkey), false);
  assert.equal(verifyDecisionSignature(out.decision, out.sig, bytesToHex(nacl.sign.keyPair().publicKey)), false);
  assert.equal(verifyDecisionSignature(out.decision, 'not base64!', pubkey), false);
});

test('checkPolicyOutput: an honest Allow passes every check; each tampering is named', () => {
  assert.deepEqual(failed(checkPolicyOutput(signed(), expect)), []);
  assert.deepEqual(failed(checkPolicyOutput(signed('Deny'), expect)), []);
  assert.deepEqual(failed(checkPolicyOutput({ ...signed(), decision: { ...signed().decision, verdict: 'Deny' } }, expect)), ['decision-signature']);
  assert.deepEqual(failed(checkPolicyOutput(signed(), { ...expect, teePubkey: 'ff'.repeat(32) })), ['decision-key']);
  assert.deepEqual(failed(checkPolicyOutput(signed(), { ...expect, wasmHash: 'ff'.repeat(32) })), ['wasm-hash']);
  assert.deepEqual(failed(checkPolicyOutput(signed(), { ...expect, action: { ...action, amount: '1' } })), ['action-commit']);
  assert.deepEqual(failed(checkPolicyOutput(signed(), { ...expect, modelProofCommit: 'ff'.repeat(32) })), ['model-proof-commit']);
  assert.deepEqual(failed(checkPolicyOutput(signed('Allow', { expires_at: String(now - 1) }), expect)), ['decision-expiry']);
});

/** A committed action proof over `signed()`. */
function actionProof(): ActionProof {
  const out = signed();
  const payload = ActionProof.parse({ v: 1, kind: 'action', actionId: 7, action, actionCommit: actionCommitOf(action), modelProofCommit, decision: out.decision, teeSignature: out.sig, teePubkey: pubkey, wasmHash, attestationUrl: 'https://api.test/attestations/c1', proposeTx: 'TX', executeTx: 'TX', approver: null });
  const salt = '11'.repeat(32);
  return { ...payload, salt, commit: commitOf(salt, payload) };
}
const failedIds = (r: ReturnType<typeof verifyActionProof>) => r.checks.filter((c) => c.status === 'fail').map((c) => c.id);

test('verifyActionProof: an honest proof passes; signer and build are "skipped" without the on-chain registration, compared with it', () => {
  const r = verifyActionProof(actionProof());
  assert.equal(r.ok, true);
  assert.deepEqual(r.checks.filter((c) => c.status === 'skipped').map((c) => c.id), ['decision-key', 'wasm-hash']);
  assert.deepEqual(verifyActionProof(actionProof(), { teePubkey: pubkey, wasmHash }).checks.filter((c) => c.status !== 'ok'), []);
  assert.deepEqual(failedIds(verifyActionProof(actionProof(), { teePubkey: 'ff'.repeat(32), wasmHash: 'ee'.repeat(32) })), ['decision-key', 'wasm-hash']);
});

test('verifyActionProof: every tampering is named', () => {
  const p = actionProof();
  const recommit = (x: ActionProof): ActionProof => ({ ...x, commit: commitOf('11'.repeat(32), x) });
  assert.deepEqual(failedIds(verifyActionProof({ ...p, commit: 'ff'.repeat(32) })), ['commit']);
  assert.deepEqual(failedIds(verifyActionProof(recommit({ ...p, action: { ...action, amount: '1' } }))), ['action-commit']);
  assert.deepEqual(failedIds(verifyActionProof(recommit({ ...p, modelProofCommit: 'ff'.repeat(32) }))), ['model-proof-commit']);
  assert.deepEqual(failedIds(verifyActionProof(recommit({ ...p, decision: { ...p.decision, verdict: 'Deny' } }))), ['decision-signature']);
  assert.deepEqual(failedIds(verifyActionProof({ ...p, extra: 1 })), ['schema']);
});

test('verifyActionProof: a copy without the salt is still checkable; the commit is skipped, and expiry is not re-checked', () => {
  const r = verifyActionProof(proofPayload(actionProof()));
  assert.equal(r.ok, true);
  assert.equal(r.checks.find((c) => c.id === 'commit')?.status, 'skipped');
  assert.equal(r.checks.some((c) => c.id === 'decision-expiry'), false);
});

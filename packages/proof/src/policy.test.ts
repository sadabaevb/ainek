import { test } from 'node:test';
import assert from 'node:assert/strict';
import nacl from 'tweetnacl';
import { canonicalBytes } from './canonical.ts';
import { buildActionProof } from './build.ts';
import { actionCommitOf, commitOf, proofPayload } from './commit.ts';
import { bytesToBase64 } from './disclosure.ts';
import { bytesToHex, sha256Hex } from './hash.ts';
import { readRepoJson } from './fixtures.ts';
import { PolicyInput, PolicyOutput, checkPolicyOutput, decidedAtMs, verifyActionProof, verifyDecisionSignature } from './policy.ts';
import type { JsonValue } from './canonical.ts';
import type { Action, ActionProof, Decision } from './schema.ts';

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
  assert.deepEqual(failed(checkPolicyOutput({ ...signed(), decision: { ...signed().decision, verdict: 'Deny' } }, expect)), ['decision-signature']);
  assert.deepEqual(failed(checkPolicyOutput(signed(), { ...expect, teePubkey: 'ff'.repeat(32) })), ['decision-key']);
  assert.deepEqual(failed(checkPolicyOutput(signed(), { ...expect, wasmHash: 'ff'.repeat(32) })), ['wasm-hash']);
  assert.deepEqual(failed(checkPolicyOutput(signed(), { ...expect, action: { ...action, amount: '1' } })), ['action-commit']);
  assert.deepEqual(failed(checkPolicyOutput(signed(), { ...expect, modelProofCommit: 'ff'.repeat(32) })), ['model-proof-commit']);
  assert.deepEqual(failed(checkPolicyOutput(signed('Allow', { expires_at: String(now - 1) }), expect)), ['decision-expiry']);
});

test('checkPolicyOutput: an expires_at in nanoseconds (the wrong unit) fails the check by name instead of throwing or reading as far in the future', () => {
  const checks = checkPolicyOutput(signed('Allow', { expires_at: '1800000000000000000' }), expect);
  assert.deepEqual(failed(checks), ['decision-expiry']);
  assert.match(checks.find((c) => c.id === 'decision-expiry')?.detail ?? '', /wrong unit/);
});

/** A committed action proof over `signed()`. */
function actionProof(): ActionProof {
  const out = signed();
  return buildActionProof({ actionId: 7, action, modelProofCommit, decision: out.decision, teeSignature: out.sig, teePubkey: pubkey, wasmHash, attestationUrl: 'https://api.test/attestations/c1', proposeTx: 'TX', salt: '11'.repeat(32) });
}
const failedIds = (r: ReturnType<typeof verifyActionProof>) => r.checks.filter((c) => c.status === 'fail').map((c) => c.id);

const registered = { teePubkey: pubkey, wasmHash };

test('verifyActionProof: an honest proof passes; a proof signed by a key of its own fails against the registration', () => {
  const r = verifyActionProof(actionProof(), registered);
  assert.equal(r.ok, true);
  assert.deepEqual(r.checks.filter((c) => c.status !== 'ok'), []);
  assert.deepEqual(failedIds(verifyActionProof(actionProof(), { teePubkey: 'ff'.repeat(32), wasmHash: 'ee'.repeat(32) })), ['decision-key', 'wasm-hash']);
});

test('verifyActionProof: every tampering is named', () => {
  const p = actionProof();
  const recommit = (x: ActionProof): ActionProof => ({ ...x, commit: commitOf('11'.repeat(32), x) });
  assert.deepEqual(failedIds(verifyActionProof({ ...p, commit: 'ff'.repeat(32) }, registered)), ['commit']);
  assert.deepEqual(failedIds(verifyActionProof(recommit({ ...p, action: { ...action, amount: '1' } }), registered)), ['action-commit']);
  assert.deepEqual(failedIds(verifyActionProof(recommit({ ...p, modelProofCommit: 'ff'.repeat(32) }), registered)), ['model-proof-commit']);
  assert.deepEqual(failedIds(verifyActionProof(recommit({ ...p, decision: { ...p.decision, verdict: 'Deny' } }), registered)), ['decision-signature']);
  assert.deepEqual(failedIds(verifyActionProof({ ...p, extra: 1 }, registered)), ['schema']);
});

test('verifyActionProof: a copy without the salt is still checkable; the commit is skipped, and expiry is not re-checked', () => {
  const r = verifyActionProof(proofPayload(actionProof()), registered);
  assert.equal(r.ok, true);
  assert.equal(r.checks.find((c) => c.id === 'commit')?.status, 'skipped');
  assert.equal(r.checks.some((c) => c.id === 'decision-expiry'), false);
});

test('the real policy job: every recorded output (docs/test-vectors/policy-decision.json) passes the agent and auditor checks, and an edited verdict does not', () => {
  const vectors = readRepoJson<{ policy: JsonValue; cases: Array<{ name: string; input: unknown; output: unknown }> }>('docs/test-vectors/policy-decision.json');
  assert.ok(vectors.cases.length >= 4);
  for (const c of vectors.cases) {
    const input = PolicyInput.parse(c.input);
    const out = PolicyOutput.parse(c.output);
    const expect = { action: input.action, modelProofCommit: input.model_proof_commit, teePubkey: out.pubkey, wasmHash: out.wasm_hash, now: input.now };
    assert.deepEqual(checkPolicyOutput(out, expect).filter((x) => x.status === 'fail'), [], c.name);
    assert.equal(out.decision.action_commit, actionCommitOf(input.action), c.name);
    assert.equal(out.decision.policy_hash, sha256Hex(canonicalBytes(vectors.policy)), c.name);
    assert.equal(out.decision.nonce, sha256Hex(`${out.decision.action_commit}:${input.now}:${input.spent_today}`), c.name);
    const edited = { ...out, decision: { ...out.decision, verdict: out.decision.verdict === 'Allow' ? 'Deny' as const : 'Allow' as const } };
    assert.ok(checkPolicyOutput(edited, expect).some((x) => x.id === 'decision-signature' && x.status === 'fail'), c.name);
  }
});

test('decidedAtMs: the moment the contract took as the time of the decision is expires_at minus the ten minutes the job adds', () => {
  assert.equal(decidedAtMs(signed('Allow', { expires_at: String(now + 600_000) }).decision), now);
  assert.equal(new Date(decidedAtMs(signed('Deny', { expires_at: '1794055393785' }).decision)).toISOString(), '2026-11-07T12:33:13.785Z'); // action #4 on testnet, recorded on UTC day 20764 = 2026-11-07
});

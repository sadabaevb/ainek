import { test } from 'node:test';
import assert from 'node:assert/strict';
import nacl from 'tweetnacl';
import { canonicalBytes } from './canonical.ts';
import { actionCommitOf } from './commit.ts';
import { bytesToBase64 } from './disclosure.ts';
import { bytesToHex, sha256Hex } from './hash.ts';
import { PolicyInput, PolicyOutput, checkPolicyOutput, verifyDecisionSignature } from './policy.ts';
import type { Action, Decision } from './schema.ts';

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

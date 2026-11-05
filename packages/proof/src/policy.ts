// The policy job's contract with the agent (SPEC §6.2): what goes to its stdin, what comes back, and the checks the agent
// runs on a decision before it spends gas on `propose_action` (the contract repeats them on-chain; an auditor can too).
import nacl from 'tweetnacl';
import { z } from 'zod';
import { canonicalBytes } from './canonical.ts';
import { actionCommitOf, commitOf } from './commit.ts';
import { base64ToBytes } from './disclosure.ts';
import { hexToBytes } from './hash.ts';
import { Action, ActionProof, Decision, hex64, u128String } from './schema.ts';
import type { Check } from './verify.ts';

/** stdin of the policy job. `now` is unix milliseconds. */
export const PolicyInput = z.object({ action: Action, model_proof_commit: hex64, spent_today: u128String, now: z.number().int().nonnegative() }).strict();
export type PolicyInput = z.infer<typeof PolicyInput>;

/** stdout of the policy job (≤ 900 bytes): the decision, its signature and what signed it. */
export const PolicyOutput = z
  .object({
    decision: Decision,
    /** base64 ed25519 over `canonical_bytes(decision)`. */
    sig: z.string().min(1),
    /** hex, the key generated inside the TEE (`PROTECTED_ED25519`), bound to `wasm_hash`. */
    pubkey: hex64,
    wasm_hash: hex64,
  })
  .strict();
export type PolicyOutput = z.infer<typeof PolicyOutput>;

/** ed25519 over `canonical_bytes(decision)`, signature base64, public key hex (SPEC §6.2). */
export function verifyDecisionSignature(decision: Decision, sigBase64: string, pubkeyHex: string): boolean {
  try {
    const sig = base64ToBytes(sigBase64);
    const pk = hexToBytes(pubkeyHex);
    return sig.length === 64 && pk.length === 32 && nacl.sign.detached.verify(canonicalBytes(decision), sig, pk);
  } catch {
    return false;
  }
}

export interface DecisionExpectations {
  action: Action;
  modelProofCommit: string;
  /** The policy public key registered on-chain (`register_agent`), from config. */
  teePubkey: string;
  /** The reproducible build's hash registered on-chain, from config. */
  wasmHash: string;
  /** unix milliseconds; `expires_at` is compared in the same unit (SPEC §6.2: `now` in ms). */
  now: number;
}

/** Everything that can be checked without the chain: the signature, who signed, which build, and that the decision is about this action, this conversation and this moment. */
export function checkPolicyOutput(out: PolicyOutput, x: DecisionExpectations): Check[] {
  const d = out.decision;
  const check = (id: Check['id'], ok: boolean, okText: string, failText: string): Check => ({ id, status: ok ? 'ok' : 'fail', detail: ok ? okText : failText });
  const expectedCommit = actionCommitOf(x.action);
  return [
    check('decision-signature', verifyDecisionSignature(d, out.sig, out.pubkey), `ed25519 signature verifies under ${out.pubkey.slice(0, 8)}… over canonical_bytes(decision)`, 'the decision signature does not verify under the key the job reports'),
    check('decision-key', out.pubkey === x.teePubkey, 'signed by the policy key registered for this agent', `signed by ${out.pubkey.slice(0, 8)}…, the registered policy key is ${x.teePubkey.slice(0, 8)}…`),
    check('wasm-hash', out.wasm_hash === x.wasmHash, 'produced by the registered policy build', `produced by build ${out.wasm_hash.slice(0, 8)}…, the registered build is ${x.wasmHash.slice(0, 8)}…`),
    check('action-commit', d.action_commit === expectedCommit, 'decision.action_commit is sha256(canonical_json(action)) of this action', 'decision.action_commit is not this action'),
    check('model-proof-commit', d.model_proof_commit === x.modelProofCommit, 'decision.model_proof_commit is this conversation', 'decision.model_proof_commit is not this conversation'),
    check('decision-expiry', BigInt(d.expires_at) > BigInt(x.now), `decision valid until ${new Date(Number(d.expires_at)).toISOString()}`, 'the decision has expired'),
  ];
}

export interface ActionProofReport {
  ok: boolean;
  checks: Check[];
  proof: ActionProof | null;
}

/**
 * Re-checks an action proof from the proof alone (SPEC §5.2), for an auditor: the action hashes to what the decision covers, the decision
 * is signed by the key the proof names, and the salted commit reproduces. `expected` is what `register_agent` put on-chain: without it
 * the key and the build are "skipped", because a proof cannot vouch for its own signer. Expiry is not re-checked: a decision has expired
 * by the time anyone audits it, and the contract checked it when it mattered.
 */
export function verifyActionProof(value: unknown, expected: { teePubkey?: string; wasmHash?: string } = {}): ActionProofReport {
  const parsed = ActionProof.safeParse(value);
  if (!parsed.success) return { ok: false, checks: [{ id: 'schema', status: 'fail', detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }], proof: null };
  const proof = parsed.data;
  const pass = (id: Check['id'], ok: boolean, okText: string, failText: string): Check => ({ id, status: ok ? 'ok' : 'fail', detail: ok ? okText : failText });
  const against = (id: Check['id'], actual: string, wanted: string | undefined, what: string): Check =>
    wanted === undefined ? { id, status: 'skipped', detail: `${what} not compared with the on-chain registration` } : pass(id, actual === wanted, `${what} matches the on-chain registration`, `${what} ${actual.slice(0, 8)}… differs from the registered ${wanted.slice(0, 8)}…`);
  const recomputed = actionCommitOf(proof.action);
  const checks: Check[] = [
    pass('schema', true, 'proof matches the ActionProof schema (SPEC §5.2)', ''),
    pass('action-commit', proof.actionCommit === recomputed && proof.decision.action_commit === recomputed, 'sha256(canonical_json(action)) is what the proof and the decision cover', 'the action does not hash to what the proof and the decision cover'),
    pass('model-proof-commit', proof.decision.model_proof_commit === proof.modelProofCommit, 'the decision binds the model proof this proof names', 'the decision binds a different model proof'),
    pass('decision-signature', verifyDecisionSignature(proof.decision, proof.teeSignature, proof.teePubkey), `ed25519 signature verifies under ${proof.teePubkey.slice(0, 8)}…`, 'the decision signature does not verify'),
    against('decision-key', proof.teePubkey, expected.teePubkey, 'the policy key'),
    against('wasm-hash', proof.wasmHash, expected.wasmHash, 'the policy build'),
    proof.salt !== undefined && proof.commit !== undefined ? pass('commit', commitOf(proof.salt, proof) === proof.commit, `commit ${proof.commit.slice(0, 12)}… reproduced from salt + proof`, 'the commit does not reproduce from the salt and the proof') : { id: 'commit', status: 'skipped', detail: 'no salt in this copy of the proof' },
  ];
  return { ok: !checks.some((c) => c.status === 'fail'), checks, proof };
}

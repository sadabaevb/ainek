// The policy job's contract with the agent (SPEC §6.2): what goes to its stdin, what comes back, and the checks on a decision:
// `checkPolicyOutput` before the agent spends gas on `propose_action`, `verifyActionProof` for an auditor afterwards.
import nacl from 'tweetnacl';
import { z } from 'zod';
import { canonicalBytes } from './canonical.ts';
import { actionCommitOf, commitOf } from './commit.ts';
import { base64ToBytes } from './disclosure.ts';
import { hexToBytes, shortHex as short } from './hash.ts';
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
    /** What the job reports about itself: outside the signature, so the attestation, not this field, is the authority on the build. */
    wasm_hash: hex64,
  })
  .strict();
export type PolicyOutput = z.infer<typeof PolicyOutput>;

/** A decision lives ten minutes (§6.2). Much longer means a wrong unit (nanoseconds) or a job fed a far-future `now`. */
const MAX_DECISION_LIFETIME_MS = 3_600_000n;

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

const check = (id: Check['id'], ok: boolean, okText: string, failText: string): Check => ({ id, status: ok ? 'ok' : 'fail', detail: ok ? okText : failText });
const against = (id: Check['id'], actual: string, wanted: string | undefined, what: string): Check =>
  wanted === undefined ? { id, status: 'skipped', detail: `${what} not compared with the registration` } : check(id, actual === wanted, `${what} matches the registration`, `${what} ${short(actual)} differs from the registered ${short(wanted)}`);

/** One wording and one rule for the agent's check and the auditor's, so they cannot drift. `coveredCommits` is every place that claims to cover the action. */
function decisionChecks(x: { decision: Decision; sig: string; pubkey: string; action: Action; coveredCommits: string[]; modelProofCommit: string; wasmHash: string; teePubkey: string | undefined; expectedWasmHash: string | undefined }): Check[] {
  const recomputed = actionCommitOf(x.action);
  return [
    check('decision-signature', verifyDecisionSignature(x.decision, x.sig, x.pubkey), `ed25519 signature verifies under ${short(x.pubkey)} over canonical_bytes(decision)`, 'the decision signature does not verify under the key the proof names'),
    against('decision-key', x.pubkey, x.teePubkey, 'the policy key'),
    against('wasm-hash', x.wasmHash, x.expectedWasmHash, 'the build the job reports'),
    check('action-commit', x.coveredCommits.every((c) => c === recomputed), 'sha256(canonical_json(action)) is what the decision covers', 'the decision does not cover this action'),
    check('model-proof-commit', x.decision.model_proof_commit === x.modelProofCommit, 'the decision binds this model proof', 'the decision binds a different model proof'),
  ];
}

/** Everything the agent can check without the chain before it spends gas. The contract checks what it can on-chain; see SPEC §4.3 and the open questions in DEV-NOTES for what it does not yet. */
export function checkPolicyOutput(out: PolicyOutput, x: { action: Action; modelProofCommit: string; teePubkey: string; wasmHash: string; /** unix milliseconds, the unit of `expires_at` (§6.2) */ now: number }): Check[] {
  const d = out.decision;
  const expires = BigInt(d.expires_at);
  const now = BigInt(x.now);
  const expiry = expires <= now ? 'the decision has expired' : expires > now + MAX_DECISION_LIFETIME_MS ? `expires_at ${d.expires_at} is not within an hour of now (${x.now} ms): a wrong unit or a far-future now` : null;
  return [
    ...decisionChecks({ decision: d, sig: out.sig, pubkey: out.pubkey, action: x.action, coveredCommits: [d.action_commit], modelProofCommit: x.modelProofCommit, wasmHash: out.wasm_hash, teePubkey: x.teePubkey, expectedWasmHash: x.wasmHash }),
    check('decision-expiry', expiry === null, `decision valid until ${d.expires_at} (unix ms)`, expiry ?? ''),
  ];
}

/**
 * Re-checks an action proof from the proof alone (SPEC §5.2), for an auditor: the action hashes to what the decision covers, the decision
 * is signed by the key the proof names, and the salted commit reproduces. `expected` is what `register_agent` put on-chain: without it
 * the key and the build are "skipped", because a proof cannot vouch for its own signer. Expiry is not re-checked: a decision has expired
 * by the time anyone audits it, and the contract checked it when it mattered.
 */
export function verifyActionProof(value: unknown, expected: { teePubkey?: string; wasmHash?: string } = {}): { ok: boolean; checks: Check[]; proof: ActionProof | null } {
  const parsed = ActionProof.safeParse(value);
  if (!parsed.success) return { ok: false, checks: [{ id: 'schema', status: 'fail', detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }], proof: null };
  const proof = parsed.data;
  const checks: Check[] = [
    { id: 'schema', status: 'ok', detail: 'proof matches the ActionProof schema (SPEC §5.2)' },
    ...decisionChecks({ decision: proof.decision, sig: proof.teeSignature, pubkey: proof.teePubkey, action: proof.action, coveredCommits: [proof.actionCommit, proof.decision.action_commit], modelProofCommit: proof.modelProofCommit, wasmHash: proof.wasmHash, teePubkey: expected.teePubkey, expectedWasmHash: expected.wasmHash }),
    proof.salt !== undefined && proof.commit !== undefined ? check('commit', commitOf(proof.salt, proof) === proof.commit, `commit ${short(proof.commit)} reproduced from salt + proof`, 'the commit does not reproduce from the salt and the proof') : { id: 'commit', status: 'skipped', detail: 'no salt in this copy of the proof' },
  ];
  return { ok: !checks.some((c) => c.status === 'fail'), checks, proof };
}

// The policy job's contract with the agent (SPEC §6.2): what goes to its stdin, what comes back, and the checks the agent
// runs on a decision before it spends gas on `propose_action` (the contract repeats them on-chain; an auditor can too).
import nacl from 'tweetnacl';
import { z } from 'zod';
import { canonicalBytes } from './canonical.ts';
import { actionCommitOf } from './commit.ts';
import { base64ToBytes } from './disclosure.ts';
import { hexToBytes } from './hash.ts';
import { Action, Decision, hex64, u128String } from './schema.ts';
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

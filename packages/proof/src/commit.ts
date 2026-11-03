// Commitments: what goes on-chain is never the proof itself, only a salted hash of it (SPEC §4.2, §5).
import { canonicalBytes, canonicalJson } from './canonical.ts';
import { concatBytes, hexToBytes, sha256Hex, utf8Bytes } from './hash.ts';
import type { Action, ActionProof, KeyEntryInput, ModelProof } from './schema.ts';

/** Fields the commit cannot cover because they are produced by committing. */
const ENVELOPE_FIELDS = ['salt', 'commit', 'commitTx'] as const;
type EnvelopeField = (typeof ENVELOPE_FIELDS)[number];

/** The proof without `salt`, `commit`, `commitTx`: the bytes that `commit` covers. */
export function proofPayload<T extends ModelProof | ActionProof>(proof: T): Omit<T, EnvelopeField> {
  const copy: Record<string, unknown> = { ...proof };
  for (const field of ENVELOPE_FIELDS) delete copy[field];
  return copy as Omit<T, EnvelopeField>;
}

/** `commit = sha256(salt_32_bytes || canonical_json(proof payload))`, hex (SPEC §4.2). */
export function commitOf(saltHex: string, proof: ModelProof | ActionProof): string {
  const salt = hexToBytes(saltHex);
  if (salt.length !== 32) throw new Error(`salt must be 32 bytes, got ${salt.length}`);
  return sha256Hex(concatBytes(salt, canonicalBytes(proofPayload(proof))));
}

/** `action_commit = sha256(canonical_json(action))` (SPEC §4.3), checked by the contract in propose_action. */
export function actionCommitOf(action: Action): string {
  return sha256Hex(canonicalJson(action));
}

/**
 * `entry_hash = sha256(prev_hash || canonical_json(KeyEntryInput) || verifier)` (SPEC §4.1).
 * Concatenation convention (to confirm with Dastan, see DEV-NOTES 2026-11-03): all three parts are
 * UTF-8 text, i.e. `prev_hash` as its 64 hex characters, not as 32 raw bytes; genesis `prev_hash` is "".
 */
export function entryHashOf(prevHash: string, input: KeyEntryInput, verifier: string): string {
  return sha256Hex(concatBytes(utf8Bytes(prevHash), canonicalBytes(input), utf8Bytes(verifier)));
}

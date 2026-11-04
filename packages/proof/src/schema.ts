// Zod schemas for everything that crosses a boundary: proofs (SPEC §5), the contract ABI types we read
// back (SPEC §4.1, §4.3) and the NEAR AI signature reply. Field names follow SPEC exactly: camelCase in
// proofs (ours), snake_case in contract types (NEAR convention, Dastan's side).
import { z } from 'zod';

export const hex64 = z.string().regex(/^[0-9a-f]{64}$/, 'expected 64 lowercase hex chars (sha256)');
const nonEmpty = z.string().min(1);
/** near-sdk serialises U64 / U128 as decimal strings in JSON. */
const u64String = z.string().regex(/^\d+$/, 'expected a decimal string (near-sdk U64)');
const u128String = z.string().regex(/^\d+$/, 'expected a decimal string (near-sdk U128)');

export const SigningAlgo = z.enum(['ed25519', 'ecdsa']);
export type SigningAlgo = z.infer<typeof SigningAlgo>;

/** Fields shared by every proof, appended after the proof is committed on-chain (SPEC §5). */
const envelope = {
  salt: hex64.optional(),
  commit: hex64.optional(),
  commitTx: nonEmpty.optional(),
};

// ---- SPEC §5.1 ----------------------------------------------------------------------------------
export const ModelProof = z
  .object({
    v: z.literal(1),
    kind: z.literal('model'),
    completionId: nonEmpty,
    model: nonEmpty,
    /** `provider_tee` is the only value a green card accepts; anything else is the non-TEE route (SPEC §3.9). */
    signatureKind: nonEmpty,
    signingAlgo: SigningAlgo,
    signingAddress: nonEmpty,
    signedText: nonEmpty,
    /** As returned by `/v1/signature`: 128 hex chars for ed25519, 0x-prefixed 65-byte hex for ecdsa. */
    signature: nonEmpty,
    requestSha256: hex64,
    responseSha256: hex64,
    e2ee: z.boolean(),
    toolNames: z.array(z.string()),
    logIndex: z.number().int().nonnegative(),
    verifier: nonEmpty,
    verifiedAt: z.iso.datetime(),
    ...envelope,
  })
  .strict();
export type ModelProof = z.infer<typeof ModelProof>;

// ---- SPEC §4.3 (contract types used inside action proofs) ------------------------------------------
export const Action = z
  .object({
    kind: z.literal('ft_transfer'),
    token_id: nonEmpty,
    receiver_id: nonEmpty,
    amount: u128String,
    memo: z.string(),
  })
  .strict();
export type Action = z.infer<typeof Action>;

export const Verdict = z.enum(['Allow', 'Deny', 'NeedsApproval']);
export type Verdict = z.infer<typeof Verdict>;

export const Decision = z
  .object({
    verdict: Verdict,
    policy_hash: hex64,
    policy_version: z.number().int().nonnegative(),
    action_commit: hex64,
    model_proof_commit: hex64,
    nonce: hex64,
    expires_at: u64String,
  })
  .strict();
export type Decision = z.infer<typeof Decision>;

// ---- SPEC §5.2 ----------------------------------------------------------------------------------
export const ActionProof = z
  .object({
    v: z.literal(1),
    kind: z.literal('action'),
    actionId: z.number().int().nonnegative(),
    action: Action,
    actionCommit: hex64,
    modelProofCommit: hex64,
    decision: Decision,
    teeSignature: nonEmpty,
    teePubkey: nonEmpty,
    wasmHash: hex64,
    attestationUrl: z.url(),
    proposeTx: nonEmpty,
    executeTx: nonEmpty.nullable(),
    approver: nonEmpty.nullable(),
    ...envelope,
  })
  .strict();
export type ActionProof = z.infer<typeof ActionProof>;

export const Proof = z.discriminatedUnion('kind', [ModelProof, ActionProof]);
export type Proof = z.infer<typeof Proof>;

// ---- SPEC §4.1 (key log) ------------------------------------------------------------------------
export const KeyEntryInput = z
  .object({
    model: nonEmpty,
    signing_address: nonEmpty,
    signing_algo: SigningAlgo,
    signing_public_key: nonEmpty,
    compose_hash: hex64,
    image_digests: z.array(nonEmpty),
    tcb_status: nonEmpty,
    ita_jwt_hash: z.union([hex64, z.literal('')]),
    nras_result_hash: z.union([hex64, z.literal('')]),
    nonce: hex64,
    report_hash: hex64,
    observed_at: u64String,
  })
  .strict();
export type KeyEntryInput = z.infer<typeof KeyEntryInput>;

export const KeyEntry = KeyEntryInput.extend({
  index: z.number().int().nonnegative(),
  verifier: nonEmpty,
  prev_hash: z.union([hex64, z.literal('')]),
  entry_hash: hex64,
  block_height: z.number().int().nonnegative(),
}).strict();
export type KeyEntry = z.infer<typeof KeyEntry>;

// ---- NEAR AI `GET /v1/signature/{id}` reply -------------------------------------------------------
export const SignatureResponse = z.object({
  text: nonEmpty,
  signature: nonEmpty,
  signing_address: nonEmpty,
  signing_algo: SigningAlgo,
  /** Absent on legacy signatures; the route detector treats absence as "not provider_tee". */
  signature_kind: z.string().optional(),
});
export type SignatureResponse = z.infer<typeof SignatureResponse>;

// ---- SPEC §4.2 (what proof_commit returns) ---------------------------------------------------------
/** `log_index` and `block_height` are u64 in the contract: numbers on the wire, decimal strings accepted too. */
export const ProofCommitRecord = z
  .object({ kind: z.enum(['model', 'action']), log_index: z.coerce.number().int().nonnegative(), block_height: z.coerce.number().int().nonnegative() })
  .strict();
export type ProofCommitRecord = z.infer<typeof ProofCommitRecord>;

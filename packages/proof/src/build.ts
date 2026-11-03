// Assemble a ModelProof (SPEC §5.1) from what the client holds after a verified exchange. One implementation
// for the web client and the agent service, so `e2ee`, `toolNames`, salt and commit cannot drift between them.
import { commitOf } from './commit.ts';
import { randomHex32, sha256Hex } from './hash.ts';
import { ModelProof, type KeyEntry, type SigningAlgo } from './schema.ts';

export interface BuildModelProofInput {
  completionId: string;
  model: string;
  /** As returned by `/v1/signature/{id}` (SDK `CompletionSignature` shape). */
  signature: { kind: string; signer: { signingAlgo: SigningAlgo; signingAddress: string }; signedText: string; signature: string };
  /** Exact bytes sent and received (ciphertext when E2EE). */
  requestBody: Uint8Array;
  responseBody: Uint8Array;
  /** The public-log entry the fail-closed check matched. */
  logEntry: KeyEntry;
  /** When the client verified the deployment evidence (ISO 8601). */
  verifiedAt: string;
  e2ee: boolean;
  toolNames?: string[];
  /** 32-byte hex; drawn at random when omitted. Fixed only in tests. */
  salt?: string;
}

/** Hashes recomputed from the bytes, bound to the log entry, salted and committed; validated against the schema. */
export function buildModelProof(input: BuildModelProofInput): ModelProof {
  const payload = {
    v: 1 as const,
    kind: 'model' as const,
    completionId: input.completionId,
    model: input.model,
    signatureKind: input.signature.kind,
    signingAlgo: input.signature.signer.signingAlgo,
    signingAddress: input.signature.signer.signingAddress,
    signedText: input.signature.signedText,
    signature: input.signature.signature,
    requestSha256: sha256Hex(input.requestBody),
    responseSha256: sha256Hex(input.responseBody),
    e2ee: input.e2ee,
    toolNames: input.toolNames ?? [],
    logIndex: input.logEntry.index,
    verifier: input.logEntry.verifier,
    verifiedAt: input.verifiedAt,
  };
  const salt = input.salt ?? randomHex32();
  return ModelProof.parse({ ...payload, salt, commit: commitOf(salt, payload) });
}

// Build the KeyEntryInput (SPEC §4.1) a verifier logs after `verifyModelAttestation` succeeded. One implementation
// for every verifier instance, so field conventions (digest prefix, nonce form, hashes) cannot drift.
import { sha256Hex } from './hash.ts';
import { KeyEntryInput, type SigningAlgo } from './schema.ts';

/** Structural subset of the SDK's `VerifiedModelAttestation`; no SDK import so this package stays light. */
export interface VerifiedModelEvidence {
  signer: { signingAlgo: SigningAlgo; signingAddress: string };
  /** Quote-bound E2EE public key; equals `signingAddress` for ed25519. */
  signingPublicKey?: string;
  tcbStatus: string;
  deployment: { appCompose: string; runtimeMeasurements: { composeHash?: string } };
}

export interface BuildKeyEntryInputParams {
  model: string;
  verified: VerifiedModelEvidence;
  /** Exact bytes of the `/v1/attestation/report` reply, kept off-chain by the verifier under `sha256(report)`. */
  reportBytes: Uint8Array;
  /** The nonce the verifier generated for that report (hex, with or without 0x). */
  nonce: string;
  /** NVIDIA NRAS overall JWT, when the verifier captured it (the SDK's built-in verifier does not expose it). */
  nrasJwt?: string;
  /** Intel Trust Authority token, when used. */
  itaJwt?: string;
  /** Unix ms on the verifier; defaults to now. */
  observedAtMs?: number;
}

/** `sha256:<hex>` image digests referenced by the compose file, in order of first appearance, deduplicated. */
export function imageDigestsOf(appCompose: string): string[] {
  return [...new Set(appCompose.match(/sha256:[0-9a-f]{64}/g) ?? [])];
}

export function buildKeyEntryInput(p: BuildKeyEntryInputParams): KeyEntryInput {
  const { verified } = p;
  const appCompose = verified.deployment.appCompose;
  return KeyEntryInput.parse({
    model: p.model,
    signing_address: verified.signer.signingAddress.toLowerCase(),
    signing_algo: verified.signer.signingAlgo,
    signing_public_key: (verified.signingPublicKey ?? verified.signer.signingAddress).toLowerCase(),
    compose_hash: (verified.deployment.runtimeMeasurements.composeHash ?? sha256Hex(appCompose)).toLowerCase(),
    image_digests: imageDigestsOf(appCompose),
    tcb_status: verified.tcbStatus,
    ita_jwt_hash: p.itaJwt ? sha256Hex(p.itaJwt) : '',
    nras_result_hash: p.nrasJwt ? sha256Hex(p.nrasJwt) : '',
    nonce: p.nonce.replace(/^0x/i, '').toLowerCase(),
    report_hash: sha256Hex(p.reportBytes),
    observed_at: String(p.observedAtMs ?? Date.now()),
  });
}

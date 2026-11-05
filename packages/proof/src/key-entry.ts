// Build the KeyEntryInput (SPEC §4.1) a verifier logs after `verifyModelAttestation` succeeded. One implementation
// for every verifier instance, so field conventions (digest prefix, hex form, hashes) cannot drift. Conventions
// are listed in SPEC §4.1 under "Соглашения верификатора".
import { normalizeHex, sha256Hex } from './hash.ts';
import { KeyEntryInput, type SigningAlgo } from './schema.ts';

/** Structural subset of the SDK's `VerifiedModelAttestation`; no SDK import so this package stays light. */
export interface VerifiedModelEvidence {
  signer: { signingAlgo: SigningAlgo; signingAddress: string };
  /** Quote-bound E2EE public key; equals `signingAddress` for ed25519. */
  signingPublicKey?: string;
  tcbStatus: string;
  deployment: { appCompose: string; runtimeMeasurements: { composeHash?: string } };
  /** The original report; its nonce was checked by the SDK against the one the verifier sent. */
  report: { nonce: string };
}

/** The compose hash of a verified deployment: the measurement from the quote, without one sha256(app_compose) (SPEC §4.1). */
export function composeHashOf(deployment: VerifiedModelEvidence['deployment']): string {
  return normalizeHex(deployment.runtimeMeasurements.composeHash ?? sha256Hex(deployment.appCompose));
}

export interface BuildKeyEntryInputParams {
  model: string;
  verified: VerifiedModelEvidence;
  /** Exact bytes of the `/v1/attestation/report` reply, kept off-chain by the verifier under `sha256(report)`. */
  reportBytes: Uint8Array;
  /** NVIDIA NRAS overall JWT, when the verifier captured it (the SDK's built-in GPU verifier does not expose it). */
  nrasJwt?: string;
  /** Intel Trust Authority token, when used. */
  itaJwt?: string;
  /** Unix ms on the verifier; defaults to now. */
  observedAtMs?: number;
}

/**
 * `sha256:<hex>` digests of the images the compose file runs, in order of first appearance, deduplicated.
 * Only `image:` lines count, so a checksum in a script or a comment is not mistaken for a deployment image.
 * Accepts the dstack `app_compose` JSON (uses its `docker_compose_file`) or compose YAML text directly.
 */
export function imageDigestsOf(appCompose: string): string[] {
  let yaml = appCompose;
  try {
    const parsed = JSON.parse(appCompose) as { docker_compose_file?: unknown };
    if (typeof parsed.docker_compose_file === 'string') yaml = parsed.docker_compose_file;
  } catch {
    // not JSON: treat the input as compose YAML
  }
  const digests = new Set<string>();
  for (const line of yaml.split('\n')) {
    const match = /^\s*(?:-\s*)?image:\s*.*@sha256:([0-9a-fA-F]{64})\b/.exec(line);
    if (match) digests.add(`sha256:${(match[1] as string).toLowerCase()}`);
  }
  return [...digests];
}

export function buildKeyEntryInput(p: BuildKeyEntryInputParams): KeyEntryInput {
  const { verified } = p;
  const { signingAlgo } = verified.signer;
  const publicKey = verified.signingPublicKey ?? (signingAlgo === 'ed25519' ? verified.signer.signingAddress : undefined);
  if (publicKey === undefined) throw new Error(`report for ${p.model} carries no E2EE public key and ${signingAlgo} addresses are not keys: nothing to pin`);
  const appCompose = verified.deployment.appCompose;
  const imageDigests = imageDigestsOf(appCompose);
  if (imageDigests.length === 0) throw new Error(`compose file of ${p.model} pins no image by digest: refusing to log an entry without image_digests`);
  const observedAt = p.observedAtMs ?? Date.now();
  if (!Number.isSafeInteger(observedAt) || observedAt < 0) throw new Error(`observedAtMs must be a non-negative integer of unix milliseconds, got ${String(p.observedAtMs)}`);
  return KeyEntryInput.parse({
    model: p.model,
    signing_address: normalizeHex(verified.signer.signingAddress),
    signing_algo: signingAlgo,
    signing_public_key: normalizeHex(publicKey),
    compose_hash: composeHashOf(verified.deployment),
    image_digests: imageDigests,
    tcb_status: verified.tcbStatus,
    ita_jwt_hash: p.itaJwt ? sha256Hex(p.itaJwt) : '',
    nras_result_hash: p.nrasJwt ? sha256Hex(p.nrasJwt) : '',
    nonce: normalizeHex(verified.report.nonce),
    report_hash: sha256Hex(p.reportBytes),
    observed_at: String(observedAt),
  });
}

// Build the KeyEntryInput (SPEC §4.1) a verifier logs after `verifyModelAttestation` succeeded. One implementation
// for every verifier instance, so field conventions (digest prefix, hex form, hashes) cannot drift. Conventions
// are listed in SPEC §4.1 under "Verifier conventions".
import { normalizeHex, sha256Hex, utf8Bytes } from './hash.ts';
import { KeyEntryInput, type SigningAlgo } from './schema.ts';

/** Structural subset of the SDK's `VerifiedModelAttestation`; no SDK import so this package stays light. */
export interface VerifiedModelEvidence {
  signer: { signingAlgo: SigningAlgo; signingAddress: string };
  /** Quote-bound E2EE public key; equals `signingAddress` for ed25519. */
  signingPublicKey?: string;
  tcbStatus: string;
  /** `runtimeMeasurements` is not read (see `composeHashOf`); it is here so an SDK result fits without a cast. */
  deployment: { appCompose: string; runtimeMeasurements?: { composeHash?: string } };
  /** The original report; its nonce was checked by the SDK against the one the verifier sent. */
  report: { nonce: string };
}

/**
 * The compose hash of a verified deployment: sha256(app_compose), the value the SDK has checked against the quote's
 * MRCONFIGID, which the hardware measures. In an honest boot the RTMR3 `compose-hash` event carries the same value, and it
 * is not what this returns: the SDK reports the last event of that name, and before dstack 0.6.0 a container holding the
 * dstack socket could append one of its own (`EmitEvent`), so a CVM could show a hash it did not boot from.
 */
export function composeHashOf(deployment: VerifiedModelEvidence['deployment']): string {
  return sha256Hex(deployment.appCompose);
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
  /**
   * Release marks to log after the image digests (release-marks.ts), when the verifier followed the release to public
   * sources. Marks the contract's limits leave no room for are left out, all of them: the key and its launcher are logged
   * either way.
   */
  marks?: readonly string[];
}

/** The contract's limits on `image_digests` (contracts/ainek/src/lib.rs): at most 16 values of at most 128 bytes. */
const MAX_IMAGE_DIGESTS = 16;
const MAX_FIELD_BYTES = 128;

/**
 * The two parts of a dstack `app_compose` JSON this package reads: the compose file it carries and the names of the
 * environment variables the deployer may set (dstack passes a CVM no others). Undefined for text that is not that JSON.
 */
export function readAppCompose(appCompose: string): { composeFile: string; allowedEnvs: string[] } | undefined {
  try {
    const parsed = JSON.parse(appCompose) as { docker_compose_file?: unknown; allowed_envs?: unknown } | null;
    if (typeof parsed?.docker_compose_file !== 'string') return undefined;
    return { composeFile: parsed.docker_compose_file, allowedEnvs: Array.isArray(parsed.allowed_envs) ? parsed.allowed_envs.filter((name): name is string => typeof name === 'string') : [] };
  } catch {
    return undefined;
  }
}

/**
 * `sha256:<hex>` digests of the images the compose file runs, in order of first appearance, deduplicated.
 * Only `image:` lines count, so a checksum in a script or a comment is not mistaken for a deployment image.
 * Accepts the dstack `app_compose` JSON (uses its `docker_compose_file`) or compose YAML text directly.
 */
export function imageDigestsOf(appCompose: string): string[] {
  const yaml = readAppCompose(appCompose)?.composeFile ?? appCompose; // not the dstack JSON: treat the input as compose YAML
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
  // Marks come after the digests and never at their cost: the contract rejects a whole entry over one value too many.
  const marked = [...imageDigests, ...(p.marks ?? [])];
  const fits = marked.length <= MAX_IMAGE_DIGESTS && marked.every((value) => utf8Bytes(value).length <= MAX_FIELD_BYTES);
  const observedAt = p.observedAtMs ?? Date.now();
  if (!Number.isSafeInteger(observedAt) || observedAt < 0) throw new Error(`observedAtMs must be a non-negative integer of unix milliseconds, got ${String(p.observedAtMs)}`);
  return KeyEntryInput.parse({
    model: p.model,
    signing_address: normalizeHex(verified.signer.signingAddress),
    signing_algo: signingAlgo,
    signing_public_key: normalizeHex(publicKey),
    compose_hash: composeHashOf(verified.deployment),
    image_digests: fits ? marked : imageDigests,
    tcb_status: verified.tcbStatus,
    ita_jwt_hash: p.itaJwt ? sha256Hex(p.itaJwt) : '',
    nras_result_hash: p.nrasJwt ? sha256Hex(p.nrasJwt) : '',
    nonce: normalizeHex(verified.report.nonce),
    report_hash: sha256Hex(p.reportBytes),
    observed_at: String(observedAt),
  });
}

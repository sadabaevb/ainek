// One attestation round for one model: fresh nonce → raw `/v1/attestation/report` bytes → the SDK's own
// verification (Intel DCAP with live collateral, NVIDIA NRAS, nonce and signer bound in the TDX report data,
// app_compose vs MRCONFIGID, RTMR3 replay) → one KeyEntryInput (SPEC §4.1) per model attestation in the report.
//
// We fetch the report ourselves rather than through the SDK's AttestationClient because the log entry carries
// `report_hash = sha256(exact report bytes)` and the client classes do not expose those bytes. The endpoint is
// public: no API key is needed to re-attest, which is the point of an independent verifier.
//
// A report may hold several attestations for one model (replicas, or two deployments during a rollout). Every one
// of them is a key the client may be talking to, so every one that verifies is logged; one failing replica does
// not hide the others, and is itself reported as failed.
//
// The compose hash in an entry is the launcher's. The containers that serve the model are deployed later, through the
// enclave's action log, which the same report carries and the SDK authenticates. When the release that log ends in can be
// followed to public sources, the entry also carries release marks (SPEC §7.5, packages/proof/src/release-marks.ts).
import { fetchImageProvenance, getSdkError, verifyImageProvenance, verifyModelAttestation, type ModelAttestation, type TcbStatus, type VerifiedModelAttestation } from '@nearai/inference-sdk/node';
import { buildKeyEntryInput, marksOf, randomHex32, sha256Hex, toModelAttestation, withRetry, type KeyEntryInput, type RawReport } from '@ainek/proof';
import { releaseMarksFor, type ReleaseReads } from '@ainek/proof/release-chain';

type RawModelAttestation = RawReport['model_attestations'][number];

/** `unmarked`: why the entry carries no release marks, when a marker was given and it carries none. */
export type AttestedKey = { ok: true; verified: VerifiedModelAttestation; entry: KeyEntryInput; unmarked?: string } | { ok: false; signingAddress: string; error: string };

/** Follows the release behind a verified report to public sources: the marks to log with its key, or why there are none. */
export type ReleaseMarker = (model: string, verified: VerifiedModelAttestation) => Promise<{ marks: string[]; why?: string }>;

export interface AttestationRound {
  model: string;
  nonce: string;
  reportBytes: Uint8Array;
  reportHash: string;
  keys: AttestedKey[];
}

export interface AttestOptions {
  baseUrl: string;
  acceptedTcbStatuses: readonly string[];
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** The SDK's verifier; tests pass one that fails on purpose. */
  verify?: typeof verifyModelAttestation;
  /** Release marks for each verified key (`releaseMarker`). Without it entries are logged as they were before marks. */
  release?: ReleaseMarker;
}

/** Whatever the SDK marks `retryable` (Intel's collateral service rejecting, NRAS or transport 5xx, 429, ...). Twin of
 *  `sdkRetryable` in packages/tier1-node, which the verifier does not depend on. */
const sdkRetryable = (err: unknown): boolean => getSdkError(err)?.retryable === true;

/** One attestation normally verifies in 5–60 s. The SDK's collateral and NRAS requests carry no deadline of their
 *  own and can hang on a socket that died while the host was asleep; past this the replica counts as failed. The budget
 *  covers all retries of a replica (below), so a slow third attempt can be cut off: the round is not held up for it. */
export const VERIFY_TIMEOUT_MS = 180_000;

/** A promise that gives up. The work itself is not cancelled (the SDK takes no AbortSignal; a retry loop inside it goes
 *  on with its remaining attempts), it only stops blocking the caller. Twin of `withDeadline` in packages/tier1-node, which the verifier does not depend on. */
export function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms / 1000} s`)), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/** Following a release is a few GitHub reads and two Sigstore verifications, most of them answered from memory after the
 *  first round. A round is not held up for it: past this the key is logged without marks. */
export const RELEASE_TIMEOUT_MS = 60_000;

/**
 * The marker a daemon uses: the release chain of @ainek/proof with this SDK's image checks. Its store of reads lives as
 * long as the marker, so a release is read from GitHub once; a later round asks only where the release's tag points now.
 * The token is optional and goes to api.github.com only: it raises the anonymous limit of 60 requests an hour.
 */
export function releaseMarker(githubToken?: string): ReleaseMarker {
  const reads: ReleaseReads = new Map();
  return (model, verified) => releaseMarksFor({ deployment: verified.deployment, report: verified.report, model, githubToken, reads, sdk: { fetchImageProvenance, verifyImageProvenance, getSdkError } });
}

export async function fetchReport(baseUrl: string, model: string, nonce: string, fetchImpl: typeof fetch = fetch): Promise<Uint8Array> {
  const url = `${baseUrl}/attestation/report?model=${encodeURIComponent(model)}&signing_algo=ed25519&nonce=${nonce}`;
  // `x-no-aliasing: true` (CLAUDE.md): the gateway must answer for exactly this model id, never an alias of it,
  // otherwise a neighbouring deployment's key could end up in the log under this model's name.
  const res = await fetchImpl(url, {
    // `Connection: close`: the gateway's balancer picks a replica per connection, not per request (12 of 12 reports from one
    // replica over a kept-alive connection, 7 and 5 from two with this header, DEV-NOTES 2026-11-10). Without it the several
    // reports of a round would all come from the replica the first one reached.
    headers: { Accept: 'application/json', 'Accept-Encoding': 'identity', 'x-no-aliasing': 'true', Connection: 'close' },
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`attestation report for ${model}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** All attestations the report carries for `model`, in report order; fails when there are none. */
export function selectModelAttestations(raw: RawReport, model: string): RawModelAttestation[] {
  const forModel = raw.model_attestations.filter((m) => m.model_name === model);
  if (forModel.length === 0) throw new Error(`report carries no model_attestations for ${model}`);
  return forModel;
}

export async function attestModel(model: string, opts: AttestOptions): Promise<AttestationRound> {
  const nonce = randomHex32();
  const reportBytes = await fetchReport(opts.baseUrl, model, nonce, opts.fetchImpl);
  const raw = JSON.parse(new TextDecoder().decode(reportBytes)) as RawReport;
  const policy = { acceptedTcbStatuses: [...opts.acceptedTcbStatuses] as TcbStatus[], gpuEvidence: 'required' as const };
  const observedAtMs = (opts.now ?? Date.now)();
  const verify = opts.verify ?? verifyModelAttestation;
  const keys = await Promise.all(
    selectModelAttestations(raw, model).map(async (selected): Promise<AttestedKey> => {
      try {
        // The SDK checks that this nonce is what the TEE signed over; a replayed report fails here.
        // Intel's collateral service sometimes rejects the request (`quote.collateral_unavailable`, 2 of 3 dry runs on Nov 7):
        // the SDK marks such failures retryable and the next try went through, so a round is not lost over one.
        // The deadline is per replica: a hung one is reported as failed and does not hide the ones that verified.
        const attestation = toModelAttestation(selected) as ModelAttestation;
        const verifying = withRetry(() => verify({ attestation, clientBinding: { nonce }, policy }), { retryable: sdkRetryable });
        const verified = await withDeadline(verifying, VERIFY_TIMEOUT_MS, 'verification of the attestation');
        // What the enclave deployed behind this key, followed to public sources. Whatever goes wrong there (GitHub's rate
        // limit, a check that does not hold, the deadline), the key and its launcher are logged as before, without marks.
        const release = opts.release && (await withDeadline(opts.release(model, verified), RELEASE_TIMEOUT_MS, 'the release check').catch((err: unknown) => ({ marks: [], why: err instanceof Error ? err.message : String(err) })));
        const entry = buildKeyEntryInput({ model, verified, reportBytes, observedAtMs, ...(release ? { marks: release.marks } : {}) });
        const unmarked = release && marksOf(entry.image_digests).logs.length === 0 ? (release.why ?? 'the marks do not fit the entry') : undefined;
        return { ok: true, verified, entry, ...(unmarked ? { unmarked } : {}) };
      } catch (err) {
        return { ok: false, signingAddress: selected.signing_address, error: err instanceof Error ? err.message : String(err) };
      }
    }),
  );
  // The report is kept on disk even when nothing verified, so the failure can be inspected later.
  return { model, nonce, reportBytes, reportHash: sha256Hex(reportBytes), keys };
}

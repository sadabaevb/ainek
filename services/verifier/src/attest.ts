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
import { verifyModelAttestation, type ModelAttestation, type TcbStatus, type VerifiedModelAttestation } from '@nearai/inference-sdk/node';
import { buildKeyEntryInput, randomHex32, sha256Hex, toModelAttestation, type KeyEntryInput, type RawReport } from '@ainek/proof';

type RawModelAttestation = RawReport['model_attestations'][number];

export type AttestedKey = { ok: true; verified: VerifiedModelAttestation; entry: KeyEntryInput } | { ok: false; signingAddress: string; error: string };

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
}

export async function fetchReport(baseUrl: string, model: string, nonce: string, fetchImpl: typeof fetch = fetch): Promise<Uint8Array> {
  const url = `${baseUrl}/attestation/report?model=${encodeURIComponent(model)}&signing_algo=ed25519&nonce=${nonce}`;
  // `x-no-aliasing: true` (CLAUDE.md): the gateway must answer for exactly this model id, never an alias of it,
  // otherwise a neighbouring deployment's key could end up in the log under this model's name.
  const res = await fetchImpl(url, {
    headers: { Accept: 'application/json', 'Accept-Encoding': 'identity', 'x-no-aliasing': 'true' },
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
  const keys = await Promise.all(
    selectModelAttestations(raw, model).map(async (selected): Promise<AttestedKey> => {
      try {
        // The SDK checks that this nonce is what the TEE signed over; a replayed report fails here.
        const verified = await verifyModelAttestation({ attestation: toModelAttestation(selected) as ModelAttestation, clientBinding: { nonce }, policy });
        return { ok: true, verified, entry: buildKeyEntryInput({ model, verified, reportBytes, observedAtMs }) };
      } catch (err) {
        return { ok: false, signingAddress: selected.signing_address, error: err instanceof Error ? err.message : String(err) };
      }
    }),
  );
  // The report is kept on disk even when nothing verified, so the failure can be inspected later.
  return { model, nonce, reportBytes, reportHash: sha256Hex(reportBytes), keys };
}

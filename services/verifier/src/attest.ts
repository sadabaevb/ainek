// One attestation round for one model: fresh nonce → raw `/v1/attestation/report` bytes → the SDK's own
// verification (Intel DCAP with live collateral, NVIDIA NRAS, nonce and signer bound in the TDX report data,
// app_compose vs MRCONFIGID, RTMR3 replay) → KeyEntryInput (SPEC §4.1).
//
// We fetch the report ourselves rather than through the SDK's AttestationClient because the log entry carries
// `report_hash = sha256(exact report bytes)` and the client classes do not expose those bytes. The endpoint is
// public: no API key is needed to re-attest, which is the point of an independent verifier.
import { randomBytes } from 'node:crypto';
import { verifyModelAttestation, type ModelAttestation, type TcbStatus, type VerifiedModelAttestation } from '@nearai/inference-sdk/node';
import { buildKeyEntryInput, toModelAttestation, type KeyEntryInput, type RawReport } from '@ainek/proof';

export interface AttestationRound {
  model: string;
  nonce: string;
  reportBytes: Uint8Array;
  verified: VerifiedModelAttestation;
  entry: KeyEntryInput;
}

export interface AttestOptions {
  baseUrl: string;
  acceptedTcbStatuses: readonly string[];
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export async function fetchReport(baseUrl: string, model: string, nonce: string, fetchImpl: typeof fetch = fetch): Promise<Uint8Array> {
  const url = `${baseUrl}/attestation/report?model=${encodeURIComponent(model)}&signing_algo=ed25519&nonce=${nonce}`;
  const res = await fetchImpl(url, { headers: { Accept: 'application/json', 'Accept-Encoding': 'identity' }, signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`attestation report for ${model}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Picks the report's entry for `model` with an E2EE key (the one the client pins), or fails. */
export function selectModelAttestation(raw: RawReport, model: string): RawReport['model_attestations'][number] {
  const forModel = raw.model_attestations.filter((m) => m.model_name === model);
  if (forModel.length === 0) throw new Error(`report carries no model_attestations for ${model}`);
  const withKey = forModel.find((m) => m.signing_public_key !== undefined) ?? forModel[0];
  return withKey as RawReport['model_attestations'][number];
}

export async function attestModel(model: string, opts: AttestOptions): Promise<AttestationRound> {
  const nonce = randomBytes(32).toString('hex');
  const reportBytes = await fetchReport(opts.baseUrl, model, nonce, opts.fetchImpl);
  const raw = JSON.parse(new TextDecoder().decode(reportBytes)) as RawReport;
  const selected = selectModelAttestation(raw, model);
  // The SDK checks that this nonce is what the TEE signed over; a replayed report fails here.
  const verified = await verifyModelAttestation({
    attestation: toModelAttestation(selected) as ModelAttestation,
    clientBinding: { nonce },
    policy: { acceptedTcbStatuses: [...opts.acceptedTcbStatuses] as TcbStatus[], gpuEvidence: 'required' },
  });
  const entry = buildKeyEntryInput({ model, verified, reportBytes, observedAtMs: (opts.now ?? Date.now)() });
  return { model, nonce, reportBytes, verified, entry };
}

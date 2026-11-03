// Loads the recording in docs/samples. Everything here is public: attestation reports, Intel collateral,
// NVIDIA's verdict and keys, the raw bytes of one chat and its signature. No API key anywhere.
import { readFileSync } from 'node:fs';
import type { KeyEntry, ModelProof } from '@ainek/proof';

const samplesDir = new URL('../../../docs/samples/', import.meta.url);

export function readBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(name, samplesDir)));
}
export function readText(name: string): string {
  return readFileSync(new URL(name, samplesDir), 'utf8');
}
export function readJson<T>(name: string): T {
  return JSON.parse(readText(name)) as T;
}

/** The fields of the raw `/v1/attestation/report` reply that the replay uses (shape as received, snake_case). */
export interface RawAttestation {
  signing_address: string;
  signing_algo: 'ed25519' | 'ecdsa';
  signing_public_key?: string;
  request_nonce: string;
  intel_quote: string;
  event_log: string | unknown[];
  report_data?: string;
  nvidia_payload?: string;
  info: { tcb_info: { app_compose: string; compose_hash: string } };
  compose_manager_attestation?: {
    actions: unknown;
    actions_hash: string;
    nonce: string;
    quote: string;
    event_log: string | unknown[];
    report_data: string;
  };
}
export interface RawReport {
  gateway_attestation: RawAttestation;
  model_attestations: Array<RawAttestation & { model_name: string }>;
}
export interface ReplayManifest {
  reportCapturedAt: string;
  evidenceRecordedAt: string;
  nowSecs: number;
  nras: { iat: number; exp: number; kid: string };
  quotes: Record<string, string>;
}
export interface SignatureFile {
  text: string;
  signature: string;
  signing_address: string;
  signing_algo: 'ed25519' | 'ecdsa';
  signature_kind: 'provider_tee' | 'gateway';
}

export interface Recording {
  report: RawReport;
  manifest: ReplayManifest;
  collateralByQuote: Record<string, unknown>;
  nrasResponse: string;
  jwks: unknown;
  rawRequest: Uint8Array;
  rawResponse: Uint8Array;
  signature: SignatureFile;
  logEntry: KeyEntry;
  proof: ModelProof;
}

export function loadRecording(): Recording {
  return {
    report: readJson<RawReport>('attestation-report.json'),
    manifest: readJson<ReplayManifest>('replay-manifest.json'),
    collateralByQuote: readJson<{ byQuoteSha256: Record<string, unknown> }>('intel-collateral.json').byQuoteSha256,
    nrasResponse: readText('nras-response.json'),
    jwks: readJson<unknown>('nvidia-jwks.json'),
    rawRequest: readBytes('chat-request.raw.json'),
    rawResponse: readBytes('chat-response.raw.json'),
    signature: readJson<SignatureFile>('signature.json'),
    logEntry: readJson<{ entry: KeyEntry }>('key-entry.sample.json').entry,
    proof: readJson<{ proof: ModelProof }>('model-proof.sample.json').proof,
  };
}

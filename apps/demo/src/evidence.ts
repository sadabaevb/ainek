// Loads the recording in docs/samples. Everything here is public: attestation reports, Intel collateral,
// NVIDIA's verdict and keys, the raw bytes of one chat and its signature. No API key anywhere.
import { readFileSync } from 'node:fs';
import type { KeyEntry, ModelProof, RawReport } from '@ainek/proof';

export type { RawReport } from '@ainek/proof';

export const samplesDir = new URL('../../../docs/samples/', import.meta.url);

export function readBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(name, samplesDir)));
}
export function readText(name: string): string {
  return readFileSync(new URL(name, samplesDir), 'utf8');
}
export function readJson<T>(name: string): T {
  return JSON.parse(readText(name)) as T;
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
  logEntry: KeyEntry;
  /** Recorded exchanges, oldest first: the plaintext one from Nov 2 and the E2EE one from Nov 3. */
  exchanges: RecordedExchange[];
}

export interface RecordedExchange {
  label: string;
  rawRequest: Uint8Array;
  rawResponse: Uint8Array;
  signature: SignatureFile;
  proof: ModelProof;
  /** Present for the E2EE exchange only: what the recording client sent and decrypted; not covered by the proof. */
  plaintext?: { prompt: string; reply: string; recordedAt: string };
}

/** Entry #0 of the public log, recorded from the chain (docs/samples/key-entry.sample.json). */
export function loadSampleLogEntry(): KeyEntry {
  return readJson<{ entry: KeyEntry }>('key-entry.sample.json').entry;
}

function e2eeExchange(): RecordedExchange {
  const plaintext = readJson<{ prompt: string; reply: string; recordedAt: string }>('e2ee-plaintext.json');
  return {
    label: `E2EE exchange (recorded ${plaintext.recordedAt.slice(0, 10)})`,
    rawRequest: readBytes('e2ee-chat-request.raw.json'),
    rawResponse: readBytes('e2ee-chat-response.raw.json'),
    signature: readJson<SignatureFile>('e2ee-signature.json'),
    proof: readJson<{ proof: ModelProof }>('model-proof-e2ee.sample.json').proof,
    plaintext,
  };
}

export function loadRecording(): Recording {
  return {
    report: readJson<RawReport>('attestation-report.json'),
    manifest: readJson<ReplayManifest>('replay-manifest.json'),
    collateralByQuote: readJson<{ byQuoteSha256: Record<string, unknown> }>('intel-collateral.json').byQuoteSha256,
    nrasResponse: readText('nras-response.json'),
    jwks: readJson<unknown>('nvidia-jwks.json'),
    logEntry: loadSampleLogEntry(),
    exchanges: [
      {
        label: 'plaintext exchange (recorded 2026-11-02)',
        rawRequest: readBytes('chat-request.raw.json'),
        rawResponse: readBytes('chat-response.raw.json'),
        signature: readJson<SignatureFile>('signature.json'),
        proof: readJson<{ proof: ModelProof }>('model-proof.sample.json').proof,
      },
      e2eeExchange(),
    ],
  };
}

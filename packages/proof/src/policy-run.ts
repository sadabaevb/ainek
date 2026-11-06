// Which code made a policy decision? The signature says only which key signed, and OutLayer's "one build only" lock is an
// access rule its owner can move (SPEC §3.5). What ties a decision to a build is the run's attestation: a TDX quote whose
// report data commits to the hash of the code that ran and of what it printed. This re-checks that chain: the decision is
// the run's output, the run is the published build, the quote commits to both, Intel signed the quote, and the worker is
// one OutLayer's contract approves. Nothing here trusts OutLayer's own "verified" flag.
import { z } from 'zod';
import { canonicalJson } from './canonical.ts';
import { base64ToBytes } from './disclosure.ts';
import { bytesToHex, concatBytes, sha256Hex, shortHex as short, utf8Bytes } from './hash.ts';
import { viewFunction } from './near-view.ts';
import type { PolicyOutput } from './policy.ts';
import { hex64 } from './schema.ts';
import type { Check } from './verify.ts';

/** What `GET /attestations/...` answers. Fields we do not use are left alone. */
export const PolicyRun = z.looseObject({
  task_type: z.string(),
  task_id: z.number().int(),
  tdx_quote: z.string().min(1),
  worker_measurement: z.string(),
  repo_url: z.string().nullish(),
  commit_hash: z.string().nullish(),
  build_target: z.string(),
  wasm_hash: hex64,
  executed_wasm_sha256: hex64,
  input_hash: hex64,
  output_hash: hex64,
  block_height: z.number().int(),
  caller_account_id: z.string(),
  project_id: z.string().nullish(),
  secrets_ref: z.string().nullish(),
  timestamp: z.number().int(),
  attached_usd: z.union([z.string(), z.number()]).nullish(),
});
export type PolicyRun = z.infer<typeof PolicyRun>;

export interface Measurements {
  mrtd: string;
  rtmr0: string;
  rtmr1: string;
  rtmr2: string;
  rtmr3: string;
}

/** A quote whose signature chain up to Intel has been verified; `reportData` and the measurements are read from it, as hex. */
export interface VerifiedQuote {
  tcbStatus: string;
  reportData: string;
  measurements: Measurements;
}

/** Verifies a quote against Intel's collateral as of a moment (DCAP); throws when it does not verify. Injected, so this package stays free of a DCAP library. */
export type QuoteVerifier = (quote: Uint8Array, collateral: unknown, atSeconds: number) => VerifiedQuote;

const le64 = (value: number): Uint8Array => {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigInt64(0, BigInt(value), true);
  return bytes;
};

/**
 * What OutLayer's worker puts in the quote's report data. Text fields are their UTF-8 bytes, hashes their hex text. The layout
 * comes from OutLayer's dashboard code (DEV-NOTES 2026-11-04) and is checked against real quotes in the tests.
 */
export function taskHashOf(run: PolicyRun): string {
  const text = (value: string | number | null | undefined): Uint8Array => utf8Bytes(value === null || value === undefined ? '' : String(value));
  return sha256Hex(
    concatBytes(
      text(run.task_type),
      le64(run.task_id),
      text(run.repo_url),
      text(run.commit_hash),
      text(run.build_target),
      text(run.wasm_hash),
      text(run.input_hash),
      text(run.output_hash),
      le64(run.block_height),
      text(run.caller_account_id),
      text(run.project_id),
      text(run.secrets_ref),
      le64(run.timestamp),
      text(run.attached_usd),
    ),
  );
}

/** Intel's platform id, from the first certificate in the quote: it says which collateral to ask for. Only chooses what to fetch: a wrong one cannot pass the signature check. */
export function fmspcOf(quote: Uint8Array): string | null {
  const pem = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/.exec(new TextDecoder('latin1').decode(quote));
  if (!pem) return null;
  const der = base64ToBytes((pem[1] ?? '').replace(/\s+/g, ''));
  const oid = [0x06, 0x0a, 0x2a, 0x86, 0x48, 0x86, 0xf8, 0x4d, 0x01, 0x0d, 0x01, 0x04]; // 1.2.840.113741.1.13.1.4, FMSPC
  for (let i = 0; i + oid.length + 8 <= der.length; i++) {
    if (oid.every((byte, j) => der[i + j] === byte)) return bytesToHex(der.slice(i + oid.length + 2, i + oid.length + 8));
  }
  return null;
}

/** The job's stdout for a parsed output: the job prints canonical JSON, so this reproduces the bytes `output_hash` covers. */
export const policyOutputText = (output: PolicyOutput): string => canonicalJson(output);

export interface PolicyRunEvidence {
  run: PolicyRun;
  /** The job's stdout: the decision being checked. */
  output: string;
  /** The published build (`docs/DEPLOY.md`, or rebuild it with `scripts/wasm-hash.sh`). */
  wasmHash: string;
  project?: string;
  /** Undefined when no verifier ran; `error` when the quote did not verify. */
  quote?: VerifiedQuote | { error: string };
  /** `is_measurements_approved` on OutLayer's contract; null when it could not be read. */
  measurementsApproved?: boolean | null;
}

export function checkPolicyRun({ run, output, wasmHash, project, quote, measurementsApproved }: PolicyRunEvidence): Check[] {
  const buildOk = run.wasm_hash === wasmHash && run.executed_wasm_sha256 === wasmHash;
  const projectOk = project === undefined || run.project_id === project;
  const verified = quote && !('error' in quote) ? quote : null;
  const wantedReportData = `${taskHashOf(run)}${'0'.repeat(64)}`;
  const checks: Check[] = [
    {
      id: 'run-build',
      status: buildOk && projectOk ? 'ok' : 'fail',
      detail: !buildOk ? `the run executed ${short(run.executed_wasm_sha256)}, not the published build ${short(wasmHash)}` : !projectOk ? `the run belongs to ${String(run.project_id)}, not to ${project}` : `the run executed the published build ${short(wasmHash)}`,
    },
    { id: 'run-output', status: sha256Hex(output) === run.output_hash ? 'ok' : 'fail', detail: sha256Hex(output) === run.output_hash ? 'this decision is what the run printed' : 'this decision is not what the run printed' },
    quote === undefined
      ? { id: 'run-quote', status: 'skipped', detail: 'the TDX quote was not verified' }
      : 'error' in quote
        ? { id: 'run-quote', status: 'fail', detail: `the TDX quote did not verify: ${quote.error}` }
        : { id: 'run-quote', status: quote.tcbStatus === 'UpToDate' ? 'ok' : 'fail', detail: `Intel signature chain verifies; TCB ${quote.tcbStatus} at the time of the run` },
    verified
      ? { id: 'run-binding', status: verified.reportData === wantedReportData ? 'ok' : 'fail', detail: verified.reportData === wantedReportData ? 'the quote commits to this build, this input and this output' : 'the quote does not commit to these hashes' }
      : { id: 'run-binding', status: 'skipped', detail: 'without a verified quote, its report data proves nothing' },
    !verified || measurementsApproved === null || measurementsApproved === undefined
      ? { id: 'run-worker', status: 'skipped', detail: 'OutLayer\'s list of approved workers was not checked' }
      : measurementsApproved && verified.measurements.rtmr3 === run.worker_measurement
        ? { id: 'run-worker', status: 'ok', detail: 'the worker\'s measurements are approved on OutLayer\'s contract' }
        : { id: 'run-worker', status: 'fail', detail: 'the worker\'s measurements are not approved on OutLayer\'s contract' },
  ];
  return checks;
}

/** The same checks with the network parts done: Intel's collateral as OutLayer archived it for the run's moment, and OutLayer's list of approved workers. */
export async function verifyPolicyRun(x: { run: PolicyRun; output: string; wasmHash: string; project?: string; apiUrl: string; rpcUrl: string; network: 'testnet' | 'mainnet'; verifyQuote: QuoteVerifier; fetch?: typeof fetch }): Promise<Check[]> {
  const { run, output, wasmHash, project } = x;
  const f = x.fetch ?? fetch;
  let quote: VerifiedQuote | { error: string };
  try {
    const bytes = base64ToBytes(run.tdx_quote);
    const fmspc = fmspcOf(bytes);
    if (!fmspc) throw new Error('the quote names no Intel platform');
    const res = await f(`${x.apiUrl}/public/collateral?fmspc=${fmspc}&at=${run.timestamp}`);
    if (!res.ok) throw new Error(`Intel collateral for ${fmspc}: HTTP ${res.status}`);
    const body = (await res.json()) as { collateral: string };
    quote = x.verifyQuote(bytes, JSON.parse(body.collateral), run.timestamp);
  } catch (err) {
    quote = { error: err instanceof Error ? err.message : String(err) };
  }
  let measurementsApproved: boolean | null = null;
  if (!('error' in quote)) {
    const worker = x.network === 'mainnet' ? 'worker.outlayer.near' : 'worker.outlayer.testnet';
    measurementsApproved = await viewFunction(x.rpcUrl, worker, 'is_measurements_approved', { measurements: quote.measurements }).then((v) => v === true, () => null);
  }
  return checkPolicyRun({ run, output, wasmHash, ...(project === undefined ? {} : { project }), quote, measurementsApproved });
}

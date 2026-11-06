// Which code made a policy decision? The signature says only which key signed, and OutLayer's "one build only" lock is an
// access rule its owner can move (SPEC §3.5). What ties a decision to a build is the run's attestation: a TDX quote whose
// report data commits to the hash the worker gives for the code and to what the job printed. This re-checks that chain: the
// decision is the run's output, the record names the published build, the quote commits to both under our project and its
// owner, Intel signed the quote, and the worker is one OutLayer's contract approves. Nothing here trusts OutLayer's own
// "verified" flag.
import { z } from 'zod';
import { base64ToBytes } from './disclosure.ts';
import { bytesToHex, concatBytes, sha256Hex, shortHex as short, utf8Bytes } from './hash.ts';
import { viewFunction } from './near-view.ts';
import { check } from './policy.ts';
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
  // Absent on a run made over HTTPS (`/attestations/by-call/...`): it has no transaction of its own.
  block_height: z.number().int().nullish(),
  caller_account_id: z.string().nullish(),
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
  advisoryIds: string[];
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

/** The fields of a record that the quote's report data covers. */
type HashedFields = Pick<PolicyRun, 'task_type' | 'task_id' | 'repo_url' | 'commit_hash' | 'build_target' | 'wasm_hash' | 'input_hash' | 'output_hash' | 'block_height' | 'caller_account_id' | 'project_id' | 'secrets_ref' | 'timestamp' | 'attached_usd'>;

/**
 * What OutLayer's worker puts in the quote's report data. Text fields are their UTF-8 bytes, hashes their hex text. The layout
 * comes from OutLayer's dashboard code (DEV-NOTES 2026-11-04) and is checked against real quotes in the tests. A run made over
 * HTTPS has no block height, and the worker then leaves the field out of the hash instead of hashing a zero (found on the first
 * real by-call records, DEV-NOTES 2026-11-06).
 */
export function taskHashOf(run: HashedFields): string {
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
      ...(run.block_height === null || run.block_height === undefined ? [] : [le64(run.block_height)]),
      text(run.caller_account_id),
      text(run.project_id),
      text(run.secrets_ref),
      le64(run.timestamp),
      text(run.attached_usd),
    ),
  );
}

/** The secrets a run of our job has to read: its policy and signing key, in the project owner's profile (docs/DEPLOY.md). The agent asks for exactly this. */
export function policySecretsRef(project: string): { profile: string; account_id: string } {
  return { profile: 'default', account_id: project.split('/')[0] ?? '' };
}

/**
 * The record this decision has to come from. The worker hashes its text fields one after another with no separators, so the same bytes can
 * be cut into fields in another way (DEV-NOTES 2026-11-06), and what a record says cannot be trusted field by field. So the text fields come
 * from what we already know: the published build, the hashes of this input and output, our project, called by its owner with its secrets.
 * The record supplies only the fixed-width fields and the last one. A height could stand in for the start of a caller only if that caller
 * held NUL bytes, which no NEAR account does.
 */
function expectedRun(run: PolicyRun, { wasmHash, input, output, project }: Pick<PolicyRunEvidence, 'wasmHash' | 'input' | 'output' | 'project'>): HashedFields {
  const { profile, account_id: owner } = policySecretsRef(project);
  return {
    task_type: 'execute',
    task_id: run.task_id,
    repo_url: null,
    commit_hash: null,
    build_target: 'wasm32-wasip1',
    wasm_hash: wasmHash,
    input_hash: input === null ? run.input_hash : sha256Hex(input),
    output_hash: sha256Hex(output),
    block_height: run.block_height,
    caller_account_id: owner,
    project_id: project,
    secrets_ref: `${owner}/${profile}`,
    timestamp: run.timestamp,
    attached_usd: run.attached_usd,
  };
}

/** Two failures with different meanings: the record is not what the quote covers, or it is, and it is a run other than the one this decision needs. */
function bindingCheck(run: PolicyRun, expected: HashedFields, reportData: string, inputKnown: boolean): Check {
  const commitsTo = (r: HashedFields): boolean => reportData === `${taskHashOf(r)}${'0'.repeat(64)}`;
  if (!commitsTo(run)) return check('run-binding', false, '', 'the quote does not commit to this record');
  const differing = (Object.keys(expected) as Array<keyof HashedFields>).filter((field) => (run[field] ?? null) !== (expected[field] ?? null));
  return check('run-binding', commitsTo(expected), `the quote commits to this build, ${inputKnown ? 'this input and this output' : 'and this output'}, under this project and its owner`, `the quote commits to a run that differs from what this decision needs in: ${differing.join(', ')}`);
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

export interface PolicyRunEvidence {
  run: PolicyRun;
  /** The job's stdout: the decision being checked. */
  output: string;
  /** The stdin the caller sent, canonical JSON. Without this check a real run on a false `spent_today` would pass. Null when re-checking later from a proof, which does not carry it: the contract recomputed the daily total itself. */
  input: string | null;
  /** The published build (`docs/DEPLOY.md`, or rebuild it with `scripts/wasm-hash.sh`). */
  wasmHash: string;
  project: string;
  /** When money is about to move: a quote is judged at the run's own moment, so an old run must not pass as a new one. */
  freshness?: { nowSeconds: number; maxAgeSeconds: number };
  /** Undefined when no verifier ran; `error` when the quote did not verify. */
  quote?: VerifiedQuote | { error: string };
  /** `is_measurements_approved` on OutLayer's contract; null when it could not be read. */
  measurementsApproved?: boolean | null;
}

/** What `verify` from @phala/dcap-qvl returns, as far as we read it. */
interface DcapResult {
  status: string;
  advisory_ids: string[];
  report: { asTd10(): { reportData: Uint8Array; mrTd: Uint8Array; rtMr0: Uint8Array; rtMr1: Uint8Array; rtMr2: Uint8Array; rtMr3: Uint8Array } | null | undefined };
}

/** Turns dcap-qvl's `verify` into a `QuoteVerifier`. Node and the browser hand in their own import, so this package stays free of the library. */
export function quoteVerifierOf<C>(verify: (quote: Uint8Array, collateral: C, atSeconds: number) => DcapResult): QuoteVerifier {
  return (quote, collateral, atSeconds) => {
    const verified = verify(quote, collateral as C, atSeconds);
    const td = verified.report.asTd10();
    if (!td) throw new Error('the quote is not a TD10 report');
    return {
      tcbStatus: verified.status,
      advisoryIds: verified.advisory_ids,
      reportData: bytesToHex(td.reportData),
      measurements: { mrtd: bytesToHex(td.mrTd), rtmr0: bytesToHex(td.rtMr0), rtmr1: bytesToHex(td.rtMr1), rtmr2: bytesToHex(td.rtMr2), rtmr3: bytesToHex(td.rtMr3) },
    };
  };
}

/** A verifier that throws means the quote did not verify, which is a result, not a crash. */
export function tryVerifyQuote(verify: QuoteVerifier, quote: Uint8Array, collateral: unknown, atSeconds: number): VerifiedQuote | { error: string } {
  try {
    return verify(quote, collateral, atSeconds);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export function checkPolicyRun({ run, output, input, wasmHash, project, freshness, quote, measurementsApproved }: PolicyRunEvidence): Check[] {
  const buildOk = run.wasm_hash === wasmHash && run.executed_wasm_sha256 === wasmHash;
  const verified = quote && !('error' in quote) ? quote : null;
  const advisories = verified?.advisoryIds.length ? ` (advisories: ${verified.advisoryIds.join(', ')})` : '';
  const measurementOk = verified?.measurements.rtmr3 === run.worker_measurement;
  return [
    run.project_id !== project
      ? check('run-build', false, '', `the run belongs to ${String(run.project_id)}, not to ${project}`)
      : check('run-build', buildOk, `the record names the published build ${short(wasmHash)}`, `the record names ${short(run.executed_wasm_sha256)}, not the published build ${short(wasmHash)}`),
    input === null ? { id: 'run-input', status: 'skipped', detail: 'this proof does not carry the job input; the contract recomputed the daily total itself' } : check('run-input', sha256Hex(input) === run.input_hash, 'the run decided on this input', 'the run decided on a different input'),
    check('run-output', sha256Hex(output) === run.output_hash, 'this decision is what the run printed', 'this decision is not what the run printed'),
    ...(freshness ? [check('run-fresh', run.timestamp <= freshness.nowSeconds + 120 && freshness.nowSeconds - run.timestamp <= freshness.maxAgeSeconds, 'the run happened just now', `the run is from ${run.timestamp} (unix seconds), not from just now (${freshness.nowSeconds})`)] : []),
    verified
      ? check('run-quote', verified.tcbStatus === 'UpToDate', `Intel signature chain verifies; TCB ${verified.tcbStatus} at the time of the run${advisories}`, `Intel signature chain verifies, but TCB is ${verified.tcbStatus} at the time of the run${advisories}`)
      : quote
        ? check('run-quote', false, '', `the TDX quote did not verify: ${'error' in quote ? quote.error : ''}`)
        : { id: 'run-quote', status: 'skipped', detail: 'the TDX quote was not verified' },
    verified
      ? bindingCheck(run, expectedRun(run, { wasmHash, input, output, project }), verified.reportData, input !== null)
      : { id: 'run-binding', status: 'skipped', detail: 'without a verified quote, its report data proves nothing' },
    verified && typeof measurementsApproved === 'boolean'
      ? !measurementOk
        ? check('run-worker', false, '', "the attestation names a different worker measurement than the quote")
        : check('run-worker', measurementsApproved, "the worker's measurements are on OutLayer's approved list", "the worker's measurements are not on OutLayer's approved list")
      : { id: 'run-worker', status: 'skipped', detail: "OutLayer's list of approved workers was not checked" },
  ];
}

/**
 * The same checks with the network parts done: Intel's collateral as OutLayer archived it for the run's moment, and OutLayer's list of approved
 * workers. A verdict comes back as checks; an outage throws, because "could not check" is a different thing to tell someone than "does not verify".
 */
export async function verifyPolicyRun({ apiUrl, rpcUrl, network, verifyQuote, fetch: f = fetch, signal, ...evidence }: Omit<PolicyRunEvidence, 'quote' | 'measurementsApproved'> & { apiUrl: string; rpcUrl: string; network: 'testnet' | 'mainnet'; verifyQuote: QuoteVerifier; fetch?: typeof fetch; signal?: AbortSignal }): Promise<Check[]> {
  const { run } = evidence;
  const quote = await verifiedQuoteOf(run, apiUrl, verifyQuote, f, signal);
  if ('error' in quote) return checkPolicyRun({ ...evidence, quote });
  const worker = network === 'mainnet' ? 'worker.outlayer.near' : 'worker.outlayer.testnet';
  const approved = await viewFunction(rpcUrl, worker, 'is_measurements_approved', { measurements: quote.measurements }, signal);
  return checkPolicyRun({ ...evidence, quote, measurementsApproved: approved === true });
}

async function verifiedQuoteOf(run: PolicyRun, apiUrl: string, verifyQuote: QuoteVerifier, f: typeof fetch, signal?: AbortSignal): Promise<VerifiedQuote | { error: string }> {
  let bytes: Uint8Array;
  let fmspc: string | null;
  try {
    bytes = base64ToBytes(run.tdx_quote);
    fmspc = fmspcOf(bytes);
  } catch {
    return { error: 'the quote cannot be read' };
  }
  if (!fmspc) return { error: 'the quote names no Intel platform' };
  const res = await f(`${apiUrl}/public/collateral?fmspc=${fmspc}&at=${run.timestamp}`, { redirect: 'error', ...(signal ? { signal } : {}) });
  if (!res.ok) throw new Error(`Intel collateral for platform ${fmspc}: HTTP ${res.status}`);
  const { collateral } = (await res.json()) as { collateral: string };
  return tryVerifyQuote(verifyQuote, bytes, JSON.parse(collateral), run.timestamp);
}

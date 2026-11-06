// Which code made a policy decision? The signature says only which key signed, and OutLayer's "one build only" lock is an
// access rule its owner can move (SPEC §3.5). What ties a decision to a build is the run's attestation: a TDX quote whose
// report data commits to the hash of the code that ran and of what it printed. This re-checks that chain: the decision is
// the run's output, the run is the published build, the quote commits to both, Intel signed the quote, and the worker is
// one OutLayer's contract approves. Nothing here trusts OutLayer's own "verified" flag.
import { z } from 'zod';
import { base64ToBytes } from './disclosure.ts';
import { bytesToHex, concatBytes, sha256Hex, shortHex as short, utf8Bytes } from './hash.ts';
import { viewFunction } from './near-view.ts';
import { check } from './policy.ts';
import { hex64 } from './schema.ts';
import { NEAR_ACCOUNT } from './trust-set.ts';
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

/**
 * What OutLayer's worker puts in the quote's report data. Text fields are their UTF-8 bytes, hashes their hex text. The layout
 * comes from OutLayer's dashboard code (DEV-NOTES 2026-11-04) and is checked against real quotes in the tests. A run made over
 * HTTPS has no block height, and the worker then leaves the field out of the hash instead of hashing a zero (found on the first
 * real by-call records, DEV-NOTES 2026-11-06).
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
      ...(run.block_height === null || run.block_height === undefined ? [] : [le64(run.block_height)]),
      text(run.caller_account_id),
      text(run.project_id),
      text(run.secrets_ref),
      le64(run.timestamp),
      text(run.attached_usd),
    ),
  );
}

/** `<account>/<name>`, the form of `project_id` and `secrets_ref`. */
const isOwnedName = (value: string): boolean => {
  const [owner, name, ...rest] = value.split('/');
  return rest.length === 0 && NEAR_ACCOUNT.test(owner ?? '') && /^[A-Za-z\d._-]{1,64}$/.test(name ?? '');
};

/**
 * The worker hashes its text fields one after another with no separators, so the same bytes can be cut into fields in another way:
 * a run of other code that carried the published hashes in `commit_hash` could be rewritten to name them, with the rest moved into
 * the caller field. So only the form of a real run passes. The fixed fields put the hashes right after the build target, and the
 * fields after them cannot hold another run's three hashes (192 hex digits): an account takes 64 characters and `/` breaks a run of hex.
 */
function formProblem(run: PolicyRun): string | null {
  if (run.task_type !== 'execute') return `task_type is ${JSON.stringify(run.task_type)}`;
  if (run.repo_url || run.commit_hash) return 'it names a repository, and a run of a published build names none';
  if (run.build_target !== 'wasm32-wasip1') return `build_target is ${JSON.stringify(run.build_target)}`;
  if (run.caller_account_id && !NEAR_ACCOUNT.test(run.caller_account_id)) return 'caller_account_id is not a NEAR account';
  if (run.project_id && !isOwnedName(run.project_id)) return 'project_id is not <account>/<name>';
  if (run.secrets_ref && !isOwnedName(run.secrets_ref)) return 'secrets_ref is not <account>/<name>';
  if (run.attached_usd !== null && run.attached_usd !== undefined && !/^\d+(\.\d+)?$/.test(String(run.attached_usd))) return 'attached_usd is not an amount';
  return null;
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
  /** The stdin the caller sent, canonical JSON. Without this check a real run on a false `spent_today` would pass. */
  input: string;
  /** The published build (`docs/DEPLOY.md`, or rebuild it with `scripts/wasm-hash.sh`). */
  wasmHash: string;
  project?: string;
  /** When money is about to move: a quote is judged at the run's own moment, so an old run must not pass as a new one. */
  freshness?: { nowSeconds: number; maxAgeSeconds: number };
  /** Undefined when no verifier ran; `error` when the quote did not verify. */
  quote?: VerifiedQuote | { error: string };
  /** `is_measurements_approved` on OutLayer's contract; null when it could not be read. */
  measurementsApproved?: boolean | null;
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
  const form = formProblem(run);
  return [
    project !== undefined && run.project_id !== project
      ? check('run-build', false, '', `the run belongs to ${String(run.project_id)}, not to ${project}`)
      : check('run-build', buildOk, `the run executed the published build ${short(wasmHash)}`, `the run executed ${short(run.executed_wasm_sha256)}, not the published build ${short(wasmHash)}`),
    check('run-input', sha256Hex(input) === run.input_hash, 'the run decided on this input', 'the run decided on a different input'),
    check('run-output', sha256Hex(output) === run.output_hash, 'this decision is what the run printed', 'this decision is not what the run printed'),
    ...(freshness ? [check('run-fresh', run.timestamp <= freshness.nowSeconds + 120 && freshness.nowSeconds - run.timestamp <= freshness.maxAgeSeconds, 'the run happened just now', `the run is from ${run.timestamp} (unix seconds), not from just now (${freshness.nowSeconds})`)] : []),
    verified
      ? check('run-quote', verified.tcbStatus === 'UpToDate', `Intel signature chain verifies; TCB ${verified.tcbStatus} at the time of the run${advisories}`, `Intel signature chain verifies, but TCB is ${verified.tcbStatus} at the time of the run${advisories}`)
      : quote
        ? check('run-quote', false, '', `the TDX quote did not verify: ${'error' in quote ? quote.error : ''}`)
        : { id: 'run-quote', status: 'skipped', detail: 'the TDX quote was not verified' },
    verified
      ? check('run-binding', form === null && verified.reportData === `${taskHashOf(run)}${'0'.repeat(64)}`, 'the quote commits to this build, this input and this output', form ? `this record is not in the form of a real run: ${form}` : 'the quote does not commit to these hashes')
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

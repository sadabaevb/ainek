// Read-only NEAR view calls over plain JSON-RPC (global fetch, no SDK), enough for the key log (SPEC §4.1 views) and the
// proof commits (SPEC §4.2). Shared by the web client, the demo and the verifier so the ABI call shapes live in one place.
import { z } from 'zod';
import { withRetry } from './retry.ts';
import { bytesToBase64 } from './disclosure.ts';
import { KeyEntry, ProofCommitRecord, hex64, u128String } from './schema.ts';
import type { Check } from './verify.ts';

const TIMEOUT_MS = 10_000;
const ATTEMPTS = 3;

/** `storage_balance_of(account)` (SPEC §4.2): the yoctoNEAR the account prepaid for its commits; 0n when it never deposited. */
export async function readStorageBalance(rpcUrl: string, contractId: string, account: string): Promise<bigint> {
  return u128String.transform(BigInt).parse(await viewFunction(rpcUrl, contractId, 'storage_balance_of', { account }));
}

/** The deployed contract has no such method (contract v1 ships the log only; `commit_proof`/`proof_commit` come with SPEC §4.2). */
export class ContractMethodNotFound extends Error {}

/** `signal` lets a caller abandon the read (the Node runner aborts the log read when attestation fails); an aborted call is not retried. */
export async function viewFunction(rpcUrl: string, contractId: string, method: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: '1',
    method: 'query',
    params: { request_type: 'call_function', finality: 'final', account_id: contractId, method_name: method, args_base64: bytesToBase64(new TextEncoder().encode(JSON.stringify(args))) },
  });
  // A failing view answers HTTP 200 with a text error (the typed cause exists only on the EXPERIMENTAL RPC), so the
  // method-not-found case is classified here once, for every view that lands later. Only MethodNotFound itself: a
  // MethodResolveError for a bad export signature is a broken deploy and must surface, not read as "not deployed yet".
  const contractError = (text: string): Error => {
    const message = `${contractId}.${method}: ${text}`;
    return /\bMethodNotFound\b/.test(text) ? new ContractMethodNotFound(message) : new Error(message);
  };
  // Network failures, timeouts and 429/5xx are retried a bounded number of times; contract errors are not.
  const transient = (err: unknown): boolean => !signal?.aborted && (err instanceof Transient || (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError' || /fetch failed|network/i.test(err.message))));
  return withRetry(
    async () => {
      const res = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS) });
      if (res.status === 429 || res.status >= 500) throw new Transient(`${rpcUrl}: HTTP ${res.status}`);
      if (!res.ok) throw new Error(`${rpcUrl}: HTTP ${res.status}`);
      const json = (await res.json()) as { result?: { result?: number[]; error?: string }; error?: { message?: string; data?: unknown } };
      if (json.error) throw contractError(typeof json.error.data === 'string' ? json.error.data : json.error.message ?? JSON.stringify(json.error));
      if (json.result?.error) throw contractError(json.result.error);
      const bytes = json.result?.result ?? [];
      return bytes.length === 0 ? undefined : JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes)));
    },
    { retryable: transient, attempts: ATTEMPTS, pauseMs: 500 },
  );
}

class Transient extends Error {}

/** The window the fail-closed check accepts a log entry from: 24 h in nanoseconds, as a U64 string. */
export const LOG_WINDOW_NS = '86400000000000';
/** u64::MAX: `latest_keys` subtracts it with saturation, so this asks for every entry of a model, newest first. */
export const ANY_AGE_NS = '18446744073709551615';
const Head = z.object({ index: z.number().int().nonnegative(), entry_hash: hex64 }).nullable();

export interface KeyLogReader {
  /** `latest_keys(model, max_age_ns)`: newest first, the fail-closed window by default. */
  latestKeys(model: string, maxAgeNs?: string, signal?: AbortSignal): Promise<KeyEntry[]>;
  /** `entry(index)`; null when the index does not exist. */
  entry(index: number): Promise<KeyEntry | null>;
  /** `entries_since(index, limit)`. */
  entriesSince(index: number, limit: number): Promise<KeyEntry[]>;
  /** `head()`; null while the log is empty. */
  head(): Promise<{ index: number; entry_hash: string } | null>;
  /** `verifiers()`: the accounts registered to write to the log. Being registered is not being trusted: that stays the client's choice. */
  verifiers(): Promise<string[]>;
}

export function keyLogReader(rpcUrl: string, contractId: string): KeyLogReader {
  const view = (method: string, args: Record<string, unknown>, signal?: AbortSignal) => viewFunction(rpcUrl, contractId, method, args, signal);
  return {
    latestKeys: async (model, maxAgeNs = LOG_WINDOW_NS, signal) => KeyEntry.array().parse(await view('latest_keys', { model, max_age_ns: maxAgeNs }, signal)),
    entry: async (index) => {
      const raw = await view('entry', { index });
      return raw == null ? null : KeyEntry.parse(raw);
    },
    entriesSince: async (index, limit) => KeyEntry.array().parse(await view('entries_since', { index, limit })),
    head: async () => Head.parse((await view('head', {})) ?? null),
    verifiers: async () => z.string().array().parse(await view('verifiers', {})),
  };
}

// ---- proof_commit (SPEC §4.2) --------------------------------------------------------------------
export type ProofCommitLookup = { status: 'found'; record: ProofCommitRecord } | { status: 'none' } | { status: 'not-deployed' };

/**
 * `proof_commit(account, commit)`: the on-chain record for a salted commit. `none` when that account never committed it,
 * `not-deployed` while the contract has no such view yet. Other failures (RPC down, malformed account id) throw.
 */
export async function readProofCommit(rpcUrl: string, contractId: string, account: string, commit: string): Promise<ProofCommitLookup> {
  try {
    const raw = await viewFunction(rpcUrl, contractId, 'proof_commit', { account, commit });
    return raw == null ? { status: 'none' } : { status: 'found', record: ProofCommitRecord.parse(raw) };
  } catch (err) {
    if (err instanceof ContractMethodNotFound) return { status: 'not-deployed' };
    throw err;
  }
}

/** The on-chain record against the proof it should describe: the kind and the log index must be the proof's. */
export function checkProofCommit(proof: { kind: 'model' | 'action'; logIndex?: number }, lookup: ProofCommitLookup, account: string): Check {
  const id = 'on-chain-commit';
  if (lookup.status === 'not-deployed') return { id, status: 'skipped', detail: 'proof_commit is not in the contract yet (SPEC §4.2): the on-chain record cannot be checked' };
  if (lookup.status === 'none') return { id, status: 'fail', detail: `${account} never committed this hash` };
  const { kind, log_index, block_height } = lookup.record;
  const problems: string[] = [];
  if (kind !== proof.kind) problems.push(`committed as kind "${kind}", the proof is "${proof.kind}"`);
  if (proof.logIndex !== undefined && log_index !== proof.logIndex) problems.push(`committed with log_index ${log_index}, the proof points at #${proof.logIndex}`);
  if (problems.length > 0) return { id, status: 'fail', detail: problems.join('; ') };
  return { id, status: 'ok', detail: `recorded by ${account} at block ${block_height} (kind ${kind}, log #${log_index})` };
}

// Reads from NEAR over plain JSON-RPC (global fetch, no SDK): contract views for the key log (SPEC §4.1), the proof commits
// (§4.2) and whatever §4.3 needs, and an account's access keys. Shared by the web client, the demo, the verifier and the agent,
// so the call shapes, the timeout and the retries live in one place.
import { z } from 'zod';
import { isNetworkFailure, withRetry } from './retry.ts';
import { bytesToBase64 } from './disclosure.ts';
import { KeyEntry, ProofCommitRecord, hex64, u128String } from './schema.ts';
import { NEAR_ACCOUNT } from './trust-set.ts';
import type { Check } from './verify.ts';

const TIMEOUT_MS = 10_000;
const ATTEMPTS = 3;

/** `storage_balance_of(account)` (SPEC §4.2): the yoctoNEAR the account prepaid for its commits; 0n when it never deposited. */
export async function readStorageBalance(rpcUrl: string, contractId: string, account: string): Promise<bigint> {
  return u128String.transform(BigInt).parse(await viewFunction(rpcUrl, contractId, 'storage_balance_of', { account }));
}

/** The only methods the agent's function-call key may call (SPEC §4.3). */
export const AGENT_KEY_METHODS = ['commit_proof', 'propose_action'];

/** The claim "the agent holds only a function-call key" rests on the key's on-chain scope, not on what the variable is called. An empty method list means every method. */
export function keyScopeProblem(permission: unknown, contract: string): string | null {
  const scope = (permission as { FunctionCall?: { receiver_id: string; method_names: string[] } }).FunctionCall;
  if (!scope) return `it is not a function-call key (${JSON.stringify(permission).slice(0, 40)})`;
  if (scope.receiver_id !== contract) return `it is scoped to ${scope.receiver_id}, not to ${contract}`;
  const methods = [...scope.method_names].sort();
  if (methods.join() !== AGENT_KEY_METHODS.join()) return `its methods are [${methods.join(', ') || 'any'}], not [${AGENT_KEY_METHODS.join(', ')}]`;
  return null;
}

/** The deployed contract has no such method (contract v1 ships the log only; `commit_proof`/`proof_commit` come with SPEC §4.2). */
export class ContractMethodNotFound extends Error {}

/**
 * One `query` to the RPC with the timeout and the bounded retries every read shares: network failures, timeouts and 429/5xx are retried,
 * an answer from the node is not. `fail` words an error the node itself reported. `signal` lets a caller abandon the read (the Node
 * runner aborts the log read when attestation fails); an aborted call is not retried.
 */
async function rpcQuery(rpcUrl: string, params: Record<string, unknown>, fail: (text: string) => Error, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: '1', method: 'query', params: { finality: 'final', ...params } });
  const transient = (err: unknown): boolean => !signal?.aborted && (err instanceof Transient || isNetworkFailure(err));
  return withRetry(
    async () => {
      const res = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS) });
      if (res.status === 429 || res.status >= 500) throw new Transient(`${rpcUrl}: HTTP ${res.status}`);
      if (!res.ok) throw new Error(`${rpcUrl}: HTTP ${res.status}`);
      const json = (await res.json()) as { result?: Record<string, unknown> & { error?: string }; error?: { message?: string; data?: unknown } };
      if (json.error) throw fail(typeof json.error.data === 'string' ? json.error.data : json.error.message ?? JSON.stringify(json.error));
      if (typeof json.result?.error === 'string') throw fail(json.result.error);
      return json.result ?? {};
    },
    { retryable: transient, attempts: ATTEMPTS, pauseMs: 500 },
  );
}

export async function viewFunction(rpcUrl: string, contractId: string, method: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  // A failing view answers HTTP 200 with a text error (the typed cause exists only on the EXPERIMENTAL RPC), so the
  // method-not-found case is classified here once, for every view that lands later. Only MethodNotFound itself: a
  // MethodResolveError for a bad export signature is a broken deploy and must surface, not read as "not deployed yet".
  const contractError = (text: string): Error => {
    const message = `${contractId}.${method}: ${text}`;
    return /\bMethodNotFound\b/.test(text) ? new ContractMethodNotFound(message) : new Error(message);
  };
  const result = await rpcQuery(rpcUrl, { request_type: 'call_function', account_id: contractId, method_name: method, args_base64: bytesToBase64(new TextEncoder().encode(JSON.stringify(args))) }, contractError, signal);
  const bytes = (result['result'] as number[] | undefined) ?? [];
  return bytes.length === 0 ? undefined : JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes)));
}

const AccessKeys = z.object({ keys: z.array(z.object({ public_key: z.string(), access_key: z.object({ permission: z.unknown() }) })) });
export type AccessKey = z.infer<typeof AccessKeys>['keys'][number];

/** Every access key of an account, with what each may do: the chain's own answer to "what can this account sign?". An account that does not exist has none. */
export async function viewAccessKeys(rpcUrl: string, account: string, signal?: AbortSignal): Promise<AccessKey[]> {
  return AccessKeys.parse(await rpcQuery(rpcUrl, { request_type: 'view_access_key_list', account_id: account }, (text) => new Error(`access keys of ${account}: ${text}`), signal)).keys;
}

class Transient extends Error {}

/** The window the fail-closed check accepts a log entry from: 24 h in nanoseconds, as a U64 string. */
export const LOG_WINDOW_NS = '86400000000000';
/** u64::MAX: `latest_keys` subtracts it with saturation, so this asks for every entry of a model, newest first. */
export const ANY_AGE_NS = '18446744073709551615';
const Head = z.object({ index: z.number().int().nonnegative(), entry_hash: hex64 }).nullable();

export interface KeyLogReader {
  /** `latest_keys(model, max_age_ns, verifier?)`: newest first, at most 100, the fail-closed window by default; with `verifier`, that account's entries only. */
  latestKeys(model: string, maxAgeNs?: string, signal?: AbortSignal, verifier?: string): Promise<KeyEntry[]>;
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
    latestKeys: async (model, maxAgeNs = LOG_WINDOW_NS, signal, verifier) => KeyEntry.array().parse(await view('latest_keys', { model, max_age_ns: maxAgeNs, ...(verifier === undefined ? {} : { verifier }) }, signal)),
    entry: async (index) => {
      const raw = await view('entry', { index });
      return raw == null ? null : KeyEntry.parse(raw);
    },
    entriesSince: async (index, limit) => KeyEntry.array().parse(await view('entries_since', { index, limit })),
    head: async () => Head.parse((await view('head', {})) ?? null),
    verifiers: async () => z.string().array().parse(await view('verifiers', {})),
  };
}

/** How many log reads go out at once. A visitor may trust up to 100 verifiers; a public RPC answers such a burst with refusals. */
const LOG_READS_AT_ONCE = 6;

/**
 * The window the fail-closed check works on: the newest entries of the model, plus each trusted verifier's own entries
 * read separately, merged newest first. `latest_keys` returns at most 100 entries, and registering a verifier is not
 * the client's decision: without the separate reads, one registered account writing 100 entries would push every
 * trusted entry out of the answer and the client would refuse honest messages (or miss a split view). A trusted
 * verifier's own read is capped at 100 too: its older entries in the window are not seen. The general
 * read stays because it tells "logged only outside your trust set" from "not logged at all".
 * Any read failing fails the whole: a partial window must not pass for the log (fail-closed). A name that is not a NEAR
 * account id is skipped: the contract's view rejects such an argument, and it can have no entries anyway.
 */
export async function latestKeysFor(reader: Pick<KeyLogReader, 'latestKeys'>, model: string, trustedVerifiers: readonly string[], maxAgeNs?: string, signal?: AbortSignal): Promise<KeyEntry[]> {
  // The general read first, then one per trusted verifier.
  const filters: Array<string | undefined> = [undefined, ...new Set(trustedVerifiers.filter((v) => NEAR_ACCOUNT.test(v)))];
  // One failed read fails the whole, so the reads still in flight are stopped with it.
  const stop = new AbortController();
  const signals = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
  const byIndex = new Map<number, KeyEntry>();
  let next = 0;
  const worker = async () => {
    while (next < filters.length && !stop.signal.aborted) {
      const entries = await reader.latestKeys(model, maxAgeNs, signals, filters[next++]);
      for (const e of entries) byIndex.set(e.index, e);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(LOG_READS_AT_ONCE, filters.length) }, worker));
  } catch (err) {
    stop.abort();
    throw err;
  }
  return [...byIndex.values()].sort((x, y) => y.index - x.index);
}

// ---- proof_commit (SPEC §4.2) --------------------------------------------------------------------
export type ProofCommitLookup = { status: 'found'; record: ProofCommitRecord } | { status: 'none' } | { status: 'not-deployed' };

/**
 * `proof_commit(account, commit)`: the on-chain record for a salted commit. `none` when that account never committed it,
 * `not-deployed` while the contract has no such view yet. Other failures (RPC down, malformed account id) throw.
 */
export async function readProofCommit(rpcUrl: string, contractId: string, account: string, commit: string, signal?: AbortSignal): Promise<ProofCommitLookup> {
  try {
    const raw = await viewFunction(rpcUrl, contractId, 'proof_commit', { account, commit }, signal);
    return raw == null ? { status: 'none' } : { status: 'found', record: ProofCommitRecord.parse(raw) };
  } catch (err) {
    if (err instanceof ContractMethodNotFound) return { status: 'not-deployed' };
    throw err;
  }
}

/** The contract's refusal of a commit this account already holds (SPEC §4.2). */
export const isAlreadyCommitted = (message: string): boolean => /already committed/i.test(message);

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

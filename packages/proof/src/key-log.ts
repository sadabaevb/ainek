// SPEC §7.1 step 2: is the attested key confirmed by the public log? The contract's `latest_keys(model, max_age)`
// returns the window; this function applies the client-side trust policy (TRUSTED_VERIFIERS + QUORUM) to it.
import { canonicalJson } from './canonical.ts';
import { normalizeHex, shortHex } from './hash.ts';
import { ZodError } from 'zod';
import { ContractMethodNotFound, type KeyLogReader } from './near-view.ts';
import type { Check } from './verify.ts';
import type { KeyEntry } from './schema.ts';

export interface KeyLogQuery {
  model: string;
  signingAddress: string;
  /** When given, an entry must also carry this compose hash to count (decision pending, DEV-NOTES 2026-11-02). */
  composeHash?: string;
  trustedVerifiers: readonly string[];
  /** Confirmations from distinct trusted verifiers required; 1 in the demo, 2 in production. */
  quorum: number;
}

export type KeyLogStatus = 'ok' | 'not-logged' | 'split-view';
/** Why the status is what it is. The UI words it; `detail` is the English technical line. */
export type KeyLogReason = 'ok' | 'split-view' | 'below-quorum' | 'untrusted-only' | 'absent';

/** The key the demo shows the client instead of the attested one (the chat's "Swap the key" switch, `pnpm demo:tamper`, `demo:metrics`): a well-formed 32-byte hex no verifier ever logged. */
export const DEMO_SWAPPED_KEY = 'ab'.repeat(32);

export interface KeyLogVerdict {
  status: KeyLogStatus;
  reason: KeyLogReason;
  /** The confirmations this verdict required: a card shown later must not read today's setting. */
  quorum: number;
  /** Distinct trusted verifiers that logged this exact key. */
  confirmedBy: string[];
  /** Entries that matched the query, trusted verifiers only. */
  matching: KeyEntry[];
  /** Entries for the model from verifiers outside the trust set: shown, never counted. */
  untrusted: KeyEntry[];
  /** Distinct verifiers outside the trust set that logged this exact key: the card names them instead of saying "not in the log". */
  loggedByUntrusted: string[];
  detail: string;
}

export interface SplitView {
  verifierA: string;
  verifierB: string;
  detail: string;
}

/** Two trusted verifiers whose key sets for the model do not overlap at all: the log is being shown differently to different people. */
export function findSplitView(entries: readonly KeyEntry[], model: string, trustedVerifiers: readonly string[]): SplitView | null {
  const trustedSet = new Set(trustedVerifiers);
  const keysByVerifier = new Map<string, Set<string>>();
  for (const e of entries) {
    if (e.model !== model || !trustedSet.has(e.verifier)) continue;
    const set = keysByVerifier.get(e.verifier) ?? new Set<string>();
    set.add(normalizeHex(e.signing_address));
    keysByVerifier.set(e.verifier, set);
  }
  const verifiers = [...keysByVerifier.entries()];
  for (let i = 0; i < verifiers.length; i++) {
    for (let j = i + 1; j < verifiers.length; j++) {
      const [verifierA, keysA] = verifiers[i] as [string, Set<string>];
      const [verifierB, keysB] = verifiers[j] as [string, Set<string>];
      if (![...keysA].some((k) => keysB.has(k))) {
        return { verifierA, verifierB, detail: `${verifierA} and ${verifierB} logged different key sets for ${model} in this window` };
      }
    }
  }
  return null;
}

export function evaluateKeyLog(entries: readonly KeyEntry[], query: KeyLogQuery): KeyLogVerdict {
  const forModel = entries.filter((e) => e.model === query.model);
  const trustedSet = new Set(query.trustedVerifiers);
  const trusted = forModel.filter((e) => trustedSet.has(e.verifier));
  const untrusted = forModel.filter((e) => !trustedSet.has(e.verifier));

  const wanted = normalizeHex(query.signingAddress);
  const hasKey = (e: KeyEntry) => normalizeHex(e.signing_address) === wanted && (query.composeHash === undefined || normalizeHex(e.compose_hash) === normalizeHex(query.composeHash));
  const matching = trusted.filter(hasKey);
  const confirmedBy = verifiersOf(matching);
  const loggedByUntrusted = verifiersOf(untrusted.filter(hasKey));

  // The trust set can now come from the viewer's browser: whatever arrives here, no key passes without a confirmation.
  const quorum = Math.max(1, query.quorum);
  const split = findSplitView(forModel, query.model, query.trustedVerifiers);
  if (split) return { status: 'split-view', reason: 'split-view', quorum, confirmedBy: [], matching: [], untrusted, loggedByUntrusted, detail: `${split.detail}: refusing to send` };
  if (confirmedBy.length >= quorum) {
    return { status: 'ok', reason: 'ok', quorum, confirmedBy, matching, untrusted, loggedByUntrusted, detail: `key ${shortHex(wanted)} confirmed by ${confirmedBy.join(', ')}` };
  }
  // A trusted match short of quorum outranks entries from outside the trust set, which are named, never counted.
  const reason = matching.length > 0 ? 'below-quorum' : loggedByUntrusted.length > 0 ? 'untrusted-only' : 'absent';
  const why = {
    'below-quorum': `only ${confirmedBy.length} of ${quorum} required confirmations`,
    'untrusted-only': `key ${shortHex(wanted)} is logged only by ${loggedByUntrusted.join(', ')}, outside the trust set`,
    absent: `key ${shortHex(wanted)} is not in the public log`,
  }[reason];
  return { status: 'not-logged', reason, quorum, confirmedBy, matching, untrusted, loggedByUntrusted, detail: `${why}: not sent (fail-closed)` };
}

export const verifiersOf = (entries: readonly KeyEntry[]): string[] => [...new Set(entries.map((e) => e.verifier))];

/**
 * The entry a proof points at, from a verdict that passed. Instances of a model share one signing key, so several composes
 * can sit behind it: take the newest entry with the attested compose, so that the proof and the card name the deployment
 * that was checked. No such entry is not a refusal (the compose is shown, not enforced: DEV-NOTES 2026-11-02), it means the
 * newest entry for the key. `matching` keeps the contract's newest-first order.
 */
export function proofEntryOf(verdict: KeyLogVerdict, composeHash: string): KeyEntry {
  const compose = normalizeHex(composeHash);
  const entry = verdict.matching.find((e) => normalizeHex(e.compose_hash) === compose) ?? verdict.matching[0];
  if (!entry) throw new Error('the verdict has no log entry for a proof to point at');
  return entry;
}


// ---- The entry a proof points at, with the public log as the source of truth -----------------------
export interface ResolvedEntry {
  /** What the proof is checked against: the chain's entry when it answered, else the embedded copy, else nothing. */
  entry: KeyEntry | null;
  check: Check;
}

/**
 * Re-reads entry `logIndex` through `reader` and compares it with the copy embedded in the input (a disclosure file, a
 * stored exchange) when there is one. Missing or different is a failure. An unreachable log is a skip that falls back to
 * the embedded copy and says so, so a reader never mistakes the sender's copy for the chain's word.
 */
export async function resolveLogEntry(reader: Pick<KeyLogReader, 'entry'>, logIndex: number, embedded?: KeyEntry, logName = 'the public log'): Promise<ResolvedEntry> {
  const id = 'log-entry';
  let fromChain: KeyEntry | null;
  try {
    fromChain = await reader.entry(logIndex);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    // The log answered, but not with an entry (no such view, or a shape the schema rejects): that is a failure of the
    // log, not an outage, and the embedded copy must not stand in for it.
    if (err instanceof ContractMethodNotFound || err instanceof ZodError) return { entry: null, check: { id, status: 'fail', detail: `${logName} did not answer with a valid entry (${why})` } };
    return { entry: embedded ?? null, check: { id, status: 'skipped', detail: `${logName} unavailable (${why})${embedded ? '; using the embedded entry, not re-read from the chain' : ''}` } };
  }
  if (!fromChain) return { entry: embedded ?? null, check: { id, status: 'fail', detail: `entry #${logIndex} is not in ${logName}${embedded ? ': the embedded entry cannot be confirmed' : ''}` } };
  if (embedded && canonicalJson(embedded) !== canonicalJson(fromChain)) return { entry: fromChain, check: { id, status: 'fail', detail: `entry #${logIndex} in ${logName} differs from the embedded entry` } };
  return { entry: fromChain, check: { id, status: 'ok', detail: `entry #${logIndex} re-read from ${logName}${embedded ? ', equal to the embedded entry' : ''}` } };
}

// SPEC §7.1 step 2: is the attested key confirmed by the public log? The contract's `latest_keys(model, max_age)`
// returns the window; this function applies the client-side trust policy (TRUSTED_VERIFIERS + QUORUM) to it.
import { canonicalJson } from './canonical.ts';
import { normalizeHex, shortHex } from './hash.ts';
import type { KeyLogReader } from './near-view.ts';
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

export interface KeyLogVerdict {
  status: KeyLogStatus;
  /** Distinct trusted verifiers that logged this exact key. */
  confirmedBy: string[];
  /** Entries that matched the query, trusted verifiers only. */
  matching: KeyEntry[];
  /** Entries for the model from verifiers outside the trust set: shown, never counted. */
  untrusted: KeyEntry[];
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

  const split = findSplitView(forModel, query.model, query.trustedVerifiers);
  if (split) return { status: 'split-view', confirmedBy: [], matching: [], untrusted, detail: `${split.detail}: refusing to send` };

  const wanted = normalizeHex(query.signingAddress);
  const matching = trusted.filter(
    (e) => normalizeHex(e.signing_address) === wanted && (query.composeHash === undefined || normalizeHex(e.compose_hash) === normalizeHex(query.composeHash)),
  );
  const confirmedBy = [...new Set(matching.map((e) => e.verifier))];
  if (confirmedBy.length >= query.quorum) {
    return { status: 'ok', confirmedBy, matching, untrusted, detail: `key ${shortHex(wanted)} confirmed by ${confirmedBy.join(', ')}` };
  }
  const why = matching.length === 0 ? `key ${shortHex(wanted)} is not in the public log` : `only ${confirmedBy.length} of ${query.quorum} required confirmations`;
  return { status: 'not-logged', confirmedBy, matching, untrusted, detail: `${why}: not sent (fail-closed)` };
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
    return { entry: embedded ?? null, check: { id, status: 'skipped', detail: `${logName} unavailable (${why})${embedded ? '; using the embedded entry, not re-read from the chain' : ''}` } };
  }
  if (!fromChain) return { entry: embedded ?? null, check: { id, status: 'fail', detail: `entry #${logIndex} is not in ${logName}${embedded ? ': the embedded entry cannot be confirmed' : ''}` } };
  if (embedded && canonicalJson(embedded) !== canonicalJson(fromChain)) return { entry: fromChain, check: { id, status: 'fail', detail: `entry #${logIndex} in ${logName} differs from the embedded entry` } };
  return { entry: fromChain, check: { id, status: 'ok', detail: `entry #${logIndex} re-read from ${logName}${embedded ? ', equal to the embedded entry' : ''}` } };
}

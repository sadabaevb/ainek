// SPEC §7.1 step 2: is the attested key confirmed by the public log? The contract's `latest_keys(model, max_age)`
// returns the window; this function applies the client-side trust policy (TRUSTED_VERIFIERS + QUORUM) to it.
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
    set.add(e.signing_address.toLowerCase());
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

  const wanted = query.signingAddress.toLowerCase();
  const matching = trusted.filter(
    (e) => e.signing_address.toLowerCase() === wanted && (query.composeHash === undefined || e.compose_hash === query.composeHash),
  );
  const confirmedBy = [...new Set(matching.map((e) => e.verifier))];
  if (confirmedBy.length >= query.quorum) {
    return { status: 'ok', confirmedBy, matching, untrusted, detail: `key ${short(wanted)} confirmed by ${confirmedBy.join(', ')}` };
  }
  const why = matching.length === 0 ? `key ${short(wanted)} is not in the public log` : `only ${confirmedBy.length} of ${query.quorum} required confirmations`;
  return { status: 'not-logged', confirmedBy, matching, untrusted, detail: `${why}: not sent (fail-closed)` };
}

function short(hex: string): string {
  return `…${hex.slice(-4)}`;
}

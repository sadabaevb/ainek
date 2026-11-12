// SPEC §7.1 step 2: is the attested key, and the deployment behind it, confirmed by the public log? The contract's
// `latest_keys(model, max_age)` returns the window; this file applies the client-side trust policy (TRUSTED_VERIFIERS + QUORUM) to it.
import { canonicalJson } from './canonical.ts';
import { normalizeHex, shortHex } from './hash.ts';
import { ZodError } from 'zod';
import { ContractMethodNotFound, type KeyLogReader } from './near-view.ts';
import type { Check } from './verify.ts';
import type { KeyEntry } from './schema.ts';

export interface KeyLogQuery {
  model: string;
  signingAddress: string;
  /**
   * The compose hash of the deployment this client attested. When given, only an entry with this key AND this compose counts. Callers
   * pass it when the deployment check is on (`requireLoggedDeployment` in the config, or the demo switch), and undefined otherwise.
   * What it does not settle: instances of a model share one signing key and the gateway picks the instance per request, so the
   * instance that answers the message may be another one than the instance that answered the attestation.
   */
  composeHash?: string | undefined;
  trustedVerifiers: readonly string[];
  /** Confirmations from distinct trusted verifiers required; 1 in the demo, 2 in production. */
  quorum: number;
}

export type KeyLogStatus = 'ok' | 'not-logged' | 'split-view';
/** Why the status is what it is. The UI words it; `detail` is the English technical line. */
export type KeyLogReason = 'ok' | 'split-view' | 'below-quorum' | 'unknown-deployment' | 'untrusted-only' | 'absent' | ReleaseRefusal;
/** Refusals of the release rule (release-marks.ts), applied on top of a key that passed when the client asks for it. */
export type ReleaseRefusal = 'unlogged-release' | 'untied-log' | 'unknown-release' | 'shorter-log' | 'release-below-quorum' | 'rewritten-log' | 'young-release';

/** The key the demo shows the client instead of the attested one (the chat's "Swap the key" switch, `pnpm demo:tamper`, `demo:metrics`): a well-formed 32-byte hex no verifier ever logged. */
export const DEMO_SWAPPED_KEY = 'ab'.repeat(32);
/** The compose hash the demo shows the client instead of the attested one (the chat's "unknown deployment" switch): a deployment no verifier ever logged, behind the real key. */
export const DEMO_UNKNOWN_COMPOSE = 'cd'.repeat(32);

export interface KeyLogVerdict {
  status: KeyLogStatus;
  reason: KeyLogReason;
  /** The confirmations this verdict required: a card shown later must not read today's setting. */
  quorum: number;
  /** Distinct trusted verifiers that logged this exact key (with the queried deployment, when the query named one). */
  confirmedBy: string[];
  /** Entries that matched the query, trusted verifiers only. */
  matching: KeyEntry[];
  /** Entries for the model from verifiers outside the trust set: shown, never counted. */
  untrusted: KeyEntry[];
  /** Distinct verifiers outside the trust set that logged this exact key: the card names them instead of saying "not in the log". */
  loggedByUntrusted: string[];
  /** Set when the query named a deployment: its compose hash, and the distinct composes trusted verifiers logged with this key in the window (newest first). */
  deployment?: { composeHash: string; loggedComposes: string[] } | undefined;
  /** Set on a `young-release` refusal, in ms: how long before the check the release was first marked (absent when no entry names the release), and how long this client waits. */
  releaseAge?: { ms?: number | undefined; minMs: number } | undefined;
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
  const compose = query.composeHash === undefined ? undefined : normalizeHex(query.composeHash);
  const hasKey = (e: KeyEntry) => normalizeHex(e.signing_address) === wanted;
  const matches = (e: KeyEntry) => hasKey(e) && (compose === undefined || normalizeHex(e.compose_hash) === compose);
  const withKey = trusted.filter(hasKey);
  const matching = withKey.filter(matches);
  const confirmedBy = verifiersOf(matching);
  // By key alone: "only verifiers you do not trust know this key" is true whatever deployment they saw behind it.
  const loggedByUntrusted = verifiersOf(untrusted.filter(hasKey));
  const deployment = compose === undefined ? undefined : { composeHash: compose, loggedComposes: [...new Set(withKey.map((e) => normalizeHex(e.compose_hash)))] };
  const what = compose === undefined ? `key ${shortHex(wanted)}` : `key ${shortHex(wanted)} with deployment ${shortHex(compose)}`;

  // The trust set can now come from the viewer's browser: whatever arrives here, no key passes without a confirmation.
  const quorum = Math.max(1, query.quorum);
  const split = findSplitView(forModel, query.model, query.trustedVerifiers);
  if (split) return { status: 'split-view', reason: 'split-view', quorum, confirmedBy: [], matching: [], untrusted, loggedByUntrusted, deployment, detail: `${split.detail}: refusing to send` };
  if (confirmedBy.length >= quorum) {
    return { status: 'ok', reason: 'ok', quorum, confirmedBy, matching, untrusted, loggedByUntrusted, deployment, detail: `${what} confirmed by ${confirmedBy.join(', ')}` };
  }
  // A trusted match short of quorum comes first. Then the key that trusted verifiers know, but not with this deployment: the case the
  // key alone cannot catch. Entries from outside the trust set are named, never counted.
  const reason = matching.length > 0 ? 'below-quorum' : withKey.length > 0 ? 'unknown-deployment' : loggedByUntrusted.length > 0 ? 'untrusted-only' : 'absent';
  const why = {
    'below-quorum': `only ${confirmedBy.length} of ${quorum} required confirmations for ${what}`,
    'unknown-deployment': `key ${shortHex(wanted)} is logged, but not with deployment ${shortHex(deployment?.composeHash ?? '')}: trusted verifiers saw ${deployment?.loggedComposes.map(shortHex).join(', ')} behind it`,
    'untrusted-only': `key ${shortHex(wanted)} is logged only by ${loggedByUntrusted.join(', ')}, outside the trust set`,
    absent: `key ${shortHex(wanted)} is not in the public log`,
  }[reason];
  return { status: 'not-logged', reason, quorum, confirmedBy, matching, untrusted, loggedByUntrusted, deployment, detail: `${why}: not sent (fail-closed)` };
}

export interface SeenDeployment {
  composeHash: string;
  /** Distinct signing keys logged with it. */
  keys: string[];
  verifiers: string[];
  entries: number;
  /** `observed_at` of its oldest and newest entry among those given, unix ms. */
  firstSeenMs: number;
  lastSeenMs: number;
}

/**
 * The deployments of a model as the log shows them: one line per compose hash, newest first. Several deployments behind one key is
 * normal (replicas, a rollout); a new one appearing is exactly what the log is there to record. "First seen" is only as old as the
 * entries given: the contract's views return the latest 100.
 */
export function deploymentsSeen(entries: readonly KeyEntry[], model: string): SeenDeployment[] {
  const seen = new Map<string, SeenDeployment>();
  for (const e of entries) {
    if (e.model !== model) continue;
    const composeHash = normalizeHex(e.compose_hash);
    const at = Number(e.observed_at);
    const d = seen.get(composeHash) ?? { composeHash, keys: [], verifiers: [], entries: 0, firstSeenMs: at, lastSeenMs: at };
    const key = normalizeHex(e.signing_address);
    if (!d.keys.includes(key)) d.keys.push(key);
    if (!d.verifiers.includes(e.verifier)) d.verifiers.push(e.verifier);
    d.entries += 1;
    d.firstSeenMs = Math.min(d.firstSeenMs, at);
    d.lastSeenMs = Math.max(d.lastSeenMs, at);
    seen.set(composeHash, d);
  }
  return [...seen.values()].sort((a, b) => b.lastSeenMs - a.lastSeenMs);
}

/** Where a deployment stands for a viewer right now: would the deployment check pass for it, and if not, why. */
export type DeploymentStanding = 'ok' | 'split-view' | 'below-quorum' | 'untrusted' | 'old';

/**
 * The chat's own rule (`evaluateKeyLog` on the 24 h window) asked about one deployment from `deploymentsSeen`, for each key it was
 * logged with. When no trusted verifier has it in the window: `untrusted` if only verifiers outside the trust set logged it there or
 * ever, `old` if a trusted verifier did, but before the window.
 */
export function deploymentStanding(window: readonly KeyEntry[], d: SeenDeployment, query: Pick<KeyLogQuery, 'model' | 'trustedVerifiers' | 'quorum'>): DeploymentStanding {
  const reasons = d.keys.map((key) => evaluateKeyLog(window, { ...query, signingAddress: key, composeHash: d.composeHash }).reason);
  if (reasons.includes('ok')) return 'ok';
  if (reasons.includes('split-view')) return 'split-view';
  if (reasons.includes('below-quorum')) return 'below-quorum';
  const inWindow = window.some((e) => e.model === query.model && normalizeHex(e.compose_hash) === d.composeHash);
  return !inWindow && d.verifiers.some((v) => query.trustedVerifiers.includes(v)) ? 'old' : 'untrusted';
}

export const verifiersOf = (entries: readonly KeyEntry[]): string[] => [...new Set(entries.map((e) => e.verifier))];

/**
 * The entry a proof points at, from a verdict that passed. Instances of a model share one signing key, so several composes
 * can sit behind it: take the newest entry with the attested compose, so that the proof and the card name the deployment
 * that was checked. With the deployment check on, every matching entry has that compose. With it off, no such entry is not a
 * refusal: it means the newest entry for the key, and the card says so. `matching` keeps the contract's newest-first order.
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

/** When the fail-closed client would have had nothing fresh to go on: the holes in `[from, to]` not covered by any entry's `windowMs` after it was observed. */
export interface FreshCoverage {
  /** Holes, oldest first, in ms since the epoch. */
  holes: Array<{ from: number; to: number }>;
  /** Their total length in ms. */
  uncoveredMs: number;
  /** When the stretch without a hole that reaches `to` began (`to` itself when the log is stale at `to`). */
  unbrokenSince: number;
  /** The longest pause inside that stretch, in ms: between two entries, or from the last one to `to` (the one still open). */
  longestPauseMs: number;
}

/** Over the history of the log, how long a client that trusts these entries would have had no fresh one to go on.
 *  `observedAtMs` are the entries' times; each keeps the client served for `windowMs` (24 h for the chat).
 *  A lower bound on refusals, not the client's verdict: it does not look at which key an entry carries, at the quorum or
 *  at the deployment check, and it goes by the verifier's clock (an entry is visible only once its transaction lands). */
export function freshCoverage(observedAtMs: readonly number[], from: number, to: number, windowMs: number): FreshCoverage {
  const times = [...observedAtMs].sort((a, b) => a - b);
  const holes: FreshCoverage['holes'] = [];
  let covered = from; // everything before this moment is accounted for
  for (const t of times) {
    if (t + windowMs <= covered) continue;
    if (t > covered) holes.push({ from: covered, to: t });
    covered = Math.max(covered, t + windowMs);
  }
  if (covered < to) holes.push({ from: covered, to });
  const last = holes.at(-1);
  const unbrokenSince = last ? last.to : from;
  const stretch = [...times.filter((t) => t >= unbrokenSince && t < to), to];
  const longestPauseMs = stretch.reduce((max, t, i) => (i === 0 ? 0 : Math.max(max, t - stretch[i - 1]!)), 0);
  return { holes, uncoveredMs: holes.reduce((sum, h) => sum + h.to - h.from, 0), unbrokenSince, longestPauseMs };
}

/**
 * The log check over every model report that carries the key: the gateway may return several, and the one that signs the reply
 * need not be the first. Returns the first refusal, else the verdict for the first compose. Pass `[undefined]` for the key alone.
 */
export function evaluateKeyLogForAll(entries: readonly KeyEntry[], query: Omit<KeyLogQuery, 'composeHash'>, composes: readonly (string | undefined)[]): KeyLogVerdict {
  const [first, ...rest] = (composes.length > 0 ? composes : [undefined]).map((composeHash) => evaluateKeyLog(entries, { ...query, composeHash }));
  return [first as KeyLogVerdict, ...rest].find((v) => v.status !== 'ok') ?? (first as KeyLogVerdict);
}

/** The distinct compose hashes among reports that share `signingAddress`, in report order. */
export function composesBehindKey(reports: readonly { signingAddress: string; composeHash: string }[], signingAddress: string): string[] {
  const wanted = normalizeHex(signingAddress);
  return [...new Set(reports.filter((r) => normalizeHex(r.signingAddress) === wanted).map((r) => normalizeHex(r.composeHash)))];
}

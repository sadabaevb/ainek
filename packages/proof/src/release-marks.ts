// What a verifier writes into a key-log entry about the code behind the key, and what a client makes of it.
//
// A key-log entry has always carried the image digests of the measured launcher (`image_digests`). The contract takes
// any text there (at most 16 values of at most 128 bytes), so two more kinds of value ride in the same field, each with a
// prefix no digest has. No schema changes, and a client that does not know them ignores them.
//
//   log:<16 hex of the instance id>:<number of actions>:<sha256 of those actions>
//     The action log the verifier was shown, as the enclave quotes it. A verifier writes it only after following the
//     model's current release in that log to public sources (release-chain.ts): the compose file in the public
//     repository, its tag, the signed builds. So the mark says "at this state of the log, a verifier followed the release
//     that serves the model". It does not say the verifier followed everything the log deployed: see `releaseMarksFor`.
//
//   release:<16 hex of sha256(file path)>:<sha256 of the file>
//     Which release that was: the compose file that defines the model's service, as the latest `compose_up` of that
//     service read it. It names the release in the public log, with the time it first appeared there. The client's rule
//     reads the log mark only.
//
// The client's rule (`evaluateRelease`): the action log attested now must be exactly one that enough trusted verifiers
// marked. An enclave deploys by appending to that log, so anything it did after a verifier looked is refused until a
// verifier looks again. The rule does not interpret the actions, so it does not depend on knowing which of them change
// what runs. No network is needed: the action log comes with the attestation the client already verified.
//
// A client may also wait (`waitMs`): it then sends only when the log has been marked as it stands for that long, by as
// many verifiers as it requires. Whatever the enclave last did, others have had that long to look at it. The time is the
// verifiers' own and the client's, and it reaches back only as far as the client reads the public log.
//
// Compose Manager only appends to this log (one write site in its source, at the commit the running image was built
// from), so every state of an honest log begins with every earlier one. A log whose beginning is not what a verifier saw
// was therefore edited, or started over and grown again: the manager starts from an empty log when its file is missing or
// unreadable. A log shorter than one a verifier saw is refused too, without that name: the rule cannot tell a log that
// was cut from an attestation made before the verifier's entry.
import { canonicalJson } from './canonical.ts';
import { checked, type Checked } from './checked.ts';
import { normalizeHex, sha256Hex, shortHex } from './hash.ts';
import { composeHashOf } from './key-entry.ts';
import { evaluateKeyLog, type KeyLogQuery, type KeyLogVerdict, type ReleaseRefusal } from './key-log.ts';
import { utcText } from './release-lines.ts';
import { sameInstance, wholeMinutes, type ManagerAction } from './release.ts';
import type { KeyEntry } from './schema.ts';

const RELEASE = /^release:([0-9a-f]{16}):([0-9a-f]{64})$/;
const LOG = /^log:([0-9a-f]{16}):(\d{1,7}):([0-9a-f]{64})$/;
/** The furthest a JavaScript date reaches from 1970, in ms. */
const MAX_DATE_MS = 8.64e15;

/**
 * sha256 of an action log in the form the enclave quotes it and the SDK checks. Compose Manager defines that form as
 * Python's `json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False)` over actions whose values are strings
 * and arrays of strings (`canonicalize_actions` in its source), which is this package's canonical JSON. For the whole log
 * this is the `actions_hash` of the report.
 */
export function actionsHash(actions: readonly ManagerAction[]): string {
  return sha256Hex(canonicalJson(actions));
}

/** The short name a mark gives a compose file: paths can be longer than a mark may be. */
const fileIdOf = (file: string): string => sha256Hex(file).slice(0, 16);
/** The short name a mark gives a CVM instance: the start of its dstack instance id. */
const instanceIdOf = (instance: string): string => instance.toLowerCase().slice(0, 16);

/** The mark for a release: a compose file in the state a `compose_up` read it. */
export function releaseMark(file: string, fileSha256: string): string {
  return `release:${fileIdOf(file)}:${fileSha256.toLowerCase()}`;
}

/** The mark for an action log as it stands: whose it is, how long it is, and its hash. */
export function logMark(instance: string, actions: readonly ManagerAction[]): string {
  return `log:${instanceIdOf(instance)}:${actions.length}:${actionsHash(actions)}`;
}

export interface ReleaseMarks {
  /** Everything that is not a mark: the launcher's image digests. */
  digests: string[];
  releases: { fileId: string; fileSha256: string }[];
  logs: { instance: string; length: number; hash: string }[];
}

/** The `image_digests` of an entry, sorted into the marks a verifier added and the digests it has always carried. */
export function marksOf(imageDigests: readonly string[]): ReleaseMarks {
  const marks: ReleaseMarks = { digests: [], releases: [], logs: [] };
  for (const value of imageDigests) {
    const release = RELEASE.exec(value);
    const log = LOG.exec(value);
    if (release?.[1] && release[2]) marks.releases.push({ fileId: release[1], fileSha256: release[2] });
    else if (log?.[1] && log[2] && log[3]) marks.logs.push({ instance: log[1], length: Number(log[2]), hash: log[3] });
    else marks.digests.push(value);
  }
  return marks;
}

/**
 * - `ok`: the action log the enclave attests is exactly one that enough trusted verifiers marked.
 * - `unlogged-release`: the entries that vouch for the key carry no log mark at all (verifiers that do not write them yet).
 * - `untied-log`: the log cannot be tied to the instance that holds the key, so no mark can vouch for it.
 * - `unknown-release`: no vouching entry marks the log as it stands: the enclave added to it after the last mark, or no
 *   trusted verifier has marked this instance.
 * - `shorter-log`: a trusted verifier marked a longer log from this instance than the one attested now.
 * - `release-below-quorum`: some trusted verifiers marked the log as it stands, fewer than the client requires.
 * - `rewritten-log`: the log does not begin with what a trusted verifier saw from this instance.
 * - `recent-mark`: the log is marked as it stands by enough verifiers, for less time than the client waits.
 */
export type ReleaseLogStatus = 'ok' | ReleaseRefusal;
export interface ReleaseLogVerdict {
  status: ReleaseLogStatus;
  /** Distinct verifiers that logged the action log exactly as it stands. */
  confirmedBy: string[];
  /** On a `recent-mark` refusal: for how long the log has been marked as it stands, in ms; absent when the marks carry no readable time. */
  markedForMs?: number | undefined;
  detail: string;
}

/** How a client applies the release rule to its attested reports. */
export interface ReleaseRule {
  /** The client asks for the launcher to be logged: only entries for a report's own launcher may confirm its log. */
  withLauncher: boolean;
  /** Send only when the log has been marked as it stands for this long (SPEC §7.5); 0 or absent is no wait. */
  waitMs?: number | undefined;
  /** Unix ms on this client, to measure that time from; defaults to now. */
  now?: number | undefined;
}

/** What `evaluateRelease` takes besides the entries and the log: the wait of the rule, the quorum, and the entries that can contradict the log without being able to confirm it. */
type ReleaseCheck = Pick<ReleaseRule, 'waitMs' | 'now'> & { quorum?: number | undefined; witnesses?: readonly KeyEntry[] | undefined };

/**
 * Checks the action log a client was attested against the marks of key-log entries. `entries` are the ones the key check
 * accepted: from trusted verifiers, fresh, for this key and this launcher. Only they can confirm the log. `witnesses` are
 * all the entries of trusted verifiers the client holds, whatever key or launcher they are for: a mark of this instance
 * among them can contradict the log, so that a change of launcher does not hide what a verifier saw of the instance.
 * `instance` is the dstack instance id that both the key's quote and the log's quote name; a log that cannot be tied to
 * that instance matches no mark.
 */
export function evaluateRelease(entries: readonly KeyEntry[], attested: { actions: readonly ManagerAction[]; instance: Checked<string> }, { quorum = 1, witnesses = entries, waitMs = 0, now = Date.now() }: ReleaseCheck = {}): ReleaseLogVerdict {
  const { actions } = attested;
  const refused = (status: ReleaseRefusal, detail: string, confirmedBy: string[] = []): ReleaseLogVerdict => ({ status, confirmedBy, detail });
  if (!entries.some((entry) => marksOf(entry.image_digests).logs.length > 0)) return refused('unlogged-release', `none of the ${entries.length} log entr${entries.length === 1 ? 'y' : 'ies'} for this key and launcher carries a mark of the enclave's action log`);
  if (attested.instance.status !== 'ok') return refused('untied-log', `the action log cannot be tied to the enclave that holds the key: ${attested.instance.why}`);
  const instance = instanceIdOf(attested.instance.value);

  const prefixes = new Map<number, string>(); // the hash of the first n actions, computed once per n
  const hashOfFirst = (n: number): string => {
    const known = prefixes.get(n) ?? actionsHash(actions.slice(0, n));
    prefixes.set(n, known);
    return known;
  };
  type Seen = { entry: KeyEntry; length: number };
  const longest = (a: Seen | undefined, b: Seen): Seen => (a && a.length >= b.length ? a : b);
  const vouching = new Set(entries);
  const held = [...new Set([...entries, ...witnesses])];
  const confirming: KeyEntry[] = []; // vouching entries that mark the log exactly as it stands
  let ahead: Seen | undefined; // a verifier saw a longer log than this one
  let behind: Seen | undefined; // the longest earlier state of this log a vouching entry marked
  for (const entry of held) {
    for (const seen of marksOf(entry.image_digests).logs) {
      if (seen.instance !== instance) continue; // another instance
      if (seen.length > actions.length) ahead = longest(ahead, { entry, length: seen.length });
      // An honest log begins with each of its earlier states, whenever those were seen: this is a mismatch no timing explains.
      else if (hashOfFirst(seen.length) !== seen.hash) return refused('rewritten-log', `the first ${seen.length} actions of the log attested now are not the ones entry #${entry.index} by ${entry.verifier} saw (${shortHex(hashOfFirst(seen.length))}, logged ${shortHex(seen.hash)})`);
      else if (!vouching.has(entry)) continue; // logged for another key or launcher: it can contradict this log, not confirm it
      else if (seen.length === actions.length) confirming.push(entry);
      else behind = longest(behind, { entry, length: seen.length });
    }
  }

  // Either this attestation is older than that entry, and the enclave has moved on, or the log lost actions. The lengths
  // alone do not say which, so this is not called a rewrite; an exact match with an earlier mark does not outweigh it.
  if (ahead) return refused('shorter-log', `entry #${ahead.entry.index} by ${ahead.entry.verifier} saw ${ahead.length} actions from this instance and the log attested now has ${actions.length}: this attestation is older than that entry, or the log was cut`);
  const confirmedBy = [...new Set(confirming.map((entry) => entry.verifier))];
  if (confirmedBy.length === 0) {
    if (!behind) return refused('unknown-release', `no trusted verifier has marked the action log of this instance (${instance})`);
    const added = actions.length - behind.length;
    const last = actions.at(-1);
    return refused('unknown-release', `the enclave's action log has ${added} action${added === 1 ? '' : 's'} since entry #${behind.entry.index} by ${behind.entry.verifier} marked it (the latest: ${last?.action ?? '?'} at ${last?.timestamp ?? '?'}); no trusted verifier has marked the log as it stands`);
  }
  const need = Math.max(1, quorum);
  if (confirmedBy.length < need) return refused('release-below-quorum', `only ${confirmedBy.length} of ${need} required verifiers marked the action log as it stands`, confirmedBy);

  // The log is marked as it stands. Since when: each of those verifiers' earliest entry with this mark, and of them the
  // one that completes the quorum. Before that moment fewer verifiers than the client requires had marked this state, so
  // one verifier's clock cannot make it look older. A time that is no date (nanoseconds, say) is no time.
  const firstBy = new Map<string, number>();
  for (const entry of confirming) {
    const at = Number(entry.observed_at);
    if (Number.isFinite(at) && Math.abs(at) <= MAX_DATE_MS) firstBy.set(entry.verifier, Math.min(firstBy.get(entry.verifier) ?? at, at));
  }
  const since = [...firstBy.values()].sort((a, b) => a - b)[need - 1];
  const marked = `the action log as it stands (${actions.length} actions) is marked by ${confirmedBy.join(', ')}`;
  const waits = `this client waits ${wholeMinutes(waitMs)} min`;
  if (since === undefined) return waitMs > 0 ? refused('recent-mark', `${marked}, at a time that does not read as one, so for how long is not known; ${waits}`, confirmedBy) : { status: 'ok', confirmedBy, detail: marked };
  const markedForMs = now - since;
  const from = `${marked} since ${utcText(new Date(since).toISOString())}`;
  // A clock behind the verifiers' makes the time negative: without a wait that refuses nothing.
  if (waitMs > 0 && markedForMs < waitMs) return { ...refused('recent-mark', `${from}, ${wholeMinutes(markedForMs)} min before this check; ${waits}`, confirmedBy), markedForMs };
  return { status: 'ok', confirmedBy, detail: from };
}

/** A verified model report as the release rule reads it. Structural, so this package needs no SDK import. */
export interface AttestedReport {
  signer: { signingAddress: string };
  deployment: { appCompose: string; composeManager?: { actions: readonly ManagerAction[] } | undefined };
  report: { eventLog?: unknown; composeManagerAttestation?: { eventLog?: unknown } | undefined };
}

/**
 * What the release rule says about one verified report: the entries that vouch for its key, and for its launcher when
 * the client asks for the launcher to be logged, against the action log the report attests.
 */
export function releaseStanding(entries: readonly KeyEntry[], query: Omit<KeyLogQuery, 'composeHash'>, { deployment, report }: AttestedReport, { withLauncher, waitMs, now }: ReleaseRule): ReleaseLogVerdict {
  const vouching = evaluateKeyLog(entries, { ...query, composeHash: withLauncher ? composeHashOf(deployment) : undefined }).matching;
  // Whatever a trusted verifier logged for the model, under any key or launcher: an instance keeps its id when its
  // launcher is upgraded, and what was seen of it then still binds its log now.
  const trusted = new Set(query.trustedVerifiers);
  const witnesses = entries.filter((entry) => entry.model === query.model && trusted.has(entry.verifier));
  const log = deployment.composeManager;
  // Both quotes are verified by now. When they name two instances the log is another replica's record, not this enclave's.
  const instance = log ? sameInstance(report.eventLog, report.composeManagerAttestation?.eventLog) : checked.skipped('the attested report carries no action log');
  return evaluateRelease(vouching, { actions: log?.actions ?? [], instance }, { quorum: query.quorum, witnesses, waitMs, now });
}

/**
 * The release rule on top of a key verdict that passed: for every attested report behind the key, the entries that vouch
 * for it must also carry its action log exactly as it stands. A key whose enclave did something no verifier has looked at
 * is refused like a key nobody logged. A verdict that did not pass is returned as it is.
 *
 * The reports must be fresh: the rule says nothing about what the enclave did after it attested them. A client that keeps
 * verified reports for a while attests again before it applies this.
 */
export function withReleaseRule(verdict: KeyLogVerdict, entries: readonly KeyEntry[], query: Omit<KeyLogQuery, 'composeHash'>, reports: readonly AttestedReport[], rule: ReleaseRule): KeyLogVerdict {
  if (verdict.status !== 'ok') return verdict;
  const refused = (reason: ReleaseRefusal, detail: string, confirmedBy: string[] = []): KeyLogVerdict => ({ ...verdict, status: 'not-logged', reason, confirmedBy, detail: `${detail}: not sent (fail-closed)` });
  const key = normalizeHex(query.signingAddress);
  const behindKey = reports.filter((r) => normalizeHex(r.signer.signingAddress) === key);
  if (behindKey.length === 0) return refused('untied-log', 'the action log cannot be tied to the enclave that holds the key: no attested report carries this key');
  const at = { ...rule, now: rule.now ?? Date.now() }; // one moment for every report of this check
  for (const report of behindKey) {
    const standing = releaseStanding(entries, query, report, at);
    if (standing.status === 'recent-mark') return { ...refused(standing.status, standing.detail, standing.confirmedBy), releaseWait: { markedForMs: standing.markedForMs, waitMs: rule.waitMs ?? 0 } };
    if (standing.status !== 'ok') return refused(standing.status, standing.detail, standing.confirmedBy);
  }
  return verdict;
}

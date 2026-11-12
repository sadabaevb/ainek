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
import { sameInstance, type ManagerAction } from './release.ts';
import type { KeyEntry } from './schema.ts';

const RELEASE = /^release:([0-9a-f]{16}):([0-9a-f]{64})$/;
const LOG = /^log:([0-9a-f]{16}):(\d{1,7}):([0-9a-f]{64})$/;

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
 * - `unlogged-release`: the entries carry no log mark at all (verifiers that do not write them yet).
 * - `untied-log`: the log cannot be tied to the instance that holds the key, so no mark can vouch for it.
 * - `unknown-release`: they carry marks, and none for the log as it stands: the enclave did something after the last
 *   verifier looked, or no verifier has seen this instance, or a verifier has seen a longer log than this one.
 * - `release-below-quorum`: some trusted verifiers marked the log as it stands, fewer than the client requires.
 * - `rewritten-log`: the log does not begin with what a trusted verifier saw from this instance.
 */
export type ReleaseLogStatus = 'ok' | ReleaseRefusal;
export interface ReleaseLogVerdict {
  status: ReleaseLogStatus;
  /** Distinct verifiers that logged the action log exactly as it stands. */
  confirmedBy: string[];
  detail: string;
}

/**
 * Checks the action log a client was attested against the marks of key-log entries. `entries` are the ones the key check
 * accepted: from trusted verifiers, fresh, for this key and this launcher. `instance` is the dstack instance id that both
 * the key's quote and the log's quote name; a log that cannot be tied to that instance matches no mark.
 */
export function evaluateRelease(entries: readonly KeyEntry[], attested: { actions: readonly ManagerAction[]; instance: Checked<string> }, quorum = 1): ReleaseLogVerdict {
  const { actions } = attested;
  const refused = (status: ReleaseRefusal, detail: string, confirmedBy: string[] = []): ReleaseLogVerdict => ({ status, confirmedBy, detail });
  const marks = entries.flatMap((entry) => marksOf(entry.image_digests).logs.map((seen) => ({ entry, seen })));
  if (marks.length === 0) return refused('unlogged-release', `none of the ${entries.length} log entr${entries.length === 1 ? 'y' : 'ies'} for this key and launcher carries a mark of the enclave's action log`);
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
  const confirmedBy = new Set<string>();
  let ahead: Seen | undefined; // a verifier saw a longer log than this one
  let behind: Seen | undefined; // the longest earlier state of this log a verifier marked
  for (const { entry, seen } of marks) {
    if (seen.instance !== instance) continue; // another instance behind the same key and launcher
    if (seen.length > actions.length) ahead = longest(ahead, { entry, length: seen.length });
    // An honest log begins with each of its earlier states, whenever those were seen: this is a mismatch no timing explains.
    else if (hashOfFirst(seen.length) !== seen.hash) return refused('rewritten-log', `the first ${seen.length} actions of the log attested now are not the ones entry #${entry.index} by ${entry.verifier} saw (${shortHex(hashOfFirst(seen.length))}, logged ${shortHex(seen.hash)})`);
    else if (seen.length === actions.length) confirmedBy.add(entry.verifier);
    else behind = longest(behind, { entry, length: seen.length });
  }

  // Either this attestation is older than that entry, and the enclave has moved on, or the log lost actions. The lengths
  // alone do not say which, so this is not called a rewrite; an exact match with an earlier mark does not outweigh it.
  if (ahead) return refused('unknown-release', `entry #${ahead.entry.index} by ${ahead.entry.verifier} saw ${ahead.length} actions from this instance and the log attested now has ${actions.length}: this attestation is older than that entry, or the log was cut`);
  const need = Math.max(1, quorum);
  if (confirmedBy.size >= need) return { status: 'ok', confirmedBy: [...confirmedBy], detail: `the action log as it stands (${actions.length} actions) was marked by ${[...confirmedBy].join(', ')}` };
  if (confirmedBy.size > 0) return refused('release-below-quorum', `only ${confirmedBy.size} of ${need} required verifiers marked the action log as it stands`, [...confirmedBy]);
  if (!behind) return refused('unknown-release', `no trusted verifier has marked the action log of this instance (${instance})`);
  const since = actions.length - behind.length;
  const last = actions.at(-1);
  return refused('unknown-release', `the enclave's action log has ${since} action${since === 1 ? '' : 's'} since entry #${behind.entry.index} by ${behind.entry.verifier} marked it (the latest: ${last?.action ?? '?'} at ${last?.timestamp ?? '?'}); no trusted verifier has marked the log as it stands`);
}

/** A verified model report as the release rule reads it. Structural, so this package needs no SDK import. */
export interface AttestedReport {
  signer: { signingAddress: string };
  deployment: { appCompose: string; composeManager?: { actions: readonly ManagerAction[] } | undefined };
  report: { eventLog?: unknown; composeManagerAttestation?: { eventLog?: unknown } | undefined };
}

/**
 * What the release rule says about one verified report: the entries that vouch for its key, and for its launcher when
 * `withLauncher` (the client asks for the launcher to be logged), against the action log the report attests.
 */
export function releaseStanding(entries: readonly KeyEntry[], query: Omit<KeyLogQuery, 'composeHash'>, { deployment, report }: AttestedReport, withLauncher: boolean): ReleaseLogVerdict {
  const vouching = evaluateKeyLog(entries, { ...query, composeHash: withLauncher ? composeHashOf(deployment) : undefined }).matching;
  const log = deployment.composeManager;
  // Both quotes are verified by now. When they name two instances the log is another replica's record, not this enclave's.
  const instance = log ? sameInstance(report.eventLog, report.composeManagerAttestation?.eventLog) : checked.skipped('the attested report carries no action log');
  return evaluateRelease(vouching, { actions: log?.actions ?? [], instance }, query.quorum);
}

/**
 * The release rule on top of a key verdict that passed: for every attested report behind the key, the entries that vouch
 * for it must also carry its action log exactly as it stands. A key whose enclave did something no verifier has looked at
 * is refused like a key nobody logged. A verdict that did not pass is returned as it is.
 *
 * The reports must be fresh: the rule says nothing about what the enclave did after it attested them. A client that keeps
 * verified reports for a while attests again before it applies this.
 */
export function withReleaseRule(verdict: KeyLogVerdict, entries: readonly KeyEntry[], query: Omit<KeyLogQuery, 'composeHash'>, reports: readonly AttestedReport[], withLauncher: boolean): KeyLogVerdict {
  if (verdict.status !== 'ok') return verdict;
  const refused = (reason: ReleaseRefusal, detail: string, confirmedBy: string[] = []): KeyLogVerdict => ({ ...verdict, status: 'not-logged', reason, confirmedBy, detail: `${detail}: not sent (fail-closed)` });
  const key = normalizeHex(query.signingAddress);
  const behindKey = reports.filter((r) => normalizeHex(r.signer.signingAddress) === key);
  if (behindKey.length === 0) return refused('unlogged-release', 'no attested report carries this key, so there is no action log to check');
  for (const report of behindKey) {
    const standing = releaseStanding(entries, query, report, withLauncher);
    if (standing.status !== 'ok') return refused(standing.status, standing.detail, standing.confirmedBy);
  }
  return verdict;
}

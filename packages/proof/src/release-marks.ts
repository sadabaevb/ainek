// What a verifier writes into a key-log entry about the code behind the key, and what a client makes of it.
//
// A key-log entry has always carried the image digests of the measured launcher (`image_digests`). The contract takes
// any text there (at most 16 values of at most 128 bytes), so two more kinds of value ride in the same field, each with a
// prefix no digest has. No schema changes, and a client that does not know them ignores them.
//
//   log:<16 hex of the instance id>:<number of actions>:<sha256 of those actions>
//     The action log the verifier was shown, as the enclave quotes it. A verifier writes it only after following the
//     release that log ends in to public sources (release-chain.ts): the compose file in the public repository, its tag,
//     the signed builds. So the mark says "a verifier checked what this log deployed", for the log exactly as it stood.
//
//   release:<16 hex of sha256(file path)>:<sha256 of the file>
//     Which release that was: the compose file that defines the model's service, as its latest `compose_up` read it. It
//     names the release in the public log, with the time it first appeared there. The client's rule reads the log mark.
//
// The client's rule (`evaluateRelease`): the action log attested now must be exactly one that enough trusted verifiers
// marked. An enclave deploys by appending to that log, so anything it did after a verifier looked is refused until a
// verifier looks again. The rule does not interpret the actions, so it does not depend on knowing which of them change
// what runs. And the log only grows: one that does not begin with what a verifier saw from the same instance was
// rewritten. No network is needed: the action log comes with the attestation the client already verified.
import type { Checked } from './checked.ts';
import { sha256Hex, shortHex } from './hash.ts';
import { composeHashOf } from './key-entry.ts';
import { evaluateKeyLog, type KeyLogQuery, type KeyLogVerdict, type ReleaseRefusal } from './key-log.ts';
import { sameInstance, type ManagerAction } from './release.ts';
import type { KeyEntry } from './schema.ts';

const RELEASE = /^release:([0-9a-f]{16}):([0-9a-f]{64})$/;
const LOG = /^log:([0-9a-f]{16}):(\d{1,7}):([0-9a-f]{64})$/;

const utf8 = new TextEncoder();
/** Order of two strings by their UTF-8 bytes, as the SDK orders the fields of an action. */
function byBytes(a: string, b: string): number {
  const x = utf8.encode(a);
  const y = utf8.encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return (x[i] ?? 0) - (y[i] ?? 0);
  return x.length - y.length;
}

/**
 * sha256 of an action log in the form the enclave quotes it and the SDK checks: a JSON array of objects, the fields of
 * each sorted by their UTF-8 bytes, no spaces. For the whole log this is the `actions_hash` of the report.
 */
export function actionsHash(actions: readonly ManagerAction[]): string {
  const json = `[${actions
    .map((action) => `{${Object.entries(action).sort(([a], [b]) => byBytes(a, b)).map(([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)}`).join(',')}}`)
    .join(',')}]`;
  return sha256Hex(json);
}

/** The short name a mark gives a compose file: paths can be longer than a mark may be. */
const fileIdOf = (file: string): string => sha256Hex(file).slice(0, 16);
/** The short name a mark gives a CVM instance: the start of its dstack instance id. */
const instanceIdOf = (instance: string): string => instance.toLowerCase().slice(0, 16);

/** The mark for one compose file as the action log last deployed it. */
export function releaseMark(file: string, fileSha256: string): string {
  return `release:${fileIdOf(file)}:${fileSha256.toLowerCase()}`;
}

/** The mark for an action log as it stands: whose it is, how long it is, and its hash. */
export function logMark(instance: string, actions: readonly ManagerAction[]): string {
  return `log:${instanceIdOf(instance)}:${actions.length}:${actionsHash(actions)}`;
}

export interface ReleaseMarks {
  releases: { fileId: string; fileSha256: string }[];
  logs: { instance: string; length: number; hash: string }[];
}

/** The marks among the `image_digests` of an entry. Anything else there (the launcher's image digests) is passed over. */
export function marksOf(imageDigests: readonly string[]): ReleaseMarks {
  const marks: ReleaseMarks = { releases: [], logs: [] };
  for (const value of imageDigests) {
    const release = RELEASE.exec(value);
    if (release?.[1] && release[2]) marks.releases.push({ fileId: release[1], fileSha256: release[2] });
    const log = LOG.exec(value);
    if (log?.[1] && log[2] && log[3]) marks.logs.push({ instance: log[1], length: Number(log[2]), hash: log[3] });
  }
  return marks;
}

/**
 * - `ok`: the action log the enclave attests is exactly one that enough trusted verifiers checked and logged.
 * - `unlogged-release`: the entries carry no log mark at all (verifiers that do not write them yet).
 * - `unknown-release`: they carry marks, and none for the log as it stands: the enclave did something after the last
 *   verifier looked, or no verifier has seen this instance, or the log cannot be tied to the instance that holds the key.
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
 * accepted: from trusted verifiers, fresh, for this key and this launcher. `instance` is the dstack instance id both the
 * key's quote and the log's quote name; without one the log cannot be matched to a mark, and nothing vouches for it.
 */
export function evaluateRelease(entries: readonly KeyEntry[], attested: { actions: readonly ManagerAction[]; instance?: string | undefined }, quorum = 1): ReleaseLogVerdict {
  const { actions } = attested;
  const refused = (status: ReleaseRefusal, detail: string, confirmedBy: string[] = []): ReleaseLogVerdict => ({ status, confirmedBy, detail });
  const marks = entries.flatMap((entry) => marksOf(entry.image_digests).logs.map((seen) => ({ entry, seen })));
  if (marks.length === 0) return refused('unlogged-release', `none of the ${entries.length} log entr${entries.length === 1 ? 'y' : 'ies'} for this key and launcher records an action log`);
  if (attested.instance === undefined) return refused('unknown-release', "the enclave's event log names no instance id, so no logged action log can be matched to it");
  const instance = instanceIdOf(attested.instance);

  const prefixes = new Map<number, string>(); // the hash of the first n actions, computed once per n
  const hashOfFirst = (n: number): string => {
    const known = prefixes.get(n) ?? actionsHash(actions.slice(0, n));
    prefixes.set(n, known);
    return known;
  };
  const confirmedBy = new Set<string>();
  let latest: { entry: KeyEntry; length: number } | undefined; // the longest earlier state of this log a verifier marked
  for (const { entry, seen } of marks) {
    if (seen.instance !== instance) continue; // another instance behind the same key and launcher
    if (seen.length > actions.length) return refused('rewritten-log', `entry #${entry.index} by ${entry.verifier} saw ${seen.length} actions from this instance; the log attested now has ${actions.length}`);
    if (hashOfFirst(seen.length) !== seen.hash) return refused('rewritten-log', `the first ${seen.length} actions of the log attested now are not the ones entry #${entry.index} by ${entry.verifier} saw (${shortHex(hashOfFirst(seen.length))}, logged ${shortHex(seen.hash)})`);
    if (seen.length === actions.length) confirmedBy.add(entry.verifier);
    else if (!latest || seen.length > latest.length) latest = { entry, length: seen.length };
  }

  const need = Math.max(1, quorum);
  if (confirmedBy.size >= need) return { status: 'ok', confirmedBy: [...confirmedBy], detail: `the action log as it stands (${actions.length} actions) was checked and logged by ${[...confirmedBy].join(', ')}` };
  if (confirmedBy.size > 0) return refused('unknown-release', `only ${confirmedBy.size} of ${need} required verifiers logged the action log as it stands`, [...confirmedBy]);
  if (!latest) return refused('unknown-release', `no trusted verifier has logged the action log of this instance (${instance})`);
  const since = actions.length - latest.length;
  const last = actions.at(-1);
  return refused('unknown-release', `the enclave's action log has ${since} action${since === 1 ? '' : 's'} since entry #${latest.entry.index} by ${latest.entry.verifier} saw it (the latest: ${last?.action ?? '?'} at ${last?.timestamp ?? '?'}); no trusted verifier has checked the log as it stands`);
}

/** One attested report behind a key: its launcher, its action log and the instance that quoted both. */
export interface AttestedLog {
  /** Undefined when the client does not ask for the launcher to be logged: then every entry for the key may vouch. */
  composeHash?: string | undefined;
  actions: readonly ManagerAction[];
  /** The instance id the key's quote and the log's quote both name; failed when they name two, skipped when one names none. */
  instance: Checked<string>;
}

/** The verified model reports that carry `signingAddress`, as the release rule reads them. Structural, so no SDK import. */
export function attestedLogsOf(
  reports: readonly {
    signer: { signingAddress: string };
    deployment: { appCompose: string; composeManager?: { actions: readonly ManagerAction[] } | undefined };
    report: { eventLog?: unknown; composeManagerAttestation?: { eventLog?: unknown } | undefined };
  }[],
  signingAddress: string,
  withLauncher: boolean,
): AttestedLog[] {
  return reports
    .filter((r) => r.signer.signingAddress.toLowerCase() === signingAddress.toLowerCase())
    .map((r) => ({ composeHash: withLauncher ? composeHashOf(r.deployment) : undefined, actions: r.deployment.composeManager?.actions ?? [], instance: sameInstance(r.report.eventLog, r.report.composeManagerAttestation?.eventLog) }));
}

/**
 * The release rule on top of a key verdict that passed: for every attested report behind the key, the entries that vouch
 * for its key and launcher must also carry its action log exactly as it stands. A key whose enclave did something no
 * verifier has looked at is refused like a key nobody logged. A verdict that did not pass is returned as it is.
 */
export function withReleaseRule(verdict: KeyLogVerdict, entries: readonly KeyEntry[], query: Omit<KeyLogQuery, 'composeHash'>, reports: readonly AttestedLog[]): KeyLogVerdict {
  if (verdict.status !== 'ok') return verdict;
  const refused = (reason: ReleaseRefusal, detail: string, confirmedBy: string[] = []): KeyLogVerdict => ({ ...verdict, status: 'not-logged', reason, confirmedBy, detail: `${detail}: not sent (fail-closed)` });
  if (reports.length === 0) return refused('unlogged-release', 'no attested report behind this key carries an action log');
  for (const report of reports) {
    // Both quotes verified and they name two instances: the log is another replica's record, not this enclave's.
    if (report.instance.status === 'fail') return refused('unknown-release', report.instance.why);
    const vouching = evaluateKeyLog(entries, { ...query, composeHash: report.composeHash }).matching;
    const release = evaluateRelease(vouching, { actions: report.actions, instance: report.instance.status === 'ok' ? report.instance.value : undefined }, verdict.quorum);
    if (release.status !== 'ok') return refused(release.status, release.detail, release.confirmedBy);
  }
  return verdict;
}

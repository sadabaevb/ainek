// What ran behind a model's key, read from the action log its enclave attests.
//
// On NEAR AI Cloud the measured compose of a model's CVM (the `compose-hash` in RTMR3) is a launcher: a telemetry sidecar,
// certbot, Compose Manager and its launcher. The containers that serve the model are started later by Compose Manager, from a
// compose file in a public repository (nearai/cvm-compose-files) at a commit an operator asks for. Compose Manager writes every
// such action to a log; the hash of that log is bound to a TDX quote of its own, and the SDK authenticates it during model
// verification (`deployment.composeManager.actions`). So the compose hash and the signing key can stay the same while the
// code that decrypts prompts changes: the action log is where that change shows.
//
// These helpers read that log. They are pure: fetching the compose file and its build provenance is the caller's job.
import { checked, type Checked } from './checked.ts';

/** Where NEAR AI keeps the compose files Compose Manager deploys (the SDK's default too). */
export const COMPOSE_REPOSITORY = 'nearai/cvm-compose-files';

/** One entry of the action log, with the wire names Compose Manager signs. Unknown fields are kept. */
export interface ManagerAction {
  readonly action: string;
  readonly timestamp: string;
  readonly tag?: string | readonly string[] | undefined;
  readonly commit?: string | undefined;
  readonly file?: string | undefined;
  readonly file_sha256?: string | undefined;
  readonly services?: readonly string[] | undefined;
  readonly image?: string | undefined;
  readonly [field: string]: string | readonly string[] | undefined;
}

/** One deployment: the `compose_up` that first ran a commit of a compose file. */
export interface Release {
  /** The tag Compose Manager checked out, when the action carries one. */
  tag?: string;
  /** Commit of the compose repository, lower-cased. */
  commit: string;
  /** Path of the compose file in that repository. */
  file: string;
  /** sha256 of the file as Compose Manager read it, lower-cased; older actions do not carry it. */
  fileSha256?: string;
  /** When that `compose_up` ran, as Compose Manager's clock wrote it (ISO 8601). */
  deployedAt: string;
}

const str = (v: string | readonly string[] | undefined): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/** Every `compose_up` that names a commit and a file, as the release it started and the services it named. */
function* composeUps(actions: readonly ManagerAction[]): Generator<{ release: Release; services: readonly string[] }> {
  for (const a of actions) {
    const commit = str(a.commit);
    const file = str(a.file);
    if (a.action !== 'compose_up' || !commit || !file) continue;
    const tag = str(a.tag);
    const fileSha256 = str(a.file_sha256);
    yield { release: { ...(tag ? { tag } : {}), commit: commit.toLowerCase(), file, ...(fileSha256 ? { fileSha256: fileSha256.toLowerCase() } : {}), deployedAt: a.timestamp }, services: a.services ?? [] };
  }
}

/**
 * The releases that deployed `service` from `file`, oldest first. A `compose_up` covers the service when it names it, or names
 * no services at all (Compose Manager then brings up the whole file). Consecutive actions of one commit are one release; a
 * commit that comes back after another one is a new release, so a rollback shows as one.
 */
export function releasesFor(actions: readonly ManagerAction[], target: { file: string; service: string }): Release[] {
  const releases: Release[] = [];
  for (const { release, services } of composeUps(actions)) {
    if (release.file !== target.file || (services.length > 0 && !services.includes(target.service))) continue;
    if (releases.at(-1)?.commit !== release.commit) releases.push(release);
  }
  return releases;
}

/**
 * Every commit of `file` the log deployed, oldest first, each at its first `compose_up` whatever services that one named:
 * the moment that commit first ran in the enclave. For "how long was this commit public before it served".
 */
export function firstDeployments(actions: readonly ManagerAction[], file: string): Release[] {
  const first = new Map<string, Release>();
  for (const { release } of composeUps(actions)) if (release.file === file && !first.has(release.commit)) first.set(release.commit, release);
  return [...first.values()];
}

/** The latest `compose_up` of every compose file the log deployed from, the most recently used file first. */
export function composeFilesOf(actions: readonly ManagerAction[]): Release[] {
  const latest = new Map<string, Release>();
  for (const { release } of composeUps(actions)) {
    latest.delete(release.file); // re-insert, so the map keeps the order of last use
    latest.set(release.file, release);
  }
  return [...latest.values()].reverse();
}

/** The image Compose Manager says it last started as, and when. The log is written by that image: see the caller's caveats. */
export function managerStartOf(actions: readonly ManagerAction[]): { image: string; startedAt: string } | undefined {
  for (let i = actions.length - 1; i >= 0; i--) {
    const a = actions[i];
    if (a && a.action === 'compose_manager_started' && a.image) return { image: a.image, startedAt: a.timestamp };
  }
  return undefined;
}

/** dstack's runtime event type: an event the guest extended RTMR3 with, by name. */
const RUNTIME_EVENT_TYPE = 0x08000001;

/**
 * The payload of the first RTMR3 runtime event of a name in a dstack event log (an array, or its JSON text), or undefined.
 * The first, not the last: dstack writes its own events during boot, and before dstack 0.6.0 a container holding the dstack
 * socket could append more under any name. The caller must have had the log replayed against the quote's RTMR3, which the
 * SDK does during verification; without that the log is only what a server said.
 */
export function firstRuntimeEvent(eventLog: unknown, name: string): string | undefined {
  let events: unknown = eventLog;
  if (typeof eventLog === 'string') {
    try {
      events = JSON.parse(eventLog);
    } catch {
      return undefined;
    }
  }
  if (!Array.isArray(events)) return undefined;
  for (const e of events as { imr?: unknown; event_type?: unknown; event?: unknown; event_payload?: unknown }[]) {
    if (e && e.imr === 3 && e.event_type === RUNTIME_EVENT_TYPE && e.event === name) return typeof e.event_payload === 'string' ? e.event_payload.toLowerCase() : undefined;
  }
  return undefined;
}

/**
 * Whether the quote behind an action log and the quote behind the signing key name one dstack instance id, given the event
 * log of each. The SDK checks that both booted from the same app compose, which every replica of a model does; this ties the
 * log to the replica that attested the key. It rules out a mix-up between replicas, not a host that runs two CVMs under one id.
 */
export function sameInstance(keyEventLog: unknown, logEventLog: unknown): Checked<string> {
  const key = firstRuntimeEvent(keyEventLog, 'instance-id');
  const log = firstRuntimeEvent(logEventLog, 'instance-id');
  if (!key || !log) return checked.skipped('an event log names no instance id');
  return key === log ? checked.ok(key) : checked.failed(`the log was quoted by instance ${log}, the signing key by instance ${key}`);
}

// The log is authenticated and still input from outside. What it names goes into GitHub URLs, so a caller checks the shape
// first: a path with `..` would climb out of the repository it is supposed to be read from.

/** A full git commit id. */
export function isCommitId(value: string): boolean {
  return /^[0-9a-f]{40}$/i.test(value);
}

/** A relative path with no empty, `.` or `..` segment. */
export function isRepoPath(value: string): boolean {
  return value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

/**
 * A tag name that can be looked up by name: letters, digits, `.`, `_` and `-`, starting with a letter or digit (one URL
 * segment, never a dot segment), and not all hex digits, which GitHub would read as a commit id.
 */
export function isPlainTag(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && !/^[0-9a-f]+$/i.test(value);
}

/** Milliseconds of an action or GitHub timestamp. Compose Manager writes nanoseconds, which `Date.parse` is not required to accept. */
export function timeOf(iso: string): number {
  return Date.parse(iso.replace(/(\.\d{3})\d+/, '$1'));
}

/** A span of time for a human: "36 s", "11 min", "2 h 14 min", "3 d 10 h". Negative spans read as "0 s", an unparsed one as "an unknown time". */
export function spanText(ms: number): string {
  if (!Number.isFinite(ms)) return 'an unknown time';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  if (min < 48 * 60) return `${Math.floor(min / 60)} h ${min % 60} min`;
  const h = Math.round(min / 60);
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

/** Whole minutes in a span of ms, rounded down and never negative: a time shown this way is never more than it is. */
export function wholeMinutes(ms: number): number {
  return Math.max(0, Math.floor(ms / 60_000));
}


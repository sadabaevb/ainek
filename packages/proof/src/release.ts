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

/** One deployment of a service: every consecutive `compose_up` of one commit of one file that covered the service. */
export interface Release {
  /** The tag Compose Manager checked out, when the action carries one. */
  tag?: string;
  /** Commit of the compose repository. */
  commit: string;
  /** Path of the compose file in that repository. */
  file: string;
  /** sha256 of the file as Compose Manager read it; older actions do not carry it. */
  fileSha256?: string;
  /** The first `compose_up` of this run, as Compose Manager's clock wrote it (ISO 8601). */
  deployedAt: string;
  /** How many `compose_up` actions of this run covered the service. */
  ups: number;
}

const str = (v: string | readonly string[] | undefined): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/**
 * The releases that deployed `service` from `file`, oldest first. A `compose_up` covers the service when it names it, or names
 * no services at all (Compose Manager then brings up the whole file). Consecutive actions of one commit are one release; a
 * commit that comes back after another one is a new release, so a rollback shows as one.
 */
export function releasesFor(actions: readonly ManagerAction[], target: { file: string; service: string }): Release[] {
  const releases: Release[] = [];
  for (const a of actions) {
    if (a.action !== 'compose_up' || a.file !== target.file) continue;
    const commit = str(a.commit);
    if (!commit) continue;
    const services = a.services ?? [];
    if (services.length > 0 && !services.includes(target.service)) continue;
    const last = releases.at(-1);
    if (last && last.commit === commit) {
      last.ups += 1;
      continue;
    }
    const tag = str(a.tag);
    const fileSha256 = str(a.file_sha256);
    releases.push({ ...(tag ? { tag } : {}), commit, file: target.file, ...(fileSha256 ? { fileSha256: fileSha256.toLowerCase() } : {}), deployedAt: a.timestamp, ups: 1 });
  }
  return releases;
}

/**
 * Every commit of `file` the log deployed, oldest first, each with its first `compose_up` whatever services that one named:
 * the moment that commit first ran in the enclave. For "how long was this commit public before it served".
 */
export function firstDeployments(actions: readonly ManagerAction[], file: string): Release[] {
  const first = new Map<string, Release>();
  for (const a of actions) {
    const commit = str(a.commit);
    if (a.action !== 'compose_up' || a.file !== file || !commit) continue;
    const seen = first.get(commit);
    if (seen) {
      seen.ups += 1;
      continue;
    }
    const tag = str(a.tag);
    const fileSha256 = str(a.file_sha256);
    first.set(commit, { ...(tag ? { tag } : {}), commit, file, ...(fileSha256 ? { fileSha256: fileSha256.toLowerCase() } : {}), deployedAt: a.timestamp, ups: 1 });
  }
  return [...first.values()];
}

/** Compose files the log deployed from, the most recently used first, each with the commit of its latest `compose_up`. */
export function composeFilesOf(actions: readonly ManagerAction[]): { file: string; commit: string; fileSha256?: string }[] {
  const latest = new Map<string, { file: string; commit: string; fileSha256?: string }>();
  for (const a of actions) {
    const commit = str(a.commit);
    if (a.action !== 'compose_up' || !a.file || !commit) continue;
    const fileSha256 = str(a.file_sha256);
    latest.delete(a.file); // re-insert, so the map keeps the order of last use
    latest.set(a.file, { file: a.file, commit, ...(fileSha256 ? { fileSha256: fileSha256.toLowerCase() } : {}) });
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

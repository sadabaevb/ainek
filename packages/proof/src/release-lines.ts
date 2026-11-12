// What a release inspection found, in words: one line per fact, each with the state of its check. The CLI prints these
// lines and the proof card lists them, so the two surfaces cannot word the same finding differently. English whatever the
// language of the interface, like the other check details of this package.
import type { Checked } from './checked.ts';
import { shortHex } from './hash.ts';
import { COMPOSE_REPOSITORY, spanText, timeOf, type Release } from './release.ts';
import type { ReleaseLogVerdict } from './release-marks.ts';
import type { ImageCheck, ReleaseInspection, ServiceRelease, SourceChange } from './release-types.ts';

/** One fact of an inspection: `ok` was checked and held, `fail` was checked and did not, `skipped` was not checked or is only a reading. */
export interface ReleaseLine {
  status: 'ok' | 'fail' | 'skipped';
  text: string;
}
type Add = (status: ReleaseLine['status'], text: string) => void;

// Timestamps come from the action log and from GitHub: one that does not parse is said to be unreadable, not thrown on.
const isoOf = (time: string): string | undefined => {
  const ms = timeOf(time);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
};
/** `2026-11-12 07:09 UTC` for a timestamp of the action log or of GitHub. */
export const utcText = (time: string): string => {
  const iso = isoOf(time);
  return iso ? `${iso.slice(0, 16).replace('T', ' ')} UTC` : 'an unreadable time';
};
const day = (time: string): string => isoOf(time)?.slice(0, 10) ?? 'an unreadable date';
const digestText = (digest: string | undefined): string => (digest ? `sha256:${shortHex(digest.replace(/^sha256:/, ''))}` : 'no digest');
/** What a release is called: its tag, or the start of its commit id when the action carried none. */
export const releaseName = (release: Release): string => release.tag ?? release.commit.slice(0, 10);
/** `1 commit`, `4 commits`. */
export const countText = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** One line for a check: what it found, or why it failed, or why it was not made. */
function say<T>(add: Add, check: Checked<T>, text: { ok: (value: T) => string; fail: string; skipped: string }): void {
  if (check.status === 'ok') add('ok', text.ok(check.value));
  else add(check.status, `${check.status === 'fail' ? text.fail : text.skipped}: ${check.why}`);
}

function imageLine(add: Add, role: string, { image, provenance }: ImageCheck): void {
  const name = `${role}: ${image.repository}@${digestText(image.digest)}`;
  say(add, provenance, {
    ok: (p) => `${name}, built from ${p.repository}@${p.commit.slice(0, 10)} (${p.ref}) by ${p.workflow}; signed build provenance verified`,
    fail: `${name}; build provenance did not verify`,
    skipped: `${name}; build provenance not checked`,
  });
}

/** From the previous build's source to the current one's. A current build that lacks commits the previous one had is a step back. */
function sourceText({ ahead, behind, files }: SourceChange): string {
  if (ahead === 0 && behind === 0) return 'the same source commit';
  const forward = `${countText(ahead, 'commit')}, ${files >= 300 ? '300 or more files' : countText(files, 'file')} changed`; // GitHub's comparison lists at most 300 files
  if (behind === 0) return forward;
  return ahead === 0 ? `an older source: ${countText(behind, 'commit')} behind the previous build` : `a diverged source: ${forward}, and ${countText(behind, 'commit')} of the previous build missing`;
}

function serviceLines(add: Add, s: ServiceRelease, model: string, now: number): void {
  const r = s.release;
  add('ok', `release serving ${model}: ${r.tag ? `${r.tag}, ` : ''}commit ${r.commit.slice(0, 10)} of ${COMPOSE_REPOSITORY}, ${r.file}, service ${s.service}, deployed ${utcText(r.deployedAt)}`);
  say(add, s.file, { ok: (f) => `the public file at that commit hashes to the sha256 the enclave recorded (${shortHex(f.sha256)})`, fail: 'the file does not match', skipped: 'the file was not compared' });
  say(add, s.tag, { ok: (tag) => `tag ${tag} of ${COMPOSE_REPOSITORY} points at that commit, so the commit is the repository's own and not a fork's`, fail: 'the tag does not match', skipped: "the tag was not checked, so the commit may be a fork's" });
  if (s.proxy) imageLine(add, 'proxy (decrypts the prompt, signs the answer)', s.proxy);
  else add('skipped', 'the service names no image in the file: nothing to check');
  if (s.engines.length === 0) add('skipped', 'engine: the file names none through VLLM_BACKEND_URLS that this reads');
  else {
    // An engine can be brought up alone: one whose own latest release is not the proxy's is shown as that release defines it.
    const apart = [...new Set(s.engines.flatMap((e) => (e.release ? [releaseName(e.release)] : [])))];
    add('skipped', `engine: ${[...new Set(s.engines.map((e) => (e.image ? `${e.image.repository}@${digestText(e.image.digest)}` : 'image not read')))].join(', ')} (${countText(s.engines.length, 'service')}${apart.length > 0 ? `, last brought up by another release than the proxy: ${apart.join(', ')}` : ''}); no build policy for it, not checked`);
  }
  const weights = [...new Set(s.engines.flatMap((e) => (e.weights ? [`${e.weights.repository}, snapshot ${e.weights.snapshot.slice(0, 8)}`] : [])))];
  if (weights.length > 0) add('skipped', `weights named in the file: ${weights.join('; ')}; attestation does not hash weights`);
  // Two clocks nobody attests: a reading, so never a check mark.
  if (s.committedAt.status === 'ok') add('skipped', `committed ${utcText(s.committedAt.value)} by GitHub's record, deployed ${spanText(timeOf(r.deployedAt) - timeOf(s.committedAt.value))} later, ${spanText(now - timeOf(r.deployedAt))} ago`);
  else add('skipped', `when the commit was made: not checked: ${s.committedAt.why}`);
  if (s.previousBuild) {
    const { release: was, proxy, change } = s.previousBuild;
    const source = proxy.provenance.status === 'ok' ? ` from ${proxy.provenance.value.repository}@${proxy.provenance.value.commit.slice(0, 10)}` : '';
    const delta = change.status === 'ok' ? `; ${sourceText(change.value)}: ${change.value.url}` : '';
    add(proxy.provenance.status === 'fail' ? 'fail' : 'skipped', `previous build of the proxy: ${digestText(proxy.image.digest)}${source}, in release ${releaseName(was)} (deployed ${utcText(was.deployedAt)})${delta}${proxy.provenance.status === 'fail' ? `; its build provenance did not verify: ${proxy.provenance.why}` : ''}`);
  }
  const first = s.history[0];
  if (first) add('skipped', `releases of this service in the log: ${s.history.length} since ${day(first.deployedAt)}${s.history.length > 1 ? ` (${releaseName(first)} … ${releaseName(r)})` : ''}`);
}

/** The manager's image, and what the measured compose says about it and about the tag age it demands. */
function managerLines(add: Add, { manager, launcher }: ReleaseInspection): void {
  if (manager) imageLine(add, `manager (writes this log; started ${utcText(manager.startedAt)})`, manager);
  if (launcher.status !== 'ok') {
    add('skipped', `the measured compose was not read for the manager's image and tag age: ${launcher.why}`);
    return;
  }
  // The log is the manager's own word for which image it is. The measured compose is not: when both name one image, the
  // manager that booted is part of the compose hash. dstack hands a CVM only the variables its app compose lists as allowed.
  const boot = manager?.boot;
  if (boot) {
    const variable = boot.variable ? `the fallback of ${boot.variable}, which is ${boot.settable ? '' : 'not '}in the app's allowed_envs` : undefined;
    if (!boot.image.digest) add('skipped', `the measured compose pins no image for the manager (${boot.raw})`);
    else if (!boot.same) add('skipped', `this is not the image the measured compose starts the manager as (${digestText(boot.image.digest)}): ${boot.settable ? `the operator may have set ${boot.variable}, which is in the app's allowed_envs, or the measured launcher replaced the image after boot` : 'it was replaced after boot, which the measured launcher exists to do'}. What identifies it is the log's own record and the build provenance`);
    else if (boot.settable) add('skipped', `this is the measured compose's default for the manager (${variable}): the operator may set another, so the compose hash does not fix the image`);
    else add('ok', `this is the image the measured compose starts the manager as${variable ? ` (${variable})` : ''}: at boot it is part of the compose hash`);
  }
  const age = launcher.value.minTagAge;
  if (age) {
    const meaning = !age.variable ? '' : `: ${age.fallback === undefined ? 'unset' : `${age.fallback} h`} unless ${age.variable} is set. That variable is ${age.settable ? "in the app's allowed_envs: the operator may set it, and the measurement does not show its value" : "not in the app's allowed_envs"}`;
    add('skipped', `minimum age of a tag before it may run: the measured compose gives the manager MIN_TAG_AGE_HOURS=${age.raw}${meaning}. Compose Manager's own default is 48 h`);
  }
}

/**
 * The lines of an inspection, in the order they are read, and one line for a summary (undefined when no release was
 * resolved). The summary names the release and, when its build was verified, the source it was built from.
 */
export function describeRelease(inspection: ReleaseInspection, { model, now = Date.now() }: { model: string; now?: number }): { lines: ReleaseLine[]; summary?: string } {
  const lines: ReleaseLine[] = [];
  const add: Add = (status, text) => void lines.push({ status, text });
  const { log } = inspection;
  add('ok', `action log: ${log.actions === 0 ? 'no actions' : `${countText(log.actions, 'action')}, ${day(log.since)} to ${day(log.until)}`}, manager quote TCB ${log.tcbStatus}`);
  say(add, log.instance, { ok: (id) => `the log and the signing key were quoted by one CVM instance (${shortHex(id)}), not by two replicas`, fail: "this is another machine's log", skipped: "whether the log is this replica's was not checked" });
  if (inspection.unresolved) add('skipped', `the release serving ${model} was not resolved: ${inspection.unresolved}`);
  for (const s of inspection.services) serviceLines(add, s, model, now);
  managerLines(add, inspection);
  const [served] = inspection.services;
  if (!served) return { lines };
  const built = served.proxy?.provenance.status === 'ok' ? `, proxy built from ${served.proxy.provenance.value.repository}@${served.proxy.provenance.value.commit.slice(0, 10)}` : '';
  return { lines, summary: `release ${releaseName(served.release)} deployed ${utcText(served.release.deployedAt)}${built}` };
}

/**
 * Where the public key log stands on the enclave's action log, in the words of the rule that decides it
 * (`releaseStanding` in release-marks.ts): one line, the same in `pnpm demo:attest` and on /log. `enforced` says whether
 * this client refuses by the rule or only shows what it would say.
 */
export function releaseInLogLine(inLog: ReleaseLogVerdict, enforced: boolean): ReleaseLine {
  if (inLog.status === 'ok') return { status: 'ok', text: `key log: ${inLog.detail}` };
  // A log that does not continue what a verifier saw is not a matter of a setting.
  if (inLog.status === 'rewritten-log') return { status: 'fail', text: `key log: the enclave's action log was rewritten: ${inLog.detail}` };
  return { status: 'skipped', text: `key log: ${inLog.detail} (${enforced ? 'AINEK_REQUIRE_RELEASE is on' : 'AINEK_REQUIRE_RELEASE is off, so this client sends all the same; with it on it would not'})` };
}

/**
 * A verdict with one more finding read into it: a line that failed fails the verdict and is named among its failures,
 * like any check that did not hold. Any other line leaves the verdict as it was.
 */
export function withFinding<V extends { status: 'ok' | 'fail' | 'skipped'; failures: string[] }>(verdict: V, line: ReleaseLine): V {
  return line.status === 'fail' ? { ...verdict, status: 'fail', failures: [...verdict.failures, line.text] } : verdict;
}


// Prints what `inspectRelease` found: the release that serves the model, from the enclave's action log to a source commit.
// It only prints. Which checks failed is `failedChecks` in @ainek/tier1-node/release: a line here is marked as failed, not
// checked or fine by the same `Checked` values that function reads.
import { shortHex as short, spanText, timeOf, type Checked } from '@ainek/proof';
import { COMPOSE_REPOSITORY, type ImageCheck, type LeadTime, type ReleaseInspection, type ServiceRelease, type SourceChange } from '@ainek/tier1-node/release';
import { NA, OK, head, line, markOf } from './term.ts';

// Timestamps come from the action log and from GitHub: one that does not parse is said to be unreadable, not thrown on.
const isoOf = (time: string): string | undefined => {
  const ms = timeOf(time);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
};
const utc = (time: string): string => {
  const iso = isoOf(time);
  return iso ? `${iso.slice(0, 16).replace('T', ' ')} UTC` : 'an unreadable time';
};
const day = (time: string): string => isoOf(time)?.slice(0, 10) ?? 'an unreadable date';
const digestText = (digest: string | undefined): string => (digest ? `sha256:${short(digest.replace(/^sha256:/, ''))}` : 'no digest');
const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** One line for a check: what it found, or why it failed, or why it was not made. */
function say<T>(check: Checked<T>, text: { ok: (value: T) => string; fail: string; skipped: string }): void {
  if (check.status === 'ok') line(OK, text.ok(check.value));
  else line(markOf(check.status), `${check.status === 'fail' ? text.fail : text.skipped}: ${check.why}`);
}

function imageLine(role: string, { image, provenance }: ImageCheck): void {
  const name = `${role}: ${image.repository}@${digestText(image.digest)}`;
  say(provenance, {
    ok: (p) => `${name}, built from ${p.repository}@${p.commit.slice(0, 10)} (${p.ref}) by ${p.workflow}; signed build provenance verified`,
    fail: `${name}; build provenance did not verify`,
    skipped: `${name}; build provenance not checked`,
  });
}

/** From the previous build's source to the current one's. A current build that lacks commits the previous one had is a step back. */
function sourceText({ ahead, behind, files }: SourceChange): string {
  if (ahead === 0 && behind === 0) return 'the same source commit';
  const forward = `${count(ahead, 'commit')}, ${files >= 300 ? '300 or more files' : count(files, 'file')} changed`; // GitHub's comparison lists at most 300 files
  if (behind === 0) return forward;
  return ahead === 0 ? `an older source: ${count(behind, 'commit')} behind the previous build` : `a diverged source: ${forward}, and ${count(behind, 'commit')} of the previous build missing`;
}

function printService(s: ServiceRelease, model: string, now: number): void {
  const r = s.release;
  line(OK, `release serving ${model}: ${r.tag ? `${r.tag}, ` : ''}commit ${r.commit.slice(0, 10)} of ${COMPOSE_REPOSITORY}, ${r.file}, service ${s.service}, deployed ${utc(r.deployedAt)}`);
  say(s.file, { ok: (f) => `the public file at that commit hashes to the sha256 the enclave recorded (${short(f.sha256)})`, fail: 'the file does not match', skipped: 'the file was not compared' });
  say(s.tag, { ok: (tag) => `tag ${tag} of ${COMPOSE_REPOSITORY} points at that commit, so the commit is the repository's own and not a fork's`, fail: 'the tag does not match', skipped: "the tag was not checked, so the commit may be a fork's" });
  if (s.proxy) imageLine('proxy (decrypts the prompt, signs the answer)', s.proxy);
  else line(NA, 'the service names no image in the file: nothing to check');
  if (s.engines.length === 0) line(NA, 'engine: the file names none through VLLM_BACKEND_URLS that this reads');
  else {
    // An engine can be brought up alone: one whose own latest release is not the proxy's is shown as that release defines it.
    const apart = [...new Set(s.engines.flatMap((e) => (e.release ? [e.release.tag ?? e.release.commit.slice(0, 10)] : [])))];
    line(NA, `engine: ${[...new Set(s.engines.map((e) => (e.image ? `${e.image.repository}@${digestText(e.image.digest)}` : 'image not read')))].join(', ')} (${count(s.engines.length, 'service')}${apart.length > 0 ? `, last brought up by another release than the proxy: ${apart.join(', ')}` : ''}); no build policy for it, not checked`);
  }
  const weights = [...new Set(s.engines.flatMap((e) => (e.weights ? [`${e.weights.repository}, snapshot ${e.weights.snapshot.slice(0, 8)}`] : [])))];
  if (weights.length > 0) line(NA, `weights named in the file: ${weights.join('; ')}; attestation does not hash weights`);
  // Two clocks nobody attests: a reading, so never a check mark.
  if (s.committedAt.status === 'ok') line(NA, `committed ${utc(s.committedAt.value)} by GitHub's record, deployed ${spanText(timeOf(r.deployedAt) - timeOf(s.committedAt.value))} later, ${spanText(now - timeOf(r.deployedAt))} ago`);
  else line(NA, `when the commit was made: not checked: ${s.committedAt.why}`);
  if (s.previousBuild) {
    const { release: was, proxy, change } = s.previousBuild;
    const source = proxy.provenance.status === 'ok' ? ` from ${proxy.provenance.value.repository}@${proxy.provenance.value.commit.slice(0, 10)}` : '';
    const delta = change.status === 'ok' ? `; ${sourceText(change.value)}: ${change.value.url}` : '';
    line(markOf(proxy.provenance.status === 'fail' ? 'fail' : 'skipped'), `previous build of the proxy: ${digestText(proxy.image.digest)}${source}, in release ${was.tag ?? was.commit.slice(0, 10)} (deployed ${utc(was.deployedAt)})${delta}${proxy.provenance.status === 'fail' ? `; its build provenance did not verify: ${proxy.provenance.why}` : ''}`);
  }
  const first = s.history[0];
  if (first) line(NA, `releases of this service in the log: ${s.history.length} since ${day(first.deployedAt)}${s.history.length > 1 ? ` (${first.tag ?? first.commit.slice(0, 10)} … ${r.tag ?? r.commit.slice(0, 10)})` : ''}`);
}

/** The manager's image, and what the measured compose says about it and about the tag age it demands. */
function printManager({ manager, launcher }: ReleaseInspection): void {
  if (manager) imageLine(`manager (writes this log; started ${utc(manager.startedAt)})`, manager);
  if (launcher.status !== 'ok') {
    line(NA, `the measured compose was not read for the manager's image and tag age: ${launcher.why}`);
    return;
  }
  // The log is the manager's own word for which image it is. The measured compose is not: when both name one image, the
  // manager that booted is part of the compose hash. dstack hands a CVM only the variables its app compose lists as allowed.
  const boot = manager?.boot;
  if (boot) {
    const variable = boot.variable ? `the fallback of ${boot.variable}, which is ${boot.settable ? '' : 'not '}in the app's allowed_envs` : undefined;
    if (!boot.image.digest) line(NA, `the measured compose pins no image for the manager (${boot.raw})`);
    else if (!boot.same) line(NA, `this is not the image the measured compose starts the manager as (${digestText(boot.image.digest)}): ${boot.settable ? `the operator may have set ${boot.variable}, which is in the app's allowed_envs, or the measured launcher replaced the image after boot` : 'it was replaced after boot, which the measured launcher exists to do'}. What identifies it is the log's own record and the build provenance`);
    else if (boot.settable) line(NA, `this is the measured compose's default for the manager (${variable}): the operator may set another, so the compose hash does not fix the image`);
    else line(OK, `this is the image the measured compose starts the manager as${variable ? ` (${variable})` : ''}: at boot it is part of the compose hash`);
  }
  const age = launcher.value.minTagAge;
  if (age) {
    const meaning = !age.variable ? '' : `: ${age.fallback === undefined ? 'unset' : `${age.fallback} h`} unless ${age.variable} is set. That variable is ${age.settable ? "in the app's allowed_envs: the operator may set it, and the measurement does not show its value" : "not in the app's allowed_envs"}`;
    line(NA, `minimum age of a tag before it may run: the measured compose gives the manager MIN_TAG_AGE_HOURS=${age.raw}${meaning}. Compose Manager's own default is 48 h`);
  }
}

/**
 * Prints the code section and returns one line for the summary card, or undefined when no release was resolved.
 * `logEntryIndex` is the key-log entry the send decision used: it is for the launcher, and the section says so.
 */
export function printRelease(inspection: ReleaseInspection | undefined, { model, logEntryIndex, now = Date.now() }: { model: string; logEntryIndex: number; now?: number }): string | undefined {
  head("5. Code behind the key: what the enclave's manager deployed (its action log, bound to a TDX quote of its own)");
  if (!inspection) {
    line(NA, 'this model report carries no action log: not checked');
    return undefined;
  }
  const { log } = inspection;
  line(OK, `action log: ${log.actions === 0 ? 'no actions' : `${count(log.actions, 'action')}, ${day(log.since)} to ${day(log.until)}`}, manager quote TCB ${log.tcbStatus}`);
  say(log.instance, { ok: (id) => `the log and the signing key were quoted by one CVM instance (${short(id)}), not by two replicas`, fail: "this is another machine's log", skipped: "whether the log is this replica's was not checked" });
  if (inspection.unresolved) line(NA, `the release serving ${model} was not resolved: ${inspection.unresolved}`);
  for (const s of inspection.services) printService(s, model, now);
  printManager(inspection);
  line(NA, `the key log does not record releases: entry #${logEntryIndex} is for the launcher's compose hash, which a release does not change`);
  const [served] = inspection.services;
  if (!served) return undefined;
  const built = served.proxy?.provenance.status === 'ok' ? `, proxy built from ${served.proxy.provenance.value.repository}@${served.proxy.provenance.value.commit.slice(0, 10)}` : '';
  return `release ${served.release.tag ?? served.release.commit.slice(0, 10)} deployed ${utc(served.release.deployedAt)}${built}`;
}

/** The nearest thing to a typical value that is itself one of the measurements or the mean of the middle two. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/** Prints, for every commit of a file the log deployed, how long the commit had existed when it first ran. */
export function printLeadTimes(file: string, times: LeadTime[]): void {
  head(`6. Every release of ${file} in the log: how long each commit had existed when it first ran in the enclave`);
  for (const t of times) {
    const label = `${utc(t.release.deployedAt)}  ${(t.release.tag ?? '').padEnd(9)} ${t.release.commit.slice(0, 10)}`;
    if (t.committedAt.status !== 'ok') line(NA, `${label}  commit time not read: ${t.committedAt.why}`);
    else line(NA, `${label}  committed ${utc(t.committedAt.value)}  ${t.leadMs === undefined ? 'a time does not parse' : spanText(t.leadMs)}`);
  }
  const leads = times.flatMap((t) => (t.leadMs === undefined ? [] : [t.leadMs]));
  if (leads.length === 0) return;
  const under = (hours: number) => leads.filter((ms) => ms < hours * 3_600_000).length;
  line(NA, `${count(leads.length, 'release')} with a commit time: median ${spanText(median(leads))}, shortest ${spanText(Math.min(...leads))}, longest ${spanText(Math.max(...leads))}; ${under(1)} under an hour, ${under(48)} under 48 h`);
  line(NA, "commit times are GitHub's record of the committer (for a merged pull request, the merge); deployment times are Compose Manager's clock: neither is a trusted timestamp");
}

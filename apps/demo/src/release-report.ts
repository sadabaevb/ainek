// Prints what `inspectRelease` found: the release that serves the model, from the enclave's action log to a source commit.
// Shared by the live modes. A line is a failure only when something was checked and did not hold; a check that could not be
// made (GitHub's rate limit, no build policy for an image) is marked as not checked and does not fail the run.
import { shortHex as short, spanText, timeOf } from '@ainek/proof';
import type { ImageCheck, LeadTime, ReleaseInspection } from '@ainek/tier1-node/release';
import { COMPOSE_REPOSITORY } from '@ainek/tier1-node/release';
import { FAIL, NA, OK, head, line, markOf, plain } from './term.ts';

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

function imageLine(role: string, check: ImageCheck): boolean {
  const name = `${check.image.repository}@${digestText(check.image.digest)}`;
  const p = check.provenance;
  if (p.status === 'ok') return line(OK, `${role}: ${name}, built from ${p.value.repository}@${p.value.commit.slice(0, 10)} (${p.value.ref}) by ${p.value.workflow}; signed build provenance verified`);
  return line(markOf(p.status), `${role}: ${name}; build provenance ${p.status === 'fail' ? 'did not verify' : 'not checked'}: ${p.why}`);
}

/**
 * Prints the code section and returns whether a check failed, plus one line for the summary card (undefined when there is
 * nothing to say). `logEntryIndex` is the key-log entry the send decision used: it is for the launcher, and the section says so.
 */
export function printRelease(inspection: ReleaseInspection | undefined, { model, logEntryIndex, now = Date.now() }: { model: string; logEntryIndex: number; now?: number }): { failed: boolean; summary?: string } {
  head("5. Code behind the key: what the enclave's manager deployed (its action log, bound to a TDX quote of its own)");
  if (!inspection) {
    line(NA, 'this model report carries no action log: not checked');
    return { failed: false };
  }
  let failed = false;
  const fail = (isFailure: boolean) => void (failed ||= isFailure);
  const { log } = inspection;
  line(OK, `action log: ${log.actions === 0 ? 'no actions' : `${count(log.actions, 'action')}, ${day(log.since)} to ${day(log.until)}`}, manager quote TCB ${log.tcbStatus}`);
  if (log.instance.status === 'ok') line(OK, `the log and the signing key were quoted by one CVM instance (${short(log.instance.value)}), not by two replicas`);
  else fail(line(markOf(log.instance.status), log.instance.status === 'fail' ? `this is another machine's log: ${log.instance.why}` : `whether the log is this replica's was not checked: ${log.instance.why}`));
  if (inspection.unresolved) line(NA, `the release serving ${model} was not resolved: ${inspection.unresolved}`);
  let summary: string | undefined;
  for (const s of inspection.services) {
    const r = s.release;
    const name = r.tag ?? r.commit.slice(0, 10);
    line(OK, `release serving ${model}: ${r.tag ? `${r.tag}, ` : ''}commit ${r.commit.slice(0, 10)} of ${COMPOSE_REPOSITORY}, ${r.file}, service ${s.service}, deployed ${utc(r.deployedAt)}`);
    if (s.file.status === 'ok') line(OK, `the public file at that commit hashes to the sha256 the enclave recorded (${short(s.file.value.sha256)})`);
    else fail(line(markOf(s.file.status), s.file.status === 'fail' ? `the file does not match: ${s.file.why}` : `the file was not compared: ${s.file.why}`));
    if (s.tag.status === 'ok') line(OK, `tag ${s.tag.value} of ${COMPOSE_REPOSITORY} points at that commit, so the commit is the repository's own and not a fork's`);
    else fail(line(markOf(s.tag.status), s.tag.status === 'fail' ? `the tag does not match: ${s.tag.why}` : `the tag was not checked, so the commit may be a fork's: ${s.tag.why}`));
    if (s.proxy) fail(imageLine('proxy (decrypts the prompt, signs the answer)', s.proxy));
    else line(NA, 'the service names no image in the file: nothing to check');
    const engineImages = [...new Set(s.engines.map((e) => (e.image ? `${e.image.repository}@${digestText(e.image.digest)}` : 'no image')))];
    if (s.engines.length > 0) line(NA, `engine: ${engineImages.join(', ')} (${count(s.engines.length, 'service')}); no build policy for it, not checked`);
    const weights = [...new Set(s.engines.flatMap((e) => (e.weights ? [`${e.weights.repository}, snapshot ${e.weights.snapshot.slice(0, 8)}`] : [])))];
    if (weights.length > 0) line(NA, `weights named in the file: ${weights.join('; ')}; attestation does not hash weights`);
    if (s.committedAt.status === 'ok') line(NA, `committed ${utc(s.committedAt.value)} by GitHub's record, deployed ${spanText(timeOf(r.deployedAt) - timeOf(s.committedAt.value))} later, ${spanText(now - timeOf(r.deployedAt))} ago`);
    else line(NA, `when the commit was made: not checked: ${s.committedAt.why}`);
    if (s.previousBuild) {
      const { release: was, proxy, change } = s.previousBuild;
      const source = proxy.provenance.status === 'ok' ? ` from ${proxy.provenance.value.repository}@${proxy.provenance.value.commit.slice(0, 10)}` : '';
      // GitHub's comparison lists at most 300 files.
      const delta = change.status === 'ok' ? `; ${count(change.value.commits, 'commit')}, ${change.value.files >= 300 ? '300 or more files' : count(change.value.files, 'file')} changed: ${change.value.url}` : '';
      line(NA, `previous build of the proxy: ${digestText(proxy.image.digest)}${source}, in release ${was.tag ?? was.commit.slice(0, 10)} (deployed ${utc(was.deployedAt)})${delta}`);
      if (proxy.provenance.status === 'fail') fail(line(FAIL, `the previous build's provenance did not verify: ${proxy.provenance.why}`));
    }
    const first = s.history[0];
    if (first) line(NA, `releases of this service in the log: ${s.history.length} since ${day(first.deployedAt)}${s.history.length > 1 ? ` (${first.tag ?? first.commit.slice(0, 10)} … ${name})` : ''}`);
    const built = s.proxy?.provenance.status === 'ok' ? `, proxy built from ${s.proxy.provenance.value.repository}@${s.proxy.provenance.value.commit.slice(0, 10)}` : '';
    summary ??= plain(`release ${name} deployed ${utc(r.deployedAt)}${built}`);
  }
  const { manager, minTagAge } = inspection;
  if (manager) {
    fail(imageLine(`manager (writes this log; started ${utc(manager.startedAt)})`, manager));
    // The log is the manager's own word for which image it is. The measured compose is not: when both name one image, the
    // manager that booted is part of the compose hash.
    const boot = manager.boot;
    // dstack hands a CVM only the environment variables its app compose lists in `allowed_envs`.
    const variable = boot?.variable ? `the fallback of ${boot.variable}, which is ${boot.settable ? '' : 'not '}in the app's allowed_envs` : undefined;
    if (!boot) line(NA, 'the measured compose was not read for the image it starts the manager as');
    else if (!boot.image.digest) line(NA, `the measured compose pins no image for the manager (${boot.image.raw})`);
    else if (!boot.same) line(NA, `this is not the image the measured compose starts the manager as (${digestText(boot.image.digest)}): it was replaced after boot, which the measured launcher exists to do. What identifies it is the log's own record and the build provenance`);
    else if (boot.settable) line(NA, `this is the measured compose's default for the manager (${variable}): the operator may set another, so the compose hash does not fix the image`);
    else line(OK, `this is the image the measured compose starts the manager as${variable ? ` (${variable})` : ''}: at boot it is part of the compose hash`);
  }
  if (minTagAge) {
    const { raw, variable, fallback, settable } = minTagAge;
    const meaning = !variable ? '' : `: ${fallback === undefined ? 'unset' : `${fallback} h`} unless ${variable} is set. That variable is ${settable ? "in the app's allowed_envs: the operator may set it, and the measurement does not show its value" : "not in the app's allowed_envs"}`;
    line(NA, `minimum age of a tag before it may run: the measured compose gives the manager MIN_TAG_AGE_HOURS=${raw}${meaning}. Compose Manager's own default is 48 h`);
  }
  line(NA, `the key log does not record releases: entry #${logEntryIndex} is for the launcher's compose hash, which a release does not change`);
  return { failed, ...(summary ? { summary } : {}) };
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
    if (t.committedAt.status === 'ok' && t.leadMs !== undefined) line(NA, `${label}  committed ${utc(t.committedAt.value)}  ${spanText(t.leadMs)}`);
    else line(NA, `${label}  commit time not read: ${t.committedAt.status === 'ok' ? 'no lead time' : t.committedAt.why}`);
  }
  const leads = times.flatMap((t) => (t.leadMs === undefined ? [] : [t.leadMs]));
  if (leads.length === 0) return;
  const under = (hours: number) => leads.filter((ms) => ms < hours * 3_600_000).length;
  line(NA, `${count(leads.length, 'release')} with a commit time: median ${spanText(median(leads))}, shortest ${spanText(Math.min(...leads))}, longest ${spanText(Math.max(...leads))}; ${under(1)} under an hour, ${under(48)} under 48 h`);
  line(NA, "commit times are GitHub's record of the committer (for a merged pull request, the merge); deployment times are Compose Manager's clock: neither is a trusted timestamp");
}

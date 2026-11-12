// Prints what `inspectRelease` found: the release that serves the model, from the enclave's action log to a source commit.
// It only prints. The words are `describeRelease` of @ainek/proof/release-chain, which the proof card shows too, and which
// checks failed is `failedChecks` there: a line is marked failed, not checked or fine by the same `Checked` values.
import { spanText, type KeyLogVerdict } from '@ainek/proof';
import { countText as count, describeRelease, utcText as utc, type LeadTime, type ReleaseInspection } from '@ainek/tier1-node/release';
import { FAIL, NA, OK, head, line, markOf } from './term.ts';

/**
 * Prints the code section and returns one line for the summary card, or undefined when no release was resolved.
 * `inLog` is the client's release rule (SPEC §7.5) applied to the log this run read, and `enforced` whether this client
 * is set to refuse by it: the section ends with where the key log stands on the action log the enclave attests.
 */
export function printRelease(inspection: ReleaseInspection | undefined, { model, inLog, enforced, now = Date.now() }: { model: string; inLog: KeyLogVerdict; enforced: boolean; now?: number }): string | undefined {
  head("5. Code behind the key: what the enclave's manager deployed (its action log, bound to a TDX quote of its own)");
  if (!inspection) {
    line(NA, 'this model report carries no action log: not checked');
    return undefined;
  }
  const { lines, summary } = describeRelease(inspection, { model, now });
  for (const l of lines) line(markOf(l.status), l.text);
  printReleaseInLog(inLog, enforced);
  return summary;
}

/** Where the key log stands on the enclave's action log, in the words of the rule that decides it (release-marks.ts). */
function printReleaseInLog(inLog: KeyLogVerdict, enforced: boolean): void {
  const setting = enforced ? 'AINEK_REQUIRE_RELEASE is on' : 'AINEK_REQUIRE_RELEASE is off, so this client sends all the same; with it on it would not';
  const why = inLog.detail.replace(': not sent (fail-closed)', '');
  if (inLog.status === 'ok') line(OK, `key log: the enclave's action log as it stands is one a trusted verifier checked and logged (${inLog.confirmedBy.join(', ')})`);
  // A log that does not continue what a verifier saw is not a matter of a setting.
  else if (inLog.reason === 'rewritten-log') line(FAIL, `key log: the enclave's action log was rewritten: ${why}`);
  else line(NA, `key log: ${why} (${setting})`);
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

// Prints what `inspectRelease` found: the release that serves the model, from the enclave's action log to a source commit.
// It only prints. The words are `describeRelease` of @ainek/proof/release-chain, which the proof card shows too, and which
// checks failed is `failedChecks` there: a line is marked failed, not checked or fine by the same `Checked` values.
import { spanText } from '@ainek/proof';
import { countText as count, describeRelease, utcText as utc, type LeadTime, type ReleaseInspection, type ReleaseLine } from '@ainek/tier1-node/release';
import { NA, head, line, markOf } from './term.ts';

/**
 * Prints the code section and returns one line for the summary card, or undefined when no release was resolved.
 * `keyLog` is the last line of the section: where the key log stands on the action log the enclave attests (SPEC §7.5).
 */
export function printRelease(inspection: ReleaseInspection | undefined, { model, keyLog, now = Date.now() }: { model: string; keyLog: ReleaseLine; now?: number }): string | undefined {
  head("5. Code behind the key: what the enclave's manager deployed (its action log, bound to a TDX quote of its own)");
  const { lines, summary } = inspection ? describeRelease(inspection, { model, now }) : { lines: [{ status: 'skipped', text: 'this model report carries no action log: not checked' }], summary: undefined };
  for (const l of [...lines, keyLog]) line(markOf(l.status), l.text);
  return summary;
}

/**
 * Prints what three outside parties say about the state this report attests. A check mark is "this party has looked at
 * exactly this"; what it concluded is in its line. None of it takes part in the result of the command.
 */
export function printOutside(lines: readonly ReleaseLine[]): void {
  head('Who else has looked at exactly this (three public readings, none of them ours; shown, not applied)');
  for (const l of lines) line(markOf(l.status), l.text);
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

// `pnpm demo:controls`: negative controls on the recorded evidence. Offline, no API key.
//
// `pnpm demo` shows the recording passing. This shows what must not pass: every control in control-table.ts changes one
// thing in that same recording, and the check has to refuse it for the reason the control is about. The same table runs
// as tests (controls.test.ts, part of `pnpm test`).
import { HEADINGS, controlSet, refusalOf } from './control-table.ts';
import { loadRecording } from './evidence.ts';
import { FAIL, NA, OK, exitFlushed, head, line } from './term.ts';

const rec = loadRecording();
const { unchanged, rows } = controlSet(rec);

console.log(`Ainek negative controls: recording of ${rec.manifest.reportCapturedAt.slice(0, 10)}. Offline, no API key.`);
console.log('Each line changes one thing in the evidence `pnpm demo` accepts. Every one of them has to be refused.');

// Unchanged, everything is accepted. Without this a refusal below could come from a broken recording, not from the change.
head('0. Unchanged: the same checks on the recording as it is');
let baseline = true;
for (const { what, attempt } of unchanged) {
  const problem = await refusalOf(attempt);
  if (problem !== undefined) baseline = false;
  line(problem === undefined ? OK : FAIL, problem === undefined ? `${what}: accepted` : `${what}: not accepted, so the controls show nothing: ${problem}`);
}

let controls = 0;
let failed = 0;
let notes = 0;
let heading = -1;
for (const row of rows) {
  if (row.heading !== heading) head(`${row.heading + 1}. ${HEADINGS[(heading = row.heading)]}`);
  if ('note' in row) {
    notes += 1;
    line(NA, row.note);
    continue;
  }
  controls += 1;
  const refusal = await refusalOf(row.attempt);
  const held = refusal !== undefined && refusal.includes(row.expect);
  if (!held) failed += 1;
  line(held ? OK : FAIL, held ? `${row.what} → refused: ${refusal}` : refusal === undefined ? `${row.what} → ACCEPTED: this change must be refused` : `${row.what} → refused, but not for this change (expected ${row.expect}): ${refusal}`);
}

const ok = baseline && failed === 0;
const result = !baseline ? 'NOT RUN. The recording is not accepted unchanged.' : ok ? `REFUSED. ${controls} of ${controls} changes were refused, each for its own reason.` : `${failed} of ${controls} changes were NOT refused as they must be.`;
console.log(`\nResult: ${result}`);
console.log(`The ${notes} lines marked ${NA} are not controls: each says where the control for that part is, or that there is none.`);
await exitFlushed(ok ? 0 : 1);

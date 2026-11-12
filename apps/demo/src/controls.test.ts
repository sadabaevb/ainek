import { test } from 'node:test';
import assert from 'node:assert/strict';
import { controlSet, judge, type Control } from './control-table.ts';
import { loadRecording } from './evidence.ts';

// The table `pnpm demo:controls` narrates, as tests: the recording is accepted unchanged, and every change to it is
// refused with the code its control expects. A refusal for another reason fails here too: it would mean the change was
// never looked at.
const { unchanged, rows } = controlSet(loadRecording());
const controls = rows.filter((row): row is Control => !('note' in row));

for (const { what, attempt } of unchanged) {
  test(`unchanged, ${what} is accepted`, async () => {
    assert.equal(await attempt(), undefined);
  });
}

for (const control of controls) {
  test(`${control.what} is refused (${control.expect})`, async () => {
    const { held, refusal } = await judge(control);
    assert.ok(refusal !== undefined, 'the change was accepted');
    assert.ok(held, `refused for another reason: ${refusal.code}: ${refusal.detail}`);
  });
}

test('the table: 15 controls, something under each of the six headings, and no note that reports a failure', () => {
  // The documents say 15 and quote the result line. A recording without an action log would make it 14: change both together.
  assert.equal(controls.length, 15);
  assert.deepEqual([...new Set(rows.map((r) => r.heading))], [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(rows.filter((r) => 'note' in r && r.failed), []);
});

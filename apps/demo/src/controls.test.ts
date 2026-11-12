import { test } from 'node:test';
import assert from 'node:assert/strict';
import { controlSet, refusalOf } from './control-table.ts';
import { loadRecording } from './evidence.ts';

// The table `pnpm demo:controls` narrates, as tests: the recording is accepted unchanged, and every change to it is
// refused for the reason its control names. A refusal for another reason fails here too: it would mean the change was
// never looked at.
const { unchanged, rows } = controlSet(loadRecording());

for (const { what, attempt } of unchanged) {
  test(`unchanged, ${what} is accepted`, async () => {
    assert.equal(await refusalOf(attempt), undefined);
  });
}

for (const row of rows) {
  if ('note' in row) continue;
  test(`${row.what} is refused (${row.expect})`, async () => {
    const refusal = await refusalOf(row.attempt);
    assert.ok(refusal !== undefined, 'the change was accepted');
    assert.ok(refusal.includes(row.expect), `refused for another reason: ${refusal}`);
  });
}

test('the table has a control or a note under each of the six headings', () => {
  assert.deepEqual([...new Set(rows.map((r) => r.heading))], [0, 1, 2, 3, 4, 5]);
  assert.ok(rows.filter((r) => !('note' in r)).length >= 14);
});

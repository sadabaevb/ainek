import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hoursSince, observedUtc, utcMinuteOf } from './format.ts';

test('a log entry\'s time is shown at minute precision, UTC', () => {
  assert.equal(observedUtc(String(Date.UTC(2026, 10, 13, 0, 56, 30))), '2026-11-13 00:56 UTC');
});

// `observed_at` is whatever the verifier wrote. One entry with a value no Date can hold used to throw while /log was
// rendering, for every visitor and for as long as the entry stayed in the window.
test('a time no Date can hold is said, not thrown', () => {
  for (const value of ['8640000000000001', '1794511126000000000', '18446744073709551615']) {
    assert.equal(observedUtc(value), 'an unreadable time', value);
    assert.match(hoursSince(value), /^(\d+\.\d|\?)$/, value);
  }
  assert.equal(utcMinuteOf(Number.NaN), 'an unreadable time');
});

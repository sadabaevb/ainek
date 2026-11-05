import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withRetry } from './retry.ts';

const flaky = (failures: number) => {
  let calls = 0;
  return { fn: async () => { calls++; if (calls <= failures) throw new Error(`flaky ${calls}`); return calls; }, calls: () => calls };
};
const always = () => true;

test('withRetry: a retryable failure is retried and every retry is reported', async () => {
  const f = flaky(2);
  let retries = 0;
  assert.equal(await withRetry(f.fn, { retryable: always, pauseMs: 0, onRetry: () => retries++ }), 3);
  assert.equal(retries, 2);
});

test('withRetry: a failure the predicate rejects is thrown at once', async () => {
  const f = flaky(1);
  await assert.rejects(withRetry(f.fn, { retryable: () => false, pauseMs: 0 }), /flaky 1/);
  assert.equal(f.calls(), 1);
});

test('withRetry: the last failure is thrown when the attempts run out', async () => {
  const f = flaky(5);
  await assert.rejects(withRetry(f.fn, { retryable: always, attempts: 3, pauseMs: 0 }), /flaky 3/);
  assert.equal(f.calls(), 3);
});

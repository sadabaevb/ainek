import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { base64ToBytes } from './disclosure.ts';
import { readRepoJson } from './fixtures.ts';
import { bytesToHex } from './hash.ts';
import { PolicyRun, fmspcOf, taskHashOf, tryVerifyQuote } from './policy-run.ts';

const sample = PolicyRun.parse(readRepoJson<{ attestation: unknown }>('docs/samples/policy-run.sample.json').attestation);

test('the task hash layout matches the report data of every real quote we have', () => {
  const dir = new URL('../../../docs/spike-outlayer/', import.meta.url);
  const runs = [sample, ...readdirSync(dir).filter((f) => f.endsWith('.attestation.json')).map((f) => PolicyRun.parse(readRepoJson(`docs/spike-outlayer/${f}`)))];
  assert.ok(runs.length >= 4);
  for (const run of runs) assert.equal(taskHashOf(run), bytesToHex(base64ToBytes(run.tdx_quote).subarray(568, 600)), String(run.task_id));
});

test('fmspcOf reads the platform id from the quote certificate', () => {
  assert.equal(fmspcOf(base64ToBytes(sample.tdx_quote)), 'b0c06f000000');
  assert.equal(fmspcOf(new Uint8Array(10)), null);
});

test('tryVerifyQuote: a verifier that throws is a result, not a crash', () => {
  const result = tryVerifyQuote(() => { throw new Error('bad signature'); }, new Uint8Array(1), {}, 0);
  assert.deepEqual(result, { error: 'bad signature' });
});

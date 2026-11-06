import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { canonicalJson } from './canonical.ts';
import { base64ToBytes } from './disclosure.ts';
import { readRepoJson } from './fixtures.ts';
import { bytesToHex, sha256Hex } from './hash.ts';
import { PolicyRun, fmspcOf, taskHashOf, tryVerifyQuote } from './policy-run.ts';

const sample = PolicyRun.parse(readRepoJson<{ attestation: unknown }>('docs/samples/policy-run.sample.json').attestation);

test('the task hash layout matches the report data of every real quote we have', () => {
  const dir = new URL('../../../docs/spike-outlayer/', import.meta.url);
  const runs = [sample, ...readdirSync(dir).filter((f) => f.endsWith('.attestation.json')).map((f) => PolicyRun.parse(readRepoJson(`docs/spike-outlayer/${f}`)))];
  assert.ok(runs.length >= 4);
  for (const run of runs) {
    const reportData = bytesToHex(base64ToBytes(run.tdx_quote).subarray(568, 600));
    assert.equal(taskHashOf(run), reportData, String(run.task_id));
    // A record of an on-chain run with its block height taken out must not pass as a run made over HTTPS.
    if (run.block_height !== null && run.block_height !== undefined) assert.notEqual(taskHashOf({ ...run, block_height: null }), reportData, String(run.task_id));
  }
});

// The agent calls the job over HTTPS, and that record differs from an on-chain run's: no block height, and the input hash covers the input as sent.
test('a run made over HTTPS: no block height, and the hashes cover the canonical input and output', () => {
  const run = PolicyRun.parse(readRepoJson('docs/spike-outlayer/by-call-allow.attestation.json'));
  const io = readRepoJson<{ input: string; output: string }>('docs/spike-outlayer/by-call-allow.io.json');
  assert.equal(run.block_height ?? null, null);
  // The memo is Cyrillic with quotes and an emoji: OutLayer hashes the bytes as sent, it does not re-escape them.
  for (const text of [io.input, io.output]) assert.equal(canonicalJson(JSON.parse(text)), text);
  assert.equal(sha256Hex(io.input), run.input_hash);
  assert.equal(sha256Hex(io.output), run.output_hash);
});

test('fmspcOf reads the platform id from the quote certificate', () => {
  assert.equal(fmspcOf(base64ToBytes(sample.tdx_quote)), 'b0c06f000000');
  assert.equal(fmspcOf(new Uint8Array(10)), null);
});

test('tryVerifyQuote: a verifier that throws is a result, not a crash', () => {
  const result = tryVerifyQuote(() => { throw new Error('bad signature'); }, new Uint8Array(1), {}, 0);
  assert.deepEqual(result, { error: 'bad signature' });
});

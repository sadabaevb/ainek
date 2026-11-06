import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { canonicalJson } from './canonical.ts';
import { base64ToBytes } from './disclosure.ts';
import { readRepoJson } from './fixtures.ts';
import { bytesToHex, sha256Hex } from './hash.ts';
import { PolicyRun, checkPolicyRun, fmspcOf, taskHashOf, tryVerifyQuote } from './policy-run.ts';

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

// What a verified quote says about the record `quoted`. The signature itself is checked in tier1-node's dcap.test.ts.
const bindingOf = (run: PolicyRun, quoted: PolicyRun = run) =>
  checkPolicyRun({
    run,
    input: '',
    output: '',
    wasmHash: run.wasm_hash,
    quote: { tcbStatus: 'UpToDate', advisoryIds: [], reportData: `${taskHashOf(quoted)}${'0'.repeat(64)}`, measurements: { mrtd: '', rtmr0: '', rtmr1: '', rtmr2: '', rtmr3: run.worker_measurement } },
  }).find((c) => c.id === 'run-binding');

const byCall = PolicyRun.parse(readRepoJson('docs/spike-outlayer/by-call-allow.attestation.json'));
const sameHash = 'the same bytes cut differently hash the same, which is why the form is checked';

test('the form check passes every real record we have', () => {
  const dir = new URL('../../../docs/spike-outlayer/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.attestation.json'));
  for (const run of [sample, ...files.map((f) => PolicyRun.parse(readRepoJson(`docs/spike-outlayer/${f}`)))]) assert.equal(bindingOf(run)?.status, 'ok', String(run.task_id));
});

test('a text field moved across a field boundary is refused', () => {
  const moved = { ...byCall, repo_url: 'wasm32', build_target: '-wasip1' };
  assert.equal(taskHashOf(moved), taskHashOf(byCall), sameHash);
  assert.equal(bindingOf(moved, byCall)?.status, 'fail');
});

test('a run of other code cannot be rewritten to name the published build', () => {
  const [other, input, output] = ['a', 'b', 'c'].map((c) => c.repeat(64));
  const real = { ...byCall, commit_hash: `${byCall.build_target}${byCall.wasm_hash}${byCall.input_hash}${byCall.output_hash}`, wasm_hash: other!, input_hash: input!, output_hash: output! };
  const forged = { ...byCall, caller_account_id: `${byCall.build_target}${other}${input}${output}${byCall.caller_account_id}` };
  assert.equal(taskHashOf(forged), taskHashOf(real), sameHash);
  assert.match(bindingOf(forged, real)?.detail ?? '', /caller_account_id is not a NEAR account/);
});

test('an on-chain record cannot pass as a run over HTTPS by moving its block height into the caller', () => {
  const height = new Uint8Array(8);
  new DataView(height.buffer).setBigInt64(0, BigInt(sample.block_height ?? 0), true);
  const forged = { ...sample, block_height: null, caller_account_id: `${new TextDecoder().decode(height)}${sample.caller_account_id}` };
  assert.equal(taskHashOf(forged), taskHashOf(sample), sameHash);
  assert.equal(bindingOf(forged, sample)?.status, 'fail');
});

test('fmspcOf reads the platform id from the quote certificate', () => {
  assert.equal(fmspcOf(base64ToBytes(sample.tdx_quote)), 'b0c06f000000');
  assert.equal(fmspcOf(new Uint8Array(10)), null);
});

test('tryVerifyQuote: a verifier that throws is a result, not a crash', () => {
  const result = tryVerifyQuote(() => { throw new Error('bad signature'); }, new Uint8Array(1), {}, 0);
  assert.deepEqual(result, { error: 'bad signature' });
});

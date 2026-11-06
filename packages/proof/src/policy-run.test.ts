import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { canonicalJson } from './canonical.ts';
import { base64ToBytes } from './disclosure.ts';
import { readRepoJson } from './fixtures.ts';
import { bytesToHex, sha256Hex } from './hash.ts';
import { PolicyRun, checkPolicyRun, fmspcOf, taskHashOf, tryVerifyQuote } from './policy-run.ts';

const sample = PolicyRun.parse(readRepoJson<{ attestation: unknown }>('docs/samples/policy-run.sample.json').attestation);
const byCall = PolicyRun.parse(readRepoJson('docs/spike-outlayer/by-call-allow.attestation.json'));
const io = readRepoJson<{ input: string; output: string }>('docs/spike-outlayer/by-call-allow.io.json');

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
  assert.equal(byCall.block_height ?? null, null);
  // The memo is Cyrillic with quotes and an emoji: OutLayer hashes the bytes as sent, it does not re-escape them.
  for (const text of [io.input, io.output]) assert.equal(canonicalJson(JSON.parse(text)), text);
  assert.equal(sha256Hex(io.input), byCall.input_hash);
  assert.equal(sha256Hex(io.output), byCall.output_hash);
});

const project = 'ainek-dev-dastan.testnet/policy';
/** What the check says when the API serves `served` and the verified quote is really about `quoted`. The signature itself is checked in tier1-node's dcap.test.ts. */
const bindingOf = (served: PolicyRun, quoted: PolicyRun = served) =>
  checkPolicyRun({
    run: served,
    ...io,
    wasmHash: byCall.wasm_hash,
    project,
    quote: { tcbStatus: 'UpToDate', advisoryIds: [], reportData: `${taskHashOf(quoted)}${'0'.repeat(64)}`, measurements: { mrtd: '', rtmr0: '', rtmr1: '', rtmr2: '', rtmr3: served.worker_measurement } },
  }).find((c) => c.id === 'run-binding')?.status;
const sameBytes = 'the same bytes cut differently hash the same, which is why the hash is rebuilt from known values';

test('the binding: a real record passes, and how a record cuts the same bytes changes nothing', () => {
  assert.equal(bindingOf(byCall), 'ok');
  const moved = { ...byCall, repo_url: 'wasm32', build_target: '-wasip1' };
  assert.equal(taskHashOf(moved), taskHashOf(byCall), sameBytes);
  assert.equal(bindingOf(moved, byCall), 'ok');
});

test('the binding: a run of other code cannot be rewritten to name the published build', () => {
  const [other, input, output] = ['a', 'b', 'c'].map((c) => c.repeat(64));
  const real = { ...byCall, commit_hash: `${byCall.build_target}${byCall.wasm_hash}${byCall.input_hash}${byCall.output_hash}`, wasm_hash: other!, input_hash: input!, output_hash: output! };
  const forged = { ...byCall, caller_account_id: `${byCall.build_target}${other}${input}${output}${byCall.caller_account_id}` };
  assert.equal(taskHashOf(forged), taskHashOf(real), sameBytes);
  assert.equal(bindingOf(forged, real), 'fail');
});

test('the binding: a run under another project cannot be rewritten to name ours, even with our secrets', () => {
  const real = { ...byCall, caller_account_id: 'evil.testnet', project_id: `evilz${project}` };
  const forged = { ...byCall, caller_account_id: 'evil.testnetevilz' };
  assert.equal(taskHashOf(forged), taskHashOf(real), sameBytes);
  assert.equal(bindingOf(forged, real), 'fail');
});

test('the binding: another caller, other secrets or none, and an on-chain record without its height all fail', () => {
  for (const over of [{ caller_account_id: 'other.testnet' }, { secrets_ref: 'other.testnet/default' }, { secrets_ref: null }]) assert.equal(bindingOf({ ...byCall, ...over }), 'fail', JSON.stringify(over));
  assert.equal(bindingOf(byCall, { ...byCall, block_height: 276457284 }), 'fail');
});

test('fmspcOf reads the platform id from the quote certificate', () => {
  assert.equal(fmspcOf(base64ToBytes(sample.tdx_quote)), 'b0c06f000000');
  assert.equal(fmspcOf(new Uint8Array(10)), null);
});

test('tryVerifyQuote: a verifier that throws is a result, not a crash', () => {
  const result = tryVerifyQuote(() => { throw new Error('bad signature'); }, new Uint8Array(1), {}, 0);
  assert.deepEqual(result, { error: 'bad signature' });
});

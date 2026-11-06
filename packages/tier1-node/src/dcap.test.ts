import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PolicyRun, base64ToBytes, checkPolicyRun, fmspcOf, taskHashOf, type PolicyRunEvidence } from '@ainek/proof';
import { verifyTdxQuote } from './dcap.ts';

const read = (path: string) => JSON.parse(readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8'));
const sample = read('docs/samples/policy-run.sample.json') as { attestation: unknown; output: string; collateral: unknown; measurementsApproved: boolean };
const run = PolicyRun.parse(sample.attestation);
const wasmHash = run.wasm_hash;
const quoteOf = (r: PolicyRun) => verifyTdxQuote(base64ToBytes(r.tdx_quote), sample.collateral, r.timestamp);
const evidence = (over: Partial<PolicyRunEvidence> = {}): PolicyRunEvidence => ({ run, output: sample.output, wasmHash, project: 'ainek-dev-dastan.testnet/policy', quote: quoteOf(run), measurementsApproved: sample.measurementsApproved, ...over });
const statusOf = (e: PolicyRunEvidence, id: string) => checkPolicyRun(e).find((c) => c.id === id)?.status;

test('a real run: Intel signed the quote, and the quote commits to the published build and to this decision', () => {
  assert.deepEqual(checkPolicyRun(evidence()).map((c) => [c.id, c.status]), [['run-build', 'ok'], ['run-output', 'ok'], ['run-quote', 'ok'], ['run-binding', 'ok'], ['run-worker', 'ok']]);
});

test('an edited decision is not what the run printed', () => {
  assert.equal(statusOf(evidence({ output: sample.output.replace('"verdict":"Allow"', '"verdict":"Deny"') }), 'run-output'), 'fail');
});

test('another build fails twice: against the published hash, and against what the quote commits to', () => {
  const other = { ...run, wasm_hash: 'ab'.repeat(32), executed_wasm_sha256: 'ab'.repeat(32) };
  const e = evidence({ run: other });
  assert.equal(statusOf(e, 'run-build'), 'fail');
  assert.equal(statusOf(e, 'run-binding'), 'fail');
  assert.equal(statusOf(evidence({ wasmHash: 'cd'.repeat(32) }), 'run-build'), 'fail');
  assert.equal(statusOf(evidence({ project: 'someone.testnet/policy' }), 'run-build'), 'fail');
});

test('an altered quote does not verify, and nothing is then read from it', () => {
  const bytes = base64ToBytes(run.tdx_quote);
  bytes[600] = (bytes[600] ?? 0) ^ 1;
  assert.throws(() => verifyTdxQuote(bytes, sample.collateral, run.timestamp));
  const e = evidence({ quote: { error: 'bad signature' } });
  assert.deepEqual([statusOf(e, 'run-quote'), statusOf(e, 'run-binding'), statusOf(e, 'run-worker')], ['fail', 'skipped', 'skipped']);
});

test('no quote check or no worker list is said plainly, never read as passing', () => {
  const unverified = evidence();
  delete unverified.quote;
  assert.deepEqual([statusOf(unverified, 'run-quote'), statusOf(unverified, 'run-binding')], ['skipped', 'skipped']);
  assert.equal(statusOf(evidence({ measurementsApproved: null }), 'run-worker'), 'skipped');
  assert.equal(statusOf(evidence({ measurementsApproved: false }), 'run-worker'), 'fail');
  assert.equal(statusOf(evidence({ run: { ...run, worker_measurement: 'ff'.repeat(48) } }), 'run-worker'), 'fail');
});

test('the task hash layout matches the report data of every real quote we have', () => {
  const spike = new URL('../../../docs/spike-outlayer/', import.meta.url);
  const runs = [run, ...readdirSync(spike).filter((f) => f.endsWith('.attestation.json')).map((f) => PolicyRun.parse(read(`docs/spike-outlayer/${f}`)))];
  assert.ok(runs.length >= 4);
  for (const r of runs) assert.equal(taskHashOf(r), Buffer.from(base64ToBytes(r.tdx_quote)).subarray(568, 600).toString('hex'), String(r.task_id));
});

test('fmspcOf reads the platform id from the quote certificate', () => {
  assert.equal(fmspcOf(base64ToBytes(run.tdx_quote)), 'b0c06f000000');
  assert.equal(fmspcOf(new Uint8Array(10)), null);
});

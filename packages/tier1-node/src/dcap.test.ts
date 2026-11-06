import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { ActionProof, PolicyInput, PolicyOutput, PolicyRun, actionCommitOf, actionRunChecks, base64ToBytes, checkPolicyRun, type PolicyRunEvidence } from '@ainek/proof';
import { verifyTdxQuote } from './dcap.ts';

const read = (path: string) => JSON.parse(readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8'));
const sample = read('docs/samples/policy-run.sample.json') as { attestation: unknown; input: string; output: string; collateral: unknown; published: { wasmHash: string; project: string }; measurementsApproved: boolean };
const run = PolicyRun.parse(sample.attestation);
const { wasmHash, project } = sample.published;
const quote = verifyTdxQuote(base64ToBytes(run.tdx_quote), sample.collateral, run.timestamp);
const evidence = (over: Partial<PolicyRunEvidence> = {}): PolicyRunEvidence => ({ run, input: sample.input, output: sample.output, wasmHash, project, quote, measurementsApproved: sample.measurementsApproved, ...over });
const statusOf = (e: PolicyRunEvidence, id: string) => checkPolicyRun(e).find((c) => c.id === id)?.status;

test('a real run: Intel signed the quote, and the quote commits to the published build and to this decision', () => {
  assert.deepEqual(checkPolicyRun(evidence()).map((c) => [c.id, c.status]), [['run-build', 'ok'], ['run-input', 'ok'], ['run-output', 'ok'], ['run-quote', 'ok'], ['run-binding', 'ok'], ['run-worker', 'ok']]);
});

test('an edited decision is not what the run printed', () => {
  assert.equal(statusOf(evidence({ output: sample.output.replace('"verdict":"Allow"', '"verdict":"Deny"') }), 'run-output'), 'fail');
});

test('a real run on another input does not pass: spent_today is not in the signed decision', () => {
  assert.equal(statusOf(evidence({ input: sample.input.replace('"spent_today":"0"', '"spent_today":"999"') }), 'run-input'), 'fail');
});

test('a real run over HTTPS passes every check against Intel', () => {
  const byCall = PolicyRun.parse(read('docs/spike-outlayer/by-call-allow.attestation.json'));
  const io = read('docs/spike-outlayer/by-call-allow.io.json') as { input: string; output: string };
  const checks = checkPolicyRun({ run: byCall, input: io.input, output: io.output, wasmHash, project, quote: verifyTdxQuote(base64ToBytes(byCall.tdx_quote), sample.collateral, byCall.timestamp), measurementsApproved: true });
  assert.deepEqual(checks.filter((c) => c.status !== 'ok'), []);
});

test('an action proof: its decision is rebuilt into what the run printed, and the quote passes against Intel in the same way', async () => {
  const byCall = read('docs/spike-outlayer/by-call-allow.attestation.json') as object;
  const io = read('docs/spike-outlayer/by-call-allow.io.json') as { input: string; output: string };
  const { action, model_proof_commit } = PolicyInput.parse(JSON.parse(io.input));
  const { decision, sig, pubkey, wasm_hash } = PolicyOutput.parse(JSON.parse(io.output));
  const proof = ActionProof.parse({ v: 1, kind: 'action', actionId: 0, action, actionCommit: actionCommitOf(action), modelProofCommit: model_proof_commit, decision, teeSignature: sig, teePubkey: pubkey, wasmHash: wasm_hash, attestationUrl: 'https://api.test/attestations/by-call/x', proposeTx: 'tx' });
  const f = (async (url: unknown) => {
    const text = String(url);
    if (text.endsWith('/attestations/by-call/x')) return new Response(JSON.stringify(byCall));
    if (text.includes('/public/collateral')) return new Response(JSON.stringify({ collateral: JSON.stringify(sample.collateral) }));
    return new Response(JSON.stringify({ result: { result: [...Buffer.from('true')] } })); // is_measurements_approved over JSON-RPC
  }) as typeof fetch;
  const realFetch = globalThis.fetch;
  globalThis.fetch = f; // the view call goes through the global one
  const checks = await actionRunChecks(proof, { apiUrl: 'https://api.test', project, wasmHash, rpcUrl: 'https://rpc.test', network: 'testnet', verifyQuote: verifyTdxQuote, fetch: f }).finally(() => {
    globalThis.fetch = realFetch;
  });
  assert.deepEqual(checks.map((c) => [c.id, c.status]), [['run-build', 'ok'], ['run-input', 'skipped'], ['run-output', 'ok'], ['run-quote', 'ok'], ['run-binding', 'ok'], ['run-worker', 'ok']]);
});

test('freshness is checked only where it is asked for, and an old run or one from the future fails it', () => {
  assert.equal(checkPolicyRun(evidence()).some((c) => c.id === 'run-fresh'), false);
  const at = (now: number) => statusOf(evidence({ freshness: { nowSeconds: now, maxAgeSeconds: 600 } }), 'run-fresh');
  assert.equal(at(run.timestamp + 10), 'ok');
  assert.equal(at(run.timestamp + 601), 'fail');
  assert.equal(at(run.timestamp - 121), 'fail');
});

test('the recording is of the build the agent is set to expect: a redeploy has to record a new sample, or the demo would tell a stale story', () => {
  const env = parseEnv(readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8'));
  assert.equal(sample.published.wasmHash, env['OUTLAYER_WASM_HASH']);
  assert.equal(sample.published.project, env['OUTLAYER_PROJECT']);
  assert.equal(run.wasm_hash, sample.published.wasmHash);
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

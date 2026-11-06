import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PolicyOutput, type PolicyInput } from '@ainek/proof';
import { outLayerPolicy, outLayerRunCheck } from './policy.ts';

const output = { decision: { verdict: 'Allow', policy_hash: 'ef'.repeat(32), policy_version: 3, action_commit: 'ab'.repeat(32), model_proof_commit: 'cd'.repeat(32), nonce: '12'.repeat(32), expires_at: '1' }, sig: 'c2ln', pubkey: '34'.repeat(32), wasm_hash: '56'.repeat(32) };
const input = { action: { kind: 'ft_transfer' as const, token_id: 't', receiver_id: 'r', amount: '1', memo: '' }, model_proof_commit: 'cd'.repeat(32), spent_today: '0', now: 1 };
const attestation = 'https://api.test/attestations/c1';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const done = (over: object = {}) => json(200, { status: 'completed', output, attestation_url: attestation, ...over });

/** A fetch that answers from a script and records what it was asked. */
function scripted(answers: Response[]) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const f = (async (url: unknown, init?: RequestInit) => { calls.push({ url: String(url), init }); return answers.shift() ?? json(500, { error: 'script exhausted' }); }) as typeof fetch;
  return { f, calls };
}
const client = (f: typeof fetch, over: { timeoutMs?: number } = {}) => outLayerPolicy({ apiUrl: 'https://api.test', paymentKey: 'o:n:s', project: 'o.testnet/policy', fetch: f, pollMs: 0, ...over });

test('evaluate: POST /call/{project} with the payment key and {input}, under a deadline; a completed answer yields the parsed output and the attestation url', async () => {
  const { f, calls } = scripted([done()]);
  const r = await client(f).evaluate(input);
  assert.equal(calls[0]?.url, 'https://api.test/call/o.testnet/policy');
  assert.equal((calls[0]?.init?.headers as Record<string, string>)['x-payment-key'], 'o:n:s');
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { input, secrets_ref: { profile: 'default', account_id: 'o.testnet' } });
  assert.ok(calls[0]?.init?.signal instanceof AbortSignal);
  assert.equal(calls[0]?.init?.redirect, 'error', 'a redirect must not carry the payment key to another host');
  assert.deepEqual(r, { output, attestationUrl: attestation });
});

test('evaluate: stdout handed over as text is parsed; an output that is not the §6.2 shape is rejected', async () => {
  assert.equal((await client(scripted([done({ output: JSON.stringify(output) })]).f).evaluate(input)).output.decision.verdict, 'Allow');
  await assert.rejects(client(scripted([done({ output: { verdict: 'Allow' } })]).f).evaluate(input));
});

test('evaluate: the attestation url is required and made absolute, so an action proof built from it after the money moved cannot fail on it', async () => {
  await assert.rejects(client(scripted([json(200, { status: 'completed', output })]).f).evaluate(input), /no attestation_url/);
  assert.equal((await client(scripted([done({ attestation_url: '/attestations/c1' })]).f).evaluate(input)).attestationUrl, attestation);
});

test('evaluate: the payment key never goes to another host, and an attestation url must be https', async () => {
  const { f, calls } = scripted([json(200, { status: 'pending', poll_url: 'https://evil.example/x' })]);
  await assert.rejects(client(f).evaluate(input), /refusing to send the payment key/);
  assert.equal(calls.length, 1);
  await assert.rejects(client(scripted([done({ attestation_url: 'http://api.test/a' })]).f).evaluate(input), /not https/);
});

test('evaluate: a refusal carries the platform reason; a failed job says so', async () => {
  await assert.rejects(client(scripted([json(403, { error: 'Project not allowed for this payment key', reason: 'project_not_allowed' })]).f).evaluate(input), /Project not allowed.*\(project_not_allowed\)/);
  await assert.rejects(client(scripted([json(200, { status: 'failed', error: 'trap' })]).f).evaluate(input), /the policy job failed: trap/);
  await assert.rejects(client(scripted([json(200, { status: 'weird' })]).f).evaluate(input), /unexpected answer status weird/);
});

test('evaluate: a 408 with poll_url is polled, never resent; a run that stays pending ends at the deadline', async () => {
  const { f, calls } = scripted([json(408, { error: 'timeout', reason: 'timeout', poll_url: '/calls/c2' }), json(200, { status: 'pending' }), done()]);
  assert.equal((await client(f).evaluate(input)).attestationUrl, attestation);
  assert.deepEqual(calls.map((c) => c.url), ['https://api.test/call/o.testnet/policy', 'https://api.test/calls/c2', 'https://api.test/calls/c2']);
  assert.equal(calls.filter((c) => c.init?.method === 'POST').length, 1);
  const forever = (async () => json(200, { status: 'pending', poll_url: '/calls/c3' })) as typeof fetch;
  await assert.rejects(outLayerPolicy({ apiUrl: 'https://api.test', paymentKey: 'o:n:s', project: 'o.testnet/policy', fetch: forever, pollMs: 1, timeoutMs: 20 }).evaluate(input));
});

test('outLayerRunCheck: waits out the 404, then checks a real run end to end; another answer is an error', async () => {
  const sample = JSON.parse(readFileSync(new URL('../../../docs/samples/policy-run.sample.json', import.meta.url), 'utf8')) as { attestation: { wasm_hash: string; timestamp: number }; input: string; output: string; collateral: unknown };
  const runInput = JSON.parse(sample.input) as PolicyInput;
  const check = (f: typeof fetch) => outLayerRunCheck({ apiUrl: 'https://api.test', project: 'ainek-dev-dastan.testnet/policy', wasmHash: sample.attestation.wasm_hash, rpcUrl: 'http://rpc.test', network: 'testnet', fetch: f, pollMs: 0, now: () => sample.attestation.timestamp * 1000 });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => json(200, { result: { result: Array.from(Buffer.from('true')) } })) as typeof fetch;
  try {
    const { f, calls } = scripted([json(404, {}), json(200, sample.attestation), json(200, { collateral: JSON.stringify(sample.collateral) })]);
    const checks = await check(f)(attestation, runInput, PolicyOutput.parse(JSON.parse(sample.output)));
    assert.deepEqual(checks.map((c) => [c.id, c.status]), [['run-build', 'ok'], ['run-input', 'ok'], ['run-output', 'ok'], ['run-fresh', 'ok'], ['run-quote', 'ok'], ['run-binding', 'ok'], ['run-worker', 'ok']]);
    const lied = await check(scripted([json(200, sample.attestation), json(200, { collateral: JSON.stringify(sample.collateral) })]).f)(attestation, { ...runInput, spent_today: '999' }, PolicyOutput.parse(JSON.parse(sample.output)));
    assert.equal(lied.find((c) => c.id === 'run-input')?.status, 'fail', 'a real run on another spent_today must not pass');
    const old = await outLayerRunCheck({ apiUrl: 'https://api.test', project: 'ainek-dev-dastan.testnet/policy', wasmHash: sample.attestation.wasm_hash, rpcUrl: 'http://rpc.test', network: 'testnet', fetch: scripted([json(200, sample.attestation), json(200, { collateral: JSON.stringify(sample.collateral) })]).f, now: () => (sample.attestation.timestamp + 601) * 1000 })(attestation, runInput, PolicyOutput.parse(JSON.parse(sample.output)));
    assert.equal(old.find((c) => c.id === 'run-fresh')?.status, 'fail', 'an old run must not pass as this one');
    assert.equal(calls.length, 3);
    assert.match(calls[2]?.url ?? '', /public\/collateral\?fmspc=b0c06f000000&at=\d+/);
  } finally {
    globalThis.fetch = realFetch;
  }
  await assert.rejects(check(scripted([json(500, {})]).f)(attestation, runInput, output as PolicyOutput), /HTTP 500/);
  await assert.rejects(check(scripted([json(200, sample.attestation), json(502, {})]).f)(attestation, runInput, PolicyOutput.parse(JSON.parse(sample.output))), /collateral.*HTTP 502/, 'an outage is not a verdict');
});

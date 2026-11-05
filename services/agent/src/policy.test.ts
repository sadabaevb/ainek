import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outLayerPolicy } from './policy.ts';

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
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { input });
  assert.ok(calls[0]?.init?.signal instanceof AbortSignal);
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

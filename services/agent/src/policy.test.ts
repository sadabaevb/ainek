import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OutLayerError, outLayerPolicy } from './policy.ts';

const output = { decision: { verdict: 'Allow', policy_hash: 'ef'.repeat(32), policy_version: 3, action_commit: 'ab'.repeat(32), model_proof_commit: 'cd'.repeat(32), nonce: '12'.repeat(32), expires_at: '1' }, sig: 'c2ln', pubkey: '34'.repeat(32), wasm_hash: '56'.repeat(32) };
const input = { action: { kind: 'ft_transfer' as const, token_id: 't', receiver_id: 'r', amount: '1', memo: '' }, model_proof_commit: 'cd'.repeat(32), spent_today: '0', now: 1 };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A fetch that answers from a script and records what it was asked. */
function scripted(answers: Response[]) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const f = (async (url: unknown, init?: RequestInit) => { calls.push({ url: String(url), init }); return answers.shift() ?? json(500, { error: 'script exhausted' }); }) as typeof fetch;
  return { f, calls };
}
const client = (f: typeof fetch) => outLayerPolicy({ apiUrl: 'https://api.test', paymentKey: 'o:n:s', project: 'o.testnet/policy', fetch: f, pollMs: 0, maxPolls: 3 });

test('evaluate: POST /call/{project} with the payment key and {input}; a completed answer yields the parsed output and the attestation url', async () => {
  const { f, calls } = scripted([json(200, { call_id: 'c1', status: 'completed', output, attestation_url: 'https://api.test/attestations/c1', time_ms: 192 })]);
  const r = await client(f).evaluate(input);
  assert.equal(calls[0]?.url, 'https://api.test/call/o.testnet/policy');
  assert.equal((calls[0]?.init?.headers as Record<string, string>)['x-payment-key'], 'o:n:s');
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { input });
  assert.deepEqual(r, { output, callId: 'c1', attestationUrl: 'https://api.test/attestations/c1', timeMs: 192 });
});

test('evaluate: stdout handed over as text is parsed; an output that is not the §6.2 shape is rejected', async () => {
  assert.equal((await client(scripted([json(200, { status: 'completed', output: JSON.stringify(output) })]).f).evaluate(input)).output.decision.verdict, 'Allow');
  await assert.rejects(client(scripted([json(200, { status: 'completed', output: { verdict: 'Allow' } })]).f).evaluate(input));
});

test('evaluate: a refusal carries the platform reason; a failed job is job_failed', async () => {
  await assert.rejects(client(scripted([json(403, { error: 'Project not allowed for this payment key', reason: 'project_not_allowed' })]).f).evaluate(input), (e: unknown) => e instanceof OutLayerError && e.reason === 'project_not_allowed' && e.status === 403);
  await assert.rejects(client(scripted([json(200, { status: 'failed', error: 'trap' })]).f).evaluate(input), (e: unknown) => e instanceof OutLayerError && e.reason === 'job_failed');
});

test('evaluate: a 408 with poll_url is polled, never resent; polling gives up after maxPolls', async () => {
  const { f, calls } = scripted([json(408, { error: 'timeout', reason: 'timeout', poll_url: '/calls/c2' }), json(200, { call_id: 'c2', status: 'pending' }), json(200, { call_id: 'c2', status: 'completed', output })]);
  const r = await client(f).evaluate(input);
  assert.equal(r.callId, 'c2');
  assert.deepEqual(calls.map((c) => c.url), ['https://api.test/call/o.testnet/policy', 'https://api.test/calls/c2', 'https://api.test/calls/c2']);
  assert.equal(calls.filter((c) => c.init?.method === 'POST').length, 1);
  const slow = scripted([json(200, { status: 'pending', poll_url: '/calls/c3' }), json(200, { status: 'pending' }), json(200, { status: 'pending' }), json(200, { status: 'pending' })]);
  await assert.rejects(client(slow.f).evaluate(input), (e: unknown) => e instanceof OutLayerError && e.reason === 'poll_timeout');
});

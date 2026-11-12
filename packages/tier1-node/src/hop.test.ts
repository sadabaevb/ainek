import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readHopOutcome, swapReplyKey } from './hop.ts';
import type { ChatCompletion, Tier1Outcome } from './tier1.ts';

const stats = { timings: {}, totalMs: 1, retries: 0 };
const failed = (step: string, reason: string, extra: object = {}) => ({ kind: 'failed', step, reason, ...stats, ...extra }) as unknown as Tier1Outcome;
const BODY = `{"error":{"message":"Provider failed for model 'vendor/model-a': Decryption failed","type":"invalid_request_error"}}`;
const sendFailed = (response: { status: number; complete: boolean; body?: string }, reason = `chat completion failed: HTTP ${response.status} ${(response.body ?? '').slice(0, 200)}`) => failed('send', reason, { response });

test('swapReplyKey: only the reply key (and the version, when asked) change; the body and the other headers pass through', async () => {
  const sent = new Request('https://gateway.invalid/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer k', 'x-signing-algo': 'ed25519', 'x-client-pub-key': 'aa'.repeat(32), 'x-model-pub-key': 'bb'.repeat(32), 'x-encryption-version': '3' },
    body: '{"ciphertext":"…"}',
  });
  const swapped = swapReplyKey()(sent.clone());
  assert.match(swapped.headers.get('x-client-pub-key') ?? '', /^[0-9a-f]{64}$/);
  assert.notEqual(swapped.headers.get('x-client-pub-key'), 'aa'.repeat(32));
  assert.deepEqual([swapped.method, swapped.url, swapped.headers.get('authorization'), swapped.headers.get('x-model-pub-key'), swapped.headers.get('x-encryption-version')], ['POST', sent.url, 'Bearer k', 'bb'.repeat(32), '3']);
  assert.equal(await swapped.text(), '{"ciphertext":"…"}');
  const downgraded = swapReplyKey({ downgrade: true })(sent.clone());
  assert.equal(downgraded.headers.get('x-encryption-version'), '2');
  assert.notEqual(downgraded.headers.get('x-client-pub-key'), swapped.headers.get('x-client-pub-key'), 'a fresh key each time');
});

test('swapReplyKey: a request made with another key algorithm is not touched: a key of the wrong kind would only be refused as malformed', () => {
  const ecdsa = new Request('https://gateway.invalid/v1/chat/completions', { method: 'POST', headers: { 'x-signing-algo': 'ecdsa', 'x-client-pub-key': 'cc'.repeat(64) }, body: '{}' });
  assert.throws(() => swapReplyKey()(ecdsa), /swaps an ed25519 reply key, and the request says ecdsa/);
  assert.throws(() => swapReplyKey()(new Request('https://gateway.invalid/', { method: 'POST', body: '{}' })), /the request says no algorithm/);
});

test('readHopOutcome: HTTP 400 or 422 that says decryption failed is the refusal; the body is kept whole', () => {
  // The words the control looks for may sit past the 200 characters the reason keeps.
  const long = `{"error":{"message":"${'x'.repeat(300)} Decryption failed"}}`;
  assert.deepEqual(readHopOutcome(sendFailed({ status: 400, complete: true, body: BODY })), { kind: 'refused', status: 400, detail: BODY });
  assert.deepEqual(readHopOutcome(sendFailed({ status: 422, complete: true, body: long })), { kind: 'refused', status: 422, detail: long });
});

test('readHopOutcome: a whole reply that came back is an answer, whether or not this client could read it', () => {
  assert.deepEqual(readHopOutcome(sendFailed({ status: 200, complete: true }, 'the reply could not be decrypted')), { kind: 'answered', status: 200, detail: 'the reply could not be decrypted' });
  assert.equal(readHopOutcome(failed('signature', 'no signature', { unverifiedCompletion: { id: 'c' } as unknown as ChatCompletion })).kind, 'answered');
});

test('readHopOutcome: anything else says nothing about the reply key', () => {
  // The gateway answers 400 for other provider errors as well: the status alone is not the refusal.
  assert.deepEqual(readHopOutcome(sendFailed({ status: 400, complete: true, body: '{"error":{"message":"Provider failed: model overloaded"}}' })), { kind: 'inconclusive', status: 400, detail: '{"error":{"message":"Provider failed: model overloaded"}}' });
  // The status line arrived and the body did not: a stalled or dropped connection, not the enclave answering.
  assert.equal(readHopOutcome(sendFailed({ status: 200, complete: false }, 'the send step timed out')).kind, 'inconclusive');
  assert.equal(readHopOutcome(sendFailed({ status: 400, complete: false }, 'the send step timed out')).kind, 'inconclusive');
  // Nothing came back at all.
  assert.deepEqual(readHopOutcome(failed('send', 'the send step timed out after 120 s')), { kind: 'inconclusive', detail: 'send: the send step timed out after 120 s' });
  // The API key, the balance, the rate limit, the route, the service.
  for (const status of [401, 402, 403, 404, 405, 413, 429, 500, 503]) assert.equal(readHopOutcome(sendFailed({ status, complete: true, body: 'Decryption failed' })).kind, 'inconclusive', String(status));
  assert.equal(readHopOutcome(failed('attestation', 'quote.collateral_unavailable')).kind, 'inconclusive');
  assert.equal(readHopOutcome({ kind: 'refused', step: 'key-log', reason: 'key is not in the public log', ...stats } as unknown as Tier1Outcome).kind, 'inconclusive');
  assert.deepEqual(readHopOutcome({ kind: 'verified', completion: { id: 'chatcmpl-1' }, ...stats } as unknown as Tier1Outcome), { kind: 'verified', detail: 'completion chatcmpl-1 verified under the attested key' });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readHopOutcome, swapReplyKey } from './hop.ts';
import type { ChatCompletion, Tier1Outcome } from './tier1.ts';

const stats = { timings: {}, totalMs: 1, retries: 0 };
const failed = (step: string, reason: string, extra: object = {}) => ({ kind: 'failed', step, reason, ...stats, ...extra }) as unknown as Tier1Outcome;
const refusal = 'chat completion failed: HTTP 400 {"error":{"message":"Provider failed: Decryption failed"}}';

test('swapReplyKey: only the reply key (and the version, when asked) change; the body and the other headers pass through', async () => {
  const sent = new Request('https://gateway.invalid/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer k', 'x-client-pub-key': 'aa'.repeat(32), 'x-model-pub-key': 'bb'.repeat(32), 'x-encryption-version': '3' },
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

test('readHopOutcome: HTTP 400 or 422 where a reply would have been is a refusal, and says whether decryption is the reason', () => {
  assert.deepEqual(readHopOutcome(failed('send', refusal, { httpStatus: 400 })), { kind: 'refused', status: 400, detail: refusal, decryptionFailed: true });
  assert.deepEqual(readHopOutcome(failed('send', 'chat completion failed: HTTP 422 bad field', { httpStatus: 422 })), { kind: 'refused', status: 422, detail: 'chat completion failed: HTTP 422 bad field', decryptionFailed: false });
});

test('readHopOutcome: a reply that came back is an answer, whether or not this client could read it', () => {
  // A 2xx arrived and could not be decrypted: the enclave answered to another key.
  assert.deepEqual(readHopOutcome(failed('send', 'the reply could not be decrypted', { httpStatus: 200 })), { kind: 'answered', status: 200, detail: 'the reply could not be decrypted' });
  assert.equal(readHopOutcome(failed('signature', 'no signature', { unverifiedCompletion: { id: 'c' } as unknown as ChatCompletion })).kind, 'answered');
});

test('readHopOutcome: nothing sent, nothing back, or a status about something else says nothing about the reply key', () => {
  // A timeout or a dropped connection in the send step is not the enclave answering: no status was recorded.
  assert.deepEqual(readHopOutcome(failed('send', 'the send step timed out after 120 s')), { kind: 'inconclusive', detail: 'send: the send step timed out after 120 s' });
  // The API key, the balance, the rate limit, the route, the service.
  for (const status of [401, 402, 403, 404, 405, 413, 429, 500, 503]) assert.equal(readHopOutcome(failed('send', `chat completion failed: HTTP ${status} x`, { httpStatus: status })).kind, 'inconclusive', String(status));
  assert.equal(readHopOutcome(failed('attestation', 'quote.collateral_unavailable')).kind, 'inconclusive');
  assert.equal(readHopOutcome({ kind: 'refused', step: 'key-log', reason: 'key is not in the public log', ...stats } as unknown as Tier1Outcome).kind, 'inconclusive');
  assert.deepEqual(readHopOutcome({ kind: 'verified', completion: { id: 'chatcmpl-1' }, ...stats } as unknown as Tier1Outcome), { kind: 'verified', detail: 'completion chatcmpl-1 verified under the attested key' });
});

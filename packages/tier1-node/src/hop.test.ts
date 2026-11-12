import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readHopOutcome, swapReplyKey } from './hop.ts';
import type { ChatCompletion, Tier1Outcome } from './tier1.ts';

const stats = { timings: {}, totalMs: 1, retries: 0 };
const failed = (step: string, reason: string, extra: object = {}) => ({ kind: 'failed', step, reason, ...stats, ...extra }) as unknown as Tier1Outcome;

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

test('readHopOutcome: an HTTP error about the request is a refusal; a reply nobody could read is an answer; the rest says nothing', () => {
  assert.deepEqual(readHopOutcome(failed('send', 'chat completion failed: HTTP 400 {"error":"decryption failed"}')), { kind: 'refused', status: 400, detail: '{"error":"decryption failed"}' });
  assert.deepEqual(readHopOutcome(failed('send', 'chat completion failed: HTTP 422 ')), { kind: 'refused', status: 422, detail: '' });
  // The key, the balance, the rate limit and the service: not about the swapped reply key.
  for (const status of [401, 402, 403, 429, 500, 503]) assert.equal(readHopOutcome(failed('send', `chat completion failed: HTTP ${status} x`)).kind, 'inconclusive', String(status));
  // A 2xx came back and the client could not decrypt it: the enclave answered to another key.
  assert.equal(readHopOutcome(failed('send', '[e2ee.decryption_failed] the reply could not be decrypted')).kind, 'answered');
  assert.equal(readHopOutcome(failed('signature', 'no signature', { unverifiedCompletion: { id: 'c' } as unknown as ChatCompletion })).kind, 'answered');
  // Stopped before anything was sent.
  assert.equal(readHopOutcome(failed('attestation', 'quote.collateral_unavailable')).kind, 'inconclusive');
  assert.equal(readHopOutcome({ kind: 'refused', step: 'key-log', reason: 'key is not in the public log', ...stats } as unknown as Tier1Outcome).kind, 'inconclusive');
  assert.deepEqual(readHopOutcome({ kind: 'verified', completion: { id: 'chatcmpl-1' }, ...stats } as unknown as Tier1Outcome), { kind: 'verified', detail: 'completion chatcmpl-1 verified under the attested key' });
});

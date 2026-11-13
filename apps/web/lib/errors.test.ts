import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeKeyLimit, looksLikeNoReply, noReplyReason } from './errors.ts';

test('looksLikeKeyLimit: the chat request refused for credit or rate, and nothing else', () => {
  for (const reason of ['chat completion failed: HTTP 402 {"error":"insufficient credits"}', 'chat completion failed: HTTP 429 {"error":"rate limit: 30 requests per minute"}']) assert.equal(looksLikeKeyLimit(reason), true, reason);
  for (const reason of [
    'chat completion failed: HTTP 500 upstream',
    'chat completion failed: HTTP 502 {"error":"upstream returned HTTP 429"}',
    'chat completion failed: HTTP 4020',
    'chat completion failed: HTTP 401 ',
    'https://rpc.testnet.fastnear.com: HTTP 429',
    'SdkError api.http_status (retryable)',
    'quote.signature_invalid',
  ]) assert.equal(looksLikeKeyLimit(reason), false, reason);
});

test('looksLikeNoReply: the page\'s own limit on the wait for a reply, and nothing that only mentions one', () => {
  for (const ms of [180_000, 1_500, 90_500]) assert.equal(looksLikeNoReply(noReplyReason(ms)), true, String(ms));
  assert.equal(noReplyReason(180_000), 'no reply within 180 s');
  for (const reason of ['chat completion failed: HTTP 504 no reply within 180 s', 'the send step did not finish within 120 s', 'signal timed out', '']) assert.equal(looksLikeNoReply(reason), false, reason);
});

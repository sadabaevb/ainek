import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeKeyLimit } from './errors.ts';

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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeKeyLimit } from './errors.ts';

test('looksLikeKeyLimit: a refused key or a rate limit, not a failed check or a broken upstream', () => {
  for (const reason of ['chat completion failed: HTTP 402 {"error":"insufficient credits"}', 'chat completion failed: HTTP 429 {"error":"rate limit: 30 requests per minute"}', 'chat completion failed: HTTP 401 ', 'SdkError api.http_status (retryable)']) assert.equal(looksLikeKeyLimit(reason), true, reason);
  for (const reason of ['chat completion failed: HTTP 500 upstream', 'chat completion failed: HTTP 4020', 'quote.signature_invalid', 'key abab is not in the public log']) assert.equal(looksLikeKeyLimit(reason), false, reason);
});

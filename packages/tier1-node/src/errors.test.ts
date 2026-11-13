import assert from 'node:assert/strict';
import { test } from 'node:test';
import { outageHint } from './errors.ts';

test('outageHint: a step that could not be made is said to be that, and never that the evidence is fine', () => {
  const intel = outageHint('[quote.collateral_unavailable] Intel quote collateral is unavailable') ?? '';
  assert.match(intel, /api\.trustedservices\.intel\.com.*was not judged.*run the command again/);
  assert.match(intel, /If it repeats, the quote itself may be the reason/);
  assert.doesNotMatch(intel, /not the evidence/);
  for (const reason of ['[api.transport_failed] Cloud API request failed', '[api.http_status] Cloud API returned HTTP 503', '[api.http_status] Cloud API returned HTTP 429', 'fetch failed', 'getaddrinfo ENOTFOUND cloud-api.near.ai', 'read ECONNRESET']) {
    assert.match(outageHint(reason) ?? '', /a service did not answer/, reason);
  }
  assert.match(outageHint('the attestation step did not finish within 120 s') ?? '', /ran out of time/);
});

test('outageHint: a verdict gets no excuse', () => {
  for (const reason of [
    '[quote.signature_invalid] the quote does not verify',
    '[gpu.verdict_failed] NVIDIA said no',
    '[api.http_status] Cloud API returned HTTP 404',
    '[api.http_status] Cloud API returned HTTP 401',
    'key 5a02 is not in the public log',
    'a report mentions quote.collateral_unavailable in passing', // the code must open the reason, in brackets
    '',
  ]) assert.equal(outageHint(reason), undefined, reason);
});

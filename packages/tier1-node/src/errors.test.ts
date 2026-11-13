import assert from 'node:assert/strict';
import { test } from 'node:test';
import { outageHint } from './errors.ts';

test('outageHint: a service that did not answer is named, and told apart from a check that failed', () => {
  assert.match(outageHint('[quote.collateral_unavailable] Intel quote collateral is unavailable') ?? '', /api\.trustedservices\.intel\.com.*not the evidence: run the command again/);
  for (const reason of ['fetch failed', 'getaddrinfo ENOTFOUND cloud-api.near.ai', 'read ECONNRESET']) assert.match(outageHint(reason) ?? '', /a host did not answer/, reason);
  // A verdict gets no excuse.
  for (const reason of ['[quote.signature_invalid] the quote does not verify', '[gpu.verdict_failed] NVIDIA said no', 'the attestation step did not finish within 120 s', 'key 5a02 is not in the public log', '']) assert.equal(outageHint(reason), undefined, reason);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VerificationError, type VerificationFailure } from '@nearai/inference-sdk/node';
import { sdkRetryable } from './retry.ts';

const collateralUnavailable = () => new VerificationError({ code: 'quote.collateral_unavailable', retryable: true } as VerificationFailure);

test('sdkRetryable: the SDK verdict, also when the SDK error is the cause of a wrapper; a plain error is never retried', () => {
  assert.equal(sdkRetryable(collateralUnavailable()), true);
  assert.equal(sdkRetryable(new Error('wrapped', { cause: collateralUnavailable() })), true);
  assert.equal(sdkRetryable(new Error('network down')), false);
});

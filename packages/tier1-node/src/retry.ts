import { getSdkError } from '@nearai/inference-sdk/node';

/** What the SDK marks retryable, found anywhere in the cause chain: Intel collateral hiccups, NRAS/transport 5xx, 429, a signature not yet on this node. The loop itself is `withRetry` in @ainek/proof. */
export function sdkRetryable(err: unknown): boolean {
  return getSdkError(err)?.retryable === true;
}

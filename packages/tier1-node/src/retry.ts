import { getSdkError } from '@nearai/inference-sdk/node';

/** What the SDK marks retryable: Intel collateral hiccups, NRAS/transport 5xx, 429, a signature not yet on this node. */
export function sdkRetryable(err: unknown): boolean {
  return getSdkError(err)?.retryable === true;
}

/** Same rule as apps/web/lib/nearai-browser.ts: only retryable failures are retried, with a growing pause (`pauseMs`, then twice that, …). */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 3, onRetry: () => void = () => undefined, retryable: (err: unknown) => boolean = sdkRetryable, pauseMs = 1500): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts || !retryable(err)) throw err;
      onRetry();
      await new Promise((r) => setTimeout(r, pauseMs * i));
    }
  }
}

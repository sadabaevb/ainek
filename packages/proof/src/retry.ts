// The retry loop of the browser client's SDK calls, the Node runner and the JSON-RPC reader. Each caller brings its own
// `retryable` predicate: the SDK's error classes differ per bundle, and the RPC reader has its own idea of transient.
export interface RetryOptions {
  retryable: (err: unknown) => boolean;
  attempts?: number;
  /** The first pause; the next ones are twice, three times that. */
  pauseMs?: number;
  onRetry?: () => void;
}

/** Calls `fn` up to `attempts` times, retrying only the failures `retryable` accepts; the last failure is thrown. */
export async function withRetry<T>(fn: () => Promise<T>, { retryable, attempts = 3, pauseMs = 1500, onRetry }: RetryOptions): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts || !retryable(err)) throw err;
      onRetry?.();
      await new Promise((r) => setTimeout(r, pauseMs * i));
    }
  }
}

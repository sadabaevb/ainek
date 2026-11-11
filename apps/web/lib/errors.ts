import { getSdkError } from '@nearai/inference-sdk';

/** One wording for every error shown to the user: SDK failures by code, everything else by message. */
export function describeError(err: unknown): string {
  const sdk = getSdkError(err);
  if (sdk) return `${sdk.name} ${sdk.failure.code}${sdk.retryable ? ' (retryable)' : ''}`;
  return err instanceof Error ? err.message : String(err);
}

/**
 * Did the chat request itself come back as "out of credit" (402) or "too many requests" (429)? The chat runs on one NEAR AI key
 * with a spend limit, behind a relay with a rate limit; when either is hit the visitor should hear that, and what works without
 * the key. Only the status that `httpError` in nearai-browser.ts puts first counts: not a status quoted in a response body, not
 * the RPC's, and not an SDK failure, which carries no status here.
 */
export function looksLikeKeyLimit(reason: string): boolean {
  return /^chat completion failed: HTTP (402|429)\b/.test(reason);
}

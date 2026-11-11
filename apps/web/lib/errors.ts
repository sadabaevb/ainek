import { getSdkError } from '@nearai/inference-sdk';

/** One wording for every error shown to the user: SDK failures by code, everything else by message. */
export function describeError(err: unknown): string {
  const sdk = getSdkError(err);
  if (sdk) return `${sdk.name} ${sdk.failure.code}${sdk.retryable ? ' (retryable)' : ''}`;
  return err instanceof Error ? err.message : String(err);
}

/**
 * Does a failed step look like the upstream refusing our key rather than something being wrong with the evidence? The hosted
 * chat runs on one NEAR AI key with a spend limit, behind a relay with a rate limit; when either is hit, a visitor should hear
 * that it is the demo's budget and what still works without it. A guess from the status: the card says "may".
 */
export function looksLikeKeyLimit(reason: string): boolean {
  return /\bHTTP (401|402|403|429)\b/.test(reason) || reason.includes('api.http_status');
}

import { getSdkError } from '@nearai/inference-sdk/node';

/** One line for an error: the SDK's own message (`[code] what happened`) when an SDK error is anywhere in the cause chain, the message otherwise. */
export function describeSdkError(err: unknown): string {
  return getSdkError(err)?.message ?? (err instanceof Error ? err.message : String(err));
}

/**
 * A second line for a failure that is a service not answering. "[quote.collateral_unavailable] Intel quote collateral is
 * unavailable" does not say that the quote was never judged, and a reader, or a screener that runs a command once, takes
 * it for a check that failed. Undefined for every other reason: a check that failed gets no excuse.
 */
export function outageHint(reason: string): string | undefined {
  if (/\bquote\.collateral_unavailable\b/.test(reason)) {
    return "Intel's collateral service (api.trustedservices.intel.com) did not answer, so the hardware quote was not judged. That is the network or Intel, not the evidence: run the command again";
  }
  if (/\bfetch failed\b|\b(ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT)\b/.test(reason)) return 'a host did not answer, so nothing was judged. That is the network, not the evidence: run the command again';
  return undefined;
}


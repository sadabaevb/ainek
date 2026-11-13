import { getSdkError } from '@nearai/inference-sdk/node';

/** One line for an error: the SDK's own message (`[code] what happened`) when an SDK error is anywhere in the cause chain, the message otherwise. */
export function describeSdkError(err: unknown): string {
  return getSdkError(err)?.message ?? (err instanceof Error ? err.message : String(err));
}

/**
 * A second line for a step that could not be made, as against one that was made and failed. A reader of
 * "[quote.collateral_unavailable] Intel quote collateral is unavailable", or a screener that runs a command once, takes
 * it for a failed check. Matched on the SDK's own failure code, which opens the reason (`describeSdkError`), and on the
 * runner's deadline. Undefined for every other reason: a verdict gets no excuse.
 *
 * It says "was not judged" and never "the evidence is fine": the SDK reports every failure to get Intel's collateral
 * under that one code, and a quote Intel has no collateral for would land there too. Hence "if it repeats".
 */
export function outageHint(reason: string): string | undefined {
  if (/\[quote\.collateral_unavailable\]/.test(reason)) {
    return "Intel's collateral for the quote could not be fetched (api.trustedservices.intel.com), so the hardware quote was not judged. Most often that is the network or Intel's service: run the command again. If it repeats, the quote itself may be the reason";
  }
  if (/\[api\.transport_failed\]|\[api\.http_status\].*\bHTTP (5\d\d|429)\b|\bfetch failed\b|\b(ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT)\b/.test(reason)) {
    return 'a service did not answer, so this step was not made. Most often that is the network: run the command again';
  }
  if (/\bdid not finish within \d+ s\b/.test(reason)) return 'the step ran out of time before it gave an answer, so nothing was judged: run the command again';
  return undefined;
}

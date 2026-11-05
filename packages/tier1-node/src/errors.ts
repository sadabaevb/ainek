import { getSdkError } from '@nearai/inference-sdk/node';

/** One line for an error: the SDK's own message (`[code] what happened`) when an SDK error is anywhere in the cause chain, the message otherwise. */
export function describeSdkError(err: unknown): string {
  return getSdkError(err)?.message ?? (err instanceof Error ? err.message : String(err));
}

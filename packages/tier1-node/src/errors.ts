import { getSdkError } from '@nearai/inference-sdk/node';

/** One line for an error: the SDK's own message (`[code] what happened`) when an SDK error is anywhere in the cause chain, the message otherwise. */
export function describeSdkError(err: unknown): string {
  return getSdkError(err)?.message ?? (err instanceof Error ? err.message : String(err));
}

/** The HTTP status a request of the SDK failed with, when an HTTP status is what failed it. */
export function sdkHttpStatus(err: unknown): number | undefined {
  const failure = getSdkError(err)?.failure;
  return failure?.code === 'api.http_status' ? failure.details.status : undefined;
}

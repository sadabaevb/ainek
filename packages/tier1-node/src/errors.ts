import { getSdkError } from '@nearai/inference-sdk/node';

/** One line for an error: the SDK's failure code and details when it is an SDK error, the message otherwise. */
export function describeSdkError(err: unknown): string {
  const sdk = getSdkError(err);
  if (sdk) return `${sdk.failure.code}${'details' in sdk.failure && sdk.failure.details ? ' ' + JSON.stringify(sdk.failure.details) : ''}`;
  return err instanceof Error ? err.message : String(err);
}

import { getSdkError } from '@nearai/inference-sdk';
import { errorText } from './wallet';

/** One wording for every error shown to the user: SDK failures by code, everything else by message. */
export function describeError(err: unknown): string {
  const sdk = getSdkError(err);
  if (sdk) return `${sdk.name} ${sdk.failure.code}${sdk.retryable ? ' (retryable)' : ''}`;
  return errorText(err);
}

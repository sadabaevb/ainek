// Terminal output shared by the replay and live modes.
import { getSdkError } from '@nearai/inference-sdk/node';

export const OK = '✓';
export const FAIL = '✗';
export const NA = '—';

export function markOf(status: 'ok' | 'fail' | 'skipped' | string): string {
  return status === 'ok' ? OK : status === 'fail' ? FAIL : NA;
}

export function head(title: string): void {
  console.log(`\n${title}`);
}

/** Prints one check line and tells the caller whether it was a failure (modes count failures differently). */
export function line(mark: string, text: string): boolean {
  console.log(`  ${mark} ${text}`);
  return mark === FAIL;
}

export function describe(err: unknown): string {
  const sdk = getSdkError(err);
  if (sdk) return `${sdk.failure.code}${'details' in sdk.failure && sdk.failure.details ? ' ' + JSON.stringify(sdk.failure.details) : ''}`;
  return err instanceof Error ? err.message : String(err);
}

export function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

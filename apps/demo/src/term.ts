// Terminal output shared by the replay and live modes.
export { describeSdkError as describe } from '@ainek/tier1-node';

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

export function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

/** Exits once stdout has drained: to a pipe (`| tee`) stdout is written asynchronously, and process.exit() right after console.log would cut the last lines off. */
export function exitFlushed(code: number): Promise<never> {
  return new Promise<never>(() => process.stdout.write('', () => process.exit(code)));
}

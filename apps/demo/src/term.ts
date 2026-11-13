// Terminal output shared by the replay and live modes.
import { oneLine } from '@ainek/proof';
export { describeSdkError as describe, outageHint } from '@ainek/tier1-node/errors'; // the subpath: the offline replay must not load the runner

export const OK = '✓';
export const FAIL = '✗';
export const NA = '—';

export function markOf(status: 'ok' | 'fail' | 'skipped' | string): string {
  return status === 'ok' ? OK : status === 'fail' ? FAIL : NA;
}

/**
 * Prints one line that may carry text from outside: a log entry, a verifier's name, a tag, an image name, a server's error.
 * Control characters in it become spaces (`oneLine`), so an escape sequence in a tag cannot move the cursor, recolour a
 * line or draw a check mark. Space at either end is dropped.
 */
export function out(text: string): void {
  console.log(oneLine(text, Infinity));
}

export function head(title: string): void {
  console.log();
  out(title);
}

/** Prints one check line and tells the caller whether it was a failure (modes count failures differently). */
export function line(mark: string, text: string): boolean {
  console.log(`  ${mark} ${oneLine(text, Infinity)}`);
  return mark === FAIL;
}

export function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

/** Exits once stdout has drained: to a pipe (`| tee`) stdout is written asynchronously, and process.exit() right after console.log would cut the last lines off. */
export function exitFlushed(code: number): Promise<never> {
  return new Promise<never>(() => process.stdout.write('', () => process.exit(code)));
}

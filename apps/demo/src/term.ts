// Terminal output shared by the replay and live modes.
export { describeSdkError as describe } from '@ainek/tier1-node/errors'; // the subpath: the offline replay must not load the runner

export const OK = '✓';
export const FAIL = '✗';
export const NA = '—';

export function markOf(status: 'ok' | 'fail' | 'skipped' | string): string {
  return status === 'ok' ? OK : status === 'fail' ? FAIL : NA;
}

/**
 * Text from outside (a log entry, a tag, a file or image name, a server's error) with its control characters replaced, so it
 * cannot move the cursor or recolour a line: an escape sequence in a tag must not be able to draw a check mark.
 */
export function plain(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');
}

export function head(title: string): void {
  console.log(`\n${plain(title)}`);
}

/** Prints one check line and tells the caller whether it was a failure (modes count failures differently). */
export function line(mark: string, text: string): boolean {
  console.log(`  ${mark} ${plain(text)}`);
  return mark === FAIL;
}

export function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

/** Exits once stdout has drained: to a pipe (`| tee`) stdout is written asynchronously, and process.exit() right after console.log would cut the last lines off. */
export function exitFlushed(code: number): Promise<never> {
  return new Promise<never>(() => process.stdout.write('', () => process.exit(code)));
}

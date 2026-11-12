// The outcome of one check, for results that carry what they found. Same three states as `CheckStatus` in verify.ts.
// "Could not be made" (no network, nothing to compare against) is its own state on purpose: it must never read as "held".

export type Checked<T> = { status: 'ok'; value: T } | { status: 'skipped'; why: string } | { status: 'fail'; why: string };

export const checked = {
  ok: <T>(value: T): Checked<T> => ({ status: 'ok', value }),
  /** The check could not be made; `why` says what was missing. */
  skipped: (why: string): Checked<never> => ({ status: 'skipped', why }),
  /** The check was made and did not hold. */
  failed: (why: string): Checked<never> => ({ status: 'fail', why }),
};

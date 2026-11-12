// The outcome of one check, for results that carry what they found. Same three states as `CheckStatus` in verify.ts.
// "Could not be made" (no network, nothing to compare against) is its own state on purpose: it must never read as "held".

export type Checked<T> =
  | { status: 'ok'; value: T }
  /** `again`: what was missing was an answer from outside (a rate limit, an outage), so asking again may make the check. */
  | { status: 'skipped'; why: string; again?: true }
  | { status: 'fail'; why: string };

export const checked = {
  ok: <T>(value: T): Checked<T> => ({ status: 'ok', value }),
  /** The check could not be made; `why` says what was missing. */
  skipped: (why: string): Checked<never> => ({ status: 'skipped', why }),
  /** The check could not be made because something outside did not answer: asking again may make it. */
  unanswered: (why: string): Checked<never> => ({ status: 'skipped', why, again: true }),
  /** The check was made and did not hold. */
  failed: (why: string): Checked<never> => ({ status: 'fail', why }),
};

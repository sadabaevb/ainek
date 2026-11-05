import type { CommitAction } from './flow';
import type { Dict } from './i18n';
import { DEPOSIT_NEAR } from './wallet';

/** The commit button's text for what a click will do. */
export function commitLabel(t: Dict, action: CommitAction): string {
  return { connect: t.commitConnect, deposit: t.depositAndCommit(DEPOSIT_NEAR), retry: t.commitRetry, commit: t.commitNow }[action];
}

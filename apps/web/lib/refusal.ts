// The words for a refused key, decided once from the verdict: the refusal card and the /log preview must say the same thing.
import type { KeyLogReason, KeyLogVerdict } from '@ainek/proof';
import type { Dict } from './i18n';

export function refusalText(t: Dict, v: KeyLogVerdict): { reason: Exclude<KeyLogReason, 'ok'>; title: string; body: string } {
  const reason = v.reason === 'ok' ? 'absent' : v.reason;
  const texts: Record<typeof reason, [string, string]> = {
    'split-view': [t.refusedSplitTitle, t.refusedSplitBody],
    'below-quorum': [t.refusedQuorumTitle, t.refusedQuorumBody(v.confirmedBy.length, v.quorum)],
    'untrusted-only': [t.refusedUntrustedTitle, t.refusedUntrustedBody(v.loggedByUntrusted.join(', '))],
    absent: [t.refusedTitle, t.refusedBody],
  };
  const [title, body] = texts[reason];
  return { reason, title, body };
}

// The words for a refused key, decided once from the verdict: the refusal card and the /log preview must say the same thing.
import { shortHex, type KeyLogReason, type KeyLogVerdict } from '@ainek/proof';
import type { Dict } from './i18n';

export function refusalText(t: Dict, v: KeyLogVerdict): { reason: Exclude<KeyLogReason, 'ok'>; title: string; body: string } {
  const reason = v.reason === 'ok' ? 'absent' : v.reason;
  const texts: Record<typeof reason, [string, string]> = {
    'split-view': [t.refusedSplitTitle, t.refusedSplitBody],
    'below-quorum': [t.refusedQuorumTitle, v.deployment ? t.refusedQuorumBodyDeployment(v.confirmedBy.length, v.quorum, shortHex(v.deployment.composeHash)) : t.refusedQuorumBody(v.confirmedBy.length, v.quorum)],
    'unknown-deployment': [t.refusedDeploymentTitle, t.refusedDeploymentBody(shortHex(v.deployment?.composeHash ?? ''), v.deployment?.loggedComposes.length ?? 0)],
    'untrusted-only': [t.refusedUntrustedTitle, t.refusedUntrustedBody(v.loggedByUntrusted.join(', '))],
    'unlogged-release': [t.refusedNoReleaseTitle, t.refusedNoReleaseBody],
    'unknown-release': [t.refusedReleaseTitle, t.refusedReleaseBody],
    'rewritten-log': [t.refusedRewrittenTitle, t.refusedRewrittenBody],
    absent: [t.refusedTitle, t.refusedBody],
  };
  const [title, body] = texts[reason];
  return { reason, title, body };
}

// The words for a refused key, decided once from the verdict: the refusal card and the /log preview must say the same thing.
import { shortHex, type KeyLogReason, type KeyLogVerdict } from '@ainek/proof';
import { wholeMinutes } from './format.ts';
import type { Dict } from './i18n';

export function refusalText(t: Dict, v: KeyLogVerdict): { reason: Exclude<KeyLogReason, 'ok'>; title: string; body: string } {
  const reason = v.reason === 'ok' ? 'absent' : v.reason;
  const texts: Record<typeof reason, [string, string]> = {
    'split-view': [t.refusedSplitTitle, t.refusedSplitBody],
    'below-quorum': [t.refusedQuorumTitle, v.deployment ? t.refusedQuorumBodyDeployment(v.confirmedBy.length, v.quorum, shortHex(v.deployment.composeHash)) : t.refusedQuorumBody(v.confirmedBy.length, v.quorum)],
    'unknown-deployment': [t.refusedDeploymentTitle, t.refusedDeploymentBody(shortHex(v.deployment?.composeHash ?? ''), v.deployment?.loggedComposes.length ?? 0)],
    'untrusted-only': [t.refusedUntrustedTitle, t.refusedUntrustedBody(v.loggedByUntrusted.join(', '))],
    'unlogged-release': [t.refusedNoReleaseTitle, t.refusedNoReleaseBody],
    'untied-log': [t.refusedUntiedTitle, t.refusedUntiedBody],
    'unknown-release': [t.refusedReleaseTitle, t.refusedReleaseBody],
    'shorter-log': [t.refusedShorterTitle, t.refusedShorterBody],
    'release-below-quorum': [t.refusedReleaseQuorumTitle, t.refusedReleaseQuorumBody(v.confirmedBy.length, v.quorum)],
    'rewritten-log': [t.refusedRewrittenTitle, t.refusedRewrittenBody],
    'young-release': [t.refusedYoungTitle, t.refusedYoungBody(v.releaseAge?.ms === undefined ? undefined : wholeMinutes(v.releaseAge.ms), wholeMinutes(v.releaseAge?.minMs ?? 0))],
    absent: [t.refusedTitle, t.refusedBody],
  };
  const [title, body] = texts[reason];
  return { reason, title, body };
}

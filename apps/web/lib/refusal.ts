// The words for a refused key, decided once from the verdict: the refusal card and the /log preview must say the same thing.
import { shortHex, wholeMinutes, type KeyLogReason, type KeyLogVerdict } from '@ainek/proof';
import type { Dict } from './i18n';

/** The refusals only the release rule gives (SPEC §7.5): with one of them on a card, the rule was on for that message. */
const BY_RELEASE_RULE: ReadonlySet<KeyLogReason> = new Set(['unlogged-release', 'untied-log', 'unknown-release', 'shorter-log', 'release-below-quorum', 'rewritten-log', 'recent-mark']);

export function refusalText(t: Dict, v: KeyLogVerdict): { reason: Exclude<KeyLogReason, 'ok'>; title: string; body: string; byReleaseRule: boolean } {
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
    'recent-mark': [t.refusedRecentTitle, t.refusedRecentBody(v.releaseWait?.markedForMs === undefined ? undefined : wholeMinutes(v.releaseWait.markedForMs), wholeMinutes(v.releaseWait?.waitMs ?? 0))],
    absent: [t.refusedTitle, t.refusedBody],
  };
  const [title, body] = texts[reason];
  return { reason, title, body, byReleaseRule: BY_RELEASE_RULE.has(reason) };
}

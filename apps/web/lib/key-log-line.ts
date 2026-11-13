// Where the public key log stands on the action log of a verified report, as one more line of a release check. It needs
// only the light part of @ainek/proof, so it is imported outright; the release chain itself (lib/release.ts) stays
// loaded on demand.
import { releaseLineFor, withFinding, type KeyEntry, type ReleaseRule, type TrustSet } from '@ainek/proof';
import type { VerifiedModelAttestation } from '@nearai/inference-sdk';
import type { ReleaseCheck } from './release.ts';

/**
 * What turns the release rule on in the browser, for the line under the release check: the site's setting, or the
 * viewer's own switch where the site has it off. The line is English on every page, so it does not quote the label.
 */
export const releaseTurnedOnBy = (siteHasIt: boolean): string => (siteHasIt ? "the site's setting" : 'the switch for the release rule in the chat');

/** What a page knows about the public key log when it shows a release: the entries it read and the rule the chat applies to them. */
export interface KeyLogContext {
  entries: readonly KeyEntry[];
  /** The viewer's trust set, as chosen on /log. */
  trust: TrustSet;
  rule: ReleaseRule;
  /** The chat refuses by the release rule; otherwise the line only says what the rule would say. */
  enforced: boolean;
  /** `releaseTurnedOnBy` for this site. */
  turnedOnBy: string;
}

/**
 * A release check with one more line: where the key log stands on the action log of this report, by the release rule
 * (SPEC §7.5), as of `at`, the moment the report was checked. With the rule off the line only says what the rule would
 * say; with it on, a log that is not marked fails the check, because the chat does not send. A log found rewritten fails
 * it either way, as it fails `pnpm demo:attest`.
 *
 * It reads this one report. The chat applies the rule to every report the gateway returns for the key, which is usually
 * this one alone. `log` is null while the page has no read of the key log to go by: the line then says so, rather than
 * go missing.
 */
export function withKeyLog(check: ReleaseCheck, attestation: Pick<VerifiedModelAttestation, 'signer' | 'deployment' | 'report'>, model: string, log: KeyLogContext | null, at: number): ReleaseCheck {
  const line = log
    ? releaseLineFor(log.entries, { model, signingAddress: attestation.signer.signingAddress, trustedVerifiers: log.trust.verifiers, quorum: log.trust.quorum }, attestation, { ...log.rule, now: at }, log.enforced, log.turnedOnBy)
    : ({ status: 'skipped', text: 'key log: not read at the moment, so where it stands on this action log is not known' } as const);
  return { ...withFinding(check, line), lines: [...check.lines, line] };
}

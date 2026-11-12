// Where the public key log stands on the action log of a verified report, as one more line of a release check. It needs
// only the light part of @ainek/proof, so it is imported outright; the release chain itself (lib/release.ts) stays
// loaded on demand.
import { releaseInLogLine, releaseStanding, withFinding, type KeyEntry, type ReleaseRule, type TrustSet } from '@ainek/proof';
import type { VerifiedModelAttestation } from '@nearai/inference-sdk';
import type { ReleaseCheck } from './release.ts';

/** What a page knows about the public key log when it shows a release: the entries it read and the rule the chat applies to them. */
export interface KeyLogContext {
  entries: readonly KeyEntry[];
  /** The viewer's trust set, as chosen on /log. */
  trust: TrustSet;
  rule: ReleaseRule;
  /** The chat refuses by the release rule; otherwise the line only says what the rule would say. */
  enforced: boolean;
}

/**
 * A release check with one more line: where the key log stands on the action log of this report, by the chat's own
 * release rule (SPEC §7.5). The line is shown whether or not the chat refuses by the rule. A log found rewritten fails
 * the check whatever the setting, as it fails `pnpm demo:attest`.
 */
export function withKeyLog(check: ReleaseCheck, attestation: Pick<VerifiedModelAttestation, 'signer' | 'deployment' | 'report'>, model: string, { entries, trust, rule, enforced }: KeyLogContext): ReleaseCheck {
  const standing = releaseStanding(entries, { model, signingAddress: attestation.signer.signingAddress, trustedVerifiers: trust.verifiers, quorum: trust.quorum }, attestation, rule);
  const line = releaseInLogLine(standing, enforced);
  return { ...withFinding(check, line), lines: [...check.lines, line] };
}

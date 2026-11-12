// The release behind the key, checked in this browser: the chain of @ainek/proof/release-chain with the image checks of
// the SDK's root entry. It asks GitHub (the compose file, the tag, the build proofs) and Sigstore (the trust root) from
// the visitor's own address, without a token, so it runs only when the visitor asks for it: GitHub allows 60 anonymous
// requests an hour from one address, and one check used seven or eight on Nov 12 (more when the log names more compose
// files, or the engines run another release than the proxy). Import it on demand: it brings the chain with it.
//
// What it reads is the action log of the replica that attested to this browser. Replicas of a model share a signing key
// and the gateway picks one per connection, so the replica that answers a message may be another one.
import { fetchImageProvenance, getSdkError, verifyImageProvenance, type VerifiedModelAttestation } from '@nearai/inference-sdk';
import { releaseStanding, type KeyEntry } from '@ainek/proof';
import { describeRelease, inspectRelease, releaseInLogLine, releaseName, utcText, verdictOf, type ReleaseInspection, type ReleaseLine, type ReleaseVerdict } from '@ainek/proof/release-chain';

export interface ReleaseCheck extends ReleaseVerdict {
  /** The release the log names for the model, when one was resolved. */
  release?: { name: string; file: string; /** `2026-11-12 08:55 UTC`. */ deployedAt: string; builtFrom?: { repository: string; commit: string } };
  /** Why no release was resolved, when none was. */
  unresolved?: string;
  /** Something was left open only because GitHub or Sigstore did not answer: checking again may do better. */
  retry: boolean;
  /** Every release of the model's service in this replica's log, newest first. */
  history: { name: string; commit: string; deployedAt: string }[];
  /** Every fact, in the words `pnpm demo:attest` prints. */
  lines: ReleaseLine[];
}

type Attested = Pick<VerifiedModelAttestation, 'deployment' | 'report'>;

/**
 * Inspections of this session, by the verified report they read. The report itself is the key: the verdict depends on
 * all of it (the action log, both event logs, the app compose), and the chat hands every card of the hour the same one.
 * An inspection under way is shared, so two cards asked at once make one set of requests.
 */
const inspections = new WeakMap<Attested, Promise<ReleaseInspection | undefined>>();

/**
 * Follows the action log of a verified model report to the release that serves `model`. A finished inspection is kept
 * for that report, unless something in it was left open because GitHub or Sigstore did not answer: then the next call
 * asks again. `fetch` is the one GitHub is read with; tests pass a fake.
 */
export async function checkRelease(attestation: Attested, model: string, fetch: typeof globalThis.fetch = globalThis.fetch): Promise<ReleaseCheck> {
  let running = inspections.get(attestation);
  if (!running) {
    running = inspectRelease({ deployment: attestation.deployment, report: attestation.report, model, fetch, sdk: { fetchImageProvenance, verifyImageProvenance, getSdkError } });
    inspections.set(attestation, running);
    const forget = () => void (inspections.get(attestation) === running && inspections.delete(attestation));
    running.then((inspection) => inspection?.retry && forget(), forget);
  }
  // Worded on every call: the lines say how long ago, and a kept inspection grows older.
  return present(await running, model);
}

function present(inspection: ReleaseInspection | undefined, model: string): ReleaseCheck {
  if (!inspection) return { status: 'skipped', failures: [], unchecked: [], unresolved: 'this model report carries no action log', retry: false, history: [], lines: [] };
  // Every service of the model feeds the verdict; the first is the one the sentence names.
  const [served] = inspection.services;
  const built = served?.proxy?.provenance;
  return {
    ...verdictOf(inspection),
    ...(served
      ? {
          release: {
            name: releaseName(served.release),
            file: served.release.file,
            deployedAt: utcText(served.release.deployedAt),
            ...(built?.status === 'ok' ? { builtFrom: { repository: built.value.repository, commit: built.value.commit } } : {}),
          },
        }
      : {}),
    ...(inspection.unresolved ? { unresolved: inspection.unresolved } : {}),
    retry: inspection.retry === true,
    // The log is oldest first.
    history: (served?.history ?? []).map((r) => ({ name: releaseName(r), commit: r.commit, deployedAt: utcText(r.deployedAt) })).reverse(),
    lines: describeRelease(inspection, { model }).lines,
  };
}

/** What the page knows about the public key log when it shows a release: the entries it read and the viewer's rule for them. */
export interface KeyLogContext {
  entries: readonly KeyEntry[];
  trustedVerifiers: readonly string[];
  quorum: number;
  /** The client asks for the launcher to be logged, so only entries for the report's launcher may confirm its log. */
  withLauncher: boolean;
  /** The wait the client asks for, in ms (SPEC §7.5). */
  waitMs: number;
  /** The chat refuses by the release rule; otherwise the line only says what the rule would say. */
  enforced: boolean;
}

/**
 * A release check with one more line: where the public key log stands on the action log of this report, by the chat's
 * own release rule (SPEC §7.5). The line is shown whether or not the chat refuses by the rule. A log found rewritten
 * fails the check whatever the setting, as it fails `pnpm demo:attest`.
 */
export function withKeyLog(check: ReleaseCheck, attestation: Pick<VerifiedModelAttestation, 'signer' | 'deployment' | 'report'>, model: string, log: KeyLogContext): ReleaseCheck {
  const standing = releaseStanding(log.entries, { model, signingAddress: attestation.signer.signingAddress, trustedVerifiers: log.trustedVerifiers, quorum: log.quorum }, attestation, { withLauncher: log.withLauncher, waitMs: log.waitMs });
  const line = releaseInLogLine(standing, log.enforced);
  const lines = [...check.lines, line];
  return line.status === 'fail' ? { ...check, status: 'fail', failures: [...check.failures, line.text], lines } : { ...check, lines };
}


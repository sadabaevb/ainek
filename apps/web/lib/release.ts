// The release behind the key, checked in this browser: the chain of @ainek/proof/release-chain with the image checks of
// the SDK's root entry. It asks GitHub (the compose file, the tag, the build proofs) and Sigstore (the trust root) from
// the visitor's own address, without a token, so it runs only when the visitor asks for it: GitHub allows 60 anonymous
// requests an hour from one address and one check uses up to eight. Import it on demand: it brings the chain with it.
//
// What it reads is the action log of the replica that attested to this browser. Replicas of a model share a signing key
// and the gateway picks one per connection, so the replica that answers a message may be another one.
import { fetchImageProvenance, getSdkError, verifyImageProvenance, type VerifiedModelAttestation } from '@nearai/inference-sdk';
import { describeRelease, failedChecks, inspectRelease, releaseName, uncheckedChecks, utcText, type ReleaseLine } from '@ainek/proof/release-chain';

export interface ReleaseCheck {
  /** `ok`: every check of the release was made and held. `fail`: one did not hold. `skipped`: nothing failed, and something was not checked. */
  status: 'ok' | 'fail' | 'skipped';
  /** The release the log names for the model, when one was resolved. */
  release?: { name: string; file: string; /** `2026-11-12 08:55 UTC`. */ deployedAt: string; builtFrom?: { repository: string; commit: string } };
  /** What failed, then what was not checked, each named as @ainek/proof names it (English). */
  failures: string[];
  unchecked: string[];
  /** Why no release was resolved, when none was. */
  unresolved?: string;
  /** Every release of the model's service in this replica's log, newest first. */
  history: { name: string; commit: string; deployedAt: string }[];
  /** Every fact, in the words `pnpm demo:attest` prints. */
  lines: ReleaseLine[];
}

type Attested = Pick<VerifiedModelAttestation, 'deployment' | 'report'>;

/** Conclusive checks of this session, by model and by the state of the action log they read. */
const checked = new Map<string, ReleaseCheck>();

/**
 * Follows the action log of a verified model report to the release that serves `model`. A result in which every check was
 * made is kept for the session, so a second card or a second click costs no request; one in which something could not be
 * checked is not kept, so that asking again can do better. `fetch` is the one GitHub is read with; tests pass a fake.
 */
export async function checkRelease(attestation: Attested, model: string, fetch: typeof globalThis.fetch = globalThis.fetch): Promise<ReleaseCheck> {
  const log = attestation.deployment.composeManager?.actions ?? [];
  const key = `${model}|${log.length}|${log.at(-1)?.timestamp ?? ''}`;
  const kept = checked.get(key);
  if (kept) return kept;
  const check = await inspect(attestation, model, fetch);
  if (check.release && check.unchecked.length === 0) checked.set(key, check);
  return check;
}

async function inspect(attestation: Attested, model: string, fetch: typeof globalThis.fetch): Promise<ReleaseCheck> {
  const inspection = await inspectRelease({ deployment: attestation.deployment, report: attestation.report, model, fetch, sdk: { fetchImageProvenance, verifyImageProvenance, getSdkError } });
  if (!inspection) return { status: 'skipped', failures: [], unchecked: [], unresolved: 'this model report carries no action log', history: [], lines: [] };
  const failures = failedChecks(inspection);
  const unchecked = uncheckedChecks(inspection);
  // Every service of the model feeds the checks; the first is the one the sentence names.
  const [served] = inspection.services;
  const built = served?.proxy?.provenance;
  return {
    status: failures.length > 0 ? 'fail' : served !== undefined && unchecked.length === 0 ? 'ok' : 'skipped',
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
    failures,
    unchecked,
    ...(inspection.unresolved ? { unresolved: inspection.unresolved } : {}),
    // The log is oldest first.
    history: (served?.history ?? []).map((r) => ({ name: releaseName(r), commit: r.commit, deployedAt: utcText(r.deployedAt) })).reverse(),
    lines: describeRelease(inspection, { model }).lines,
  };
}

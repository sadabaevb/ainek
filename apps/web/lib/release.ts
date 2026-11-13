// The release behind the key, checked in this browser: the chain of @ainek/proof/release-chain with the image checks of
// the SDK's root entry. It asks GitHub (the compose file, the tag, the build proofs) and Sigstore (the trust root) from
// the visitor's own address, without a token, so it runs only when the visitor asks for it: GitHub allows 60 anonymous
// requests an hour from one address, and one check used seven or eight on Nov 12 (more when the log names more compose
// files, or the engines run another release than the proxy). Import it on demand: it brings the chain with it.
//
// What it reads is the action log of the replica that attested to this browser. Replicas of a model share a signing key
// and the gateway picks one per connection, so the replica that answers a message may be another one.
import { fetchImageProvenance, getSdkError, verifyImageProvenance, type VerifiedModelAttestation } from '@nearai/inference-sdk';
import { attestedStateOf, describeRelease, inspectRelease, outsideReadings, releaseName, utcText, verdictOf, type OutsideReading, type ReleaseInspection, type ReleaseLine, type ReleaseVerdict } from '@ainek/proof/release-chain';

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
  /** What the lines were worded from; absent when the report carried no action log. */
  inspection?: ReleaseInspection;
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

/**
 * What three parties outside our team published about the state this report attests (outside-readings.ts in
 * @ainek/proof). Read once the visitor has asked for the release check, from their own address, with no token.
 * `inspection` is the one that check made: it names the release, and without it the readings by key and log still stand.
 */
export function readOutside(attestation: Pick<VerifiedModelAttestation, 'signer' | 'deployment'>, model: string, inspection?: ReleaseInspection): Promise<OutsideReading[]> {
  return outsideReadings(attestedStateOf(attestation, model, inspection));
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
    inspection,
  };
}

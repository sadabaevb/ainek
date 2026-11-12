// Node's entry to the release chain: the checks of @ainek/proof/release-chain with the image checks of the SDK's node
// entry, which asks GitHub and Sigstore directly. What the chain establishes and what it does not is at the top of that
// module and in docs/CLAIMS.md.
import { fetchImageProvenance, getSdkError, verifyImageProvenance } from '@nearai/inference-sdk/node';
import { inspectRelease as inspect, type InspectReleaseParams, type ReleaseInspection } from '@ainek/proof/release-chain';

export type * from '@ainek/proof/release-chain';
export { COMPOSE_REPOSITORY, IMAGE_POLICIES, countText, describeRelease, failedChecks, leadTimes, releaseName, uncheckedChecks, utcText, verdictOf } from '@ainek/proof/release-chain';
// `releaseMarksFor` is not wrapped here: a verifier does not depend on this package and calls it with its own SDK.

/** The chain with this SDK's image checks. */
export function inspectRelease(params: Omit<InspectReleaseParams, 'sdk'>): Promise<ReleaseInspection | undefined> {
  return inspect({ ...params, sdk: { fetchImageProvenance, verifyImageProvenance, getSdkError } });
}

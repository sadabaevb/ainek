// Node's entry to the release chain: the checks of @ainek/proof/release-chain with the image checks of the SDK's node
// entry, which asks GitHub and Sigstore directly. What the chain establishes and what it does not is at the top of that
// module and in docs/CLAIMS.md.
import { fetchImageProvenance, getSdkError, verifyImageProvenance } from '@nearai/inference-sdk/node';
import { inspectRelease as inspect, type InspectReleaseParams, type ProvenanceSdk, type ReleaseInspection } from '@ainek/proof/release-chain';

export * from '@ainek/proof/release-chain';

const sdk: ProvenanceSdk = { fetchImageProvenance, verifyImageProvenance, getSdkError };

/** `inspectRelease` of @ainek/proof/release-chain, with this SDK. */
export function inspectRelease(params: Omit<InspectReleaseParams, 'sdk'>): Promise<ReleaseInspection | undefined> {
  return inspect({ ...params, sdk });
}

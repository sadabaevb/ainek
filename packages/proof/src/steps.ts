// The steps of one Tier-1 exchange, in order. The browser flow (apps/web/lib/flow.ts, which adds `store` and `commit`
// after them) and the Node runner (packages/tier1-node/src/tier1.ts) report the same ids, so one list decides which failures mean
// "nothing was sent".
export const TIER1_STEPS = ['metadata', 'attestation', 'key-log', 'encrypt', 'send', 'signature', 'sdk-check', 'proof'] as const;
export type Tier1StepId = (typeof TIER1_STEPS)[number];

export type FailurePhase = 'not-sent' | 'sent' | 'answered';
/** What a failure at `step` means for the message: nothing left the device; it was handed to the network but no reply could be verified; a reply came and a later check failed. `send` starts at the fetch, so the boundary is exact; a step after the list (the browser's `store`, `commit`) is `answered`. */
export function failurePhase(step: string): FailurePhase {
  const at = TIER1_STEPS.indexOf(step as Tier1StepId);
  const send = TIER1_STEPS.indexOf('send');
  if (at === -1 || at > send) return 'answered';
  return at < send ? 'not-sent' : 'sent';
}

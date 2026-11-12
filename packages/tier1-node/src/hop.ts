// Negative controls for the E2EE route: what a hop between the client and the enclave can do to an encrypted request, and
// how to read what comes back. A subpath of its own (`@ainek/tier1-node/hop`): `pnpm demo:reply-key` loads it and passes
// the hop to `runTier1` as `controlHop`; no client or service does. The background is at the top of apps/demo/src/reply-key.ts.
import { generateKeyPairSync } from 'node:crypto';
import type { Tier1Outcome } from './tier1.ts';

/** A fresh ed25519 public key, hex, as the header carries it: a valid key, so nothing but its being another key can be refused. Its private half is dropped: this hop reads nothing. */
function freshReplyKey(): string {
  return generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
}

/**
 * A hop that replaces the reply key (`x-client-pub-key`) with one of its own. The body is forwarded as it came: a hop
 * cannot re-encrypt it. With `downgrade` it also rewrites the version header from 3 to 2, asking the enclave to treat
 * the request as the older protocol, which bound no reply key.
 */
export function swapReplyKey({ downgrade = false }: { downgrade?: boolean } = {}): (request: Request) => Request {
  return (request) => {
    const headers = new Headers(request.headers);
    headers.set('x-client-pub-key', freshReplyKey());
    if (downgrade) headers.set('x-encryption-version', '2');
    return new Request(request, { headers });
  };
}

/**
 * What a run with a hop showed.
 * - `verified`: the exchange went through and checked out (expected only without a hop).
 * - `refused`: the service answered that it cannot process this request (HTTP 400 or 422) where a reply would have been.
 * - `answered`: a reply came back, readable or not. With a swapped reply key that is the finding: the enclave answered
 *   to a key the client did not send.
 * - `inconclusive`: the run ended for a reason that says nothing about the reply key: nothing was sent, nothing came
 *   back, or the status is about the API key, the balance, the rate limit, the route or the service.
 */
export interface HopResult {
  kind: 'verified' | 'refused' | 'answered' | 'inconclusive';
  /** The HTTP status of the chat response, when one arrived and the exchange did not go through. */
  status?: number;
  detail: string;
  /** For `refused`: whether the response says decryption failed, which is the refusal a swapped reply key should get. */
  decryptionFailed?: boolean;
}

/** Reads the outcome of `runTier1` as a control result, from the status the `send` step recorded. */
export function readHopOutcome(outcome: Tier1Outcome): HopResult {
  if (outcome.kind === 'verified') return { kind: 'verified', detail: `completion ${outcome.completion.id} verified under the attested key` };
  if (outcome.kind === 'refused') return { kind: 'inconclusive', detail: `nothing was sent: ${outcome.reason}` };
  // A step after the send failing means a reply was read: the request got through.
  if (outcome.unverifiedCompletion) return { kind: 'answered', detail: `a reply came back, then ${outcome.step} failed: ${outcome.reason}` };
  const status = outcome.httpStatus;
  // No response at all (a step before the send, a timeout, a dropped connection): that is not the enclave answering.
  if (outcome.step !== 'send' || status === undefined) return { kind: 'inconclusive', detail: `${outcome.step}: ${outcome.reason}` };
  if (status >= 200 && status < 300) return { kind: 'answered', status, detail: outcome.reason };
  if (status === 400 || status === 422) return { kind: 'refused', status, detail: outcome.reason, decryptionFailed: /decrypt/i.test(outcome.reason) };
  return { kind: 'inconclusive', status, detail: outcome.reason };
}

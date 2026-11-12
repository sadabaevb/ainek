// Negative controls for the E2EE route: what a hop between the client and the enclave can do to an encrypted request, and
// how to read what comes back. `pnpm demo:reply-key` uses this through the `hop` parameter of `runTier1`; the client has no hop.
//
// The reply key: the enclave encrypts its answer to a key the client sends in a header (`x-client-pub-key`). E2EE v1 and v2
// did not bind that header to the request, so a hop could put its own key there and read the answer
// (nearai/cloud-api#1061). v3 puts the reply key into the associated data of every encrypted request field: with another
// key in the header the enclave cannot decrypt the request at all.
import { generateKeyPairSync } from 'node:crypto';
import type { Tier1Outcome } from './tier1.ts';

/** A fresh ed25519 public key, hex, as the header carries it. Its private half is dropped: this hop reads nothing. */
function freshReplyKey(): string {
  return generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
}

/**
 * A hop that replaces the reply key with one of its own. The body is forwarded as it came: a hop cannot re-encrypt it.
 * With `downgrade` it also rewrites the version header from 3 to 2, asking the enclave to treat the request as the older
 * protocol, which bound no reply key.
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
 * - `refused`: an HTTP error about the request came back where a reply would have been.
 * - `answered`: a reply came back that this client could not read or verify. With a swapped reply key that is the finding:
 *   the enclave answered to a key the client did not send.
 * - `inconclusive`: the run ended for a reason that says nothing about the reply key.
 */
export interface HopResult {
  kind: 'verified' | 'refused' | 'answered' | 'inconclusive';
  /** The HTTP status that came back instead of a reply. */
  status?: number;
  detail: string;
}

/** Reads the outcome of `runTier1` as a control result. The HTTP status comes from the reason the `send` step gives. */
export function readHopOutcome(outcome: Tier1Outcome): HopResult {
  if (outcome.kind === 'verified') return { kind: 'verified', detail: `completion ${outcome.completion.id} verified under the attested key` };
  if (outcome.kind === 'refused') return { kind: 'inconclusive', detail: `nothing was sent: ${outcome.reason}` };
  if (outcome.step !== 'send') {
    // A later step failing means a reply was read: the request got through.
    return outcome.unverifiedCompletion ? { kind: 'answered', detail: `a reply came back, then ${outcome.step} failed: ${outcome.reason}` } : { kind: 'inconclusive', detail: `${outcome.step}: ${outcome.reason}` };
  }
  const http = /^chat completion failed: HTTP (\d{3})\s*([\s\S]*)$/.exec(outcome.reason);
  // No HTTP error, and the step still failed: a 2xx came back that could not be decrypted or parsed.
  if (!http) return { kind: 'answered', detail: outcome.reason };
  const status = Number(http[1]);
  // 401, 402, 403 and 429 are about the API key, the balance and the rate limit; 5xx is the service. None is about this request.
  const aboutTheRequest = status >= 400 && status < 500 && ![401, 402, 403, 429].includes(status);
  return { kind: aboutTheRequest ? 'refused' : 'inconclusive', status, detail: http[2] ?? '' };
}

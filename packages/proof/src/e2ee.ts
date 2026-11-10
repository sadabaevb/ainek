// The E2EE version this client accepts for its own requests. NEAR AI's SDK encrypts and sets the version header; we do
// not re-implement the encryption. These checks read the SDK's own mark on a request: they are a tripwire against an
// SDK that is older or was changed (and, in the relay, against a tab still running an older build), not a proof that
// the binding below was made. That rests on the pinned SDK.
//
// Why the version matters: under versions 1 and 2 the key the reply is encrypted to travels in a header that nothing
// ties to the request, so a hop on the way could swap it and read the reply. Version 3 mixes that key into every
// encrypted field of the request (as AEAD associated data): with another key in the header the fields no longer decrypt.

const E2EE_VERSION = '3';
/** Headers only an E2EE request carries. `x-model-pub-key` names the key it is encrypted to, `x-client-pub-key` the reply key. */
const E2EE_HEADERS = ['x-model-pub-key', 'x-client-pub-key', 'x-encryption-version', 'x-encrypt-all-fields'] as const;

type HeaderReader = { get(name: string): string | null };

/** Whether the request carries any E2EE header, complete or not. */
export function looksE2ee(headers: HeaderReader): boolean {
  return E2EE_HEADERS.some((name) => headers.get(name) !== null);
}

/** Why these request headers are not a complete E2EE request of the version we accept, or null when they are. */
export function e2eeVersionProblem(headers: HeaderReader): string | null {
  const version = headers.get('x-encryption-version');
  if (version !== E2EE_VERSION) return `E2EE version ${E2EE_VERSION} required, the request says ${version ?? 'none'}`;
  if (headers.get('x-model-pub-key') === null || headers.get('x-client-pub-key') === null) return 'E2EE request without the model key or the reply key';
  return null;
}

/** Throws unless the prepared request is marked as E2EE of the version we accept. Call it before the request leaves. */
export function requireE2eeVersion(headers: HeaderReader): void {
  const problem = e2eeVersionProblem(headers);
  if (problem) throw new Error(`${problem}: not sent`);
}

// The E2EE version this client accepts for its own requests. NEAR AI's SDK encrypts and sets the version header; we do
// not re-implement the encryption, we only refuse to send anything the SDK did not mark as this version.
//
// Why it matters: under versions 1 and 2 the key the reply is encrypted to travels in a header that nothing ties to the
// request, so a hop on the way could swap it and read the reply. Version 3 mixes that key into every encrypted field of
// the request (as AEAD associated data): with another key in the header the fields no longer decrypt.

export const E2EE_VERSION = '3';
export const E2EE_VERSION_HEADER = 'x-encryption-version';

/** Why these request headers are not an E2EE request of the version we accept, or null when they are. */
export function e2eeVersionProblem(headers: { get(name: string): string | null }): string | null {
  const version = headers.get(E2EE_VERSION_HEADER);
  return version === E2EE_VERSION ? null : `E2EE version ${E2EE_VERSION} required, the request says ${version ?? 'none'}`;
}

/** Throws unless the prepared request is E2EE of the version we accept. Call it before the request leaves. */
export function requireE2eeVersion(headers: { get(name: string): string | null }): void {
  const problem = e2eeVersionProblem(headers);
  if (problem) throw new Error(`${problem}: not sent`);
}

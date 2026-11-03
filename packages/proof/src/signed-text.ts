// `text` from `/v1/signature/{id}`:
//   provider_tee:  "<model>:<sha256(request bytes)>:<sha256(response bytes)>"
//   gateway:       "<sha256(request bytes)>:<sha256(response bytes)>"
// The model id may contain "/" but the two hashes are always the last two ":"-separated fields.
import { isHex64 } from './hash.ts';

export interface SignedText {
  /** null for a gateway-signed text (no model id inside). */
  model: string | null;
  requestSha256: string;
  responseSha256: string;
}

export function parseSignedText(text: string): SignedText {
  const parts = text.split(':');
  if (parts.length < 2) throw new Error('signed text must contain at least "<req hash>:<resp hash>"');
  const responseSha256 = parts[parts.length - 1] as string;
  const requestSha256 = parts[parts.length - 2] as string;
  if (!isHex64(requestSha256) || !isHex64(responseSha256)) {
    throw new Error('signed text must end with two 64-hex sha256 values');
  }
  const head = parts.slice(0, -2).join(':');
  return { model: head === '' ? null : head, requestSha256, responseSha256 };
}

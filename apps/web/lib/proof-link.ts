// A proof you can pass on as a link: the "Disclose to auditor" file (SPEC §5.4), deflated and base64url-encoded into the URL
// fragment of /verify. A fragment is never sent to a server, so the page that serves /verify does not see it; whoever gets the
// link does, and the link is as private as the file.
import { base64ToBytes, bytesToBase64 } from '@ainek/proof';

const PARAM = 'd=';
/** A disclosure is a few kilobytes; these stop a crafted link from making the page inflate megabytes. */
const MAX_FRAGMENT_CHARS = 200_000;
const MAX_JSON_BYTES = 1_000_000;

const toBase64Url = (bytes: Uint8Array) => bytesToBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const fromBase64Url = (text: string) => base64ToBytes(text.replaceAll('-', '+').replaceAll('_', '/'));
const streamOf = (bytes: Uint8Array) => new Blob([bytes as BlobPart]).stream();

/** Inflates with a ceiling on the output: the stream is cancelled as soon as it passes `limit`. */
async function inflate(bytes: Uint8Array, limit: number): Promise<Uint8Array> {
  const reader = streamOf(bytes).pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const out = new Uint8Array(limit);
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out.subarray(0, size);
    if (size + value.length > limit) {
      await reader.cancel();
      throw new Error('the link holds more than a proof');
    }
    out.set(value, size);
    size += value.length;
  }
}

/** The fragment (without `#`) that carries `json`, the text of a disclosure file. */
export async function proofFragment(json: string): Promise<string> {
  const deflated = await new Response(streamOf(new TextEncoder().encode(json)).pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer();
  const fragment = PARAM + toBase64Url(new Uint8Array(deflated));
  // Refused here rather than by whoever opens the link: the limits are the reader's.
  if (json.length > MAX_JSON_BYTES || fragment.length > MAX_FRAGMENT_CHARS) throw new Error('too long for a link');
  return fragment;
}

/** The disclosure text in a URL fragment (with or without `#`), or null when the fragment is not a proof link. Throws on a damaged one. */
export async function proofFromFragment(fragment: string): Promise<string | null> {
  const body = fragment.replace(/^#/, '');
  if (!body.startsWith(PARAM)) return null;
  if (body.length > MAX_FRAGMENT_CHARS) throw new Error('the link is too long to be a proof');
  return new TextDecoder('utf-8', { fatal: true }).decode(await inflate(fromBase64Url(body.slice(PARAM.length)), MAX_JSON_BYTES));
}

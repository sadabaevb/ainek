// A proof you can pass on as a link: the "Disclose to auditor" file (SPEC §5.4), deflated and base64url-encoded into the URL
// fragment of /verify. A fragment is never sent to a server, so the page that serves /verify does not see it; whoever gets the
// link does, and the link is as private as the file.
const PARAM = 'd=';
/** A disclosure is a few kilobytes; these stop a crafted link from making the page inflate megabytes. */
const MAX_FRAGMENT_CHARS = 200_000;
const MAX_JSON_BYTES = 1_000_000;

const toBase64Url = (bytes: Uint8Array) => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
};
const fromBase64Url = (text: string) => Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0));

async function pipe(bytes: Uint8Array, through: CompressionStream | DecompressionStream, limit = Infinity): Promise<Uint8Array> {
  const reader = new Blob([bytes as BlobPart]).stream().pipeThrough(through).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw new Error('the link holds more than a proof');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/** The fragment (without `#`) that carries `json`, the text of a disclosure file. */
export async function proofFragment(json: string): Promise<string> {
  return PARAM + toBase64Url(await pipe(new TextEncoder().encode(json), new CompressionStream('deflate-raw')));
}

/** The disclosure text in a URL fragment (with or without `#`), or null when the fragment is not a proof link. Throws on a damaged one. */
export async function proofFromFragment(fragment: string): Promise<string | null> {
  const body = fragment.replace(/^#/, '');
  if (!body.startsWith(PARAM)) return null;
  if (body.length > MAX_FRAGMENT_CHARS) throw new Error('the link is too long to be a proof');
  return new TextDecoder('utf-8', { fatal: true }).decode(await pipe(fromBase64Url(body.slice(PARAM.length)), new DecompressionStream('deflate-raw'), MAX_JSON_BYTES));
}

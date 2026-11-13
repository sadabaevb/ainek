// What the NEAR AI relay (app/api/nearai/[...path]/route.ts, SPEC §3.4) forwards: exactly the requests the page makes
// through the pinned SDK (0.3.0) for the two configured models, and the headers it sends. relay-guard.test.ts drives
// the same code (nearai-requests.ts), so an SDK update that changes them fails a test instead of the hosted chat.
import { e2eeVersionProblem, looksE2ee } from '@ainek/proof';

/** Request headers the SDK and the chat request send: content negotiation, model-key routing and E2EE. The relay drops
 *  everything else (cookies, platform-injected forwarding headers, user agent). */
export const ALLOWED_REQUEST_HEADERS: ReadonlySet<string> = new Set(['accept', 'content-type', 'x-no-aliasing', 'x-model-pub-key', 'x-client-pub-key', 'x-signing-algo', 'x-encryption-version', 'x-encrypt-all-fields']);

/** The largest chat request the relay forwards: this many messages, and this many bytes of body (encrypted, a message
 *  takes two bytes for each byte of its text). The page fits the history it sends to both (lib/history.ts). */
export const MAX_MESSAGES = 50;
export const MAX_BODY_BYTES = 64 * 1024;
const NO_PARAMS: ReadonlySet<string> = new Set();
/** How much the page asks the private model to reason before it answers: little, so that an open question is answered
 *  in well under a minute and not in two or three, at a cost in correctness (the runs are in docs/METRICS.md, Nov 13).
 *  The field travels in the clear beside the encrypted messages and says nothing of them. */
export const REASONING_EFFORT = 'low';
/** The top-level fields of the page's chat request (the E2EE wrapper keeps them; only contents are encrypted). */
const CHAT_FIELDS: ReadonlySet<string> = new Set(['model', 'messages', 'stream', 'reasoning_effort']);

function decoded(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** A completion id as the SDK writes it, `encodeURIComponent(id)`: one path segment that decodes to no slash and no dot path. */
function completionIdOk(segment: string): boolean {
  const id = decoded(segment);
  return id !== null && encodeURIComponent(id) === segment && /^[^/\\\s]{1,256}$/.test(id) && id !== '.' && id !== '..';
}

/** Paths without an argument, keyed by `METHOD a/b`, with the query parameters the SDK sets on them. */
const FIXED_ROUTES: Readonly<Record<string, ReadonlySet<string>>> = {
  'POST chat/completions': NO_PARAMS,
  // Model attestation (model, provider, nonce, …) and gateway attestation (nonce, signing_algo, include_tls_fingerprint).
  'GET attestation/report': new Set(['model', 'provider', 'nonce', 'include_tls_fingerprint', 'signing_algo', 'signing_address']),
};

/** Paths `v1/<kind>/<arg>`, keyed by `METHOD kind`. */
const ARG_ROUTES: Readonly<Record<string, { ok: (segment: string, models: ReadonlySet<string>) => boolean; problem: string; params: ReadonlySet<string> }>> = {
  // The SDK writes the segment as encodeURIComponent(model): compare that form, so no other encoding gets through.
  'GET model': { ok: (s, models) => [...models].some((m) => encodeURIComponent(m) === s), problem: 'model not allowed', params: NO_PARAMS },
  'GET signature': { ok: completionIdOk, problem: 'completion id not allowed', params: new Set(['signing_algo']) },
};

/**
 * What a relay with no API key can still forward: the reads. The model's metadata and its attestation report are public
 * at NEAR AI, so the checks before sending (the evidence, the key log, the refusals, the release behind the key) work
 * from a clean clone with no key; only a message needs one. A read that does need the key is refused upstream.
 */
export const KEY_MISSING = 'NEARAI_API_KEY is not set on the server';
export function keyProblem(method: string, apiKey: string | undefined): string | null {
  return apiKey || method === 'GET' ? null : KEY_MISSING;
}

/** Why this request may not go upstream, or null when it is one the page makes for one of the configured models. */
export function relayRequestProblem(method: string, rawPath: string, query: URLSearchParams, models: ReadonlySet<string>): string | null {
  const [v1, kind, arg, ...extra] = rawPath.split('/');
  if (v1 !== 'v1' || arg === undefined || extra.length > 0) return 'path not allowed';
  let params = FIXED_ROUTES[`${method} ${kind}/${arg}`];
  if (!params) {
    const route = ARG_ROUTES[`${method} ${kind}`];
    if (!route) return 'path not allowed';
    if (!route.ok(arg, models)) return route.problem;
    params = route.params;
  }
  const keys = [...query.keys()];
  if (keys.some((k) => !params.has(k))) return 'query parameter not allowed';
  if (new Set(keys).size !== keys.length) return 'query parameter repeated';
  const model = query.get('model');
  if (model !== null && !models.has(model)) return 'model not allowed';
  return null;
}

/** The page's chat request and nothing more: its fields, one of our models, not streamed, a bounded number of messages,
 *  and written the way the page writes it. The relay forwards the bytes it was sent and not what it parsed, so a body
 *  that names a field twice (a refused model first, an allowed one last) would be checked as one thing and read upstream
 *  as another: the body must be exactly the JSON that `JSON.stringify` gives for what was parsed, which is what the page
 *  and the SDK's E2EE wrapper produce. The setting for reasoning goes only with the attested model.
 *  A request with any E2EE header must be a complete one of the current version, and the attested model is taken only that
 *  way; the Incognito model may be plaintext by design (SPEC §3.9). The relay reads the SDK's marks, not the body: this
 *  stops a tab on an older build from sending an unbound reply key, it does not prove the contents are ciphertext. */
export function completionProblem(body: ArrayBuffer, models: ReadonlySet<string>, headers: { get(name: string): string | null }, attestedModel: string): string | null {
  const text = new TextDecoder().decode(body);
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return 'body is not JSON';
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return 'body is not a JSON object';
  if (JSON.stringify(json) !== text) return 'body is not the JSON the page writes';
  if (Object.keys(json).some((k) => !CHAT_FIELDS.has(k))) return 'field not allowed';
  if (typeof json.model !== 'string' || !models.has(json.model)) return 'model not allowed';
  if (json.stream !== undefined && json.stream !== false) return 'streaming not allowed';
  // A tab on another build is the one honest way to get here, hence the same advice as for the E2EE version below.
  if (json.reasoning_effort !== undefined && (json.reasoning_effort !== REASONING_EFFORT || json.model !== attestedModel)) return 'reasoning effort not allowed. Reload the page: it may be running another build';
  if (!Array.isArray(json.messages) || json.messages.length === 0 || json.messages.length > MAX_MESSAGES) return `messages must be 1..${MAX_MESSAGES}`;
  if (looksE2ee(headers)) {
    const problem = e2eeVersionProblem(headers);
    return problem && `${problem}. Reload the page: it may be running an older build`;
  }
  return json.model === attestedModel ? 'the attested model takes only end-to-end encrypted requests' : null;
}

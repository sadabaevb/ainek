// What the NEAR AI relay (app/api/nearai/[...path]/route.ts, SPEC §3.4) forwards: exactly the requests the page makes
// through the pinned SDK (0.2.1) for the two configured models, and the headers it sends. relay-guard.test.ts drives
// the same code (nearai-requests.ts), so an SDK update that changes them fails a test instead of the hosted chat.

/** Request headers the SDK and the chat request send: content negotiation, model-key routing and E2EE. The relay drops
 *  everything else (cookies, platform-injected forwarding headers, user agent). */
export const ALLOWED_REQUEST_HEADERS: ReadonlySet<string> = new Set(['accept', 'content-type', 'x-no-aliasing', 'x-model-pub-key', 'x-client-pub-key', 'x-signing-algo', 'x-encryption-version', 'x-encrypt-all-fields']);

const MAX_MESSAGES = 50;
const NO_PARAMS: ReadonlySet<string> = new Set();
/** The top-level fields of the page's chat request (the E2EE wrapper keeps them; only contents are encrypted). */
const CHAT_FIELDS: ReadonlySet<string> = new Set(['model', 'messages', 'stream']);

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

/** The page's chat request and nothing more: its three fields, one of our models, not streamed, a bounded number of messages. */
export function completionProblem(body: ArrayBuffer, models: ReadonlySet<string>): string | null {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
  } catch {
    return 'body is not JSON';
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return 'body is not a JSON object';
  if (Object.keys(json).some((k) => !CHAT_FIELDS.has(k))) return 'field not allowed';
  if (typeof json.model !== 'string' || !models.has(json.model)) return 'model not allowed';
  if (json.stream !== undefined && json.stream !== false) return 'streaming not allowed';
  if (!Array.isArray(json.messages) || json.messages.length === 0 || json.messages.length > MAX_MESSAGES) return `messages must be 1..${MAX_MESSAGES}`;
  return null;
}

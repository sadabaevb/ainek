// What the NEAR AI relay (app/api/nearai/[...path]/route.ts, SPEC §3.4) forwards: exactly the requests the pinned SDK
// (0.2.1) makes for the two configured models, and the headers it sends. relay-guard.test.ts drives the SDK itself, so
// an SDK update that changes its requests fails a test instead of the hosted chat.

/** Request headers the SDK and the chat request send: content negotiation, model-key routing and E2EE. The relay drops
 *  everything else (cookies, platform-injected forwarding headers, user agent). */
export const ALLOWED_REQUEST_HEADERS: ReadonlySet<string> = new Set(['accept', 'content-type', 'x-no-aliasing', 'x-model-pub-key', 'x-client-pub-key', 'x-signing-algo', 'x-encryption-version', 'x-encrypt-all-fields']);

const MAX_MESSAGES = 50;
const NO_PARAMS: ReadonlySet<string> = new Set();
/** Completion ids: 32 hex for the TEE models; the Incognito gateway may use another alphabet, never `.`, `%` or `/`. */
const COMPLETION_ID = /^[A-Za-z0-9_-]{1,128}$/;

interface Route {
  /** For `v1/<kind>/<arg>` routes: whether the third segment is acceptable, and what to say when it is not. */
  arg?: { ok: (segment: string, models: ReadonlySet<string>) => boolean; problem: string };
  /** The query parameters the SDK sets on this request. */
  params: ReadonlySet<string>;
}

/** Keyed by `METHOD a/b` for fixed paths and `METHOD kind` for paths with an argument. */
const ROUTES: Readonly<Record<string, Route>> = {
  'POST chat/completions': { params: NO_PARAMS },
  // Model attestation (model, provider, nonce, …) and gateway attestation (nonce, signing_algo, include_tls_fingerprint).
  'GET attestation/report': { params: new Set(['model', 'provider', 'nonce', 'include_tls_fingerprint', 'signing_algo', 'signing_address']) },
  // The SDK writes the segment as encodeURIComponent(model): compare that form, so no other encoding gets through.
  'GET model': { arg: { ok: (s, models) => [...models].some((m) => encodeURIComponent(m) === s), problem: 'model not allowed' }, params: NO_PARAMS },
  'GET signature': { arg: { ok: (s) => COMPLETION_ID.test(s), problem: 'completion id not allowed' }, params: new Set(['signing_algo']) },
};

/** Why this request may not go upstream, or null when it is one the SDK makes for one of the configured models. */
export function relayRequestProblem(method: string, rawPath: string, query: URLSearchParams, models: ReadonlySet<string>): string | null {
  const [v1, kind, arg, ...extra] = rawPath.split('/');
  if (v1 !== 'v1' || arg === undefined || extra.length > 0) return 'path not allowed';
  const fixed = ROUTES[`${method} ${kind}/${arg}`];
  const withArg = fixed ? undefined : ROUTES[`${method} ${kind}`];
  const route = fixed ?? (withArg?.arg ? withArg : undefined);
  if (!route) return 'path not allowed';
  if (route.arg && !route.arg.ok(arg, models)) return route.arg.problem;
  const keys = [...query.keys()];
  if (keys.some((k) => !route.params.has(k))) return 'query parameter not allowed';
  if (new Set(keys).size !== keys.length) return 'query parameter repeated';
  const model = query.get('model');
  if (model !== null && !models.has(model)) return 'model not allowed';
  return null;
}

/** Only the two configured models, a single non-streamed completion, a bounded number of messages. Content stays opaque. */
export function completionProblem(body: ArrayBuffer, models: ReadonlySet<string>): string | null {
  try {
    const json = JSON.parse(new TextDecoder().decode(body)) as { model?: unknown; stream?: unknown; n?: unknown; messages?: unknown };
    if (typeof json.model !== 'string' || !models.has(json.model)) return 'model not allowed';
    if (json.stream === true) return 'streaming not allowed';
    if (json.n !== undefined && json.n !== 1) return 'n must be 1';
    if (!Array.isArray(json.messages) || json.messages.length === 0 || json.messages.length > MAX_MESSAGES) return `messages must be 1..${MAX_MESSAGES}`;
    return null;
  } catch {
    return 'body is not JSON';
  }
}

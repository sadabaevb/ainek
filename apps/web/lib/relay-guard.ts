// What the NEAR AI relay (app/api/nearai/[...path]/route.ts) forwards: the exact requests the pinned SDK (0.2.1) makes,
// nothing near them. A path segment is compared after decoding, so an encoded slash or dot cannot reach another
// upstream path, and every query parameter must be one the SDK sets.

/** The SDK's attestation query (`getAttestationReport`) and signature query (`getSignature`). */
const ATTESTATION_PARAMS = new Set(['model', 'provider', 'nonce', 'include_tls_fingerprint', 'signing_algo', 'signing_address']);
const SIGNATURE_PARAMS = new Set(['model', 'signing_algo']);
/** Completion ids: 32 hex for the TEE models; the Incognito gateway may use another alphabet, but never `.`, `%` or `/`. */
const COMPLETION_ID = /^[A-Za-z0-9_-]{1,128}$/;

function decoded(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** Every key is one we expect, at most once, and a `model` (required where the SDK always sends it) is one of ours. */
function queryProblem(query: URLSearchParams, allowed: ReadonlySet<string>, models: ReadonlySet<string>, modelRequired: boolean): string | null {
  const keys = [...query.keys()];
  if (keys.some((k) => !allowed.has(k))) return 'query parameter not allowed';
  if (new Set(keys).size !== keys.length) return 'query parameter repeated';
  const model = query.get('model');
  if (model === null ? modelRequired : !models.has(model)) return 'model not allowed';
  return null;
}

/** Why this request may not go upstream, or null when it is one the SDK makes for one of the configured models. */
export function relayRequestProblem(method: string, rawPath: string, query: URLSearchParams, models: ReadonlySet<string>): string | null {
  const parts = rawPath.split('/');
  if (parts[0] !== 'v1') return 'path not allowed';
  const [, kind, arg, ...extra] = parts;
  if (extra.length > 0) return 'path not allowed';
  if (method === 'POST' && kind === 'chat' && arg === 'completions') return query.size === 0 ? null : 'query parameter not allowed';
  if (method !== 'GET') return 'path not allowed';
  if (kind === 'model' && arg !== undefined) {
    const model = decoded(arg);
    if (model === null || !models.has(model)) return 'model not allowed';
    return query.size === 0 ? null : 'query parameter not allowed';
  }
  if (kind === 'attestation' && arg === 'report') return queryProblem(query, ATTESTATION_PARAMS, models, true);
  if (kind === 'signature' && arg !== undefined) {
    if (!COMPLETION_ID.test(arg)) return 'completion id not allowed';
    return queryProblem(query, SIGNATURE_PARAMS, models, false);
  }
  return 'path not allowed';
}

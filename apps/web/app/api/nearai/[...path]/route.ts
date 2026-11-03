// Byte-exact proxy to NEAR AI Cloud (SPEC §3.4). The browser runs the SDK itself: it verifies attestation,
// encrypts to the model key and checks signatures. This route only adds the server-side API key and forwards
// the allowed paths unchanged, so the server sees ciphertext, sizes and IPs, never plaintext. No body logging.
import { DEFAULT_NEAR_AI_CLOUD_BASE_URL } from '@nearai/inference-sdk/node';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALLOWED_PATHS: ReadonlyArray<readonly [method: string, pattern: RegExp]> = [
  ['GET', /^v1\/model\/[^/]+$/],
  ['GET', /^v1\/attestation\/report$/],
  ['POST', /^v1\/chat\/completions$/],
  ['GET', /^v1\/signature\/[^/]+$/],
];
// The closed set of request headers the pinned SDK (0.2.1) sends: content negotiation, model-key routing and
// E2EE headers. Everything else (cookies, platform-injected forwarding headers, user agent) stays here.
const ALLOWED_REQUEST_HEADERS = new Set(['accept', 'content-type', 'x-no-aliasing', 'x-model-pub-key', 'x-client-pub-key', 'x-signing-algo', 'x-encryption-version', 'x-encrypt-all-fields']);
// Hop-by-hop headers that must not be copied from the upstream response.
const DROPPED_RESPONSE_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'set-cookie']);

const upstreamOrigin = new URL(process.env.NEARAI_BASE_URL ?? DEFAULT_NEAR_AI_CLOUD_BASE_URL).origin;

async function proxy(req: Request): Promise<Response> {
  const apiKey = process.env.NEARAI_API_KEY;
  if (!apiKey) return NextResponse.json({ error: 'NEARAI_API_KEY is not set on the server' }, { status: 503 });

  // Keep the raw (still URL-encoded) path so model ids like z-ai%2Fglm-5.3-flash reach upstream unchanged.
  const url = new URL(req.url);
  const rest = url.pathname.replace(/^\/api\/nearai\//, '');
  if (!ALLOWED_PATHS.some(([method, pattern]) => method === req.method && pattern.test(rest))) {
    return NextResponse.json({ error: `path not allowed: ${req.method} /${rest}` }, { status: 404 });
  }

  const headers = new Headers({ authorization: `Bearer ${apiKey}`, 'accept-encoding': 'identity' }); // the browser hashes these exact bytes
  req.headers.forEach((value, name) => {
    if (ALLOWED_REQUEST_HEADERS.has(name)) headers.set(name, value);
  });

  const upstream = await fetch(`${upstreamOrigin}/${rest}${url.search}`, {
    method: req.method,
    headers,
    body: req.method === 'POST' ? await req.arrayBuffer() : null,
    redirect: 'manual',
  });

  const out = new Headers({ 'cache-control': 'no-store' });
  upstream.headers.forEach((value, name) => {
    if (!DROPPED_RESPONSE_HEADERS.has(name)) out.set(name, value);
  });
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

export const GET = proxy;
export const POST = proxy;

// Byte-exact proxy to NEAR AI Cloud (SPEC §3.4). The browser runs the SDK itself: it verifies attestation,
// encrypts to the model key and checks signatures. This route only adds the server-side API key and forwards
// the allowed paths unchanged, so the server sees ciphertext, sizes and IPs. The one exception is the
// user-chosen Incognito model (SPEC §3.9): no model key exists, so that request is plaintext and the card says so.
// No body logging. Guards below keep a stranger from spending the key: same-origin callers only, the two
// configured models, no streaming or n>1, small bodies, a per-IP rate limit; NEAR AI's spend limit is the backstop.
import { ainekConfigFromEnv } from '@ainek/proof';
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
const MAX_BODY_BYTES = 64 * 1024;
const MAX_MESSAGES = 50;
const RATE_LIMIT = { windowMs: 60_000, max: 30 };

const cfg = ainekConfigFromEnv(process.env);
const upstreamOrigin = new URL(cfg.nearaiBaseUrl).origin;
const allowedModels = new Set([cfg.model, cfg.incognitoModel]);
const hits = new Map<string, number[]>(); // ip -> request timestamps inside the window (one process; fine for the demo)

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < RATE_LIMIT.windowMs);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > RATE_LIMIT.max;
}

function sameOrigin(req: Request, origin: string): boolean {
  const site = req.headers.get('sec-fetch-site');
  const from = req.headers.get('origin');
  return site === 'same-origin' || from === origin;
}

/** Only the two configured models, a single non-streamed completion, a bounded number of messages. Content stays opaque. */
function completionAllowed(body: ArrayBuffer): string | null {
  try {
    const json = JSON.parse(new TextDecoder().decode(body)) as { model?: unknown; stream?: unknown; n?: unknown; messages?: unknown };
    if (typeof json.model !== 'string' || !allowedModels.has(json.model)) return 'model not allowed';
    if (json.stream === true) return 'streaming not allowed';
    if (json.n !== undefined && json.n !== 1) return 'n must be 1';
    if (!Array.isArray(json.messages) || json.messages.length === 0 || json.messages.length > MAX_MESSAGES) return `messages must be 1..${MAX_MESSAGES}`;
    return null;
  } catch {
    return 'body is not JSON';
  }
}

async function proxy(req: Request): Promise<Response> {
  const apiKey = process.env.NEARAI_API_KEY;
  if (!apiKey) return NextResponse.json({ error: 'NEARAI_API_KEY is not set on the server' }, { status: 503 });

  // Keep the raw (still URL-encoded) path so model ids like z-ai%2Fglm-5.3-flash reach upstream unchanged.
  const url = new URL(req.url);
  const rest = url.pathname.replace(/^\/api\/nearai\//, '');
  if (!ALLOWED_PATHS.some(([method, pattern]) => method === req.method && pattern.test(rest))) {
    return NextResponse.json({ error: `path not allowed: ${req.method} /${rest}` }, { status: 404 });
  }
  if (!sameOrigin(req, url.origin)) return NextResponse.json({ error: 'same-origin requests only' }, { status: 403 });
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
  if (rateLimited(ip)) return NextResponse.json({ error: 'rate limit: 30 requests per minute' }, { status: 429 });

  let body: ArrayBuffer | null = null;
  if (req.method === 'POST') {
    body = await req.arrayBuffer();
    if (body.byteLength > MAX_BODY_BYTES) return NextResponse.json({ error: `body larger than ${MAX_BODY_BYTES} bytes` }, { status: 413 });
    const problem = completionAllowed(body);
    if (problem) return NextResponse.json({ error: problem }, { status: 400 });
  }

  const headers = new Headers({ authorization: `Bearer ${apiKey}`, 'accept-encoding': 'identity' }); // the browser hashes these exact bytes
  req.headers.forEach((value, name) => {
    if (ALLOWED_REQUEST_HEADERS.has(name)) headers.set(name, value);
  });

  const upstream = await fetch(`${upstreamOrigin}/${rest}${url.search}`, { method: req.method, headers, body, redirect: 'manual' });

  const out = new Headers({ 'cache-control': 'no-store' });
  upstream.headers.forEach((value, name) => {
    if (!DROPPED_RESPONSE_HEADERS.has(name)) out.set(name, value);
  });
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

export const GET = proxy;
export const POST = proxy;

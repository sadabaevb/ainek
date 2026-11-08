// Byte-exact proxy to NEAR AI Cloud (SPEC §3.4). The browser runs the SDK itself: it verifies attestation,
// encrypts to the model key and checks signatures. This route only adds the server-side API key and forwards
// the allowed paths unchanged, so the server sees ciphertext, sizes and IPs. The one exception is the
// user-chosen Incognito model (SPEC §3.9): no model key exists, so that request is plaintext and the card says so.
// No body logging. What limits a stranger spending the key, strongest first (SPEC §3.4): the key's spend limit; only the
// SDK's own requests for the two configured models (lib/relay-guard.ts); a per-IP limit in this instance's memory (the
// Vercel firewall rule in docs/DEPLOY.md is the shared one); a same-origin check, which stops other sites' pages in a
// browser but not a script.
import { ainekConfigFromEnv } from '@ainek/proof';
import { NextResponse } from 'next/server';
import { ALLOWED_REQUEST_HEADERS, completionProblem, relayRequestProblem } from '@/lib/relay-guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Hop-by-hop headers, cookies, and caching: no upstream answer may tell Vercel's CDN to keep it.
const DROPPED_RESPONSE_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'set-cookie', 'cache-control', 'cdn-cache-control', 'vercel-cdn-cache-control']);
const MAX_BODY_BYTES = 64 * 1024;
const RATE_LIMIT = { windowMs: 60_000, max: 30 };

const cfg = ainekConfigFromEnv(process.env);
const upstreamOrigin = new URL(cfg.nearaiBaseUrl).origin;
const allowedModels = new Set([cfg.model, cfg.incognitoModel]);
const hits = new Map<string, number[]>(); // ip -> request timestamps inside the window, this instance only

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < RATE_LIMIT.windowMs);
  if (recent.length >= RATE_LIMIT.max) {
    hits.set(ip, recent); // a refused request is not counted, so the list stays at most `max` long
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 1_000) for (const [other, times] of hits) if (times.every((t) => now - t >= RATE_LIMIT.windowMs)) hits.delete(other); // forget idle IPs
  return false;
}

function sameOrigin(req: Request, origin: string): boolean {
  const site = req.headers.get('sec-fetch-site');
  const from = req.headers.get('origin');
  return site === 'same-origin' || from === origin;
}

async function proxy(req: Request): Promise<Response> {
  // Keep the raw (still URL-encoded) path so model ids like z-ai%2Fglm-5.3-flash reach upstream unchanged.
  const url = new URL(req.url);
  const rest = url.pathname.replace(/^\/api\/nearai\//, '');
  const refused = relayRequestProblem(req.method, rest, url.searchParams, allowedModels);
  if (refused) return NextResponse.json({ error: `${refused}: ${req.method} /${rest}` }, { status: 404 });
  if (!sameOrigin(req, url.origin)) return NextResponse.json({ error: 'same-origin requests only' }, { status: 403 });
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
  if (rateLimited(ip)) return NextResponse.json({ error: 'rate limit: 30 requests per minute' }, { status: 429 });

  let body: ArrayBuffer | null = null;
  if (req.method === 'POST') {
    if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return NextResponse.json({ error: `body larger than ${MAX_BODY_BYTES} bytes` }, { status: 413 });
    body = await req.arrayBuffer();
    if (body.byteLength > MAX_BODY_BYTES) return NextResponse.json({ error: `body larger than ${MAX_BODY_BYTES} bytes` }, { status: 413 });
    const problem = completionProblem(body, allowedModels);
    if (problem) return NextResponse.json({ error: problem }, { status: 400 });
  }

  // After the guards, so a request we would refuse is refused the same way with or without a key configured.
  const apiKey = process.env.NEARAI_API_KEY;
  if (!apiKey) return NextResponse.json({ error: 'NEARAI_API_KEY is not set on the server' }, { status: 503 });

  const headers = new Headers({ authorization: `Bearer ${apiKey}`, 'accept-encoding': 'identity' }); // the browser hashes these exact bytes
  req.headers.forEach((value, name) => {
    if (ALLOWED_REQUEST_HEADERS.has(name)) headers.set(name, value);
  });

  const upstream = await fetch(`${upstreamOrigin}/${rest}${url.search}`, { method: req.method, headers, body, redirect: 'manual' });

  const out = new Headers();
  upstream.headers.forEach((value, name) => {
    if (!DROPPED_RESPONSE_HEADERS.has(name)) out.set(name, value);
  });
  out.set('cache-control', 'no-store');
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

export const GET = proxy;
export const POST = proxy;

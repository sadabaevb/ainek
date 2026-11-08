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
let lastSweep = 0;

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < RATE_LIMIT.windowMs);
  if (recent.length >= RATE_LIMIT.max) {
    hits.set(ip, recent); // a refused request is not counted, so the list stays at most `max` long
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);
  if (now - lastSweep >= RATE_LIMIT.windowMs) {
    lastSweep = now; // forget idle IPs, at most once per window
    for (const [other, times] of hits) if (times.every((t) => now - t >= RATE_LIMIT.windowMs)) hits.delete(other);
  }
  return false;
}

/** The body, or null once it passes `max` bytes: a request without a Content-Length is not read in full either. */
async function readLimited(req: Request, max: number): Promise<ArrayBuffer | null> {
  if (Number(req.headers.get('content-length') ?? 0) > max) return null;
  if (!req.body) return new ArrayBuffer(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = req.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out.buffer;
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
    body = await readLimited(req, MAX_BODY_BYTES);
    if (body === null) return NextResponse.json({ error: `body larger than ${MAX_BODY_BYTES} bytes` }, { status: 413 });
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

  // The query as the guard parsed and checked it, not the raw string, so upstream cannot read a parameter the guard did not see.
  const query = url.searchParams.toString();
  const upstream = await fetch(`${upstreamOrigin}/${rest}${query ? `?${query}` : ''}`, { method: req.method, headers, body, redirect: 'manual' });

  const out = new Headers();
  upstream.headers.forEach((value, name) => {
    if (!DROPPED_RESPONSE_HEADERS.has(name)) out.set(name, value);
  });
  out.set('cache-control', 'no-store');
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

export const GET = proxy;
export const POST = proxy;

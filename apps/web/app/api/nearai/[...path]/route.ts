// Byte-exact proxy to NEAR AI Cloud (SPEC §3.4). The browser runs the SDK itself: it verifies attestation,
// encrypts to the model key and checks signatures. This route only adds the server-side API key and forwards
// the allowed paths unchanged, so the server sees ciphertext, sizes and IPs, never plaintext. No body logging.
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALLOWED: ReadonlyArray<readonly [method: string, pattern: RegExp]> = [
  ['GET', /^v1\/model\/[^/]+$/],
  ['GET', /^v1\/attestation\/report$/],
  ['POST', /^v1\/chat\/completions$/],
  ['GET', /^v1\/signature\/[^/]+$/],
];
// Hop-by-hop or server-owned headers that must not travel either way.
const STRIP_REQUEST = new Set(['host', 'connection', 'content-length', 'authorization', 'cookie', 'accept-encoding', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto']);
const STRIP_RESPONSE = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'set-cookie']);

function upstreamOrigin(): string {
  const base = process.env.NEARAI_BASE_URL ?? 'https://cloud-api.near.ai/v1';
  return new URL(base).origin;
}

async function proxy(req: Request): Promise<Response> {
  const apiKey = process.env.NEARAI_API_KEY;
  if (!apiKey) return NextResponse.json({ error: 'NEARAI_API_KEY is not set on the server' }, { status: 503 });

  // Keep the raw (still URL-encoded) path so model ids like z-ai%2Fglm-5.3-flash reach upstream unchanged.
  const url = new URL(req.url);
  const rest = url.pathname.replace(/^\/api\/nearai\//, '');
  if (!ALLOWED.some(([method, pattern]) => method === req.method && pattern.test(rest))) {
    return NextResponse.json({ error: `path not allowed: ${req.method} /${rest}` }, { status: 404 });
  }

  const headers = new Headers();
  req.headers.forEach((value, name) => {
    if (!STRIP_REQUEST.has(name.toLowerCase())) headers.set(name, value);
  });
  headers.set('authorization', `Bearer ${apiKey}`);
  headers.set('accept-encoding', 'identity'); // the browser hashes these exact bytes

  const body = req.method === 'POST' ? await req.arrayBuffer() : undefined;
  const upstream = await fetch(`${upstreamOrigin()}/${rest}${url.search}`, {
    method: req.method,
    headers,
    ...(body === undefined ? {} : { body }),
    redirect: 'manual',
  });

  const out = new Headers();
  upstream.headers.forEach((value, name) => {
    if (!STRIP_RESPONSE.has(name.toLowerCase())) out.set(name, value);
  });
  out.set('cache-control', 'no-store');
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

export const GET = proxy;
export const POST = proxy;

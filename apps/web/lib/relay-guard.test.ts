import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AttestationClient } from '@nearai/inference-sdk';
import { ALLOWED_REQUEST_HEADERS, completionProblem, relayRequestProblem } from './relay-guard.ts';

const MODEL = 'z-ai/glm-5.3-flash';
const MODELS = new Set([MODEL, 'anthropic/claude-haiku-5-5']);
const check = (method: string, path: string, query = '') => relayRequestProblem(method, path, new URLSearchParams(query), MODELS);
const body = (json: unknown) => new TextEncoder().encode(JSON.stringify(json)).buffer as ArrayBuffer;

test('every request the SDK makes through the relay passes, and every header it sends is one the relay forwards', async () => {
  // The browser client exactly as apps/web/lib/nearai-browser.ts builds it; fetch records each request and fails it.
  const seen: Request[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(new Request(input, init));
    return new Response('{}', { status: 500 });
  }) as typeof fetch;
  try {
    const client = new AttestationClient({ baseUrl: 'http://relay.test/api/nearai/v1', headers: { 'X-No-Aliasing': 'true' } });
    await Promise.allSettled([
      client.fetchModelMetadata(MODEL),
      client.fetchModelAttestations({ model: MODEL, signingAlgo: 'ed25519' }),
      client.fetchGatewayAttestation({ signingAlgo: 'ed25519' }),
      client.fetchCompletionSignature({ completionId: '8e20a4232d22466ebb01105193efd290', signingAlgo: 'ed25519' }),
    ]);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(seen.length, 4, 'one request per call');
  for (const r of seen) {
    const url = new URL(r.url);
    const what = `${r.method} ${url.pathname}${url.search}`;
    assert.equal(relayRequestProblem(r.method, url.pathname.replace('/api/nearai/', ''), url.searchParams, MODELS), null, what);
    for (const [name] of r.headers) assert.ok(ALLOWED_REQUEST_HEADERS.has(name), `${what}: header ${name} would be dropped`);
  }
});

test('the chat completion: the path, our models only, one non-streamed answer', () => {
  assert.equal(check('POST', 'v1/chat/completions'), null);
  assert.equal(completionProblem(body({ model: MODEL, messages: [{ role: 'user', content: 'x' }] }), MODELS), null);
  assert.equal(completionProblem(body({ model: 'openai/gpt-x', messages: [{}] }), MODELS), 'model not allowed');
  assert.equal(completionProblem(body({ model: MODEL, messages: [{}], stream: true }), MODELS), 'streaming not allowed');
  assert.equal(completionProblem(body({ model: MODEL, messages: [] }), MODELS), 'messages must be 1..50');
  assert.equal(completionProblem(new TextEncoder().encode('{').buffer as ArrayBuffer, MODELS), 'body is not JSON');
});

test('another model, an encoded way out of the path, or extra segments do not pass', () => {
  assert.equal(check('GET', 'v1/model/openai%2Fgpt-x'), 'model not allowed');
  assert.equal(check('GET', 'v1/model/z-ai/glm-5.3-flash'), 'path not allowed');
  assert.equal(check('GET', 'v1/model/z-ai%2fglm-5.3-flash'), 'model not allowed');
  assert.equal(check('GET', 'v1/model/..%2F..%2Fv1%2Fusers'), 'model not allowed');
  assert.equal(check('GET', 'v1/signature/..%2Fadmin'), 'completion id not allowed');
  assert.equal(check('GET', 'v1/signature/a.b'), 'completion id not allowed');
  assert.equal(check('GET', 'v1/signature/abc/extra'), 'path not allowed');
  assert.equal(check('GET', 'v1/models'), 'path not allowed');
  assert.equal(check('GET', 'v2/model/z-ai%2Fglm-5.3-flash'), 'path not allowed');
  assert.equal(check('DELETE', 'v1/chat/completions'), 'path not allowed');
  assert.equal(check('GET', 'v1/chat/completions'), 'path not allowed');
  assert.equal(check('POST', 'v1/model/z-ai%2Fglm-5.3-flash'), 'path not allowed');
});

test('the query: only the parameters the SDK sets, once each, and only our models', () => {
  assert.equal(check('GET', 'v1/attestation/report', 'nonce=ab&signing_algo=ed25519&include_tls_fingerprint=false'), null);
  assert.equal(check('GET', 'v1/attestation/report', 'model=openai%2Fgpt-x&nonce=ab'), 'model not allowed');
  assert.equal(check('GET', 'v1/attestation/report', 'nonce=ab&limit=1000'), 'query parameter not allowed');
  assert.equal(check('GET', 'v1/attestation/report', `model=${encodeURIComponent(MODEL)}&model=openai%2Fgpt-x`), 'query parameter repeated');
  assert.equal(check('GET', 'v1/signature/abc', 'model=z-ai%2Fglm-5.3-flash'), 'query parameter not allowed');
  assert.equal(check('POST', 'v1/chat/completions', 'stream=true'), 'query parameter not allowed');
  assert.equal(check('GET', 'v1/model/z-ai%2Fglm-5.3-flash', 'x=1'), 'query parameter not allowed');
});

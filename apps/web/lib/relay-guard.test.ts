import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareE2eeChatRequest } from '@nearai/inference-sdk';
import { chatRequest, relayAttestationClient } from './nearai-requests.ts';
import { ALLOWED_REQUEST_HEADERS, completionProblem, relayRequestProblem } from './relay-guard.ts';

const MODEL = 'z-ai/glm-5.3-flash';
const INCOGNITO = 'anthropic/claude-haiku-5-5';
const MODELS = new Set([MODEL, INCOGNITO]);
const BASE = 'http://relay.test/api/nearai/v1';
/** The model's key from the recorded attestation (docs/samples/key-entry.sample.json), to let the SDK encrypt. */
const MODEL_KEY = '5a0210f2442c79355784f9de021985429561da5bacc3a4424b01ac52b7e0caff';
const check = (method: string, path: string, query = '') => relayRequestProblem(method, path, new URLSearchParams(query), MODELS);
const bytes = (json: unknown) => new TextEncoder().encode(JSON.stringify(json)).buffer as ArrayBuffer;

/** What the relay would do with this request: null when it forwards it with every header intact. */
async function relayVerdict(r: Request): Promise<string | null> {
  const url = new URL(r.url);
  const what = `${r.method} ${url.pathname}${url.search}`;
  const dropped = [...r.headers.keys()].filter((name) => !ALLOWED_REQUEST_HEADERS.has(name));
  if (dropped.length > 0) return `${what}: headers ${dropped.join(', ')} would be dropped`;
  const problem = relayRequestProblem(r.method, url.pathname.replace('/api/nearai/', ''), url.searchParams, MODELS)
    ?? (r.method === 'POST' ? completionProblem(await r.clone().arrayBuffer(), MODELS) : null);
  return problem && `${what}: ${problem}`;
}

test('every request the page makes through the relay passes, with every header it sends', async () => {
  const seen: Request[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(new Request(input, init));
    return new Response('{}', { status: 500 });
  }) as typeof fetch;
  try {
    const client = relayAttestationClient(BASE);
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
  const messages = [{ role: 'user' as const, content: 'hello' }];
  const e2ee = await prepareE2eeChatRequest({ request: chatRequest(BASE, MODEL, messages), modelKey: { signingAlgo: 'ed25519', publicKey: MODEL_KEY } });
  seen.push(e2ee.request, chatRequest(BASE, INCOGNITO, messages));
  for (const r of seen) assert.equal(await relayVerdict(r), null);
});

test('the chat body: only the page\'s fields, our models, not streamed', () => {
  const ok = { model: MODEL, messages: [{ role: 'user', content: 'x' }], stream: false };
  assert.equal(completionProblem(bytes(ok), MODELS), null);
  assert.equal(completionProblem(bytes({ ...ok, max_tokens: 200_000 }), MODELS), 'field not allowed');
  assert.equal(completionProblem(bytes({ ...ok, n: 3 }), MODELS), 'field not allowed');
  assert.equal(completionProblem(bytes({ ...ok, model: 'openai/gpt-x' }), MODELS), 'model not allowed');
  assert.equal(completionProblem(bytes({ ...ok, stream: true }), MODELS), 'streaming not allowed');
  assert.equal(completionProblem(bytes({ ...ok, stream: 'true' }), MODELS), 'streaming not allowed');
  assert.equal(completionProblem(bytes({ ...ok, messages: [] }), MODELS), 'messages must be 1..50');
  assert.equal(completionProblem(bytes([ok]), MODELS), 'body is not a JSON object');
  assert.equal(completionProblem(new TextEncoder().encode('{').buffer as ArrayBuffer, MODELS), 'body is not JSON');
});

test('another model, an encoded way out of the path, or extra segments do not pass', () => {
  assert.equal(check('GET', 'v1/model/openai%2Fgpt-x'), 'model not allowed');
  assert.equal(check('GET', 'v1/model/z-ai/glm-5.3-flash'), 'path not allowed');
  assert.equal(check('GET', 'v1/model/z-ai%2fglm-5.3-flash'), 'model not allowed');
  assert.equal(check('GET', 'v1/model/..%2F..%2Fv1%2Fusers'), 'model not allowed');
  assert.equal(check('GET', 'v1/signature/msg_01Ab-c.d%3Ae'), null, 'an id with other characters, as the SDK encodes it');
  assert.equal(check('GET', 'v1/signature/..%2Fadmin'), 'completion id not allowed');
  assert.equal(check('GET', 'v1/signature/%2e%2e'), 'completion id not allowed');
  assert.equal(check('GET', 'v1/signature/..'), 'completion id not allowed');
  assert.equal(check('GET', 'v1/signature/a%5Cb'), 'completion id not allowed');
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

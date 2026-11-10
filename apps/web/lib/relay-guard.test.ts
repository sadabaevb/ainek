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
    ?? (r.method === 'POST' ? completionProblem(await r.clone().arrayBuffer(), MODELS, r.headers, MODEL) : null);
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
  // The SDK marks its request as E2EE v3 (packages/proof/src/e2ee.ts says why that matters); the relay check below then
  // passes it. A downgraded SDK fails here instead of in the hosted chat.
  assert.equal(e2ee.request.headers.get('x-encryption-version'), '3');
  seen.push(e2ee.request, chatRequest(BASE, INCOGNITO, messages));
  for (const r of seen) assert.equal(await relayVerdict(r), null);
});

/** Headers of an E2EE request as the SDK marks it; the relay reads only these two. */
const E2EE = new Headers({ 'x-model-pub-key': MODEL_KEY, 'x-encryption-version': '3' });
const PLAIN = new Headers();

test('the chat body: only the page\'s fields, our models, not streamed', () => {
  const ok = { model: MODEL, messages: [{ role: 'user', content: 'x' }], stream: false };
  const problem = (body: ArrayBuffer) => completionProblem(body, MODELS, E2EE, MODEL);
  assert.equal(problem(bytes(ok)), null);
  assert.equal(problem(bytes({ ...ok, max_tokens: 200_000 })), 'field not allowed');
  assert.equal(problem(bytes({ ...ok, n: 3 })), 'field not allowed');
  assert.equal(problem(bytes({ ...ok, model: 'openai/gpt-x' })), 'model not allowed');
  assert.equal(problem(bytes({ ...ok, stream: true })), 'streaming not allowed');
  assert.equal(problem(bytes({ ...ok, stream: 'true' })), 'streaming not allowed');
  assert.equal(problem(bytes({ ...ok, messages: [] })), 'messages must be 1..50');
  assert.equal(problem(bytes([ok])), 'body is not a JSON object');
  assert.equal(problem(new TextEncoder().encode('{').buffer as ArrayBuffer), 'body is not JSON');
});

test('the attested model goes through only as E2EE v3; the Incognito model may be plaintext', () => {
  const chat = (model: string) => bytes({ model, messages: [{ role: 'user', content: 'x' }], stream: false });
  const v2 = new Headers({ 'x-model-pub-key': MODEL_KEY, 'x-encryption-version': '2' });
  const unversioned = new Headers({ 'x-model-pub-key': MODEL_KEY });
  assert.equal(completionProblem(chat(MODEL), MODELS, E2EE, MODEL), null);
  assert.equal(completionProblem(chat(MODEL), MODELS, PLAIN, MODEL), 'the attested model takes only end-to-end encrypted requests');
  assert.match(completionProblem(chat(MODEL), MODELS, v2, MODEL) ?? '', /E2EE version 3 required, the request says 2/);
  assert.match(completionProblem(chat(MODEL), MODELS, unversioned, MODEL) ?? '', /the request says none/);
  assert.equal(completionProblem(chat(INCOGNITO), MODELS, PLAIN, MODEL), null);
  // An Incognito model that turns out to be attested is sent the E2EE way (flow.ts): the same floor applies.
  assert.equal(completionProblem(chat(INCOGNITO), MODELS, E2EE, MODEL), null);
  assert.match(completionProblem(chat(INCOGNITO), MODELS, v2, MODEL) ?? '', /E2EE version 3 required/);
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

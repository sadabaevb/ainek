import assert from 'node:assert/strict';
import { test } from 'node:test';
import { relayRequestProblem } from './relay-guard.ts';

const MODELS = new Set(['z-ai/glm-5.3-flash', 'anthropic/claude-haiku-5-5']);
const check = (method: string, path: string, query = '') => relayRequestProblem(method, path, new URLSearchParams(query), MODELS);
const ATTESTATION = 'model=z-ai%2Fglm-5.3-flash&provider=near&nonce=ab&include_tls_fingerprint=false&signing_algo=ed25519&signing_address=cd';

test('the requests the SDK makes for our two models pass', () => {
  assert.equal(check('GET', 'v1/model/z-ai%2Fglm-5.3-flash'), null);
  assert.equal(check('GET', 'v1/model/anthropic%2Fclaude-haiku-5-5'), null);
  assert.equal(check('GET', 'v1/attestation/report', ATTESTATION), null);
  assert.equal(check('POST', 'v1/chat/completions'), null);
  assert.equal(check('GET', 'v1/signature/8e20a4232d22466ebb01105193efd290', 'model=z-ai%2Fglm-5.3-flash&signing_algo=ed25519'), null);
  assert.equal(check('GET', 'v1/signature/chatcmpl-AbC_123'), null);
});

test('another model, an encoded way out of the path, or extra segments do not', () => {
  assert.equal(check('GET', 'v1/model/openai%2Fgpt-x'), 'model not allowed');
  assert.equal(check('GET', 'v1/model/..%2F..%2Fv1%2Fusers'), 'model not allowed');
  assert.equal(check('GET', 'v1/model/%E0%A4%A'), 'model not allowed');
  assert.equal(check('GET', 'v1/signature/..%2Fadmin'), 'completion id not allowed');
  assert.equal(check('GET', 'v1/signature/a.b'), 'completion id not allowed');
  assert.equal(check('GET', 'v1/signature/abc/extra'), 'path not allowed');
  assert.equal(check('GET', 'v1/models'), 'path not allowed');
  assert.equal(check('GET', 'v2/model/z-ai%2Fglm-5.3-flash'), 'path not allowed');
  assert.equal(check('DELETE', 'v1/chat/completions'), 'path not allowed');
  assert.equal(check('GET', 'v1/chat/completions'), 'path not allowed');
});

test('the query: only the SDK\'s parameters, once each, and only our models', () => {
  assert.equal(check('GET', 'v1/attestation/report', 'model=openai%2Fgpt-x&nonce=ab'), 'model not allowed');
  assert.equal(check('GET', 'v1/attestation/report', 'nonce=ab'), 'model not allowed');
  assert.equal(check('GET', 'v1/attestation/report', `${ATTESTATION}&limit=1000`), 'query parameter not allowed');
  assert.equal(check('GET', 'v1/attestation/report', `${ATTESTATION}&model=openai%2Fgpt-x`), 'query parameter repeated');
  assert.equal(check('GET', 'v1/signature/abc', 'model=openai%2Fgpt-x'), 'model not allowed');
  assert.equal(check('POST', 'v1/chat/completions', 'stream=true'), 'query parameter not allowed');
  assert.equal(check('GET', 'v1/model/z-ai%2Fglm-5.3-flash', 'x=1'), 'query parameter not allowed');
});

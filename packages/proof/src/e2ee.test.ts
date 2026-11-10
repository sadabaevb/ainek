import { test } from 'node:test';
import assert from 'node:assert/strict';
import { e2eeVersionProblem, looksE2ee, requireE2eeVersion } from './e2ee.ts';

const v3 = { 'x-model-pub-key': 'aa', 'x-client-pub-key': 'bb', 'X-Encryption-Version': '3' };

test('only a complete E2EE v3 request may leave: an older version, none, or a missing key is refused', () => {
  assert.equal(e2eeVersionProblem(new Headers(v3)), null);
  assert.match(e2eeVersionProblem(new Headers({ ...v3, 'X-Encryption-Version': '2' })) ?? '', /the request says 2/);
  assert.match(e2eeVersionProblem(new Headers()) ?? '', /the request says none/);
  assert.match(e2eeVersionProblem(new Headers({ 'x-model-pub-key': 'aa', 'x-encryption-version': '3' })) ?? '', /without the model key or the reply key/);
  assert.doesNotThrow(() => requireE2eeVersion(new Headers(v3)));
  assert.throws(() => requireE2eeVersion(new Headers({ ...v3, 'X-Encryption-Version': '2' })), /not sent/);
});

test('any E2EE header marks a request as E2EE, so a half-marked one is not taken for plaintext', () => {
  assert.equal(looksE2ee(new Headers()), false);
  assert.equal(looksE2ee(new Headers({ 'content-type': 'application/json' })), false);
  assert.equal(looksE2ee(new Headers({ 'x-client-pub-key': 'bb' })), true);
  assert.equal(looksE2ee(new Headers({ 'x-encryption-version': '2' })), true);
});

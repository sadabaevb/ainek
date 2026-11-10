import { test } from 'node:test';
import assert from 'node:assert/strict';
import { e2eeVersionProblem, requireE2eeVersion } from './e2ee.ts';

test('only an E2EE v3 request may leave: an older version or none is refused', () => {
  assert.equal(e2eeVersionProblem(new Headers({ 'X-Encryption-Version': '3' })), null);
  assert.match(e2eeVersionProblem(new Headers({ 'x-encryption-version': '2' })) ?? '', /the request says 2/);
  assert.match(e2eeVersionProblem(new Headers()) ?? '', /the request says none/);
  assert.doesNotThrow(() => requireE2eeVersion(new Headers({ 'x-encryption-version': '3' })));
  assert.throws(() => requireE2eeVersion(new Headers({ 'x-encryption-version': '2' })), /not sent/);
});

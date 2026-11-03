import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateKeyLog } from './key-log.ts';
import type { KeyEntry } from './schema.ts';
import { readRepoJson } from './fixtures.ts';

const { entry } = readRepoJson<{ entry: KeyEntry }>('docs/samples/key-entry.sample.json');
const KEY_A = entry.signing_address;
const KEY_B = 'ab'.repeat(32);
const base = { model: entry.model, signingAddress: KEY_A, trustedVerifiers: ['v1.ainek.testnet', 'v2.ainek.testnet'], quorum: 1 };
const logged = (overrides: Partial<KeyEntry>): KeyEntry => ({ ...entry, ...overrides });

test('one trusted confirmation satisfies quorum 1', () => {
  const v = evaluateKeyLog([entry], base);
  assert.equal(v.status, 'ok');
  assert.deepEqual(v.confirmedBy, ['v1.ainek.testnet']);
});

test('swapped key is not logged → fail-closed', () => {
  assert.equal(evaluateKeyLog([entry], { ...base, signingAddress: KEY_B }).status, 'not-logged');
  assert.equal(evaluateKeyLog([], base).status, 'not-logged');
});

test('entries from verifiers outside the trust set are shown but never counted', () => {
  const v = evaluateKeyLog([logged({ verifier: 'stranger.testnet', index: 1 })], base);
  assert.equal(v.status, 'not-logged');
  assert.equal(v.untrusted.length, 1);
});

test('quorum 2 needs two distinct trusted verifiers', () => {
  const q2 = { ...base, quorum: 2 };
  assert.equal(evaluateKeyLog([entry, logged({ index: 1 })], q2).status, 'not-logged', 'same verifier twice');
  assert.equal(evaluateKeyLog([entry, logged({ index: 1, verifier: 'v2.ainek.testnet' })], q2).status, 'ok');
});

test('split view: two trusted verifiers with disjoint key sets → refuse even if our key is logged', () => {
  const v = evaluateKeyLog([entry, logged({ index: 1, verifier: 'v2.ainek.testnet', signing_address: KEY_B, signing_public_key: KEY_B })], base);
  assert.equal(v.status, 'split-view');
});

test('compose hash is enforced only when asked', () => {
  assert.equal(evaluateKeyLog([entry], { ...base, composeHash: 'ff'.repeat(32) }).status, 'not-logged');
  assert.equal(evaluateKeyLog([entry], { ...base, composeHash: entry.compose_hash }).status, 'ok');
});

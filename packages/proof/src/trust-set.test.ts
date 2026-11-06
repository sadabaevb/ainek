import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateKeyLog } from './key-log.ts';
import { clampQuorum, parseTrustSet } from './trust-set.ts';
import type { KeyEntry } from './schema.ts';

test('parseTrustSet: a well-formed choice comes back, without duplicates', () => {
  assert.deepEqual(parseTrustSet({ verifiers: ['a.testnet', 'b.testnet', 'a.testnet'], quorum: 2 }), { verifiers: ['a.testnet', 'b.testnet'], quorum: 2 });
  assert.deepEqual(parseTrustSet({ verifiers: [], quorum: 1 }), { verifiers: [], quorum: 1 });
});

test('parseTrustSet: anything malformed is no choice at all, so the caller keeps the site default', () => {
  for (const bad of [null, 'x', [], {}, { verifiers: ['a.testnet'] }, { verifiers: 'a.testnet', quorum: 1 }, { verifiers: ['a.testnet'], quorum: 0 }, { verifiers: ['a.testnet'], quorum: -1 }, { verifiers: ['a.testnet'], quorum: 1.5 }, { verifiers: ['A.testnet'], quorum: 1 }, { verifiers: ['a..testnet'], quorum: 1 }, { verifiers: ['a.testnet'], quorum: 1, extra: true }]) {
    assert.equal(parseTrustSet(bad), null, JSON.stringify(bad));
  }
});

test('clampQuorum: follows the list down and never goes below 1', () => {
  assert.equal(clampQuorum(2, 3), 2);
  assert.equal(clampQuorum(3, 2), 2);
  assert.equal(clampQuorum(2, 0), 1);
  assert.equal(clampQuorum(0, 2), 1);
});

test('evaluateKeyLog: an empty trust set or a quorum below 1 lets nothing through', () => {
  const entry = { index: 0, model: 'm', verifier: 'a.testnet', signing_address: 'ab'.repeat(32), compose_hash: 'cd'.repeat(32) } as KeyEntry;
  const query = { model: 'm', signingAddress: 'ab'.repeat(32) };
  assert.equal(evaluateKeyLog([], { ...query, trustedVerifiers: [], quorum: 0 }).status, 'not-logged');
  assert.equal(evaluateKeyLog([entry], { ...query, trustedVerifiers: [], quorum: 1 }).reason, 'untrusted-only');
  assert.equal(evaluateKeyLog([entry], { ...query, trustedVerifiers: ['b.testnet'], quorum: 0 }).status, 'not-logged');
  assert.equal(evaluateKeyLog([entry], { ...query, trustedVerifiers: ['a.testnet'], quorum: 1 }).status, 'ok');
});

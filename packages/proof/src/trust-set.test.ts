import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateKeyLog } from './key-log.ts';
import { chooseTrust, parseTrustSet, previewTrust } from './trust-set.ts';
import type { KeyEntry } from './schema.ts';

const stored = (value: unknown): string => JSON.stringify(value);
const KEY_A = 'ab'.repeat(32);
const KEY_B = 'cd'.repeat(32);
const entry = (verifier: string, key = KEY_A) => ({ index: 0, model: 'm', verifier, signing_address: key, compose_hash: 'ef'.repeat(32) }) as KeyEntry;
const site = { verifiers: ['a.testnet'], quorum: 1 };

test('parseTrustSet: a well-formed choice comes back, without duplicates', () => {
  assert.deepEqual(parseTrustSet(stored({ verifiers: ['a.testnet', 'b.testnet', 'a.testnet'], quorum: 2 })), { verifiers: ['a.testnet', 'b.testnet'], quorum: 2 });
  assert.deepEqual(parseTrustSet(stored({ verifiers: [], quorum: 1 })), { verifiers: [], quorum: 1 });
});

test('parseTrustSet: anything malformed is no choice at all, so the caller keeps the site default', () => {
  assert.equal(parseTrustSet(null), null);
  assert.equal(parseTrustSet(''), null);
  assert.equal(parseTrustSet('{not json'), null);
  for (const bad of [null, 'x', [], {}, { verifiers: ['a.testnet'] }, { verifiers: 'a.testnet', quorum: 1 }, { verifiers: ['a.testnet'], quorum: 0 }, { verifiers: ['a.testnet'], quorum: -1 }, { verifiers: ['a.testnet'], quorum: 1.5 }, { verifiers: ['A.testnet'], quorum: 1 }, { verifiers: ['a..testnet'], quorum: 1 }, { verifiers: ['a.testnet'], quorum: 1, extra: true }]) {
    assert.equal(parseTrustSet(stored(bad)), null, stored(bad));
  }
});

test('chooseTrust: unticking a verifier never lowers the quorum, so ticking it again cannot weaken the policy', () => {
  const both = { verifiers: ['a.testnet', 'b.testnet'], quorum: 2 };
  const unticked = chooseTrust({ verifiers: ['a.testnet'], quorum: both.quorum }, both);
  assert.deepEqual(unticked, { verifiers: ['a.testnet'], quorum: 2 });
  assert.equal(chooseTrust({ verifiers: ['a.testnet', 'b.testnet'], quorum: unticked?.quorum ?? 0 }, both), null);
  const short = previewTrust([entry('a.testnet')], 'm', { verifiers: ['a.testnet'], quorum: 2 });
  assert.equal(short.kind === 'checked' && short.verdict.reason, 'below-quorum');
});

test('chooseTrust: a choice equal to the site default is forgotten, whatever the order', () => {
  assert.equal(chooseTrust({ verifiers: ['a.testnet'], quorum: 1 }, site), null);
  assert.equal(chooseTrust({ verifiers: ['b.testnet', 'a.testnet'], quorum: 2 }, { verifiers: ['a.testnet', 'b.testnet'], quorum: 2 }), null);
  assert.notEqual(chooseTrust({ verifiers: ['a.testnet', 'b.testnet'], quorum: 1 }, { verifiers: ['a.testnet', 'b.testnet'], quorum: 2 }), null);
});

test('previewTrust: says what the chat would do for the newest key', () => {
  const log = [entry('a.testnet')];
  assert.deepEqual(previewTrust(log, 'm', { verifiers: [], quorum: 1 }), { kind: 'nobody' });
  assert.deepEqual(previewTrust([], 'm', site), { kind: 'no-entries' });
  assert.deepEqual(previewTrust(log, 'other', site), { kind: 'no-entries' });
  const reasonOf = (entries: KeyEntry[], verifiers: string[], quorum: number) => {
    const p = previewTrust(entries, 'm', { verifiers, quorum });
    return p.kind === 'checked' ? p.verdict.reason : p.kind;
  };
  assert.equal(reasonOf(log, ['a.testnet'], 1), 'ok');
  assert.equal(reasonOf(log, ['a.testnet', 'b.testnet'], 2), 'below-quorum');
  assert.equal(reasonOf(log, ['b.testnet'], 1), 'untrusted-only');
  assert.equal(reasonOf([entry('a.testnet', KEY_A), entry('b.testnet', KEY_B)], ['a.testnet', 'b.testnet'], 1), 'split-view');
});

test('previewTrust: a writer outside the list cannot steer the preview by logging a newer key', () => {
  const log = [entry('stranger.testnet', KEY_B), entry('a.testnet', KEY_A)];
  const p = previewTrust(log, 'm', site);
  assert.equal(p.kind === 'checked' && p.key, KEY_A);
  assert.equal(p.kind === 'checked' && p.verdict.status, 'ok');
  const none = previewTrust(log, 'm', { verifiers: ['b.testnet'], quorum: 1 });
  assert.equal(none.kind === 'checked' && none.key, KEY_B);
});

test('evaluateKeyLog: an empty trust set or a quorum below 1 lets nothing through, and the verdict names the quorum it used', () => {
  const query = { model: 'm', signingAddress: KEY_A };
  assert.equal(evaluateKeyLog([], { ...query, trustedVerifiers: [], quorum: 0 }).status, 'not-logged');
  assert.equal(evaluateKeyLog([entry('a.testnet')], { ...query, trustedVerifiers: [], quorum: 1 }).reason, 'untrusted-only');
  assert.equal(evaluateKeyLog([entry('a.testnet')], { ...query, trustedVerifiers: ['b.testnet'], quorum: 0 }).status, 'not-logged');
  assert.equal(evaluateKeyLog([entry('a.testnet')], { ...query, trustedVerifiers: ['a.testnet'], quorum: 1 }).status, 'ok');
  assert.equal(evaluateKeyLog([], { ...query, trustedVerifiers: ['a.testnet'], quorum: 3 }).quorum, 3);
  assert.equal(evaluateKeyLog([], { ...query, trustedVerifiers: ['a.testnet'], quorum: 0 }).quorum, 1);
});

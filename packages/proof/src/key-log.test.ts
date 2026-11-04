import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateKeyLog, findSplitView, resolveLogEntry } from './key-log.ts';
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
  assert.equal(findSplitView([entry, logged({ index: 1, verifier: 'v2.ainek.testnet', signing_address: KEY_B, signing_public_key: KEY_B })], entry.model, base.trustedVerifiers)?.verifierB, 'v2.ainek.testnet');
  assert.equal(findSplitView([entry], entry.model, base.trustedVerifiers), null);
});

test('compose hash is enforced only when asked', () => {
  assert.equal(evaluateKeyLog([entry], { ...base, composeHash: 'ff'.repeat(32) }).status, 'not-logged');
  assert.equal(evaluateKeyLog([entry], { ...base, composeHash: entry.compose_hash }).status, 'ok');
});

// ---- resolveLogEntry: the chain is the source of truth, the embedded copy is only a fallback that says so ----
const reader = (answer: () => Promise<KeyEntry | null>) => ({ entry: answer });

test('resolveLogEntry: the chain entry equal to the embedded copy is ok, and the chain entry is what gets checked', async () => {
  const r = await resolveLogEntry(reader(async () => entry), entry.index, { ...entry }, 'ainek.testnet');
  assert.equal(r.check.status, 'ok');
  assert.match(r.check.detail, /re-read from ainek\.testnet, equal to the embedded entry/);
  assert.deepEqual(r.entry, entry);
});

test('resolveLogEntry: a chain entry that differs from the embedded copy fails, on any field', async () => {
  const r = await resolveLogEntry(reader(async () => logged({ block_height: entry.block_height + 1 })), entry.index, entry);
  assert.equal(r.check.status, 'fail');
  assert.match(r.check.detail, /differs from the embedded entry/);
  assert.equal(r.entry?.block_height, entry.block_height + 1);
});

test('resolveLogEntry: an entry missing from the chain fails; the embedded copy is kept only to explain', async () => {
  const withCopy = await resolveLogEntry(reader(async () => null), 7, entry);
  assert.equal(withCopy.check.status, 'fail');
  assert.match(withCopy.check.detail, /#7 is not in the public log: the embedded entry cannot be confirmed/);
  const without = await resolveLogEntry(reader(async () => null), 7);
  assert.equal(without.check.status, 'fail');
  assert.equal(without.entry, null);
});

test('resolveLogEntry: an unreachable log is a skip that falls back to the embedded copy and says so', async () => {
  const r = await resolveLogEntry(reader(async () => { throw new Error('rpc down'); }), entry.index, entry);
  assert.equal(r.check.status, 'skipped');
  assert.match(r.check.detail, /unavailable \(rpc down\); using the embedded entry/);
  assert.deepEqual(r.entry, entry);
});

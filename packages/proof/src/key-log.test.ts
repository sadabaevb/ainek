import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deploymentsSeen, evaluateKeyLog, findSplitView, proofEntryOf, resolveLogEntry } from './key-log.ts';
import type { KeyEntry } from './schema.ts';
import { readRepoJson } from './fixtures.ts';

const { entry } = readRepoJson<{ entry: KeyEntry }>('docs/samples/key-entry.sample.json');
const KEY_A = entry.signing_address;
const KEY_B = 'ab'.repeat(32);
const V2 = 'second-verifier.testnet';
const base = { model: entry.model, signingAddress: KEY_A, trustedVerifiers: [entry.verifier, V2], quorum: 1 };
const logged = (overrides: Partial<KeyEntry>): KeyEntry => ({ ...entry, ...overrides });

test('proofEntryOf: the newest entry with the attested compose, else the newest for the key', () => {
  const [composeA, composeB, composeC] = ['a0'.repeat(32), '5f'.repeat(32), 'cc'.repeat(32)];
  // Newest first, as latest_keys returns them: two deployments behind one signing key.
  const verdict = evaluateKeyLog([logged({ index: 5, compose_hash: composeB }), logged({ index: 4, compose_hash: composeA }), logged({ index: 2, compose_hash: composeA })], base);
  assert.equal(proofEntryOf(verdict, composeA).index, 4, 'not #5, the newest overall, and not the older #2');
  assert.equal(proofEntryOf(verdict, composeB).index, 5);
  assert.equal(proofEntryOf(verdict, `0x${composeA.toUpperCase()}`).index, 4, 'hex spelling does not matter');
  assert.equal(proofEntryOf(verdict, composeC).index, 5, 'a compose nobody logged is not a refusal');
  assert.throws(() => proofEntryOf(evaluateKeyLog([], base), composeA), /no log entry/, 'stops before anything is sent, not at the proof step after it');
});

test('one trusted confirmation satisfies quorum 1', () => {
  const v = evaluateKeyLog([entry], base);
  assert.equal(v.status, 'ok');
  assert.equal(v.reason, 'ok');
  assert.deepEqual(v.confirmedBy, [entry.verifier]);
});

test('swapped key is not logged → fail-closed', () => {
  assert.equal(evaluateKeyLog([entry], { ...base, signingAddress: KEY_B }).status, 'not-logged');
  assert.equal(evaluateKeyLog([entry], { ...base, signingAddress: KEY_B }).reason, 'absent');
  assert.equal(evaluateKeyLog([], base).status, 'not-logged');
});

test('entries from verifiers outside the trust set are shown but never counted', () => {
  const v = evaluateKeyLog([logged({ verifier: 'stranger.testnet', index: 1 })], base);
  assert.equal(v.status, 'not-logged');
  assert.equal(v.untrusted.length, 1);
  assert.equal(v.reason, 'untrusted-only');
  assert.deepEqual(v.loggedByUntrusted, ['stranger.testnet']);
  assert.match(v.detail, /logged only by stranger\.testnet, outside the trust set/);
  assert.match(evaluateKeyLog([], base).detail, /is not in the public log/);
});

test('quorum 2 needs two distinct trusted verifiers', () => {
  const q2 = { ...base, quorum: 2 };
  assert.equal(evaluateKeyLog([entry, logged({ index: 1 })], q2).status, 'not-logged', 'same verifier twice');
  assert.equal(evaluateKeyLog([entry, logged({ index: 1, verifier: V2 })], q2).status, 'ok');
  // One trusted confirmation plus a stranger: short of quorum, and the stranger must not change the reason.
  const short = evaluateKeyLog([entry, logged({ index: 1, verifier: 'stranger.testnet' })], q2);
  assert.equal(short.reason, 'below-quorum');
  assert.deepEqual(short.confirmedBy, [entry.verifier]);
  assert.deepEqual(short.loggedByUntrusted, ['stranger.testnet']);
  assert.match(short.detail, /only 1 of 2/);
});

test('split view: two trusted verifiers with disjoint key sets → refuse even if our key is logged', () => {
  const v = evaluateKeyLog([entry, logged({ index: 1, verifier: V2, signing_address: KEY_B, signing_public_key: KEY_B })], base);
  assert.equal(v.status, 'split-view');
  assert.equal(v.reason, 'split-view');
  assert.equal(findSplitView([entry, logged({ index: 1, verifier: V2, signing_address: KEY_B, signing_public_key: KEY_B })], entry.model, base.trustedVerifiers)?.verifierB, V2);
  assert.equal(findSplitView([entry], entry.model, base.trustedVerifiers), null);
});

test('compose hash is enforced only when asked', () => {
  assert.equal(evaluateKeyLog([entry], { ...base, composeHash: 'ff'.repeat(32) }).status, 'not-logged');
  assert.equal(evaluateKeyLog([entry], { ...base, composeHash: entry.compose_hash }).status, 'ok');
  assert.equal(evaluateKeyLog([entry], base).deployment, undefined);
});

test('unknown deployment: the key is logged by a trusted verifier, but not with the attested compose → refused, and the verdict names what was seen', () => {
  const [composeA, composeB, unknown] = ['a0'.repeat(32), '5f'.repeat(32), 'cd'.repeat(32)];
  const log = [logged({ index: 5, compose_hash: composeB }), logged({ index: 4, compose_hash: composeA }), logged({ index: 2, compose_hash: composeA })];
  const v = evaluateKeyLog(log, { ...base, composeHash: unknown });
  assert.equal(v.status, 'not-logged');
  assert.equal(v.reason, 'unknown-deployment');
  assert.deepEqual(v.deployment, { composeHash: unknown, loggedComposes: [composeB, composeA] });
  assert.deepEqual(v.matching, []);
  assert.match(v.detail, /is logged, but not with deployment cdcdcdcd…cdcd: trusted verifiers saw 5f5f5f5f…5f5f, a0a0a0a0…a0a0 behind it: not sent/);
  const ok = evaluateKeyLog(log, { ...base, composeHash: `0x${composeA.toUpperCase()}` });
  assert.equal(ok.status, 'ok');
  assert.deepEqual(ok.matching.map((e) => e.index), [4, 2], 'only entries with that deployment count, so the proof points at one of them');
  assert.match(ok.detail, /with deployment a0a0a0a0…a0a0 confirmed by/);
});

test('unknown deployment: quorum is counted per deployment, and an untrusted writer cannot vouch for one', () => {
  const [composeA, composeB] = ['a0'.repeat(32), '5f'.repeat(32)];
  // Both trusted verifiers know the key, only one has seen deployment B.
  const log = [logged({ index: 3, compose_hash: composeB }), logged({ index: 2, verifier: V2, compose_hash: composeA }), logged({ index: 1, compose_hash: composeA })];
  assert.equal(evaluateKeyLog(log, { ...base, quorum: 2, composeHash: composeA }).status, 'ok');
  assert.equal(evaluateKeyLog(log, { ...base, quorum: 2, composeHash: composeB }).reason, 'below-quorum');
  assert.equal(evaluateKeyLog(log, { ...base, quorum: 2 }).status, 'ok', 'without the deployment check the key alone has both');
  const outsider = [logged({ index: 2, verifier: 'stranger.testnet', compose_hash: composeB }), logged({ index: 1, compose_hash: composeA })];
  assert.equal(evaluateKeyLog(outsider, { ...base, composeHash: composeB }).reason, 'unknown-deployment', 'the trusted verifier knows the key, so this outranks "logged only outside the trust set"');
  assert.equal(evaluateKeyLog([logged({ verifier: 'stranger.testnet', compose_hash: composeB })], { ...base, composeHash: composeB }).reason, 'untrusted-only');
  assert.equal(evaluateKeyLog(log, { ...base, signingAddress: KEY_B, composeHash: composeA }).reason, 'absent', 'a key nobody logged stays "not in the log"');
});

test('deploymentsSeen: one line per compose of the model, newest first, with who logged it and since when', () => {
  const [composeA, composeB] = ['a0'.repeat(32), '5f'.repeat(32)];
  const log = [
    logged({ index: 5, compose_hash: composeA, observed_at: '5000' }),
    logged({ index: 4, compose_hash: composeB, observed_at: '4000', verifier: V2 }),
    logged({ index: 3, compose_hash: composeB, observed_at: '3000' }),
    logged({ index: 2, compose_hash: composeA.toUpperCase().toLowerCase(), observed_at: '2000' }),
    logged({ index: 1, model: 'another/model', compose_hash: 'ee'.repeat(32), observed_at: '1000' }),
  ];
  assert.deepEqual(deploymentsSeen(log, entry.model), [
    { composeHash: composeA, keys: [KEY_A], verifiers: [entry.verifier], entries: 2, firstSeenMs: 2000, lastSeenMs: 5000 },
    { composeHash: composeB, keys: [KEY_A], verifiers: [V2, entry.verifier], entries: 2, firstSeenMs: 3000, lastSeenMs: 4000 },
  ]);
  assert.deepEqual(deploymentsSeen([], entry.model), []);
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

test('resolveLogEntry: a log that answers without a valid entry (no view, malformed shape) fails and the embedded copy does not stand in', async () => {
  const { ContractMethodNotFound } = await import('./near-view.ts');
  const { ZodError } = await import('zod');
  for (const err of [new ContractMethodNotFound('ainek.testnet.entry: MethodNotFound'), new ZodError([])]) {
    const r = await resolveLogEntry(reader(async () => { throw err; }), entry.index, entry);
    assert.equal(r.check.status, 'fail');
    assert.match(r.check.detail, /did not answer with a valid entry/);
    assert.equal(r.entry, null);
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entryHashOf } from './commit.ts';
import { readRepoJson } from './fixtures.ts';
import { chainBreak, inputOf, pointStanding, readWholeLog, rewrittenFrom, walkLog, type LogPoint } from './log-chain.ts';
import type { KeyEntry } from './schema.ts';

const { entry: first } = readRepoJson<{ entry: KeyEntry }>('docs/samples/key-entry.sample.json');

/** A log of `n` entries grown from the recorded entry #0, hashed the way the contract hashes: each over the one before. */
function logOf(n: number): KeyEntry[] {
  const log = [first];
  for (let i = 1; i < n; i += 1) {
    const prev = log[i - 1]!;
    const e = { ...first, index: i, verifier: i % 2 ? 'second.testnet' : first.verifier, observed_at: String(Number(first.observed_at) + i * 60_000), block_height: first.block_height + i };
    log.push({ ...e, prev_hash: prev.entry_hash, entry_hash: entryHashOf(prev.entry_hash, inputOf(e), e.verifier) });
  }
  return log;
}
const log = logOf(6);
const headOf = (entries: readonly KeyEntry[]): LogPoint => ({ index: entries.length - 1, entry_hash: entries.at(-1)!.entry_hash });
const otherKey = (e: KeyEntry): KeyEntry => ({ ...e, signing_address: 'ab'.repeat(32) });

test('the entry recorded from the chain carries the hash of its own fields', () => {
  assert.equal(chainBreak([first]), undefined);
});

test('a log hashed as the contract hashes it holds, up to the head', () => {
  assert.equal(chainBreak(log), undefined);
  assert.deepEqual(walkLog({ head: headOf(log), entries: log }), { status: 'held', head: headOf(log) });
  assert.deepEqual(walkLog({ head: null, entries: [] }), { status: 'empty' });
});

test('a changed field breaks the chain at that entry, whichever field it is', () => {
  const changes: Array<(e: KeyEntry) => KeyEntry> = [
    otherKey,
    (e) => ({ ...e, verifier: 'someone-else.testnet' }),
    (e) => ({ ...e, observed_at: String(Number(e.observed_at) + 1) }),
    (e) => ({ ...e, image_digests: [...e.image_digests, 'release:made-up'] }),
    (e) => ({ ...e, image_digests: e.image_digests.toReversed() }),
  ];
  for (const change of changes) {
    const forged = log.map((e) => (e.index === 3 ? change(e) : e));
    assert.deepEqual(chainBreak(forged), { index: 3, reason: 'the hash of entry #3 is not the hash of its fields' });
  }
});

test('a changed entry with its own hash recomputed breaks at the next one', () => {
  const forged = log.map((e) => (e.index === 3 ? { ...otherKey(e), entry_hash: entryHashOf(e.prev_hash, inputOf(otherKey(e)), e.verifier) } : e));
  assert.deepEqual(chainBreak(forged), { index: 4, reason: 'entry #4 does not name the hash of entry #3' });
});

test('an entry removed, swapped or put before the first breaks where it happened', () => {
  assert.deepEqual(chainBreak(log.filter((e) => e.index !== 2)), { index: 2, reason: 'entry #3 stands where #2 should' });
  assert.deepEqual(chainBreak([log[0]!, log[2]!, log[1]!, ...log.slice(3)]), { index: 1, reason: 'entry #2 stands where #1 should' });
  assert.deepEqual(chainBreak(log.slice(1)), { index: 0, reason: 'entry #1 stands where #0 should' });
  assert.deepEqual(chainBreak([{ ...log[0]!, prev_hash: 'cd'.repeat(32) }]), { index: 0, reason: 'the first entry names an entry before it' });
});

test('a rewrite with every later hash recomputed holds as a chain, and only a point taken earlier shows it', () => {
  const seen = headOf(log);
  const rewritten = rewrittenFrom(log, 2, otherKey);
  assert.equal(chainBreak(rewritten), undefined);
  assert.deepEqual(walkLog({ head: headOf(rewritten), entries: rewritten }), { status: 'held', head: headOf(rewritten) });
  assert.equal(pointStanding(rewritten, seen), 'changed');
  // A point taken before the rewritten entry is still there: it says nothing about what came after it.
  assert.equal(pointStanding(rewritten, { index: 1, entry_hash: log[1]!.entry_hash }), 'kept');
  assert.deepEqual(rewritten.slice(0, 2), log.slice(0, 2));
});

test('a point stays kept while the log only grows, and is gone from a log cut short', () => {
  const seen = headOf(log);
  assert.equal(pointStanding(logOf(9), seen), 'kept');
  assert.equal(pointStanding(log.slice(0, 4), seen), 'gone');
});

test('a head that does not fit the entries breaks the walk', () => {
  assert.deepEqual(walkLog({ head: { index: 5, entry_hash: 'ef'.repeat(32) }, entries: log }), { status: 'broken', at: { index: 5, reason: 'the head names another hash than entry #5 has' } });
  assert.deepEqual(walkLog({ head: headOf(log), entries: log.slice(0, 4) }), { status: 'broken', at: { index: 4, reason: 'the log ends before its head #5: entry #4 did not come back' } });
});

test('the whole log is read in pages up to the head taken first; entries written meanwhile are left out', async () => {
  const long = logOf(205);
  const asked: number[] = [];
  const reader = {
    head: async () => ({ index: 201, entry_hash: long[201]!.entry_hash }),
    entriesSince: async (index: number, limit: number) => {
      asked.push(index);
      return long.slice(index, index + limit);
    },
  };
  const whole = await readWholeLog(reader);
  assert.deepEqual(asked, [0, 100, 200]);
  assert.equal(whole.entries.length, 202);
  assert.deepEqual(walkLog(whole), { status: 'held', head: { index: 201, entry_hash: long[201]!.entry_hash } });
  // A log that answers with less than its head names comes back short, and the walk says where it stopped.
  const short = await readWholeLog({ ...reader, entriesSince: async (index) => (index === 0 ? long.slice(0, 100) : []) });
  assert.equal(walkLog(short).status, 'broken');
  assert.deepEqual(await readWholeLog({ head: async () => null, entriesSince: async () => long }), { head: null, entries: [] });
});

test('the places recorded in the repository: the first is the recorded entry #0, and they go forward', () => {
  const sample = readRepoJson<{ contract: string }>('docs/samples/key-entry.sample.json');
  const { contract, points } = readRepoJson<{ contract: string; points: Array<LogPoint & { seen: string }> }>('docs/samples/log-points.json');
  assert.equal(contract, sample.contract);
  assert.deepEqual(points[0], { index: 0, entry_hash: first.entry_hash, seen: '2026-11-08' });
  for (const [i, p] of points.entries()) {
    assert.match(p.entry_hash, /^[0-9a-f]{64}$/);
    assert.match(p.seen, /^\d{4}-\d{2}-\d{2}$/);
    if (i > 0) assert.ok(p.index > points[i - 1]!.index && p.seen >= points[i - 1]!.seen, `place ${i} goes back`);
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actionCommitOf, commitOf, entryHashOf, proofPayload } from './commit.ts';
import { Action, KeyEntryInput, ModelProof } from './schema.ts';
import { readRepoJson } from './fixtures.ts';

interface Commits {
  action_commit: { action: unknown; sha256: string };
  proof_commit: { salt: string; payload: unknown; commit: string };
  entry_hash: { prev_hash: string; input: unknown; verifier: string; entry_hash: string };
}
const { commits } = readRepoJson<{ commits: Commits }>('docs/test-vectors/canonical.json');

test('actionCommitOf matches the vector', () => {
  assert.equal(actionCommitOf(Action.parse(commits.action_commit.action)), commits.action_commit.sha256);
});

test('commitOf matches the vector and ignores the envelope fields', () => {
  const payload = ModelProof.parse(commits.proof_commit.payload);
  const { salt, commit } = commits.proof_commit;
  assert.equal(commitOf(salt, payload), commit);
  const committed = { ...payload, salt, commit, commitTx: 'tx' };
  assert.equal(commitOf(salt, committed), commit, 'salt/commit/commitTx must not change the commit');
  assert.deepEqual(Object.keys(proofPayload(committed)).sort(), Object.keys(payload).sort());
  assert.notEqual(commitOf('ff'.repeat(32), payload), commit);
  assert.throws(() => commitOf('00', payload), /32 bytes/);
});

test('entryHashOf matches the vector (string concatenation convention)', () => {
  const e = commits.entry_hash;
  assert.equal(entryHashOf(e.prev_hash, KeyEntryInput.parse(e.input), e.verifier), e.entry_hash);
  assert.notEqual(entryHashOf('ab'.repeat(32), KeyEntryInput.parse(e.input), e.verifier), e.entry_hash);
});

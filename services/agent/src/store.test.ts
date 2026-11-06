import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Disclosure, parseDisclosure, type CommittedActionProof } from '@ainek/proof';
import { fileKeeper, type Intent } from './store.ts';

const sample = parseDisclosure(JSON.parse(readFileSync(new URL('../../../docs/samples/disclosure.sample.json', import.meta.url), 'utf8')) as unknown);

test('fileKeeper: files are private to this user and named by the commit; the model file is a disclosure /auditor can read; a second save replaces the file and leaves no temp behind', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ainek-agent-'));
  const dir = path.join(root, 'nested', 'proofs');
  try {
    const keep = fileKeeper(dir);
    await keep.model(sample);
    const modelFile = path.join(dir, `model-${sample.proof.commit}.json`);
    Disclosure.parse(JSON.parse(readFileSync(modelFile, 'utf8')) as unknown);
    assert.equal(statSync(modelFile).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);

    const proof = { actionId: 7, commit: 'ab'.repeat(32), salt: '11'.repeat(32) } as unknown as CommittedActionProof;
    await keep.action(proof);
    await keep.action({ ...proof, commitTx: 'TX' });
    const actionFile = path.join(dir, `action-${proof.commit}.json`);
    assert.equal((JSON.parse(readFileSync(actionFile, 'utf8')) as { commitTx?: string }).commitTx, 'TX');
    assert.equal(statSync(actionFile).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(dir).sort(), [`action-${proof.commit}.json`, `model-${sample.proof.commit}.json`].sort());

    assert.deepEqual(await keep.unsettled(), []);
    const intent = { modelProofCommit: 'cd'.repeat(32), action: {}, decision: {}, teeSignature: 's', at: 't' } as unknown as Intent;
    await keep.intent(intent);
    assert.deepEqual(await keep.unsettled(), [intent]);
    assert.equal(statSync(path.join(dir, `intent-${intent.modelProofCommit}.json`)).mode & 0o777, 0o600);
    await keep.settled(intent.modelProofCommit);
    assert.deepEqual(await keep.unsettled(), []);
    await keep.settled(intent.modelProofCommit); // settling twice is fine
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fileKeeper: a directory that does not exist yet has nothing unsettled, and a failed write leaves no temp file with a salt in it', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ainek-agent-'));
  try {
    assert.deepEqual(await fileKeeper(path.join(root, 'missing')).unsettled(), []);
    const dir = path.join(root, 'proofs');
    const keep = fileKeeper(dir);
    const proof = { actionId: 7, commit: 'ab'.repeat(32), salt: '11'.repeat(32) } as unknown as CommittedActionProof;
    await keep.action(proof);
    mkdirSync(path.join(dir, `action-${'cd'.repeat(32)}.json`)); // a directory where the file should go: the rename fails
    await assert.rejects(keep.action({ ...proof, commit: 'cd'.repeat(32) }));
    assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith('.tmp')), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fileKeeper: an unreadable folder fails instead of reading as "no unfinished payments"', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ainek-agent-'));
  const notAFolder = path.join(root, 'file');
  writeFileSync(notAFolder, 'x');
  await assert.rejects(fileKeeper(notAFolder).unsettled());
  rmSync(root, { recursive: true });
});

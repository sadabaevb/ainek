import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Disclosure, parseDisclosure, type CommittedActionProof } from '@ainek/proof';
import { fileKeeper } from './store.ts';

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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

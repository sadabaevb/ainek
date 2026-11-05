import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Disclosure, type KeyEntry, type ModelProof } from '@ainek/proof';
import type { CommittedActionProof } from './proof.ts';
import { fileKeeper } from './store.ts';

const samples = new URL('../../../docs/samples/', import.meta.url);
const sample = JSON.parse(readFileSync(new URL('disclosure.sample.json', samples), 'utf8')) as { proof: ModelProof; logEntry: KeyEntry; rawRequestBase64: string; rawResponseBase64: string };

test('fileKeeper: files are private to this user; the model file is a disclosure /auditor can read; the action file is overwritten with its commit tx', async () => {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'ainek-agent-')), 'nested', 'proofs');
  try {
    const keep = fileKeeper(dir);
    await keep.model({ proof: sample.proof, logEntry: sample.logEntry, requestBody: Buffer.from(sample.rawRequestBase64, 'base64'), responseBody: Buffer.from(sample.rawResponseBase64, 'base64') });
    const modelFile = path.join(dir, `model-${sample.proof.commit}.json`);
    const written = JSON.parse(readFileSync(modelFile, 'utf8')) as unknown;
    assert.equal(Disclosure.parse(written).rawRequestBase64, sample.rawRequestBase64);
    assert.equal(statSync(modelFile).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);

    const proof = { actionId: 7, commit: 'ab'.repeat(32), salt: '11'.repeat(32) } as unknown as CommittedActionProof;
    await keep.action(proof);
    await keep.action({ ...proof, commitTx: 'TX' });
    const actionFile = path.join(dir, 'action-7.json');
    assert.equal((JSON.parse(readFileSync(actionFile, 'utf8')) as { commitTx?: string }).commitTx, 'TX');
    assert.equal(statSync(actionFile).mode & 0o777, 0o600);
  } finally {
    rmSync(path.dirname(path.dirname(dir)), { recursive: true, force: true });
  }
});

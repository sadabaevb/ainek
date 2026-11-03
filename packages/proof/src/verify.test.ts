import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyModelProof } from './verify.ts';
import type { CheckId, VerifyReport } from './verify.ts';
import { readRepoFile, readRepoJson } from './fixtures.ts';
import type { KeyEntry, ModelProof } from './schema.ts';

const { proof } = readRepoJson<{ proof: ModelProof }>('docs/samples/model-proof.sample.json');
const { entry } = readRepoJson<{ entry: KeyEntry }>('docs/samples/key-entry.sample.json');
const rawRequest = readRepoFile('docs/samples/chat-request.raw.json');
const rawResponse = readRepoFile('docs/samples/chat-response.raw.json');

function status(report: VerifyReport, id: CheckId): string {
  return report.checks.find((c) => c.id === id)?.status ?? 'missing';
}

test('recorded sample passes every check', () => {
  const r = verifyModelProof(proof, rawRequest, rawResponse, entry);
  assert.equal(r.ok, true, JSON.stringify(r.checks, null, 2));
  assert.equal(r.checks.length, 8);
  assert.ok(r.checks.every((c) => c.status === 'ok'));
});

test('without raw bytes the hash checks are skipped, not failed', () => {
  const r = verifyModelProof(proof, undefined, undefined, entry);
  assert.equal(r.ok, true);
  assert.equal(status(r, 'request-hash'), 'skipped');
  assert.equal(status(r, 'response-hash'), 'skipped');
});

test('non-TEE route is a red card', () => {
  const r = verifyModelProof({ ...proof, signatureKind: 'gateway' }, rawRequest, rawResponse, entry);
  assert.equal(r.ok, false);
  assert.equal(status(r, 'route'), 'fail');
  assert.equal(status(r, 'signature'), 'ok', 'the signature itself is still valid');
});

test('one flipped byte in the response is caught', () => {
  const tampered = new Uint8Array(rawResponse);
  const i = tampered.length - 2;
  tampered[i] = (tampered[i] ?? 0) ^ 0x01;
  const r = verifyModelProof(proof, rawRequest, tampered, entry);
  assert.equal(r.ok, false);
  assert.equal(status(r, 'response-hash'), 'fail');
  assert.equal(status(r, 'request-hash'), 'ok');
});

test('key not in the public log → fail-closed', () => {
  assert.equal(status(verifyModelProof(proof, rawRequest, rawResponse, null), 'key-in-log'), 'fail');
  const swapped = { ...entry, signing_address: 'ab'.repeat(32), signing_public_key: 'ab'.repeat(32) };
  const r = verifyModelProof(proof, rawRequest, rawResponse, swapped);
  assert.equal(r.ok, false);
  assert.equal(status(r, 'key-in-log'), 'fail');
  assert.equal(status(verifyModelProof(proof, rawRequest, rawResponse, { ...entry, index: 5 }), 'key-in-log'), 'fail');
  assert.equal(status(verifyModelProof(proof, rawRequest, rawResponse, { ...entry, verifier: 'v9.ainek.testnet' }), 'key-in-log'), 'fail');
});

test('a proof whose signature was swapped for another key fails on the signature line', () => {
  const r = verifyModelProof({ ...proof, signingAddress: 'ab'.repeat(32) }, rawRequest, rawResponse, entry);
  assert.equal(status(r, 'signature'), 'fail');
  assert.equal(status(r, 'key-in-log'), 'fail');
});

test('commit is recomputed from salt + payload', () => {
  assert.equal(status(verifyModelProof(proof, rawRequest, rawResponse, entry), 'commit'), 'ok');
  assert.equal(status(verifyModelProof({ ...proof, commit: 'ff'.repeat(32) }, rawRequest, rawResponse, entry), 'commit'), 'fail');
  const { salt: _s, commit: _c, commitTx: _t, ...uncommitted } = proof;
  assert.equal(status(verifyModelProof(uncommitted, rawRequest, rawResponse, entry), 'commit'), 'skipped');
});

test('malformed proof stops at the schema check', () => {
  const r = verifyModelProof({ ...proof, requestSha256: 'nope' }, rawRequest, rawResponse, entry);
  assert.equal(r.ok, false);
  assert.equal(r.checks.length, 1);
  assert.equal(status(r, 'schema'), 'fail');
});

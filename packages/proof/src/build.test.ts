import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModelProof } from './build.ts';
import { parseDisclosure, toDisclosure } from './disclosure.ts';
import { verifyModelProof } from './verify.ts';
import { readRepoFile, readRepoJson } from './fixtures.ts';
import type { KeyEntry, ModelProof, SignatureResponse } from './schema.ts';

const sig = readRepoJson<SignatureResponse & { signature_kind: string }>('docs/samples/signature.json');
const { entry } = readRepoJson<{ entry: KeyEntry }>('docs/samples/key-entry.sample.json');
const { proof: sample } = readRepoJson<{ proof: ModelProof }>('docs/samples/model-proof.sample.json');
const requestBody = readRepoFile('docs/samples/chat-request.raw.json');
const responseBody = readRepoFile('docs/samples/chat-response.raw.json');

const input = {
  completionId: sample.completionId,
  model: sample.model,
  signature: { kind: sig.signature_kind, signer: { signingAlgo: sig.signing_algo, signingAddress: sig.signing_address }, signedText: sig.text, signature: sig.signature },
  requestBody,
  responseBody,
  logEntry: entry,
  verifiedAt: sample.verifiedAt,
  e2ee: sample.e2ee,
};

test('buildModelProof reproduces the recorded sample proof for the same salt', () => {
  const built = buildModelProof({ ...input, salt: sample.salt as string });
  const { commitTx: _tx, ...expected } = sample;
  assert.deepEqual(built, expected);
  assert.equal(verifyModelProof(built, requestBody, responseBody, entry).ok, true);
});

test('buildModelProof draws a fresh salt by default', () => {
  const a = buildModelProof(input);
  const b = buildModelProof(input);
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.commit, b.commit);
});

test('disclosure round-trips bytes, proof and log entry and still verifies', () => {
  const proof = buildModelProof(input);
  const file = JSON.parse(JSON.stringify(toDisclosure({ proof, logEntry: entry, requestBody, responseBody }))) as unknown;
  const back = parseDisclosure(file);
  assert.deepEqual(back.proof, proof);
  assert.deepEqual(Array.from(back.requestBody), Array.from(requestBody));
  assert.deepEqual(Array.from(back.responseBody), Array.from(responseBody));
  assert.equal(verifyModelProof(back.proof, back.requestBody, back.responseBody, back.logEntry).ok, true);
});

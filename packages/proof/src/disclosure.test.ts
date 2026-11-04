import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commitOf } from './commit.ts';
import { Disclosure, isDisclosure, parseDisclosure, toDisclosure } from './disclosure.ts';
import { readRepoFile, readRepoJson } from './fixtures.ts';
import type { KeyEntry, ModelProof } from './schema.ts';
import { verifyModelProof } from './verify.ts';

const { proof } = readRepoJson<{ proof: ModelProof }>('docs/samples/model-proof-e2ee.sample.json');
const { entry } = readRepoJson<{ entry: KeyEntry }>('docs/samples/key-entry.sample.json');
const requestBody = readRepoFile('docs/samples/e2ee-chat-request.raw.json');
const responseBody = readRepoFile('docs/samples/e2ee-chat-response.raw.json');

test('toDisclosure/parseDisclosure round-trip the exact bytes, the proof and the log entry', () => {
  const file = toDisclosure({ proof, logEntry: entry, requestBody, responseBody });
  assert.equal(isDisclosure(file), true);
  const back = parseDisclosure(JSON.parse(JSON.stringify(file)));
  assert.deepEqual(back.requestBody, requestBody);
  assert.deepEqual(back.responseBody, responseBody);
  assert.deepEqual(back.proof, proof);
  assert.deepEqual(back.logEntry, entry);
  assert.equal(verifyModelProof(back.proof, back.requestBody, back.responseBody, back.logEntry).ok, true);
});

test('a disclosure never carries plaintext: only the proof, the entry and the bytes that were signed', () => {
  const file = toDisclosure({ proof, logEntry: entry, requestBody, responseBody });
  assert.deepEqual(Object.keys(file).sort(), ['disclosedAt', 'kind', 'logEntry', 'note', 'proof', 'rawRequestBase64', 'rawResponseBase64', 'v']);
});

test('the sample disclosure file (docs/samples) verifies offline against its embedded entry and its commit is reproducible', () => {
  const raw = readRepoJson('docs/samples/disclosure.sample.json');
  const file = Disclosure.parse(raw); // the exact format a proof card downloads: no wrapper, no extra keys
  const d = parseDisclosure(file);
  assert.equal(d.proof.e2ee, true);
  const report = verifyModelProof(d.proof, d.requestBody, d.responseBody, d.logEntry);
  assert.ok(report.checks.every((c) => c.status === 'ok'), JSON.stringify(report.checks, null, 2));
  assert.equal(commitOf(d.proof.salt as string, d.proof), d.proof.commit);
  assert.equal(d.proof.commitTx, undefined, 'the sample was produced by pnpm demo:live, which does not commit');
});

test('a bare proof is not a disclosure, and an unknown field is rejected', () => {
  assert.equal(isDisclosure(proof), false);
  const file = toDisclosure({ proof, logEntry: entry, requestBody, responseBody });
  assert.throws(() => parseDisclosure({ ...file, plaintext: 'hello' }));
  assert.throws(() => parseDisclosure({ ...file, v: 2 }));
});

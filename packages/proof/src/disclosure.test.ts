import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commitOf } from './commit.ts';
import { ainekConfigFromEnv } from './config.ts';
import { isDisclosure, parseDisclosure, toDisclosure } from './disclosure.ts';
import { readRepoFile, readRepoJson } from './fixtures.ts';
import type { KeyEntry, ModelProof } from './schema.ts';
import { verifyModelProof } from './verify.ts';

// The round trip itself is covered in build.test.ts; here: the file's shape and the committed sample.
const { proof } = readRepoJson<{ proof: ModelProof }>('docs/samples/model-proof-e2ee.sample.json');
const { entry } = readRepoJson<{ entry: KeyEntry }>('docs/samples/key-entry.sample.json');
const file = toDisclosure({ proof, logEntry: entry, requestBody: readRepoFile('docs/samples/e2ee-chat-request.raw.json'), responseBody: readRepoFile('docs/samples/e2ee-chat-response.raw.json') });

test('a disclosure never carries plaintext: only the proof, the entry, the bytes that were signed and when', () => {
  assert.deepEqual(Object.keys(file).sort(), ['disclosedAt', 'kind', 'logEntry', 'note', 'proof', 'rawRequestBase64', 'rawResponseBase64', 'v']);
  const parsed = parseDisclosure(JSON.parse(JSON.stringify(file)));
  assert.equal(parsed.disclosedAt, file.disclosedAt);
  assert.equal(parsed.note, file.note);
});

test('the sample disclosure file (docs/samples) verifies offline against its embedded entry and its commit is reproducible', () => {
  const d = parseDisclosure(readRepoJson('docs/samples/disclosure.sample.json')); // strict: exactly the file a proof card downloads
  assert.equal(d.proof.e2ee, true);
  const report = verifyModelProof(d.proof, d.requestBody, d.responseBody, d.logEntry);
  assert.ok(report.checks.every((c) => c.status === 'ok'), JSON.stringify(report.checks, null, 2));
  assert.equal(commitOf(d.proof.salt as string, d.proof), d.proof.commit);
  assert.match(d.proof.commitTx ?? '', /^[1-9A-HJ-NP-Za-km-z]{43,44}$/, 'the sample was committed from the web chat, so it names its transaction');
  // It was committed on the default contract: /auditor looks the commit up there, under the account the sample button fills in.
  const chain = readRepoJson<{ contract: string; committer: string }>('docs/samples/disclosure.sample.chain.json');
  assert.equal(chain.contract, ainekConfigFromEnv({}).contract);
});

test('a bare proof is not a disclosure, and an unknown field or version is rejected', () => {
  assert.equal(isDisclosure(proof), false);
  assert.throws(() => parseDisclosure({ ...file, plaintext: 'hello' }));
  assert.throws(() => parseDisclosure({ ...file, v: 2 }));
});

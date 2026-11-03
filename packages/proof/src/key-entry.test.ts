import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildKeyEntryInput, imageDigestsOf } from './key-entry.ts';
import { entryHashOf } from './commit.ts';
import { readRepoFile, readRepoJson } from './fixtures.ts';
import type { KeyEntry, KeyEntryInput } from './schema.ts';

interface RawReport {
  model_attestations: Array<{ model_name: string; signing_address: string; signing_algo: 'ed25519' | 'ecdsa'; signing_public_key: string; request_nonce: string; info: { tcb_info: { app_compose: string; compose_hash: string } } }>;
}
const reportBytes = readRepoFile('docs/samples/attestation-report.json');
const report = JSON.parse(new TextDecoder().decode(reportBytes)) as RawReport;
const m = report.model_attestations[0]!;
const { entry: sample } = readRepoJson<{ entry: KeyEntry }>('docs/samples/key-entry.sample.json');
const vectors = readRepoJson<{ commits: { entry_hash: { input: KeyEntryInput } } }>('docs/test-vectors/canonical.json');

// What the SDK's verifyModelAttestation returns for the recorded report (values observed on 2026-11-02).
const verified = {
  signer: { signingAlgo: m.signing_algo, signingAddress: m.signing_address },
  signingPublicKey: m.signing_public_key,
  tcbStatus: 'UpToDate',
  deployment: { appCompose: m.info.tcb_info.app_compose, runtimeMeasurements: { composeHash: m.info.tcb_info.compose_hash } },
};

test('buildKeyEntryInput reproduces the recorded sample / test-vector input', () => {
  const built = buildKeyEntryInput({ model: m.model_name, verified, reportBytes, nonce: m.request_nonce, observedAtMs: Number(sample.observed_at) });
  assert.deepEqual(built, vectors.commits.entry_hash.input);
});

test('with observed_at of the live entry #0 it hashes to the entry_hash Dastan logged on ainek-log-dastan.testnet', () => {
  const built = buildKeyEntryInput({ model: m.model_name, verified, reportBytes, nonce: `0x${m.request_nonce.toUpperCase()}`, observedAtMs: 1793718606738 });
  assert.equal(entryHashOf('', built, 'ainek-dev-dastan.testnet'), '5b2e5e5b0e3314b8efc47188eef0c400c36842fdd87f050587fffecdc6116979');
});

test('compose hash falls back to sha256(app_compose); NRAS / ITA hashes are set only when the tokens are given', () => {
  const noMeasurement = { ...verified, deployment: { ...verified.deployment, runtimeMeasurements: {} } };
  const a = buildKeyEntryInput({ model: m.model_name, verified: noMeasurement, reportBytes, nonce: m.request_nonce, observedAtMs: 1 });
  assert.equal(a.compose_hash, m.info.tcb_info.compose_hash);
  assert.equal(a.nras_result_hash, '');
  const b = buildKeyEntryInput({ model: m.model_name, verified, reportBytes, nonce: m.request_nonce, nrasJwt: 'eyJ.jwt', itaJwt: 'ita', observedAtMs: 1 });
  assert.equal(b.nras_result_hash.length, 64);
  assert.equal(b.ita_jwt_hash.length, 64);
});

test('imageDigestsOf keeps order of first appearance and deduplicates', () => {
  const d = 'sha256:' + 'ab'.repeat(32);
  const e = 'sha256:' + 'cd'.repeat(32);
  assert.deepEqual(imageDigestsOf(`image: x@${d}\nimage: y@${e}\nimage: x@${d}`), [d, e]);
  assert.equal(imageDigestsOf(m.info.tcb_info.app_compose).length, 4);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildKeyEntryInput, imageDigestsOf, type BuildKeyEntryInputParams } from './key-entry.ts';
import { entryHashOf } from './commit.ts';
import { readRepoFile, readRepoJson } from './fixtures.ts';
import type { KeyEntry, KeyEntryInput } from './schema.ts';

interface RawReport {
  model_attestations: Array<{ model_name: string; signing_address: string; signing_algo: 'ed25519' | 'ecdsa'; signing_public_key: string; request_nonce: string; info: { tcb_info: { app_compose: string; compose_hash: string } } }>;
}
interface Vectors {
  commits: { entry_hash: { input: KeyEntryInput; recorded_on_chain: { verifier: string; observed_at: string; prev_hash: string; entry_hash: string } } };
}
const reportBytes = readRepoFile('docs/samples/attestation-report.json');
const m = (JSON.parse(new TextDecoder().decode(reportBytes)) as RawReport).model_attestations[0]!;
const { entry: sample } = readRepoJson<{ entry: KeyEntry }>('docs/samples/key-entry.sample.json');
const { input: expectedInput, recorded_on_chain: onChain } = readRepoJson<Vectors>('docs/test-vectors/canonical.json').commits.entry_hash;

// What the SDK's verifyModelAttestation returns for the recorded report (values observed on 2026-11-02).
const verified = {
  signer: { signingAlgo: m.signing_algo, signingAddress: m.signing_address },
  signingPublicKey: m.signing_public_key,
  tcbStatus: 'UpToDate',
  deployment: { appCompose: m.info.tcb_info.app_compose, runtimeMeasurements: { composeHash: m.info.tcb_info.compose_hash } },
};
const build = (overrides: Partial<BuildKeyEntryInputParams> = {}) =>
  buildKeyEntryInput({ model: m.model_name, verified, reportBytes, nonce: m.request_nonce, observedAtMs: 1, ...overrides });

test('buildKeyEntryInput reproduces the recorded sample / test-vector input', () => {
  assert.deepEqual(build({ observedAtMs: Number(sample.observed_at) }), expectedInput);
});

test('with the recorded observed_at it hashes to the entry_hash logged on-chain for entry #0 (Rust and TS agree)', () => {
  const built = build({ nonce: `0x${m.request_nonce.toUpperCase()}`, observedAtMs: Number(onChain.observed_at) });
  assert.equal(entryHashOf(onChain.prev_hash, built, onChain.verifier), onChain.entry_hash);
});

test('compose hash falls back to sha256(app_compose); NRAS / ITA hashes are set only when the tokens are given', () => {
  const a = build({ verified: { ...verified, deployment: { ...verified.deployment, runtimeMeasurements: {} } } });
  assert.equal(a.compose_hash, m.info.tcb_info.compose_hash);
  assert.equal(a.nras_result_hash, '');
  const b = build({ nrasJwt: 'eyJ.jwt', itaJwt: 'ita' });
  assert.equal(b.nras_result_hash.length, 64);
  assert.equal(b.ita_jwt_hash.length, 64);
});

test('imageDigestsOf keeps order of first appearance and deduplicates', () => {
  const d = 'sha256:' + 'ab'.repeat(32);
  const e = 'sha256:' + 'cd'.repeat(32);
  assert.deepEqual(imageDigestsOf(`image: x@${d}\nimage: y@${e}\nimage: x@${d}`), [d, e]);
  assert.equal(imageDigestsOf(m.info.tcb_info.app_compose).length, 4);
});

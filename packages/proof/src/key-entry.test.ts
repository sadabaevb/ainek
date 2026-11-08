import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildKeyEntryInput, composeHashOf, imageDigestsOf, type BuildKeyEntryInputParams } from './key-entry.ts';
import { entryHashOf } from './commit.ts';
import { sha256Hex } from './hash.ts';
import { readRepoFile, readRepoJson } from './fixtures.ts';
import type { RawReport } from './report.ts';
import type { KeyEntry, KeyEntryInput } from './schema.ts';

interface Vectors {
  commits: { entry_hash: { input: KeyEntryInput; recorded_on_chain: { verifier: string; observed_at: string; prev_hash: string; entry_hash: string } } };
}
const reportBytes = readRepoFile('docs/samples/attestation-report.json');
const m = (JSON.parse(new TextDecoder().decode(reportBytes)) as RawReport).model_attestations[0]!;
if (m.signing_public_key === undefined) throw new Error('fixture report has no signing_public_key');
const publicKey = m.signing_public_key;
const { entry: sample } = readRepoJson<{ entry: KeyEntry }>('docs/samples/key-entry.sample.json');
const { input: expectedInput, recorded_on_chain: onChain } = readRepoJson<Vectors>('docs/test-vectors/canonical.json').commits.entry_hash;

// What the SDK's verifyModelAttestation returns for the recorded report (values observed on 2026-11-02).
const verified = {
  signer: { signingAlgo: m.signing_algo, signingAddress: m.signing_address },
  signingPublicKey: publicKey,
  tcbStatus: 'UpToDate',
  deployment: { appCompose: m.info.tcb_info.app_compose, runtimeMeasurements: { composeHash: m.info.tcb_info.compose_hash } },
  report: { nonce: m.request_nonce },
};
const build = (overrides: Partial<BuildKeyEntryInputParams> = {}) => buildKeyEntryInput({ model: m.model_name, verified, reportBytes, observedAtMs: 1, ...overrides });

test('buildKeyEntryInput reproduces the test-vector input', () => {
  assert.deepEqual(build({ observedAtMs: Number(expectedInput.observed_at) }), expectedInput);
});

test('the replay\'s log entry is entry #0 as recorded on chain: same verifier, observed_at and entry_hash', () => {
  assert.deepEqual([sample.verifier, sample.observed_at, sample.prev_hash, sample.entry_hash], [onChain.verifier, onChain.observed_at, onChain.prev_hash, onChain.entry_hash]);
});

test('with the recorded observed_at it hashes to the entry_hash logged on-chain for entry #0 (Rust and TS agree)', () => {
  const built = build({ observedAtMs: Number(onChain.observed_at) });
  assert.equal(entryHashOf(onChain.prev_hash, built, onChain.verifier), onChain.entry_hash);
});

test('hex fields are logged without 0x and lowercase, whatever the wire form', () => {
  const shouty = { ...verified, signer: { ...verified.signer, signingAddress: `0x${m.signing_address.toUpperCase()}` }, signingPublicKey: publicKey.toUpperCase(), report: { nonce: `0X${m.request_nonce.toUpperCase()}` } };
  const built = build({ verified: shouty });
  assert.equal(built.signing_address, m.signing_address);
  assert.equal(built.signing_public_key, publicKey);
  assert.equal(built.nonce, m.request_nonce);
});

test('compose hash falls back to sha256(app_compose); NRAS / ITA hashes are set only when the tokens are given', () => {
  const a = build({ verified: { ...verified, deployment: { ...verified.deployment, runtimeMeasurements: {} } } });
  assert.equal(a.compose_hash, m.info.tcb_info.compose_hash);
  assert.equal(a.nras_result_hash, '');
  const b = build({ nrasJwt: 'eyJ.jwt', itaJwt: 'ita' });
  assert.equal(b.nras_result_hash.length, 64);
  assert.equal(b.ita_jwt_hash.length, 64);
});

test('composeHashOf: the measured value wins; absent or empty, the hash of app_compose; always in the logged form', () => {
  const measured = 'cd'.repeat(32);
  const hashed = sha256Hex('compose');
  assert.equal(composeHashOf({ appCompose: 'compose', runtimeMeasurements: { composeHash: `0x${measured.toUpperCase()}` } }), measured);
  assert.equal(composeHashOf({ appCompose: 'compose', runtimeMeasurements: {} }), hashed);
  assert.equal(composeHashOf({ appCompose: 'compose', runtimeMeasurements: { composeHash: '' } }), hashed);
});

test('refuses to build an entry that would pin nothing', () => {
  const { signingPublicKey: _k, ...noKey } = verified;
  assert.throws(() => build({ verified: { ...noKey, signer: { signingAlgo: 'ecdsa', signingAddress: '0x' + 'ab'.repeat(20) } } }), /no E2EE public key/);
  assert.equal(build({ verified: noKey }).signing_public_key, m.signing_address, 'ed25519: the address is the key');
  assert.throws(() => build({ verified: { ...verified, deployment: { ...verified.deployment, appCompose: 'services:\n  app:\n    image: foo:latest\n' } } }), /pins no image/);
  assert.throws(() => build({ observedAtMs: 1.5 }), /unix milliseconds/);
  assert.throws(() => build({ observedAtMs: Number.NaN }), /unix milliseconds/);
});

test('imageDigestsOf reads image: lines only, keeps first-appearance order, deduplicates, lowercases', () => {
  const d = 'ab'.repeat(32);
  const e = 'cd'.repeat(32);
  const yaml = `services:\n  x:\n    image: repo/x@sha256:${d.toUpperCase()}\n    command: sh -c "echo sha256:${'ee'.repeat(32)}"\n  y:\n    image: repo/y@sha256:${e}\n  z:\n    image: repo/x@sha256:${d}\n`;
  assert.deepEqual(imageDigestsOf(yaml), [`sha256:${d}`, `sha256:${e}`]);
  assert.deepEqual(imageDigestsOf(JSON.stringify({ docker_compose_file: yaml, pre_launch_script: `curl … | sha256sum -c sha256:${'ff'.repeat(32)}` })), [`sha256:${d}`, `sha256:${e}`]);
  assert.equal(imageDigestsOf(m.info.tcb_info.app_compose).length, 4);
  assert.deepEqual(imageDigestsOf(m.info.tcb_info.app_compose), expectedInput.image_digests);
});

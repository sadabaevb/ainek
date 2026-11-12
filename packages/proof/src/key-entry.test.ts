import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildKeyEntryInput, composeHashOf, imageDigestsOf, readAppCompose, type BuildKeyEntryInputParams } from './key-entry.ts';
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
  // Its own fields too: everything the entry hash covers is what the recorded report gives (the test above hashes that to entry_hash).
  const { index: _i, verifier: _v, prev_hash: _p, entry_hash: _h, block_height: _b, ...input } = sample;
  assert.deepEqual(input, build({ observedAtMs: Number(sample.observed_at) }));
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

test('composeHashOf: the hash of app_compose, which MRCONFIGID binds; a compose-hash event that says otherwise is not believed', () => {
  const hashed = sha256Hex('compose');
  assert.equal(composeHashOf({ appCompose: 'compose', runtimeMeasurements: {} }), hashed);
  assert.equal(composeHashOf({ appCompose: 'compose', runtimeMeasurements: { composeHash: hashed } }), hashed, 'an honest boot: the event agrees');
  // Before dstack 0.6.0 a container with the dstack socket could append a `compose-hash` event, and the SDK reports the last one.
  assert.equal(composeHashOf({ appCompose: 'compose', runtimeMeasurements: { composeHash: 'cd'.repeat(32) } }), hashed);
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

test('readAppCompose: the compose file and the allowed variable names of a dstack app compose; anything else is not one', () => {
  assert.deepEqual(readAppCompose(JSON.stringify({ docker_compose_file: 'services: {}', allowed_envs: ['A', 1, 'B'] })), { composeFile: 'services: {}', allowedEnvs: ['A', 'B'] });
  assert.deepEqual(readAppCompose(JSON.stringify({ docker_compose_file: 'services: {}' })), { composeFile: 'services: {}', allowedEnvs: [] });
  for (const not of ['services: {}', '{}', 'null', '[]', '{"docker_compose_file": 5}']) assert.equal(readAppCompose(not), undefined, not);
});

test('buildKeyEntryInput: release marks ride after the image digests, and never at their cost', () => {
  const plain = build();
  const marks = ['release:0123456789abcdef:' + 'a'.repeat(64), 'log:19aea1693533dc2d:224:' + 'b'.repeat(64)];
  assert.deepEqual(build({ marks }).image_digests, [...plain.image_digests, ...marks]);
  assert.deepEqual(build({ marks: [] }).image_digests, plain.image_digests);
  // 16 values of 128 bytes at most (contracts/ainek/src/lib.rs). The contract rejects a whole entry over one value too many,
  // so marks that do not fit are left out, all of them, and the key and its launcher are logged as before.
  const room = 16 - plain.image_digests.length;
  assert.equal(build({ marks: Array(room).fill(marks[0]) as string[] }).image_digests.length, 16);
  assert.deepEqual(build({ marks: Array(room + 1).fill(marks[0]) as string[] }).image_digests, plain.image_digests);
  assert.deepEqual(build({ marks: [marks[0] as string, 'log:' + 'x'.repeat(125)] }).image_digests, plain.image_digests);
});

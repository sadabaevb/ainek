import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEnv } from 'node:util';
import { ainekConfigFromEnv } from './config.ts';
import { readRepoFile, readRepoJson } from './fixtures.ts';

test('defaults point at the deployed testnet log and the demo trust policy', () => {
  const c = ainekConfigFromEnv({});
  assert.equal(c.contract, 'ainek-log-dastan.testnet');
  assert.equal(c.logSource, 'contract');
  assert.deepEqual(c.trustedVerifiers, ['ainek-dev-dastan.testnet']);
  assert.equal(c.quorum, 1);
  assert.deepEqual(c.acceptedTcbStatuses, ['UpToDate']);
  assert.equal(c.rpcUrl, 'https://rpc.testnet.fastnear.com');
  assert.equal(c.nearaiBaseUrl, 'https://cloud-api.near.ai/v1');
});

test('the default trust set includes the verifier of the replay\'s recorded entry #0, in both log modes', () => {
  const { entry } = readRepoJson<{ entry: { verifier: string } }>('docs/samples/key-entry.sample.json');
  for (const env of [{}, { AINEK_LOG_SOURCE: 'sample' }]) assert.ok(ainekConfigFromEnv(env).trustedVerifiers.includes(entry.verifier));
});

test('env overrides, lists and mainnet defaults', () => {
  const c = ainekConfigFromEnv({ NEAR_NETWORK: 'mainnet', AINEK_TRUSTED_VERIFIERS: ' v1.ainek.near, v2.ainek.near ,', AINEK_QUORUM: '2', AINEK_ACCEPTED_TCB: 'UpToDate,SWHardeningNeeded', NEARAI_BASE_URL: 'https://staging.example/v1' });
  assert.equal(c.network, 'mainnet');
  assert.equal(c.rpcUrl, 'https://rpc.mainnet.fastnear.com');
  assert.equal(c.explorer, 'https://nearblocks.io');
  assert.deepEqual(c.trustedVerifiers, ['v1.ainek.near', 'v2.ainek.near']);
  assert.equal(c.quorum, 2);
  assert.deepEqual(c.acceptedTcbStatuses, ['UpToDate', 'SWHardeningNeeded']);
  assert.equal(c.nearaiBaseUrl, 'https://staging.example/v1');
});

test('quorum and TCB policy can never be weakened by a bad value', () => {
  for (const q of ['x', '0', '-1', '0.5', '']) assert.equal(ainekConfigFromEnv({ AINEK_QUORUM: q }).quorum, 1, `quorum ${JSON.stringify(q)}`);
  assert.equal(ainekConfigFromEnv({ AINEK_QUORUM: '3' }).quorum, 3);
  assert.deepEqual(ainekConfigFromEnv({ AINEK_ACCEPTED_TCB: '' }).acceptedTcbStatuses, ['UpToDate']);
  assert.deepEqual(ainekConfigFromEnv({ AINEK_ACCEPTED_TCB: 'UptoDate,bogus' }).acceptedTcbStatuses, ['UpToDate']);
  assert.deepEqual(ainekConfigFromEnv({ AINEK_ACCEPTED_TCB: 'OutOfDate,bogus' }).acceptedTcbStatuses, ['OutOfDate']);
});

test('the policy job defaults are the published ones in .env.example, and a blank variable falls back to them', () => {
  const example = parseEnv(new TextDecoder().decode(readRepoFile('.env.example')));
  const cfg = ainekConfigFromEnv({ OUTLAYER_API_URL: '', OUTLAYER_PROJECT: '', OUTLAYER_WASM_HASH: '' });
  assert.equal(cfg.outlayerApiUrl, example['OUTLAYER_API_URL']);
  assert.equal(cfg.policyProject, example['OUTLAYER_PROJECT']);
  assert.equal(cfg.policyWasmHash, example['OUTLAYER_WASM_HASH']);
});


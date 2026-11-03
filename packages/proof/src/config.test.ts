import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ainekConfigFromEnv } from './config.ts';

test('defaults point at the deployed testnet log and the demo trust policy', () => {
  const c = ainekConfigFromEnv({});
  assert.equal(c.contract, 'ainek-log-dastan.testnet');
  assert.equal(c.logSource, 'contract');
  assert.deepEqual(c.trustedVerifiers, ['ainek-dev-dastan.testnet']);
  assert.equal(c.quorum, 1);
  assert.deepEqual(c.acceptedTcbStatuses, ['UpToDate']);
  assert.equal(c.rpcUrl, 'https://rpc.testnet.near.org');
  assert.equal(c.nearaiBaseUrl, 'https://cloud-api.near.ai/v1');
});

test('sample mode trusts the fixture verifiers by default, so web, live and replay agree', () => {
  assert.deepEqual(ainekConfigFromEnv({ AINEK_LOG_SOURCE: 'sample' }).trustedVerifiers, ['v1.ainek.testnet', 'v2.ainek.testnet', 'v3.ainek.testnet']);
  assert.deepEqual(ainekConfigFromEnv({ AINEK_LOG_SOURCE: 'sample', AINEK_TRUSTED_VERIFIERS: 'x.testnet' }).trustedVerifiers, ['x.testnet']);
});

test('env overrides, lists and mainnet defaults', () => {
  const c = ainekConfigFromEnv({ NEAR_NETWORK: 'mainnet', AINEK_TRUSTED_VERIFIERS: ' v1.ainek.near, v2.ainek.near ,', AINEK_QUORUM: '2', AINEK_ACCEPTED_TCB: 'UpToDate,SWHardeningNeeded', NEARAI_BASE_URL: 'https://staging.example/v1' });
  assert.equal(c.network, 'mainnet');
  assert.equal(c.rpcUrl, 'https://rpc.mainnet.near.org');
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

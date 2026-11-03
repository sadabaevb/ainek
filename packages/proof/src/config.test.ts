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
});

test('env overrides, lists and mainnet defaults', () => {
  const c = ainekConfigFromEnv({ NEAR_NETWORK: 'mainnet', AINEK_TRUSTED_VERIFIERS: ' v1.ainek.near, v2.ainek.near ,', AINEK_QUORUM: '2', AINEK_LOG_SOURCE: 'sample', AINEK_ACCEPTED_TCB: 'UpToDate,SWHardeningNeeded' });
  assert.equal(c.network, 'mainnet');
  assert.equal(c.rpcUrl, 'https://rpc.mainnet.near.org');
  assert.equal(c.explorer, 'https://nearblocks.io');
  assert.deepEqual(c.trustedVerifiers, ['v1.ainek.near', 'v2.ainek.near']);
  assert.equal(c.quorum, 2);
  assert.equal(c.logSource, 'sample');
  assert.deepEqual(c.acceptedTcbStatuses, ['UpToDate', 'SWHardeningNeeded']);
  assert.equal(ainekConfigFromEnv({ AINEK_QUORUM: 'x' }).quorum, 1);
});

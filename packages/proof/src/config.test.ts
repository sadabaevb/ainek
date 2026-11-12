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

test('the public settings in .env.example are the code defaults, so a host that sets none (Vercel) runs the same config', () => {
  const example = parseEnv(new TextDecoder().decode(readRepoFile('.env.example')));
  const keys = ['NEARAI_BASE_URL', 'NEARAI_MODEL', 'NEARAI_INCOGNITO_MODEL', 'NEAR_NETWORK', 'AINEK_CONTRACT', 'AINEK_LOG_SOURCE', 'AINEK_TRUSTED_VERIFIERS', 'AINEK_QUORUM', 'AINEK_ACCEPTED_TCB', 'AINEK_REQUIRE_DEPLOYMENT', 'AGENT_ACCOUNT_ID'];
  const fromExample = Object.fromEntries(keys.map((k) => [k, example[k]]));
  for (const k of keys) assert.ok(fromExample[k], `${k} is set in .env.example`);
  assert.deepEqual(ainekConfigFromEnv(fromExample), ainekConfigFromEnv({}));
});

test('the policy job defaults are the published ones in .env.example, and a blank variable falls back to them', () => {
  const example = parseEnv(new TextDecoder().decode(readRepoFile('.env.example')));
  const cfg = ainekConfigFromEnv({ OUTLAYER_API_URL: '', OUTLAYER_PROJECT: '', OUTLAYER_WASM_HASH: '' });
  assert.equal(cfg.outlayerApiUrl, example['OUTLAYER_API_URL']);
  assert.equal(cfg.policyProject, example['OUTLAYER_PROJECT']);
  assert.equal(cfg.policyWasmHash, example['OUTLAYER_WASM_HASH']);
  assert.equal(ainekConfigFromEnv({ AGENT_ACCOUNT_ID: '' }).agentAccount, example['AGENT_ACCOUNT_ID']);
});

test('the deployment check: only an explicit 0 or false turns it off; blank is the default, and a typo turns it on', () => {
  const byDefault = ainekConfigFromEnv({}).requireLoggedDeployment;
  for (const v of ['1', 'true', ' TRUE ', 'yes', 'on', 'enabled']) assert.equal(ainekConfigFromEnv({ AINEK_REQUIRE_DEPLOYMENT: v }).requireLoggedDeployment, true, v);
  for (const v of ['0', 'false', ' False ']) assert.equal(ainekConfigFromEnv({ AINEK_REQUIRE_DEPLOYMENT: v }).requireLoggedDeployment, false, v);
  for (const v of ['', '  ']) assert.equal(ainekConfigFromEnv({ AINEK_REQUIRE_DEPLOYMENT: v }).requireLoggedDeployment, byDefault, JSON.stringify(v));
});

test('AINEK_REQUIRE_RELEASE: off until asked for; blank is the default, 0 or false is off, anything else is on', () => {
  assert.equal(ainekConfigFromEnv({}).requireLoggedRelease, false);
  for (const off of ['', ' ', '0', 'false', 'FALSE']) assert.equal(ainekConfigFromEnv({ AINEK_REQUIRE_RELEASE: off }).requireLoggedRelease, false, JSON.stringify(off));
  for (const on of ['1', 'true', 'yes', 'on']) assert.equal(ainekConfigFromEnv({ AINEK_REQUIRE_RELEASE: on }).requireLoggedRelease, true, on);
});

test('AINEK_MIN_RELEASE_AGE_MIN: no wait until asked for; a value that is not whole minutes within the limit is the limit', () => {
  const ms = (value?: string) => ainekConfigFromEnv(value === undefined ? {} : { AINEK_MIN_RELEASE_AGE_MIN: value }).minReleaseAgeMs;
  assert.deepEqual([ms(), ms(''), ms(' '), ms('0')], [0, 0, 0, 0]);
  assert.deepEqual([ms('30'), ms(' 90 '), ms('720')], [30 * 60_000, 90 * 60_000, 720 * 60_000]);
  // A typo must not turn the wait off: it becomes the longest one, and the refusals say so.
  for (const odd of ['721', '-5', '1.5', '30m', 'one hour']) assert.equal(ms(odd), 720 * 60_000, odd);
});

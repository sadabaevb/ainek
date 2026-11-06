import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from './config.ts';

const env = {
  NEARAI_API_KEY: 'k',
  AGENT_ACCOUNT_ID: 'agent.testnet',
  AGENT_FC_PRIVATE_KEY: 'ed25519:' + 'a'.repeat(40),
  OWNER_ACCOUNT_ID: 'owner.testnet',
  AINEK_TOKEN: 'token.testnet',
  OUTLAYER_PAYMENT_KEY: 'o:n:s',
  OUTLAYER_PROJECT: 'o.testnet/policy',
  OUTLAYER_WASM_HASH: 'ab'.repeat(32),
} as NodeJS.ProcessEnv;

test('loadConfig: the required variables are enough; the bot is optional and the API URL has a default', () => {
  const c = loadConfig(env);
  assert.equal(c.outlayer.apiUrl, 'https://testnet-api.outlayer.ai');
  assert.equal(c.telegram, null);
  assert.deepEqual(loadConfig({ ...env, TELEGRAM_BOT_TOKEN: 't', TELEGRAM_OWNER_CHAT_ID: '1' }).telegram, { token: 't', ownerChatId: '1' });
});

test('loadConfig: refuses to start with an owner key in its environment, so the agent can never approve for itself', () => {
  assert.throws(() => loadConfig({ ...env, OWNER_PRIVATE_KEY: 'ed25519:x' }), /must never hold an owner key/);
  assert.throws(() => loadConfig({ ...env, AGENT_ADMIN_PRIVATE_KEY: 'ed25519:x' }), /must never hold an owner key/);
});

test('loadConfig: refuses the sample log, malformed hashes and a key that is not ed25519; a missing variable is named', () => {
  assert.throws(() => loadConfig({ ...env, AINEK_LOG_SOURCE: 'sample' }), /only the contract log/);
  assert.throws(() => loadConfig({ ...env, OUTLAYER_WASM_HASH: 'placeholder' }), /64 lowercase hex/);
  assert.throws(() => loadConfig({ ...env, AGENT_FC_PRIVATE_KEY: 'plain' }), /ed25519/);
  const { NEARAI_API_KEY: _omitted, ...withoutKey } = env;
  assert.throws(() => loadConfig(withoutKey as NodeJS.ProcessEnv), /NEARAI_API_KEY is required/);
});

test('loadConfig: another service\'s key in the environment warns by name, without its value', (t) => {
  const warn = t.mock.method(console, 'warn', () => undefined);
  loadConfig({ ...env, VERIFIER_PRIVATE_KEY: 'ed25519:secret' });
  assert.equal(warn.mock.callCount(), 1);
  const text = String(warn.mock.calls[0]?.arguments[0]);
  assert.match(text, /VERIFIER_PRIVATE_KEY/);
  assert.doesNotMatch(text, /secret/);
});

test('loadConfig: the OutLayer API must be https, since the payment key travels to it', () => {
  for (const url of ['http://api.test', 'api.test:443']) assert.throws(() => loadConfig({ ...env, OUTLAYER_API_URL: url }), /OUTLAYER_API_URL must be an https URL/, url);
});

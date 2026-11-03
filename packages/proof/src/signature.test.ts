import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { verifySignedText, decodeSignature } from './signature.ts';
import { parseSignedText } from './signed-text.ts';
import { readRepoJson } from './fixtures.ts';
import { SignatureResponse } from './schema.ts';

const sample = SignatureResponse.parse(readRepoJson('docs/samples/signature.json'));

test('recorded ed25519 signature verifies under the attested signing_address', () => {
  const r = verifySignedText({ signedText: sample.text, signature: sample.signature, signingAddress: sample.signing_address, signingAlgo: 'ed25519' });
  assert.equal(r.ok, true, r.detail);
});

test('ed25519: tampered text, wrong key and malformed signature fail', () => {
  const base = { signedText: sample.text, signature: sample.signature, signingAddress: sample.signing_address, signingAlgo: 'ed25519' as const };
  assert.equal(verifySignedText({ ...base, signedText: sample.text.replace(/.$/, 'f') }).ok, false);
  assert.equal(verifySignedText({ ...base, signingAddress: 'ab'.repeat(32) }).ok, false);
  assert.equal(verifySignedText({ ...base, signature: 'zz' }).ok, false);
  assert.equal(verifySignedText({ ...base, signature: sample.signature.slice(2) }).ok, false);
});

test('ed25519: base64 and 0x-prefixed signatures are accepted', () => {
  const bytes = decodeSignature(sample.signature);
  const b64 = Buffer.from(bytes).toString('base64');
  const base = { signedText: sample.text, signingAddress: sample.signing_address, signingAlgo: 'ed25519' as const };
  assert.equal(verifySignedText({ ...base, signature: b64 }).ok, true);
  assert.equal(verifySignedText({ ...base, signature: `0x${sample.signature}` }).ok, true);
});

test('parseSignedText: provider_tee and gateway shapes', () => {
  const p = parseSignedText(sample.text);
  assert.equal(p.model, 'z-ai/glm-5.3-flash');
  assert.equal(p.requestSha256.length, 64);
  const g = parseSignedText(`${p.requestSha256}:${p.responseSha256}`);
  assert.equal(g.model, null);
  assert.equal(g.responseSha256, p.responseSha256);
  assert.throws(() => parseSignedText('model:nothex:nothex'));
  assert.throws(() => parseSignedText('abc'));
});

test('ecdsa: EIP-191 personal_sign recovers to signing_address', async () => {
  const wallet = Wallet.createRandom();
  const text = `some/model:${'1'.repeat(64)}:${'2'.repeat(64)}`;
  const signature = await wallet.signMessage(text);
  assert.equal(verifySignedText({ signedText: text, signature, signingAddress: wallet.address, signingAlgo: 'ecdsa' }).ok, true);
  assert.equal(verifySignedText({ signedText: text, signature, signingAddress: wallet.address.toLowerCase(), signingAlgo: 'ecdsa' }).ok, true);
  assert.equal(verifySignedText({ signedText: text + 'x', signature, signingAddress: wallet.address, signingAlgo: 'ecdsa' }).ok, false);
  assert.equal(verifySignedText({ signedText: text, signature, signingAddress: Wallet.createRandom().address, signingAlgo: 'ecdsa' }).ok, false);
});

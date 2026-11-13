import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { WALLET_MANIFEST_URL, errorText, isDialogClosed, ownerDecide } from './wallet.ts';

test('the wallet list is pinned to a commit, not a branch', () => {
  assert.match(WALLET_MANIFEST_URL, /^https:\/\/raw\.githubusercontent\.com\/hot-dao\/near-selector\/[0-9a-f]{40}\/repository\/manifest\.json$/);
});

test('the wallet provider has a Suspense boundary right under it, and the trust set is read below that', () => {
  // What the two guard against needs a browser and a slow connection to show (docs/DEV-NOTES.md, Nov 13): thousands of
  // requests for the wallet list without the boundary, an empty page for a visitor with a trust set of their own when the
  // store is read above it. Here only that nobody takes either out. Comments are dropped first, so a line left in one does not count.
  const jsx = readFileSync(new URL('../app/providers.tsx', import.meta.url), 'utf8').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(jsx, /<NearProvider\b[^>]*>\s*<Suspense\b[^>]*>\s*<TrustProvider\b[^>]*>\s*\{children\}\s*<\/TrustProvider>\s*<\/Suspense>\s*<\/NearProvider>/);
  const providers = jsx.slice(jsx.indexOf('export function Providers('), jsx.indexOf('export function useConfig('));
  assert.equal(providers.includes('useCustomTrust('), false, 'Providers itself must not read the trust store');
});

test('isDialogClosed: every way a wallet says it was closed, as an Error or as the plain value a sandbox hands over', () => {
  for (const text of ['User rejected', 'Wallet closed', 'User closed the window before completing the action']) {
    assert.equal(isDialogClosed(new Error(text)), true, text);
    assert.equal(isDialogClosed(text), true, text);
  }
});

test('isDialogClosed: a real failure is not a closed dialog', () => {
  for (const err of [new Error('Failed to sign in'), new Error('Failed to load manifest'), { code: 500 }, undefined]) {
    assert.equal(isDialogClosed(err), false);
  }
});

test('errorText: reads an Error, a plain string and a cloned object, with no quotes around the string', () => {
  assert.equal(errorText(new Error('Failed to sign in')), 'Failed to sign in');
  assert.equal(errorText('Permission denied'), 'Permission denied');
  assert.equal(errorText({ code: 500n }), '{"code":"500"}');
});

test('ownerDecide: 1 yoctoNEAR so that only a full-access signature passes, gas for the transfer and its callback, and the hash of a call that succeeded', async () => {
  const sent: unknown[] = [];
  const call = (async (params: unknown) => {
    sent.push(params);
    return { status: { SuccessValue: '' }, transaction_outcome: { id: 'TX1' } };
  }) as never;
  assert.equal(await ownerDecide(call, { contract: 'ainek.testnet' }, 'approve', 7), 'TX1');
  assert.equal(await ownerDecide(call, { contract: 'ainek.testnet' }, 'reject', 8), 'TX1');
  assert.deepEqual(sent, [
    { contractId: 'ainek.testnet', method: 'approve', args: { action_id: 7 }, gas: '100000000000000', deposit: '1' },
    { contractId: 'ainek.testnet', method: 'reject', args: { action_id: 8 }, gas: '100000000000000', deposit: '1' },
  ]);
});

test('ownerDecide: a call the contract refused is an error with its reason, not a hash', async () => {
  const refused = (async () => ({ status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: only the owner can do this' } } } } }, transaction_outcome: { id: 'TX2' } })) as never;
  await assert.rejects(ownerDecide(refused, { contract: 'ainek.testnet' }, 'approve', 7), /approve failed: .*only the owner can do this/);
});

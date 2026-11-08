import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WALLET_MANIFEST_URL, errorText, isDialogClosed } from './wallet.ts';

test('the wallet list is pinned to a commit, not a branch', () => {
  assert.match(WALLET_MANIFEST_URL, /^https:\/\/raw\.githubusercontent\.com\/hot-dao\/near-selector\/[0-9a-f]{40}\/repository\/manifest\.json$/);
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

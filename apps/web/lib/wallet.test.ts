import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isDialogClosed } from './wallet.ts';

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

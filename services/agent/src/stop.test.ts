import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stopAgent } from './stop.ts';

test('stopAgent: the key goes first, and each step runs whatever happens to the other', async () => {
  const order: string[] = [];
  const ok = await stopAgent({ deleteKey: async () => { order.push('key'); return 'K'; }, pause: async () => { order.push('pause'); return 'P'; } });
  assert.deepEqual(order, ['key', 'pause']);
  assert.deepEqual(ok, { deleteKey: { ok: true, tx: 'K' }, pause: { ok: true, tx: 'P' } });
  const keyGone = await stopAgent({ deleteKey: async () => { throw new Error('no such key'); }, pause: async () => 'P' });
  assert.deepEqual(keyGone, { deleteKey: { ok: false, error: 'no such key' }, pause: { ok: true, tx: 'P' } });
  const noContract = await stopAgent({ deleteKey: async () => 'K', pause: async () => { throw new Error('MethodNotFound'); } });
  assert.deepEqual(noContract, { deleteKey: { ok: true, tx: 'K' }, pause: { ok: false, error: 'MethodNotFound' } });
});

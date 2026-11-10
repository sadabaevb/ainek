import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatHistory, hasOtherThread } from './history.ts';

const user = (content: string) => ({ role: 'user' as const, content });
const TEE = 'private-model';
const INCOGNITO = 'incognito-model';

const turns = [
  { message: user('a'), model: TEE, outcome: { kind: 'verified', reply: 'A' } },
  { message: user('b'), model: TEE, outcome: { kind: 'failed', unverifiedReply: 'not checked' } },
  { message: user('c'), model: TEE, outcome: { kind: 'refused' } },
  { message: user('d'), model: INCOGNITO, outcome: { kind: 'non-tee', reply: 'D' } },
  { message: user('e'), model: TEE },
];

test('history carries only checked replies: not a failed one, a refusal or a turn still in flight', () => {
  assert.deepEqual(chatHistory(turns, TEE), [user('a'), { role: 'assistant', content: 'A' }]);
});

test('each model sees only its own thread: private turns never go to the Incognito model, nor its replies back', () => {
  assert.deepEqual(chatHistory(turns, INCOGNITO), [user('d'), { role: 'assistant', content: 'D' }]);
  assert.equal(chatHistory(turns, TEE).some((m) => m.content === 'D' || m.content === 'd'), false);
  assert.equal(hasOtherThread(turns, TEE), true);
  assert.equal(hasOtherThread(turns.filter((t) => t.model === TEE), TEE), false);
  assert.equal(hasOtherThread([], TEE), false);
});

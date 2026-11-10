import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatHistory, hasOtherThread, type HistoryTurn } from './history.ts';

const user = (content: string) => ({ role: 'user' as const, content });
const TEE = 'private-model';
const INCOGNITO = 'incognito-model';

const turns: HistoryTurn[] = [
  { message: user('a'), model: TEE, outcome: { kind: 'verified', reply: 'A' } },
  { message: user('b'), model: TEE, outcome: { kind: 'failed' } }, // its text is `unverifiedReply`, not `reply`
  { message: user('c'), model: TEE, outcome: { kind: 'refused' } },
  { message: user('d'), model: INCOGNITO, outcome: { kind: 'non-tee', reply: 'D' } },
  { message: user('e'), model: TEE },
];

test('history carries only checked replies: not a failed one, a refusal or a turn still in flight', () => {
  assert.deepEqual(chatHistory(turns, TEE, TEE), [user('a'), { role: 'assistant', content: 'A' }]);
});

test('each model sees only its own thread: private turns never go to the Incognito model, nor its replies back', () => {
  assert.deepEqual(chatHistory(turns, INCOGNITO, TEE), [user('d'), { role: 'assistant', content: 'D' }]);
  assert.equal(hasOtherThread(turns, TEE, TEE), true);
  assert.equal(hasOtherThread(turns, INCOGNITO, TEE), true);
});

test('a turn the Incognito model happened to get encrypted is not repeated to it in plaintext', () => {
  const attestedOnce: HistoryTurn[] = [{ message: user('secret'), model: INCOGNITO, outcome: { kind: 'verified', reply: 'S' } }];
  assert.deepEqual(chatHistory(attestedOnce, INCOGNITO, TEE), []);
  assert.equal(hasOtherThread(attestedOnce, INCOGNITO, TEE), true);
});

test('the note about another thread appears only for an answered exchange that is left out', () => {
  const nothingSent: HistoryTurn[] = [{ message: user('x'), model: TEE, outcome: { kind: 'refused' } }, { message: user('y'), model: TEE, outcome: { kind: 'failed' } }];
  assert.equal(hasOtherThread(nothingSent, INCOGNITO, TEE), false);
  assert.equal(hasOtherThread([], TEE, TEE), false);
  assert.equal(hasOtherThread(turns.filter((t) => t.model === TEE), TEE, TEE), false);
});

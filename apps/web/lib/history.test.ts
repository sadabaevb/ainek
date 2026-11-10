import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatHistory } from './history.ts';

const user = (content: string) => ({ role: 'user' as const, content });

test('history carries verified and Incognito replies, never one whose checks failed', () => {
  const history = chatHistory([
    { message: user('a'), outcome: { kind: 'verified', reply: 'A' } },
    { message: user('b'), outcome: { kind: 'failed', reply: 'not checked' } },
    { message: user('c'), outcome: { kind: 'refused' } },
    { message: user('d'), outcome: { kind: 'non-tee', reply: 'D' } },
    { message: user('e') },
  ]);
  assert.deepEqual(history, [user('a'), { role: 'assistant', content: 'A' }, user('d'), { role: 'assistant', content: 'D' }]);
});

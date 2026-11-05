import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChatCompletion } from './chat.ts';

const reply = (message: unknown) => JSON.stringify({ object: 'chat.completion', id: 'c1', choices: [{ message }], usage: { total_tokens: 1 } });

test('parseChatCompletion: a text reply and a tool-call reply pass, with unknown fields kept', () => {
  assert.equal(parseChatCompletion(reply({ role: 'assistant', content: 'hi' })).choices[0]?.message.content, 'hi');
  const calls = parseChatCompletion(reply({ content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'p', arguments: '{}' } }] }));
  assert.equal(calls.choices[0]?.message.tool_calls?.[0]?.function.name, 'p');
  assert.deepEqual((calls as unknown as { usage: unknown }).usage, { total_tokens: 1 });
});

test('parseChatCompletion: an error envelope, an empty answer and a message-less choice are named failures, not a TypeError later', () => {
  assert.throws(() => parseChatCompletion(JSON.stringify({ error: { message: 'boom' } })), /unexpected response shape: object/);
  assert.throws(() => parseChatCompletion(JSON.stringify({ object: 'chat.completion', id: 'x', choices: [] })), /unexpected response shape: choices/);
  assert.throws(() => parseChatCompletion(JSON.stringify({ object: 'chat.completion', id: 'x', choices: [{}] })), /unexpected response shape: choices\.0\.message/);
  assert.throws(() => parseChatCompletion(JSON.stringify({ object: 'chat.completion', choices: [{ message: {} }] })), /unexpected response shape: id/);
});

test('parseChatCompletion: a tool call that is not a named function call fails instead of vanishing', () => {
  assert.throws(() => parseChatCompletion(reply({ tool_calls: [{ id: 'a', function: { name: 'p', arguments: '{}' } }] })), /tool_calls\.0\.type/);
  assert.throws(() => parseChatCompletion(reply({ tool_calls: [{ id: 'a', type: 'custom', custom: { name: 'p', input: '' } }] })), /tool_calls\.0/);
});

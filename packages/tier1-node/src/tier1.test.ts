import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatBody, contractLog, functionCallsOf, observed, replyOf, toolNamesOf, withDeadline, type ChatCompletion, type ChatInput } from './tier1.ts';

const tool = { type: 'function' as const, function: { name: 'pay', parameters: {} } };
const completion = (message: object) => ({ id: 'c', object: 'chat.completion', choices: [{ message }] }) as unknown as ChatCompletion;

test('chatBody: only the listed fields leave this process, whatever the object carries at runtime', () => {
  const chat = { messages: [{ role: 'user', content: 'x' }], tools: [tool], tool_choice: 'required', temperature: 0, response_format: { type: 'json_schema', json_schema: { name: 'secret_schema' } }, metadata: { a: 'b' }, user: 'u', n: 2, stream: true, model: 'other' } as unknown as ChatInput;
  const body = JSON.parse(chatBody('m', chat)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ['messages', 'model', 'stream', 'temperature', 'tool_choice', 'tools']);
  assert.equal(body['model'], 'm');
  assert.equal(body['stream'], false);
  assert.doesNotMatch(chatBody('m', chat), /secret_schema/);
});

test('chatBody: a tool the SDK would forward in the clear, or a nameless one, stops before anything is sent', () => {
  const messages = [{ role: 'user', content: 'x' }];
  assert.throws(() => chatBody('m', { messages, tools: [{ type: 'custom', custom: { name: 'c' } }] } as unknown as ChatInput), /function tools/);
  assert.throws(() => chatBody('m', { messages, tools: [{ type: 'function' }] } as unknown as ChatInput), /function tools/);
  assert.throws(() => chatBody('m', { messages, tool_choice: { type: 'custom', custom: { name: 'c' } } } as unknown as ChatInput), /tool_choice/);
  assert.doesNotThrow(() => chatBody('m', { messages, tool_choice: { type: 'function', function: { name: 'pay' } } } as unknown as ChatInput));
});

test('toolNamesOf, replyOf, functionCallsOf: the parts of a request and a reply the callers read', () => {
  assert.deepEqual(toolNamesOf({ tools: [tool] }), ['pay']);
  assert.deepEqual(toolNamesOf({}), []);
  assert.equal(replyOf(completion({ content: 'hi' })), 'hi');
  assert.equal(replyOf(completion({ content: null })), '');
  assert.deepEqual(functionCallsOf(completion({ tool_calls: [{ id: 'a', type: 'function', function: { name: 'pay', arguments: '{}' } }] })), [{ id: 'a', name: 'pay', arguments: '{}' }]);
  assert.deepEqual(functionCallsOf(completion({ content: 'hi' })), []);
});

test('observed: an observer that throws or rejects cannot change the outcome of a run', async () => {
  let seen = 0;
  const event = { id: 'send', status: 'ok', detail: '', ms: 1 } as const;
  observed(() => void seen++)(event);
  assert.equal(seen, 1);
  assert.doesNotThrow(() => observed(() => { throw new Error('boom'); })(event));
  observed(async () => { throw new Error('boom'); })(event); // an unhandled rejection here would fail this test
  await new Promise((r) => setImmediate(r));
});

test('withDeadline: the result when it comes in time, a named failure when it does not, and no timer left behind', async () => {
  assert.equal(await withDeadline(Promise.resolve(1), 1000, 'attestation'), 1);
  await assert.rejects(withDeadline(new Promise(() => undefined), 1, 'attestation'), /attestation did not finish within/);
  await assert.rejects(withDeadline(Promise.reject(new Error('own failure')), 1000, 'attestation'), /own failure/);
});

test('contractLog: a malformed RPC URL fails the read, not the construction, so it stays a failed step of the run', async () => {
  const read = contractLog({ rpcUrl: 'rpc.testnet.fastnear.com', contract: 'c.testnet', trustedVerifiers: ['v.testnet'] });
  await assert.rejects(read('m', new AbortController().signal));
});

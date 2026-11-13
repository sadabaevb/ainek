import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { prepareE2eeChatRequest } from '@nearai/inference-sdk';
import { chatHistory, hasOtherThread, leftBehind, type HistoryTurn } from './history.ts';
import { chatRequest, type ChatMessage } from './nearai-requests.ts';
import { MAX_BODY_BYTES, MAX_MESSAGES, REASONING_EFFORT, completionProblem } from './relay-guard.ts';

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
  assert.deepEqual(chatHistory(turns, TEE, TEE, 'next'), [user('a'), { role: 'assistant', content: 'A' }]);
});

test('each model sees only its own thread: private turns never go to the Incognito model, nor its replies back', () => {
  assert.deepEqual(chatHistory(turns, INCOGNITO, TEE, 'next'), [user('d'), { role: 'assistant', content: 'D' }]);
  assert.equal(hasOtherThread(turns, TEE, TEE), true);
  assert.equal(hasOtherThread(turns, INCOGNITO, TEE), true);
});

test('a turn the Incognito model happened to get encrypted is not repeated to it in plaintext', () => {
  const attestedOnce: HistoryTurn[] = [{ message: user('secret'), model: INCOGNITO, outcome: { kind: 'verified', reply: 'S' } }];
  assert.deepEqual(chatHistory(attestedOnce, INCOGNITO, TEE, 'next'), []);
  assert.equal(hasOtherThread(attestedOnce, INCOGNITO, TEE), true);
});

test('the note about another thread appears only for an answered exchange that is left out', () => {
  const nothingSent: HistoryTurn[] = [{ message: user('x'), model: TEE, outcome: { kind: 'refused' } }, { message: user('y'), model: TEE, outcome: { kind: 'failed' } }];
  assert.equal(hasOtherThread(nothingSent, INCOGNITO, TEE), false);
  assert.equal(hasOtherThread([], TEE, TEE), false);
  assert.equal(hasOtherThread(turns.filter((t) => t.model === TEE), TEE, TEE), false);
});

// ---- a thread longer than one request ----
/** The model's public key from the recorded log entry, to let the SDK encrypt. */
const MODEL_KEY: string = (JSON.parse(readFileSync(new URL('../../../docs/samples/key-entry.sample.json', import.meta.url), 'utf8')) as { entry: { signing_public_key: string } }).entry.signing_public_key;
const BASE = 'http://relay.test/api/nearai/v1';
const threadOf = (n: number, question: (i: number) => string, reply: (i: number) => string, model = TEE): HistoryTurn[] =>
  Array.from({ length: n }, (_, i) => ({ message: user(question(i)), model, outcome: { kind: model === TEE ? 'verified' as const : 'non-tee' as const, reply: reply(i) } }));
/** The request the page would send for `next` after `thread`, as the relay receives it: encrypted for the private model, plain for the other. */
async function requestFor(thread: HistoryTurn[], next: string, model = TEE): Promise<{ body: ArrayBuffer; headers: Headers; messages: ChatMessage[] }> {
  const messages = [...chatHistory(thread, model, TEE, next), user(next)];
  const request = model === TEE
    ? (await prepareE2eeChatRequest({ request: chatRequest(BASE, model, messages, REASONING_EFFORT), modelKey: { signingAlgo: 'ed25519', publicKey: MODEL_KEY } })).request
    : chatRequest(BASE, model, messages);
  return { body: await request.arrayBuffer(), headers: request.headers, messages };
}

test('a long thread of short exchanges: the latest that fit the relay\'s count of messages go, the earliest are left behind', async () => {
  const thread = threadOf(30, (i) => `q${i}`, (i) => `a${i}`);
  const { body, headers, messages } = await requestFor(thread, 'next');
  assert.equal(messages.length, MAX_MESSAGES - 1);
  assert.deepEqual(messages.slice(0, 2), [user('q6'), { role: 'assistant', content: 'a6' }]);
  assert.deepEqual(messages.at(-2), { role: 'assistant', content: 'a29' });
  assert.equal(leftBehind(thread, TEE, TEE, 'next'), 6);
  assert.equal(completionProblem(body, new Set([TEE]), headers, TEE), null);
  // A thread that fits is sent whole and nothing is said.
  assert.equal(leftBehind(thread.slice(0, 24), TEE, TEE, 'next'), 0);
  assert.equal(chatHistory(thread.slice(0, 24), TEE, TEE, 'next').length, 48);
});

test('a few long answers: the encrypted request stays within the relay\'s body limit, and uses most of it', async () => {
  for (const [name, reply] of [['latin', 'The model explains at length. '.repeat(120)], ['cyrillic', 'Модель отвечает подробно. '.repeat(120)], ['emoji', '😀'.repeat(900)]] as const) {
    const thread = threadOf(20, (i) => `Question ${i}?`, () => reply);
    const { body, messages } = await requestFor(thread, 'And one more question.');
    const behind = leftBehind(thread, TEE, TEE, 'And one more question.');
    assert.ok(body.byteLength <= MAX_BODY_BYTES, `${name}: ${body.byteLength} bytes`);
    assert.ok(behind > 0 && messages.length > 1, `${name}: ${behind} left behind, ${messages.length} messages sent`);
    // The bound is not a loose one: what was left behind would not have fitted.
    assert.ok(body.byteLength > MAX_BODY_BYTES * 0.8, `${name}: only ${body.byteLength} bytes used`);
    assert.equal(messages.length, 2 * (20 - behind) + 1);
  }
});

test('the longest message the composer takes goes out even when nothing of the thread fits beside it', async () => {
  // 4000 UTF-16 units of the widest characters: emoji, four bytes for every two units.
  const next = '😀'.repeat(2000);
  const thread = threadOf(6, () => 'я'.repeat(4000), () => 'я'.repeat(6000));
  const { body, messages } = await requestFor(thread, next);
  assert.ok(body.byteLength <= MAX_BODY_BYTES, `${body.byteLength} bytes`);
  assert.equal(messages.at(-1)?.content, next);
  assert.equal(leftBehind(thread, TEE, TEE, next) + (messages.length - 1) / 2, 6);
});

test('on the plaintext route the bound holds too, with the characters JSON writes longest', async () => {
  const thread = threadOf(20, (i) => `Question ${i}?`, () => '\u0001"\\\n'.repeat(800), INCOGNITO);
  const { body, messages } = await requestFor(thread, 'next', INCOGNITO);
  assert.ok(body.byteLength <= MAX_BODY_BYTES, `${body.byteLength} bytes`);
  assert.ok(messages.length > 1 && leftBehind(thread, INCOGNITO, TEE, 'next') > 0);
});

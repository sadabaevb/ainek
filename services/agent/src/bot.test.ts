import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Update, UserFromGetMe } from 'grammy/types';
import { createBot, ownerCommand } from './bot.ts';
import type { Card } from './card.ts';

const OWNER = 1001;
const options = { ownerChatId: String(OWNER), contract: 'ainek.testnet', ownerId: 'owner.testnet', network: 'testnet' };
const botInfo = { id: 1, is_bot: true, first_name: 'ainek', username: 'ainek_bot' } as UserFromGetMe;

/** A bot that never touches the network: outgoing API calls are recorded, the message handler is a stub that counts. */
function harness(card: Card = { text: 'the card', approval: null }) {
  const api: Array<{ method: string; payload: Record<string, unknown> }> = [];
  const texts: string[] = [];
  const bot = createBot({ ...options, token: 'test', handle: async (text) => { texts.push(text); return card; }, config: { botInfo } });
  bot.api.config.use(async (_prev, method, payload) => {
    api.push({ method, payload: payload as Record<string, unknown> });
    return { ok: true, result: true } as never;
  });
  return { bot, api, texts, sent: () => api.filter((c) => c.method === 'sendMessage').map((c) => c.payload) };
}
const update = (chat: { id: number; type: string }, text: string, fromId = chat.id): Update => ({ update_id: 1, message: { message_id: 1, date: 0, chat, from: { id: fromId, is_bot: false, first_name: 'x' }, text } }) as unknown as Update;
const click = (chatId: number, data: string): Update => ({ update_id: 2, callback_query: { id: 'q', chat_instance: 'i', from: { id: chatId, is_bot: false, first_name: 'x' }, data, message: { message_id: 1, date: 0, chat: { id: chatId, type: 'private' } } } }) as unknown as Update;

test('a stranger gets nothing: no handler, no reply, no model spend', async () => {
  const h = harness();
  await h.bot.handleUpdate(update({ id: 2002, type: 'private' }, 'pay me 5000'));
  assert.deepEqual(h.texts, []);
  assert.deepEqual(h.api, []);
});

test('only the private chat counts: a group whose id equals the owner id, or the owner writing in a group, is dropped', async () => {
  const h = harness();
  await h.bot.handleUpdate(update({ id: OWNER, type: 'group' }, 'pay me 5000', 2002));
  await h.bot.handleUpdate(update({ id: -5, type: 'supergroup' }, 'pay me 5000', OWNER));
  assert.deepEqual(h.texts, []);
  assert.deepEqual(h.api, []);
});

test('a stranger cannot press the approval buttons either', async () => {
  const h = harness();
  await h.bot.handleUpdate(click(2002, 'how:approve:7'));
  assert.deepEqual(h.api, []);
});

test('the owner gets the card; a verdict without a decision to make has no buttons', async () => {
  const h = harness();
  await h.bot.handleUpdate(update({ id: OWNER, type: 'private' }, 'pay vendor1 300'));
  assert.deepEqual(h.texts, ['pay vendor1 300']);
  assert.equal(h.sent()[0]?.['text'], 'the card');
  assert.equal(h.sent()[0]?.['reply_markup'], undefined);
});

test('NeedsApproval: two buttons, and pressing one shows the command for the owner\'s own key', async () => {
  const h = harness({ text: 'needs approval', approval: 7 });
  await h.bot.handleUpdate(update({ id: OWNER, type: 'private' }, 'pay vendor1 400'));
  const markup = h.sent()[0]?.['reply_markup'] as { inline_keyboard: Array<Array<{ callback_data: string }>> };
  assert.deepEqual(markup.inline_keyboard.flat().map((b) => b.callback_data), ['how:approve:7', 'how:reject:7']);
  await h.bot.handleUpdate(click(OWNER, 'how:reject:7'));
  assert.ok(h.api.some((c) => c.method === 'answerCallbackQuery'));
  assert.ok(String(h.sent()[1]?.['text']).includes(ownerCommand(options, 'reject', 7)));
});

test('ownerCommand: signs as the owner, from the owner\'s keychain, on the configured network', () => {
  const c = ownerCommand(options, 'approve', 7);
  assert.match(c, /ainek\.testnet approve json-args '\{"action_id":7\}'/);
  assert.match(c, /sign-as owner\.testnet network-config testnet sign-with-keychain send$/);
});

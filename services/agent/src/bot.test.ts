import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Update, UserFromGetMe } from 'grammy/types';
import { createBot, ownerCommand, startBot, viewCommand } from './bot.ts';
import type { Card } from './card.ts';

const OWNER = 1001;
const options = { ownerChatId: String(OWNER), contract: 'ainek.testnet', ownerId: 'owner.testnet', network: 'testnet' };
const botInfo = { id: 1, is_bot: true, first_name: 'ainek', username: 'ainek_bot' } as UserFromGetMe;

/** A bot that never touches the network: outgoing API calls are recorded, the message handler is a stub that counts. */
function harness(card: Card = { text: 'the card', approval: null }) {
  const api: Array<{ method: string; payload: Record<string, unknown> }> = [];
  const texts: string[] = [];
  const bot = createBot({ ...options, token: 'test', handle: async (text) => { texts.push(text); return card; } });
  bot.botInfo = botInfo;
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

test('the card is delivered first, and only then does the service forget the unfinished payment', async () => {
  const order: string[] = [];
  const h = harness({ text: 'the card', approval: null, delivered: async () => void order.push(`delivered after ${h.sent().length} message`) });
  await h.bot.handleUpdate(update({ id: OWNER, type: 'private' }, 'pay vendor1 300'));
  assert.deepEqual(order, ['delivered after 1 message']);
});

test('NeedsApproval: two buttons, and pressing one shows the command for the owner\'s own key', async () => {
  const h = harness({ text: 'needs approval', approval: 7 });
  await h.bot.handleUpdate(update({ id: OWNER, type: 'private' }, 'pay vendor1 400'));
  const markup = h.sent()[0]?.['reply_markup'] as { inline_keyboard: Array<Array<{ callback_data: string }>> };
  assert.deepEqual(markup.inline_keyboard.flat().map((b) => b.callback_data), ['how:approve:7', 'how:reject:7']);
  await h.bot.handleUpdate(click(OWNER, 'how:reject:7'));
  assert.ok(h.api.some((c) => c.method === 'answerCallbackQuery'));
  const reply = String(h.sent()[1]?.['text']);
  assert.ok(reply.includes(ownerCommand(options, 'reject', 7)));
  assert.ok(reply.indexOf(viewCommand(options, 7)) < reply.indexOf(ownerCommand(options, 'reject', 7)), 'the owner reads the action before signing');
});

test('ownerCommand: signs as the owner, from the owner\'s keychain, on the configured network', () => {
  const c = ownerCommand(options, 'approve', 7);
  assert.match(c, /ainek\.testnet approve json-args '\{"action_id":7\}'/);
  assert.match(c, /sign-as owner\.testnet network-config testnet sign-with-keychain send$/);
});

test('viewCommand: reads the action from the contract, no key involved', () => {
  assert.equal(viewCommand(options, 7), `near contract call-function as-read-only ainek.testnet action json-args '{"action_id":7}' network-config testnet now`);
});

test('a card too long for Telegram is cut, so the reply cannot fail after the money moved', async () => {
  const h = harness({ text: 'x'.repeat(5000), approval: null });
  await h.bot.handleUpdate(update({ id: OWNER, type: 'private' }, 'pay'));
  assert.equal(String(h.sent()[0]?.['text']).length, 4000);
});

test('startBot drops pending updates, so a message redelivered after a crash cannot pay a second time', async () => {
  const h = harness();
  const calls: Array<{ method: string; payload: unknown }> = [];
  h.bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload });
    if (method === 'getUpdates') void h.bot.stop();
    return { ok: true, result: method === 'getUpdates' ? [] : true } as never;
  });
  await startBot(h.bot);
  const deleted = calls.find((c) => c.method === 'deleteWebhook');
  assert.deepEqual(deleted?.payload, { drop_pending_updates: true });
});

test('a cosmetic call that fails does not stop the message or the command, and a failed send is retried', async () => {
  let failed = false;
  const h = harness({ text: 'the card', approval: 7 });
  h.bot.api.config.use(async (prev, method, payload) => {
    if (method === 'sendChatAction' || method === 'answerCallbackQuery') throw new Error('query is too old');
    if (method === 'sendMessage' && !failed) {
      failed = true;
      throw new Error('429');
    }
    return prev(method, payload);
  });
  await h.bot.handleUpdate(update({ id: OWNER, type: 'private' }, 'pay'));
  assert.deepEqual(h.texts, ['pay']);
  assert.equal(h.sent()[0]?.['text'], 'the card');
  await h.bot.handleUpdate(click(OWNER, 'how:approve:7'));
  assert.ok(String(h.sent()[1]?.['text']).includes(ownerCommand(options, 'approve', 7)));
});

test('ownerCommand: attaches the 1 yoctoNEAR the contract needs, so only a full-access key can approve or reject', () => {
  const target = { contract: 'c.testnet', ownerId: 'o.testnet', network: 'testnet' };
  for (const method of ['approve', 'reject'] as const) assert.match(ownerCommand(target, method, 7), /attached-deposit '1 yoctoNEAR'/);
});

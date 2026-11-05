// The Telegram side (grammY). One owner: every update from anyone else, or from any chat that is not the owner's private chat,
// is dropped before any handler runs, so no stranger can spend the model budget or see a card. Text a stranger wrote reaches
// the agent only when the owner forwards it, which is the prompt-injection scene of the demo. grammY's long polling handles
// updates one at a time, so two messages can never read the same `spent_today`. The owner's text is never logged.
import { Bot, InlineKeyboard, type BotConfig, type Context } from 'grammy';
import type { Card } from './card.ts';

export interface BotOptions {
  token: string;
  ownerChatId: string;
  contract: string;
  ownerId: string;
  network: string;
  handle: (text: string) => Promise<Card>;
  /** Tests only: a bot that never calls getMe. */
  config?: BotConfig<Context>;
}

/** The agent cannot approve anything (SPEC §7.2): the buttons only tell the owner what to run with their own key. */
export function ownerCommand(o: Pick<BotOptions, 'contract' | 'ownerId' | 'network'>, method: 'approve' | 'reject', actionId: number): string {
  return `near contract call-function as-transaction ${o.contract} ${method} json-args '{"action_id":${actionId}}' prepaid-gas '100 Tgas' attached-deposit '0 NEAR' sign-as ${o.ownerId} network-config ${o.network} sign-with-keychain send`;
}

export function createBot(o: BotOptions): Bot {
  const bot = new Bot(o.token, o.config);
  bot.use(async (ctx, next) => {
    if (ctx.chat?.type === 'private' && String(ctx.chat.id) === o.ownerChatId) await next();
  });
  bot.command('start', (ctx) => ctx.reply('Tell me whom to pay, how much and what for. The policy decides, the contract checks the decision, and you get a card with the proof.'));
  bot.on('message:text', async (ctx) => {
    await ctx.replyWithChatAction('typing');
    const card = await o.handle(ctx.message.text);
    if (card.approval === null) await ctx.reply(card.text);
    else await ctx.reply(card.text, { reply_markup: new InlineKeyboard().text('How to approve', `how:approve:${card.approval}`).text('How to reject', `how:reject:${card.approval}`) });
  });
  bot.callbackQuery(/^how:(approve|reject):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const [, method, id] = ctx.match;
    await ctx.reply(`Run this with your own key; the agent cannot do it for you:\n\n${ownerCommand(o, method as 'approve' | 'reject', Number(id))}`);
  });
  bot.catch(async ({ ctx, error }) => {
    console.error(`update ${ctx.update.update_id} failed: ${error instanceof Error ? error.message : String(error)}`);
    await ctx.reply('Something failed on the agent side. Nothing further was attempted; check the service log.').catch(() => undefined);
  });
  return bot;
}

// The Telegram side (grammY). One owner: every update from anyone else, or from any chat that is not the owner's private chat,
// is dropped before any handler runs, so no stranger can spend the model budget or see a card. Text a stranger wrote reaches
// the agent only when the owner forwards it, which is the prompt-injection scene of the demo. grammY's long polling handles
// updates one at a time, so two messages can never read the same `spent_today`. The owner's text is never logged.
import { Bot, InlineKeyboard } from 'grammy';
import { withRetry } from '@ainek/proof';
import type { Card } from './card.ts';
import { errorText } from './errors.ts';

const TELEGRAM_LIMIT = 4000; // below Telegram's 4096: a card too long to send must not become an error after the money moved
const SEND_RETRY_PAUSE_MS = 500;

export interface BotOptions {
  token: string;
  ownerChatId: string;
  contract: string;
  ownerId: string;
  network: string;
  handle: (text: string) => Promise<Card>;
}

type CommandTarget = Pick<BotOptions, 'contract' | 'ownerId' | 'network'>;

/** The agent cannot approve anything (SPEC §7.2): the buttons only tell the owner what to run with their own key. The 1 yoctoNEAR is what makes the contract insist on a full-access key. */
export function ownerCommand(o: CommandTarget, method: 'approve' | 'reject', actionId: number): string {
  return `near contract call-function as-transaction ${o.contract} ${method} json-args '{"action_id":${actionId}}' prepaid-gas '100 Tgas' attached-deposit '1 yoctoNEAR' sign-as ${o.ownerId} network-config ${o.network} sign-with-keychain send`;
}

/** The card comes from the agent and `approve` binds only an id, so the owner reads what the contract holds before signing. */
export function viewCommand(o: CommandTarget, actionId: number): string {
  return `near contract call-function as-read-only ${o.contract} action json-args '{"action_id":${actionId}}' network-config ${o.network} now`;
}

export function createBot(o: BotOptions): Bot {
  const bot = new Bot(o.token);
  bot.use(async (ctx, next) => {
    if (ctx.chat?.type === 'private' && String(ctx.chat.id) === o.ownerChatId) await next();
  });
  bot.command('start', (ctx) => ctx.reply('Tell me whom to pay, how much and what for. The policy decides, the contract checks the decision, and you get a card with the proof. Messages sent while I am down are dropped on purpose. If I stopped in the middle of a payment, I tell you when I am back: check the explorer before you send it again.'));
  bot.on('message:text', async (ctx) => {
    await ctx.replyWithChatAction('typing').catch(() => undefined); // cosmetic: it must not stop the message
    const card = await o.handle(ctx.message.text);
    const text = card.text.slice(0, TELEGRAM_LIMIT);
    const options = card.approval === null ? {} : { reply_markup: new InlineKeyboard().text('How to approve', `how:approve:${card.approval}`).text('How to reject', `how:reject:${card.approval}`) };
    // The money may have moved by now, and this card may hold the only approval buttons: a Telegram hiccup is retried.
    await withRetry(() => ctx.reply(text, options), { retryable: () => true, attempts: 3, pauseMs: SEND_RETRY_PAUSE_MS });
    await card.delivered?.().catch((err: unknown) => console.error(`after the card: ${errorText(err)}`)); // the owner has it; the worst left is a warning at the next start
  });
  bot.callbackQuery(/^how:(approve|reject):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => undefined); // updates run one at a time, so a late answer is rejected as "query is too old": the command still has to go out
    const [, method, id] = ctx.match;
    await ctx.reply(`First read what the contract holds for this action:\n\n${viewCommand(o, Number(id))}\n\nThen run this with your own key; the agent cannot do it for you:\n\n${ownerCommand(o, method as 'approve' | 'reject', Number(id))}`);
  });
  bot.catch(async ({ ctx, error }) => {
    console.error(`update ${ctx.update.update_id} failed: ${errorText(error)}`);
    await ctx.reply('Something failed while answering. A payment may have gone through: check the account on the explorer and the service log before you retry.').catch(() => undefined);
  });
  return bot;
}

/**
 * grammY confirms an update only on the next getUpdates, so a crash while handling a message would redeliver it after the restart, and a
 * fresh decision with a fresh nonce would pay a second time. Pending updates are dropped at start: a message lost in a crash is resent by the
 * owner, a transfer sent twice is not recoverable.
 */
export function startBot(bot: Bot): Promise<void> {
  return bot.start({ drop_pending_updates: true });
}

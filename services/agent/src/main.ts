// `pnpm -F agent start`: the Telegram bot. `pnpm -F agent once "<text>"`: one message without Telegram, printed to the terminal.
// Every message pays a fresh attestation on purpose (@ainek/tier1-node caches nothing): this path moves money, and some
// seconds are cheap against acting on an hour-old verification (docs/DECISIONS.md).
import { parseArgs } from 'node:util';
import { contractLog } from '@ainek/tier1-node';
import { createBot, startBot } from './bot.ts';
import { renderCard } from './card.ts';
import { nearActionChain } from './chain.ts';
import { loadConfig } from './config.ts';
import { extractAction } from './llm.ts';
import { handleOwnerText, type Deps } from './pipeline.ts';
import { outLayerPolicy, outLayerRunCheck } from './policy.ts';
import { fileKeeper } from './store.ts';
import { fromMinimalUnits } from './units.ts';

const { values: flags, positionals } = parseArgs({ options: { once: { type: 'boolean', default: false } }, allowPositionals: true, strict: true });
const cfg = loadConfig();
const readLog = contractLog(cfg);
const chain = nearActionChain(cfg);
await chain.assertKeyScope();
const tokenDecimals = await chain.tokenDecimals();
const keep = fileKeeper(cfg.dataDir);
const cardCfg = { explorer: cfg.explorer, tokenDecimals };
const deps: Deps = {
  extract: (text) => extractAction({ cfg, tokenDecimals, readLog, text }),
  policy: outLayerPolicy(cfg.outlayer),
  chain,
  keep,
  wasmHash: cfg.outlayer.wasmHash,
  checkRun: outLayerRunCheck({ apiUrl: cfg.outlayer.apiUrl, project: cfg.outlayer.project, wasmHash: cfg.outlayer.wasmHash, rpcUrl: cfg.rpcUrl, network: cfg.network }),
};
/** Anything a crash left between the intent and the action proof: a transaction may have landed that nobody recorded, and a resend would pay twice. Each is reported once. */
async function reportUnsettled(say: (text: string) => Promise<unknown>): Promise<void> {
  for (const intent of await keep.unsettled()) {
    await say(`⚠ I stopped in the middle of a payment on ${intent.at}: ${fromMinimalUnits(intent.action.amount, tokenDecimals)} ${intent.action.token_id} to ${intent.action.receiver_id}, policy verdict ${intent.decision.verdict}. It may have gone through. Check ${cfg.agentId} on the explorer (${cfg.explorer}) before you send it again.`);
    await keep.settled(intent.modelProofCommit);
  }
}

/** One message end to end, logged without its text: action ids and transactions are public anyway. */
async function handle(text: string) {
  const result = await handleOwnerText(deps, text);
  console.log(result.kind === 'proposed' ? `proposed: action #${result.proof.actionId}, ${result.proof.decision.verdict}, tx ${result.proof.proposeTx}` : result.kind === 'failed' ? `failed at ${result.stage}: ${result.reason}` : result.kind);
  return result;
}

if (flags.once) {
  const text = positionals.join(' ');
  if (!text) throw new Error('usage: pnpm -F agent once "<what the owner writes>"');
  await reportUnsettled(async (warning) => console.log(warning));
  const result = await handle(text);
  console.log(renderCard(result, cardCfg).text);
  if (result.kind === 'proposed' || result.kind === 'failed') await result.settle?.();
  process.exitCode = result.kind === 'proposed' || result.kind === 'declined' ? 0 : 1;
} else {
  if (!cfg.telegram) throw new Error('TELEGRAM_BOT_TOKEN and TELEGRAM_OWNER_CHAT_ID are required for the bot; see .env.example');
  const bot = createBot({ token: cfg.telegram.token, ownerChatId: cfg.telegram.ownerChatId, contract: cfg.contract, ownerId: cfg.ownerId, network: cfg.network, handle: async (text) => {
      const result = await handle(text);
      return { ...renderCard(result, cardCfg), ...(result.kind === 'proposed' || result.kind === 'failed' ? { delivered: result.settle } : {}) };
    } });
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
    stopping = true; // bot.stop() does nothing before bot.start(): a signal during the warnings must still end the service
    void bot.stop();
  });
  console.log(`Ainek agent: ${cfg.agentId} for ${cfg.ownerId}, contract ${cfg.contract} on ${cfg.network}, model ${cfg.model}`);
  const { ownerChatId } = cfg.telegram;
  await reportUnsettled((warning) => bot.api.sendMessage(ownerChatId, warning));
  if (!stopping) await startBot(bot);
}

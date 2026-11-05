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
import { outLayerPolicy } from './policy.ts';
import { fileKeeper } from './store.ts';

const { values: flags, positionals } = parseArgs({ options: { once: { type: 'boolean', default: false } }, allowPositionals: true, strict: true });
const cfg = loadConfig();
const readLog = contractLog(cfg);
const chain = nearActionChain(cfg);
await chain.assertKeyScope();
const deps: Deps = {
  extract: (text) => extractAction({ cfg, readLog, text }),
  policy: outLayerPolicy(cfg.outlayer),
  chain,
  keep: fileKeeper(cfg.dataDir),
  teePubkey: cfg.outlayer.teePubkey,
  wasmHash: cfg.outlayer.wasmHash,
};
/** One message end to end, logged without its text: action ids and transactions are public anyway. */
async function handle(text: string) {
  const result = await handleOwnerText(deps, text);
  console.log(result.kind === 'proposed' ? `proposed: action #${result.proof.actionId}, ${result.proof.decision.verdict}, tx ${result.proof.proposeTx}` : result.kind === 'failed' ? `failed at ${result.stage}` : result.kind);
  return result;
}

if (flags.once) {
  const text = positionals.join(' ');
  if (!text) throw new Error('usage: pnpm -F agent once "<what the owner writes>"');
  const result = await handle(text);
  console.log(renderCard(result, cfg).text);
  process.exitCode = result.kind === 'proposed' || result.kind === 'declined' ? 0 : 1;
} else {
  if (!cfg.telegram) throw new Error('TELEGRAM_BOT_TOKEN and TELEGRAM_OWNER_CHAT_ID are required for the bot; see .env.example');
  const bot = createBot({ token: cfg.telegram.token, ownerChatId: cfg.telegram.ownerChatId, contract: cfg.contract, ownerId: cfg.ownerId, network: cfg.network, handle: async (text) => renderCard(await handle(text), cfg) });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void bot.stop());
  console.log(`Ainek agent: ${cfg.agentId} for ${cfg.ownerId}, contract ${cfg.contract} on ${cfg.network}, model ${cfg.model}`);
  await startBot(bot);
}

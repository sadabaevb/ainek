// Agent configuration: the shared Ainek settings plus the AGENT_*, OUTLAYER_*, POLICY_* and TELEGRAM_* variables from
// .env.example. Everything comes from the environment (root .env; variables already set in the shell win), like the verifier.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ainekConfigFromEnv, isHex64, type AinekConfig } from '@ainek/proof';

export interface AgentConfig extends AinekConfig {
  apiKey: string;
  agentId: string;
  /** `ed25519:<base58>`: the function-call key scoped to propose_action and commit_proof. Never logged. */
  agentKey: string;
  ownerId: string;
  tokenId: string;
  outlayer: { apiUrl: string; paymentKey: string; project: string; secretsProfile: string; wasmHash: string };
  /** Where proofs and their salts are kept, one file per proof. */
  dataDir: string;
  /** Absent for `--once` runs without a bot. */
  telegram: { token: string; ownerChatId: string } | null;
}

const OWNER_ONLY = new Set(['OWNER_PRIVATE_KEY', 'AGENT_ADMIN_PRIVATE_KEY']);

export function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required; see .env.example`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const repoRoot = path.resolve(import.meta.dirname, '../../..');
  const envFile = path.join(repoRoot, '.env');
  if (env === process.env && existsSync(envFile)) process.loadEnvFile(envFile);
  const need = (name: string): string => requireEnv(env, name);
  // The agent must not be able to approve its own actions or undo its own stop button (SPEC §7.2): those keys live in .env.owner on the owner's machine.
  // This catches a mistake; the guarantee is that they are not on the box. The scope of the agent's own key is checked on-chain at start (chain.ts).
  for (const name of OWNER_ONLY) if (env[name]) throw new Error(`${name} is set in the agent's environment: the agent must never hold an owner key. Move it to .env.owner on the owner's machine`);
  for (const name of Object.keys(env)) if (name.endsWith('PRIVATE_KEY') && name !== 'AGENT_FC_PRIVATE_KEY' && !OWNER_ONLY.has(name) && env[name]) console.warn(`warning: ${name} is in the agent's environment; on a server give the agent its own env (docs/DEPLOY.md)`);
  const shared = ainekConfigFromEnv(env);
  if (shared.logSource !== 'contract') throw new Error(`AINEK_LOG_SOURCE=${shared.logSource}: the agent trusts only the contract log`);
  const agentKey = need('AGENT_FC_PRIVATE_KEY');
  if (!agentKey.startsWith('ed25519:') || agentKey.length < 20) throw new Error('AGENT_FC_PRIVATE_KEY must be ed25519:… (the function-call key of the agent account)');
  const wasmHash = need('OUTLAYER_WASM_HASH');
  if (!isHex64(wasmHash)) throw new Error('OUTLAYER_WASM_HASH must be 64 lowercase hex chars (docs/DEPLOY.md)');
  const token = env['TELEGRAM_BOT_TOKEN'];
  const ownerChatId = env['TELEGRAM_OWNER_CHAT_ID'];
  return {
    ...shared,
    apiKey: need('NEARAI_API_KEY'),
    agentId: need('AGENT_ACCOUNT_ID'),
    agentKey,
    ownerId: need('OWNER_ACCOUNT_ID'),
    tokenId: need('AINEK_TOKEN'),
    outlayer: { apiUrl: (env['OUTLAYER_API_URL'] ?? 'https://testnet-api.outlayer.ai').replace(/\/$/, ''), paymentKey: need('OUTLAYER_PAYMENT_KEY'), project: need('OUTLAYER_PROJECT'), secretsProfile: env['OUTLAYER_SECRETS_PROFILE'] ?? 'default', wasmHash },
    dataDir: env['AGENT_DATA_DIR'] ?? path.resolve(import.meta.dirname, '../data/proofs'),
    telegram: token && ownerChatId ? { token, ownerChatId } : null,
  };
}

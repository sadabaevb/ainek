// Agent configuration: the shared Ainek settings plus the AGENT_*, OUTLAYER_*, POLICY_* and TELEGRAM_* variables from
// .env.example. Everything comes from the environment (root .env; variables already set in the shell win), like the verifier.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ainekConfigFromEnv, type AinekConfig } from '@ainek/proof';

export interface AgentConfig extends AinekConfig {
  apiKey: string;
  agentId: string;
  /** `ed25519:<base58>`: the function-call key scoped to propose_action and commit_proof. Never logged. */
  agentKey: string;
  ownerId: string;
  tokenId: string;
  /** Decimals of the demo token: the owner writes "300", the chain wants minimal units. */
  tokenDecimals: number;
  outlayer: { apiUrl: string; paymentKey: string; project: string; wasmHash: string; teePubkey: string };
  /** Where proofs and their salts are kept, one file per proof. */
  dataDir: string;
  /** Absent for `--once` runs without a bot. */
  telegram: { token: string; ownerChatId: string } | null;
}

const HEX64 = /^[0-9a-f]{64}$/;
export const OWNER_ONLY = ['OWNER_PRIVATE_KEY', 'AGENT_ADMIN_PRIVATE_KEY'] as const;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const repoRoot = path.resolve(import.meta.dirname, '../../..');
  const envFile = path.join(repoRoot, '.env');
  if (env === process.env && existsSync(envFile)) process.loadEnvFile(envFile);
  const need = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`${name} is required; see .env.example`);
    return value;
  };
  // The agent must not be able to approve its own actions or undo its own stop button (SPEC §7.2): those keys live in .env.owner on the owner's machine.
  for (const name of OWNER_ONLY) if (env[name]) throw new Error(`${name} is set in the agent's environment: the agent must never hold an owner key. Move it to .env.owner on the owner's machine`);
  const shared = ainekConfigFromEnv(env);
  if (shared.logSource !== 'contract') throw new Error(`AINEK_LOG_SOURCE=${shared.logSource}: the agent trusts only the contract log`);
  const agentKey = need('AGENT_FC_PRIVATE_KEY');
  if (!agentKey.startsWith('ed25519:') || agentKey.length < 20) throw new Error('AGENT_FC_PRIVATE_KEY must be ed25519:… (the function-call key of the agent account)');
  const wasmHash = need('OUTLAYER_WASM_HASH');
  const teePubkey = need('POLICY_TEE_PUBKEY');
  if (!HEX64.test(wasmHash) || !HEX64.test(teePubkey)) throw new Error('OUTLAYER_WASM_HASH and POLICY_TEE_PUBKEY must be 64 lowercase hex chars (docs/DEPLOY.md, once the policy job is deployed)');
  const tokenDecimals = Number(env['AGENT_TOKEN_DECIMALS'] ?? '6');
  if (!Number.isInteger(tokenDecimals) || tokenDecimals < 0 || tokenDecimals > 24) throw new Error(`AGENT_TOKEN_DECIMALS must be an integer 0–24, got ${String(env['AGENT_TOKEN_DECIMALS'])}`);
  const token = env['TELEGRAM_BOT_TOKEN'];
  const ownerChatId = env['TELEGRAM_OWNER_CHAT_ID'];
  return {
    ...shared,
    apiKey: need('NEARAI_API_KEY'),
    agentId: need('AGENT_ACCOUNT_ID'),
    agentKey,
    ownerId: need('OWNER_ACCOUNT_ID'),
    tokenId: need('AINEK_TOKEN'),
    tokenDecimals,
    outlayer: { apiUrl: (env['OUTLAYER_API_URL'] ?? 'https://testnet-api.outlayer.ai').replace(/\/$/, ''), paymentKey: need('OUTLAYER_PAYMENT_KEY'), project: need('OUTLAYER_PROJECT'), wasmHash, teePubkey },
    dataDir: env['AGENT_DATA_DIR'] ?? path.resolve(import.meta.dirname, '../data/proofs'),
    telegram: token && ownerChatId ? { token, ownerChatId } : null,
  };
}

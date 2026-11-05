// `pnpm demo:stop`, run by the owner. The keys come from .env.owner, which the agent service never reads (config.ts refuses to
// start if they are in its environment): AGENT_ADMIN_PRIVATE_KEY is a full-access key of the agent account (a function-call key
// cannot delete keys), OWNER_PRIVATE_KEY is the contract owner's (pause_agent is owner-only, SPEC §4.3).
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Account, JsonRpcProvider, KeyPairSigner, PublicKey, actions, teraToGas, type KeyPairString } from 'near-api-js';
import { ainekConfigFromEnv, explorerTxUrl } from '@ainek/proof';
import { requireEnv } from './config.ts';
import { stopAgent, type StepResult } from './stop.ts';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
for (const file of ['.env', '.env.owner']) if (existsSync(path.join(repoRoot, file))) process.loadEnvFile(path.join(repoRoot, file));
const need = (name: string): string => requireEnv(process.env, name);
const cfg = ainekConfigFromEnv(process.env);
const provider = new JsonRpcProvider({ url: cfg.rpcUrl });
const agentId = need('AGENT_ACCOUNT_ID');
const fcKey = need('AGENT_FC_PUBLIC_KEY');
const agentAdmin = new Account(agentId, provider, KeyPairSigner.fromSecretKey(need('AGENT_ADMIN_PRIVATE_KEY') as KeyPairString));
const owner = new Account(need('OWNER_ACCOUNT_ID'), provider, KeyPairSigner.fromSecretKey(need('OWNER_PRIVATE_KEY') as KeyPairString));

const report = await stopAgent({
  deleteKey: async () => (await agentAdmin.signAndSendTransaction({ receiverId: agentId, actions: [actions.deleteKey(PublicKey.fromString(fcKey))] })).transaction.hash,
  pause: async () => (await owner.signAndSendTransaction({ receiverId: cfg.contract, actions: [actions.functionCall('pause_agent', { agent_id: agentId }, teraToGas(30), 0n)] })).transaction.hash,
});
const line = (label: string, r: StepResult) => console.log(r.ok ? `✓ ${label}: ${explorerTxUrl(cfg.explorer, r.tx)}` : `✗ ${label}: ${r.error}`);
line(`DeleteKey ${fcKey} on ${agentId}`, report.deleteKey);
line(`pause_agent(${agentId}) on ${cfg.contract}`, report.pause);
process.exitCode = report.deleteKey.ok && report.pause.ok ? 0 : 1;

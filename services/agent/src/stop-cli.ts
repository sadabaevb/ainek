// `pnpm demo:stop`, run by the owner. The keys come from .env.owner, which the agent service never reads (config.ts refuses to
// start if they are in its environment): AGENT_ADMIN_PRIVATE_KEY is a full-access key of the agent account (a function-call key
// cannot delete keys), OWNER_PRIVATE_KEY is the contract owner's (pause_agent is owner-only, SPEC §4.3).
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Account, JsonRpcProvider, KeyPairSigner, PublicKey, actions, teraToGas, type KeyPairString } from 'near-api-js';
import { ainekConfigFromEnv } from '@ainek/proof';
import { stopAgent } from './stop.ts';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
for (const file of ['.env', '.env.owner']) if (existsSync(path.join(repoRoot, file))) process.loadEnvFile(path.join(repoRoot, file));
const need = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required (root .env or .env.owner); see .env.example`);
  return value;
};
const cfg = ainekConfigFromEnv(process.env);
const provider = new JsonRpcProvider({ url: cfg.rpcUrl });
const agentId = need('AGENT_ACCOUNT_ID');
const agentAdmin = new Account(agentId, provider, KeyPairSigner.fromSecretKey(need('AGENT_ADMIN_PRIVATE_KEY') as KeyPairString));
const owner = new Account(need('OWNER_ACCOUNT_ID'), provider, KeyPairSigner.fromSecretKey(need('OWNER_PRIVATE_KEY') as KeyPairString));
const fcKey = PublicKey.fromString(need('AGENT_FC_PUBLIC_KEY'));

const hashOf = (outcome: { status: unknown; transaction: { hash: string } }): string => {
  if ((outcome.status as { Failure?: unknown }).Failure !== undefined) throw new Error(JSON.stringify(outcome.status).slice(0, 300));
  return outcome.transaction.hash;
};
const report = await stopAgent({
  deleteKey: async () => hashOf(await agentAdmin.signAndSendTransaction({ receiverId: agentId, actions: [actions.deleteKey(fcKey)] })),
  pause: async () => hashOf(await owner.signAndSendTransaction({ receiverId: cfg.contract, actions: [actions.functionCall('pause_agent', { agent_id: agentId }, teraToGas(30), 0n)] })),
});
const line = (label: string, r: typeof report.deleteKey) => console.log(r.ok ? `✓ ${label}: ${cfg.explorer}/txns/${r.tx}` : `✗ ${label}: ${r.error}`);
line(`DeleteKey ${need('AGENT_FC_PUBLIC_KEY')} on ${agentId}`, report.deleteKey);
line(`pause_agent(${agentId}) on ${cfg.contract}`, report.pause);
process.exitCode = report.deleteKey.ok && report.pause.ok ? 0 : 1;

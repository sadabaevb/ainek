// `pnpm demo:stop`, run by the owner. The keys come from .env.owner, which the agent service never reads (config.ts refuses to
// start if they are in its environment): AGENT_ADMIN_PRIVATE_KEY is a full-access key of the agent account (a function-call key
// cannot delete keys), OWNER_PRIVATE_KEY is the contract owner's (pause_agent is owner-only, SPEC §4.3). Each step reads what it
// needs inside its own attempt: a missing variable for one step must not stop the other one.
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

const report = await stopAgent({
  deleteKey: async () => {
    const agentId = need('AGENT_ACCOUNT_ID');
    const admin = new Account(agentId, provider, KeyPairSigner.fromSecretKey(need('AGENT_ADMIN_PRIVATE_KEY') as KeyPairString));
    return (await admin.signAndSendTransaction({ receiverId: agentId, actions: [actions.deleteKey(PublicKey.fromString(need('AGENT_FC_PUBLIC_KEY')))] })).transaction.hash;
  },
  pause: async () => {
    const owner = new Account(need('OWNER_ACCOUNT_ID'), provider, KeyPairSigner.fromSecretKey(need('OWNER_PRIVATE_KEY') as KeyPairString));
    // AINEK_CONTRACT is required here, not defaulted: pausing the wrong contract would look like a success.
    return (await owner.signAndSendTransaction({ receiverId: need('AINEK_CONTRACT'), actions: [actions.functionCall('pause_agent', { agent_id: need('AGENT_ACCOUNT_ID') }, teraToGas(30), 0n)] })).transaction.hash;
  },
});
const line = (label: string, r: StepResult) => console.log(r.ok ? `✓ ${label}: ${explorerTxUrl(cfg.explorer, r.tx)}` : `✗ ${label}: ${r.error}`);
line(`DeleteKey ${process.env['AGENT_FC_PUBLIC_KEY'] ?? '(AGENT_FC_PUBLIC_KEY unset)'} on ${process.env['AGENT_ACCOUNT_ID'] ?? '(AGENT_ACCOUNT_ID unset)'}`, report.deleteKey);
line(`pause_agent on ${process.env['AINEK_CONTRACT'] ?? '(AINEK_CONTRACT unset)'}`, report.pause);
process.exitCode = report.deleteKey.ok && report.pause.ok ? 0 : 1;

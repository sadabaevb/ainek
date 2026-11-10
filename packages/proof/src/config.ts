// The non-secret configuration every Ainek process reads from the environment (root .env, see .env.example),
// in one place so the web app, the demo and the verifier cannot drift on defaults or on validation.

/** Intel TDX TCB statuses as the NEAR AI SDK names them (mirrored here so this package stays SDK-free). */
export const TCB_STATUSES = ['UpToDate', 'SWHardeningNeeded', 'ConfigurationNeeded', 'ConfigurationAndSWHardeningNeeded', 'OutOfDate', 'OutOfDateConfigurationNeeded', 'TDRelaunchAdvised', 'TDRelaunchAdvisedConfigurationNeeded', 'Revoked', 'Unknown'] as const;
export type TcbStatusName = (typeof TCB_STATUSES)[number];

export interface AinekConfig {
  model: string;
  incognitoModel: string;
  /** NEAR AI Cloud base URL including /v1 (the proxy and the live demo both talk to it). */
  nearaiBaseUrl: string;
  network: 'testnet' | 'mainnet';
  rpcUrl: string;
  contract: string;
  /** "contract" = view calls to the log contract (default); "sample" = the recorded entry in docs/samples (offline). */
  logSource: 'sample' | 'contract';
  /** Verifiers whose entries count (SPEC §7.1). Defaults follow the source: the deployed verifier for the contract, the fixture's verifiers for the sample. */
  trustedVerifiers: string[];
  /** Distinct trusted confirmations required; always an integer >= 1. */
  quorum: number;
  /**
   * SPEC §7.1: refuse to send unless a trusted verifier logged the attested key together with the attested compose hash. Off: the
   * key alone decides, and a deployment the log has not seen is shown on the card, not refused. Only an explicit 0 or false turns
   * it off; a blank value means the default, and anything else turns it on, so a typo cannot weaken the policy.
   */
  requireLoggedDeployment: boolean;
  /** TCB statuses accepted for gateway and model quotes (SPEC §3.2 policy); unknown names are dropped, never empty. */
  acceptedTcbStatuses: TcbStatusName[];
  explorer: string;
  /** The agent this deployment shows on /agent and in `check-agent` (Tier 2); other agents of the contract appear there once they have proposed something. */
  agentAccount: string;
  /** The policy job, as the page re-checks a run of it: the OutLayer API, the project and the published build (docs/DEPLOY.md). */
  outlayerApiUrl: string;
  policyProject: string;
  policyWasmHash: string;
}

export type EnvLike = Record<string, string | undefined>;

// The demo's trust policy for the live log; the replay's recorded entry #0 is by the first verifier (config.test.ts checks).
// Two verifiers on different machines (a server; GitHub's runners, docs/DEPLOY.md), both ours. The quorum stays 1 until the
// second has run for a day: with 2, one missed round of either would stop the chat.
const DEFAULT_VERIFIERS = 'ainek-dev-dastan.testnet,ainek-v2-dastan.testnet';

// One line to turn the deployment check on in the browser, the Node runner and the /log preview, on the hosted demo too (it sets no public variables). Off until the
// verifier samples every instance behind the gateway each round (DEV-NOTES 2026-11-10); `.env.example` carries the same value.
const REQUIRE_DEPLOYMENT_DEFAULT = '0';

function list(value: string | undefined, fallback: string): string[] {
  return (value ?? fallback).split(',').map((s) => s.trim()).filter(Boolean);
}

export function ainekConfigFromEnv(env: EnvLike): AinekConfig {
  const network = env['NEAR_NETWORK'] === 'mainnet' ? 'mainnet' : 'testnet';
  const logSource = env['AINEK_LOG_SOURCE'] === 'sample' ? 'sample' : 'contract';
  const quorumRaw = Number(env['AINEK_QUORUM'] ?? '1');
  const accepted = list(env['AINEK_ACCEPTED_TCB'], 'UpToDate').filter((s): s is TcbStatusName => (TCB_STATUSES as readonly string[]).includes(s));
  return {
    model: env['NEARAI_MODEL'] ?? 'z-ai/glm-5.3-flash',
    incognitoModel: env['NEARAI_INCOGNITO_MODEL'] ?? 'anthropic/claude-haiku-5-5',
    nearaiBaseUrl: env['NEARAI_BASE_URL'] ?? 'https://cloud-api.near.ai/v1',
    network,
    // FastNear's public endpoints answer a view call in ~0.3 s; rpc.testnet.near.org took ~3.3 s per call on 2026-11-05 (DEV-NOTES).
    rpcUrl: env['NEAR_RPC_URL'] ?? (network === 'mainnet' ? 'https://rpc.mainnet.fastnear.com' : 'https://rpc.testnet.fastnear.com'),
    contract: env['AINEK_CONTRACT'] ?? 'ainek-log-dastan.testnet',
    logSource,
    trustedVerifiers: list(env['AINEK_TRUSTED_VERIFIERS'], DEFAULT_VERIFIERS),
    quorum: Number.isInteger(quorumRaw) && quorumRaw >= 1 ? quorumRaw : 1,
    requireLoggedDeployment: !['0', 'false'].includes((env['AINEK_REQUIRE_DEPLOYMENT']?.trim() || REQUIRE_DEPLOYMENT_DEFAULT).toLowerCase()),
    acceptedTcbStatuses: accepted.length > 0 ? accepted : ['UpToDate'],
    explorer: network === 'mainnet' ? 'https://nearblocks.io' : 'https://testnet.nearblocks.io',
    // `||`: `.env.example` lists these for the agent, and a copied file may leave them blank.
    agentAccount: env['AGENT_ACCOUNT_ID'] || 'agent.ainek-dev-dastan.testnet',
    outlayerApiUrl: (env['OUTLAYER_API_URL'] || (network === 'mainnet' ? 'https://api.outlayer.ai' : 'https://testnet-api.outlayer.ai')).replace(/\/$/, ''),
    policyProject: env['OUTLAYER_PROJECT'] || 'ainek-dev-dastan.testnet/policy',
    policyWasmHash: env['OUTLAYER_WASM_HASH'] || '8041305f57d4f5668ee5d40f0f461b3df3fd22145f3e90c704a0204625f2d2eb',
  };
}

export function explorerTxUrl(explorer: string, tx: string): string {
  return `${explorer}/txns/${encodeURIComponent(tx)}`; // tx comes from a proof, i.e. from whoever wrote the file
}

export function explorerAccountUrl(explorer: string, account: string): string {
  return `${explorer}/address/${encodeURIComponent(account)}`; // the account comes from the chain or from config
}

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
  /** TCB statuses accepted for gateway and model quotes (SPEC §3.2 policy); unknown names are dropped, never empty. */
  acceptedTcbStatuses: TcbStatusName[];
  explorer: string;
  /** The policy job, as the page re-checks a run of it: the OutLayer API, the project and the published build (docs/DEPLOY.md). */
  outlayerApiUrl: string;
  policyProject: string;
  policyWasmHash: string;
}

export type EnvLike = Record<string, string | undefined>;

const SAMPLE_VERIFIERS = 'v1.ainek.testnet,v2.ainek.testnet,v3.ainek.testnet';
const CONTRACT_VERIFIERS = 'ainek-dev-dastan.testnet';

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
    trustedVerifiers: list(env['AINEK_TRUSTED_VERIFIERS'], logSource === 'sample' ? SAMPLE_VERIFIERS : CONTRACT_VERIFIERS),
    quorum: Number.isInteger(quorumRaw) && quorumRaw >= 1 ? quorumRaw : 1,
    acceptedTcbStatuses: accepted.length > 0 ? accepted : ['UpToDate'],
    explorer: network === 'mainnet' ? 'https://nearblocks.io' : 'https://testnet.nearblocks.io',
    // `||`: `.env.example` lists these for the agent, and a copied file may leave them blank.
    outlayerApiUrl: (env['OUTLAYER_API_URL'] || (network === 'mainnet' ? 'https://api.outlayer.ai' : 'https://testnet-api.outlayer.ai')).replace(/\/$/, ''),
    policyProject: env['OUTLAYER_PROJECT'] || 'ainek-dev-dastan.testnet/policy',
    policyWasmHash: env['OUTLAYER_WASM_HASH'] || '8041305f57d4f5668ee5d40f0f461b3df3fd22145f3e90c704a0204625f2d2eb',
  };
}

export function explorerTxUrl(explorer: string, tx: string): string {
  return `${explorer}/txns/${encodeURIComponent(tx)}`; // tx comes from a proof, i.e. from whoever wrote the file
}

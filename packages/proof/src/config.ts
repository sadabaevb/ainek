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
    rpcUrl: env['NEAR_RPC_URL'] ?? (network === 'mainnet' ? 'https://rpc.mainnet.near.org' : 'https://rpc.testnet.near.org'),
    contract: env['AINEK_CONTRACT'] ?? 'ainek-log-dastan.testnet',
    logSource,
    trustedVerifiers: list(env['AINEK_TRUSTED_VERIFIERS'], logSource === 'sample' ? SAMPLE_VERIFIERS : CONTRACT_VERIFIERS),
    quorum: Number.isInteger(quorumRaw) && quorumRaw >= 1 ? quorumRaw : 1,
    acceptedTcbStatuses: accepted.length > 0 ? accepted : ['UpToDate'],
    explorer: network === 'mainnet' ? 'https://nearblocks.io' : 'https://testnet.nearblocks.io',
  };
}

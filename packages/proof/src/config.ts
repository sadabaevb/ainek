// The non-secret configuration every Ainek process reads from the environment (root .env, see .env.example),
// in one place so the web app, the demo and the verifier cannot drift on defaults.

export interface AinekConfig {
  model: string;
  incognitoModel: string;
  network: 'testnet' | 'mainnet';
  rpcUrl: string;
  contract: string;
  /** "contract" = view calls to the log contract (default); "sample" = the recorded entry in docs/samples (offline). */
  logSource: 'sample' | 'contract';
  trustedVerifiers: string[];
  quorum: number;
  /** TCB statuses accepted for gateway and model quotes (SPEC §3.2 policy); validated against the SDK's list by the caller. */
  acceptedTcbStatuses: string[];
  explorer: string;
}

export type EnvLike = Record<string, string | undefined>;

function list(value: string | undefined, fallback: string): string[] {
  return (value ?? fallback).split(',').map((s) => s.trim()).filter(Boolean);
}

export function ainekConfigFromEnv(env: EnvLike): AinekConfig {
  const network = env['NEAR_NETWORK'] === 'mainnet' ? 'mainnet' : 'testnet';
  return {
    model: env['NEARAI_MODEL'] ?? 'z-ai/glm-5.3-flash',
    incognitoModel: env['NEARAI_INCOGNITO_MODEL'] ?? 'anthropic/claude-haiku-5-5',
    network,
    rpcUrl: env['NEAR_RPC_URL'] ?? (network === 'mainnet' ? 'https://rpc.mainnet.near.org' : 'https://rpc.testnet.near.org'),
    contract: env['AINEK_CONTRACT'] ?? 'ainek-log-dastan.testnet',
    logSource: env['AINEK_LOG_SOURCE'] === 'sample' ? 'sample' : 'contract',
    trustedVerifiers: list(env['AINEK_TRUSTED_VERIFIERS'], 'ainek-dev-dastan.testnet'),
    quorum: Number(env['AINEK_QUORUM'] ?? '1') || 1,
    acceptedTcbStatuses: list(env['AINEK_ACCEPTED_TCB'], 'UpToDate'),
    explorer: network === 'mainnet' ? 'https://nearblocks.io' : 'https://testnet.nearblocks.io',
  };
}

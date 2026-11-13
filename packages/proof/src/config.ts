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
  /**
   * SPEC §7.5: refuse to send unless the enclave's action log is exactly one a trusted verifier checked and logged, so
   * that nothing was deployed there since. Off by default, until the verifiers that write to the log write release marks:
   * with no marks in the log this rule refuses everything. Same reading of the value as above: blank means the default,
   * 0 or false is off, anything else is on.
   */
  requireLoggedRelease: boolean;
  /**
   * SPEC §7.5, with the rule above: send only when the enclave's action log has been marked as it stands for this long, in
   * ms. 0 is no wait. From `AINEK_RELEASE_WAIT_MIN`: blank, 0 or false is no wait, whole minutes up to 720 are that, and
   * any other value is read as 720, so a typo cannot turn the wait off.
   */
  releaseWaitMs: number;
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

// The demo's trust policy for the live log; the replay's recorded entry #0 is by the same verifier (config.test.ts checks).
// Our second verifier (ainek-v2-dastan.testnet) writes too but is not trusted by default yet: a trusted verifier that
// stalls across a key rotation ends with no key in common with the other one, which reads as a split view and stops the
// chat for everyone (SPEC §7.1). It joins once it has run on a schedule for a day; a visitor can add it on /log now.
const DEFAULT_VERIFIERS = 'ainek-dev-dastan.testnet';

// The deployment check for the browser, the Node runner and the /log preview, on the hosted demo too (it sets no public variables).
// On since Nov 11 (DEV-NOTES 2026-11-11); `false` here and `0` in `.env.example` turn it back off.
// With `AINEK_LOG_SOURCE=sample` the default is off: that log is one recorded entry with one compose, and a live replica need not be that one.
const REQUIRE_DEPLOYMENT_DEFAULT = true;
/** Off until the verifiers that write to the log write release marks (DEV-NOTES 2026-11-12). */
const REQUIRE_RELEASE_DEFAULT = false;

/**
 * The longest wait a client can ask for, in minutes. It measures the wait on the entries it reads, a day of the log, and a
 * verifier that runs without a break writes an unchanged state again every six hours: the first mark the client can see
 * of a state that has stood for days is then 18 to 24 hours old. After a break in the verifier it is younger, and the
 * client waits again (SPEC §7.5).
 */
const MAX_RELEASE_WAIT_MIN = 720;

/** `AINEK_RELEASE_WAIT_MIN` in ms: blank, 0 or false is no wait, plain digits are minutes up to the maximum, and anything else is the maximum. */
function releaseWaitMs(value: string | undefined): number {
  const said = value?.trim().toLowerCase() || '0';
  if (said === 'false') return 0;
  return (/^\d+$/.test(said) ? Math.min(Number(said), MAX_RELEASE_WAIT_MIN) : MAX_RELEASE_WAIT_MIN) * 60_000;
}

/** A switch from the environment: blank means `fallback`, `0` or `false` is off, and anything else is on, so a typo cannot turn a check off. */
export function envFlag(value: string | undefined, fallback: boolean): boolean {
  const said = value?.trim().toLowerCase();
  return said ? said !== '0' && said !== 'false' : fallback;
}

function list(value: string | undefined, fallback: string): string[] {
  return (value ?? fallback).split(',').map((s) => s.trim()).filter(Boolean);
}

export function ainekConfigFromEnv(env: EnvLike): AinekConfig {
  const network = env['NEAR_NETWORK'] === 'mainnet' ? 'mainnet' : 'testnet';
  const logSource = env['AINEK_LOG_SOURCE'] === 'sample' ? 'sample' : 'contract';
  // A typo here must not quietly become 1, the weakest quorum there is.
  const quorumRaw = Number(env['AINEK_QUORUM']?.trim() || '1');
  if (!Number.isInteger(quorumRaw) || quorumRaw < 1) throw new Error(`AINEK_QUORUM must be a whole number of at least 1, got ${JSON.stringify(env['AINEK_QUORUM'])}`);
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
    quorum: quorumRaw,
    requireLoggedDeployment: envFlag(env['AINEK_REQUIRE_DEPLOYMENT'], logSource !== 'sample' && REQUIRE_DEPLOYMENT_DEFAULT),
    requireLoggedRelease: envFlag(env['AINEK_REQUIRE_RELEASE'], REQUIRE_RELEASE_DEFAULT),
    releaseWaitMs: releaseWaitMs(env['AINEK_RELEASE_WAIT_MIN']),
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

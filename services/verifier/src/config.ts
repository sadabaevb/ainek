// Verifier configuration: the shared Ainek settings (contract, RPC, NEAR AI base URL, TCB policy) plus the
// VERIFIER_* variables from .env.example. Everything comes from the environment so the same code runs as
// `pnpm -F verifier start`, `npx ainek-verify` and `docker run` without a config file.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ainekConfigFromEnv, envFlag, type AinekConfig } from '@ainek/proof';

export interface VerifierConfig extends AinekConfig {
  accountId: string;
  /** `ed25519:<base58>` as exported by near-cli / the wallet. Never logged. */
  privateKey: string;
  models: string[];
  intervalMs: number;
  /** Attestation reports fetched per model per round. The gateway answers each request from one replica behind its balancer, and
   *  the replicas differ in compose hash; one report a round would log a new deployment only when the balancer happened to pick it. */
  reportsPerRound: number;
  /** Where full attestation reports are kept, one file per `report_hash`. */
  reportsDir: string;
  /** A key already logged by this verifier within this window is not logged again (gas). */
  dedupWindowNs: string;
  /** `--dry-run`: attest and print the entry, send nothing. Needs no account or key. */
  dryRun: boolean;
  /** Follow the release behind each verified key to public sources and log release marks with it (SPEC §7.5). On unless
   *  `VERIFIER_RELEASE_MARKS` is 0 or false: then entries are logged as they were before marks. */
  releaseMarks: boolean;
  /** Optional, for the release check only: raises GitHub's anonymous limit of 60 requests an hour. Sent to api.github.com
   *  and nowhere else. Never logged. */
  githubToken: string | undefined;
}

export const SIX_HOURS_NS = String(6n * 3600n * 1_000_000_000n);
/** 24 days: under setTimeout's 2^31-1 ms limit. */
export const MAX_INTERVAL_MIN = 24 * 24 * 60;
/** Each report is one attestation fetch and one full verification (5–60 s, up to 180 s when it hangs), fetched one after another; more than this per round is a round that never ends. */
export const MAX_REPORTS_PER_ROUND = 20;

export function loadConfig(env: NodeJS.ProcessEnv = process.env, opts: { dryRun?: boolean } = {}): VerifierConfig {
  const dryRun = opts.dryRun === true;
  // Root .env is the one place for secrets (CLAUDE.md); variables already set in the shell win.
  const repoRoot = path.resolve(import.meta.dirname, '../../..');
  const envFile = path.join(repoRoot, '.env');
  if (env === process.env && existsSync(envFile)) process.loadEnvFile(envFile);

  const accountId = env['VERIFIER_ACCOUNT_ID'] ?? '';
  const privateKey = env['VERIFIER_PRIVATE_KEY'] ?? '';
  // A dry run sends nothing, so it must work from a clean clone where .env still holds the placeholders.
  if (!dryRun && (!accountId || !privateKey.startsWith('ed25519:') || privateKey.length < 20)) {
    throw new Error('VERIFIER_ACCOUNT_ID and VERIFIER_PRIVATE_KEY (ed25519:…) are required; see .env.example. To try the verifier without an account: pnpm -F verifier dry-run');
  }
  const models = (env['VERIFIER_MODELS'] ?? 'z-ai/glm-5.3-flash').split(',').map((s) => s.trim()).filter(Boolean);
  if (models.length === 0) throw new Error('VERIFIER_MODELS is empty');
  const intervalMin = Number(env['VERIFIER_INTERVAL_MIN'] ?? '15');
  // Upper bound: setTimeout takes a 32-bit ms delay (~24.8 days); past that it fires immediately and the loop spins.
  if (!Number.isFinite(intervalMin) || intervalMin < 1 || intervalMin > MAX_INTERVAL_MIN) {
    throw new Error(`VERIFIER_INTERVAL_MIN must be between 1 and ${MAX_INTERVAL_MIN}, got ${String(env['VERIFIER_INTERVAL_MIN'])}`);
  }

  // A dry run is the clean-clone check and should stay short; a writing verifier wants to see every replica (five is what
  // the gateway has shown so far, DEV-NOTES 2026-11-10).
  const reportsPerRound = Number(env['VERIFIER_REPORTS_PER_ROUND'] ?? (dryRun ? '1' : '5'));
  if (!Number.isInteger(reportsPerRound) || reportsPerRound < 1 || reportsPerRound > MAX_REPORTS_PER_ROUND) {
    throw new Error(`VERIFIER_REPORTS_PER_ROUND must be a whole number between 1 and ${MAX_REPORTS_PER_ROUND}, got ${String(env['VERIFIER_REPORTS_PER_ROUND'])}`);
  }

  return {
    ...ainekConfigFromEnv(env),
    accountId,
    privateKey,
    models,
    intervalMs: intervalMin * 60_000,
    reportsPerRound,
    // `||`, not `??`: an empty `VERIFIER_DATA_DIR=` line in .env must mean "default", not mkdir('').
    reportsDir: env['VERIFIER_DATA_DIR'] || path.resolve(import.meta.dirname, '../data/reports'),
    dedupWindowNs: SIX_HOURS_NS,
    dryRun,
    releaseMarks: envFlag(env['VERIFIER_RELEASE_MARKS'], true),
    githubToken: env['GITHUB_TOKEN']?.trim() || undefined,
  };
}

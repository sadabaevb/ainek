// Verifier configuration: the shared Ainek settings (contract, RPC, NEAR AI base URL, TCB policy) plus the
// VERIFIER_* variables from .env.example. Everything comes from the environment so the same code runs as
// `pnpm -F verifier start`, `npx ainek-verify` and `docker run` without a config file.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ainekConfigFromEnv, type AinekConfig } from '@ainek/proof';

export interface VerifierConfig extends AinekConfig {
  accountId: string;
  /** `ed25519:<base58>` as exported by near-cli / the wallet. Never logged. */
  privateKey: string;
  models: string[];
  intervalMs: number;
  /** Where full attestation reports are kept, one file per `report_hash`. */
  reportsDir: string;
  /** A key already logged by this verifier within this window is not logged again (gas). */
  dedupWindowNs: string;
}

export const SIX_HOURS_NS = String(6n * 3600n * 1_000_000_000n);
/** 24 days: under setTimeout's 2^31-1 ms limit. */
export const MAX_INTERVAL_MIN = 24 * 24 * 60;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): VerifierConfig {
  // Root .env is the one place for secrets (CLAUDE.md); variables already set in the shell win.
  const repoRoot = path.resolve(import.meta.dirname, '../../..');
  const envFile = path.join(repoRoot, '.env');
  if (env === process.env && existsSync(envFile)) process.loadEnvFile(envFile);

  const accountId = env['VERIFIER_ACCOUNT_ID'];
  const privateKey = env['VERIFIER_PRIVATE_KEY'];
  if (!accountId || !privateKey || !privateKey.startsWith('ed25519:') || privateKey.length < 20) {
    throw new Error('VERIFIER_ACCOUNT_ID and VERIFIER_PRIVATE_KEY (ed25519:…) are required; see .env.example');
  }
  const models = (env['VERIFIER_MODELS'] ?? 'z-ai/glm-5.3-flash').split(',').map((s) => s.trim()).filter(Boolean);
  if (models.length === 0) throw new Error('VERIFIER_MODELS is empty');
  const intervalMin = Number(env['VERIFIER_INTERVAL_MIN'] ?? '15');
  // Upper bound: setTimeout takes a 32-bit ms delay (~24.8 days); past that it fires immediately and the loop spins.
  if (!Number.isFinite(intervalMin) || intervalMin < 1 || intervalMin > MAX_INTERVAL_MIN) {
    throw new Error(`VERIFIER_INTERVAL_MIN must be between 1 and ${MAX_INTERVAL_MIN}, got ${String(env['VERIFIER_INTERVAL_MIN'])}`);
  }

  return {
    ...ainekConfigFromEnv(env),
    accountId,
    privateKey,
    models,
    intervalMs: intervalMin * 60_000,
    reportsDir: env['VERIFIER_DATA_DIR'] ?? path.resolve(import.meta.dirname, '../data/reports'),
    dedupWindowNs: SIX_HOURS_NS,
  };
}

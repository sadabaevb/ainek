// The root .env (CLAUDE.md: secrets live in one file) and the shared config, for the live modes.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ainekConfigFromEnv, type AinekConfig } from '@ainek/proof';

/** loadEnvFile never overrides variables already set, so the shell wins. */
export function loadLiveEnv(): { apiKey: string | undefined; cfg: AinekConfig } {
  const repoRoot = path.resolve(import.meta.dirname, '../../..');
  if (existsSync(path.join(repoRoot, '.env'))) process.loadEnvFile(path.join(repoRoot, '.env'));
  return { apiKey: process.env.NEARAI_API_KEY || undefined, cfg: ainekConfigFromEnv(process.env) };
}

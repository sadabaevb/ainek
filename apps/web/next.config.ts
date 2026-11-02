import { existsSync } from 'node:fs';
import path from 'node:path';
import { loadEnvConfig } from '@next/env';
import type { NextConfig } from 'next';

// The monorepo keeps a single .env at the repo root (CLAUDE.md: "No secrets in git", .env.example lists
// every variable). Next.js only reads apps/web/.env*, so we load the root file ourselves. Variables already
// present in the environment (or in apps/web/.env*) are not overwritten.
function repoRoot(from: string): string {
  let dir = from;
  while (!existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
    const parent = path.dirname(dir);
    if (parent === dir) return from; // not inside the monorepo: fall back to cwd
    dir = parent;
  }
  return dir;
}
loadEnvConfig(repoRoot(process.cwd()));

const nextConfig: NextConfig = {
  // The SDK is ESM and loads the dcap-qvl wasm at runtime; leave it to Node instead of bundling it.
  serverExternalPackages: ['@nearai/inference-sdk'],
};

export default nextConfig;

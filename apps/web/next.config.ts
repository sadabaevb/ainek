import type { NextConfig } from 'next';

// Secrets come from the repo-root .env, loaded at server start in instrumentation.ts (see the comment there).
const nextConfig: NextConfig = {
  // The SDK is ESM and loads the dcap-qvl wasm at runtime; leave it to Node instead of bundling it.
  serverExternalPackages: ['@nearai/inference-sdk'],
  // Shared proof package is published as TypeScript source (no build step); let Next compile it.
  transpilePackages: ['@ainek/proof'],
  // Next 16 writes an AGENTS.md into the app on every `next dev`; the repo already has CLAUDE.md.
  agentRules: false,
};

export default nextConfig;

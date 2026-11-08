import type { NextConfig } from 'next';

// Secrets come from the repo-root .env, loaded at server start in instrumentation.ts (see the comment there).
const nextConfig: NextConfig = {
  // The SDK is ESM and loads the dcap-qvl wasm at runtime; leave it to Node instead of bundling it.
  serverExternalPackages: ['@nearai/inference-sdk'],
  // Shared proof package is published as TypeScript source (no build step); let Next compile it.
  transpilePackages: ['@ainek/proof'],
  // Next 16 writes an AGENTS.md into the app on every `next dev`; the repo already has CLAUDE.md.
  agentRules: false,
  // No other site may frame Ainek: the wallet connector accepts a "wallet" announced by the parent frame and sends it
  // every sign-in and signature (near-connect 0.11.4 does not check who sent it). nosniff: files are what they claim.
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
      ],
    }];
  },
};

export default nextConfig;

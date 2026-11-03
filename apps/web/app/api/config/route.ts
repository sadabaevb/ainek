// Public (non-secret) configuration for the browser, read from the root .env on the server so that
// NEXT_PUBLIC_* inlining is not needed. Nothing secret goes here.
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export interface PublicConfig {
  model: string;
  incognitoModel: string;
  network: string;
  rpcUrl: string;
  contract: string;
  logSource: 'sample' | 'contract';
  trustedVerifiers: string[];
  quorum: number;
  explorer: string;
}

export function GET(): NextResponse<PublicConfig> {
  const network = process.env.NEAR_NETWORK ?? 'testnet';
  return NextResponse.json({
    model: process.env.NEARAI_MODEL ?? 'z-ai/glm-5.3-flash',
    incognitoModel: process.env.NEARAI_INCOGNITO_MODEL ?? 'anthropic/claude-haiku-5-5',
    network,
    rpcUrl: process.env.NEAR_RPC_URL ?? 'https://rpc.testnet.near.org',
    contract: process.env.AINEK_CONTRACT ?? 'ainek.testnet',
    logSource: process.env.AINEK_LOG_SOURCE === 'contract' ? 'contract' : 'sample',
    trustedVerifiers: (process.env.AINEK_TRUSTED_VERIFIERS ?? 'v1.ainek.testnet,v2.ainek.testnet,v3.ainek.testnet').split(',').map((s) => s.trim()).filter(Boolean),
    quorum: Number(process.env.AINEK_QUORUM ?? '1') || 1,
    explorer: network === 'mainnet' ? 'https://nearblocks.io' : 'https://testnet.nearblocks.io',
  });
}

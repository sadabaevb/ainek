import 'server-only';
import type { TcbStatus } from '@nearai/inference-sdk';
import type { PublicConfig } from './config';

const TCB_STATUSES: ReadonlySet<string> = new Set<TcbStatus>(['UpToDate', 'SWHardeningNeeded', 'ConfigurationNeeded', 'ConfigurationAndSWHardeningNeeded', 'OutOfDate', 'OutOfDateConfigurationNeeded', 'TDRelaunchAdvised', 'TDRelaunchAdvisedConfigurationNeeded', 'Revoked', 'Unknown']);

function list(value: string | undefined, fallback: string): string[] {
  return (value ?? fallback).split(',').map((s) => s.trim()).filter(Boolean);
}

export function readPublicConfig(): PublicConfig {
  const network = process.env.NEAR_NETWORK === 'mainnet' ? 'mainnet' : 'testnet';
  const accepted = list(process.env.AINEK_ACCEPTED_TCB, 'UpToDate').filter((s): s is TcbStatus => TCB_STATUSES.has(s));
  return {
    model: process.env.NEARAI_MODEL ?? 'z-ai/glm-5.3-flash',
    incognitoModel: process.env.NEARAI_INCOGNITO_MODEL ?? 'anthropic/claude-haiku-5-5',
    network,
    rpcUrl: process.env.NEAR_RPC_URL ?? (network === 'mainnet' ? 'https://rpc.mainnet.near.org' : 'https://rpc.testnet.near.org'),
    contract: process.env.AINEK_CONTRACT ?? 'ainek-log-dastan.testnet',
    logSource: process.env.AINEK_LOG_SOURCE === 'sample' ? 'sample' : 'contract',
    trustedVerifiers: list(process.env.AINEK_TRUSTED_VERIFIERS, 'ainek-dev-dastan.testnet'),
    quorum: Number(process.env.AINEK_QUORUM ?? '1') || 1,
    acceptedTcbStatuses: accepted.length > 0 ? accepted : ['UpToDate'],
    explorer: network === 'mainnet' ? 'https://nearblocks.io' : 'https://testnet.nearblocks.io',
  };
}

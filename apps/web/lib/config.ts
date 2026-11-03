// Public, non-secret configuration the browser needs. Read once on the server (config.server.ts) from the root
// .env and handed to the client through <Providers>; pages call useConfig(). No NEXT_PUBLIC_* inlining needed.
import type { TcbStatus } from '@nearai/inference-sdk';

export interface PublicConfig {
  model: string;
  incognitoModel: string;
  network: 'testnet' | 'mainnet';
  rpcUrl: string;
  contract: string;
  /** "contract" = view calls to the log contract (default); "sample" = the recorded entry in docs/samples (offline). */
  logSource: 'sample' | 'contract';
  trustedVerifiers: string[];
  quorum: number;
  /** TCB statuses accepted for gateway and model quotes (SPEC §3.2 policy; configurable so an Intel advisory does not kill the demo). */
  acceptedTcbStatuses: TcbStatus[];
  explorer: string;
}

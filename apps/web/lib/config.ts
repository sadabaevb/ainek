// Public, non-secret configuration the browser needs. Read once on the server (config.server.ts) from the root
// .env and handed to the client through <Providers>; pages call useConfig(). No NEXT_PUBLIC_* inlining needed.
import type { TcbStatus } from '@nearai/inference-sdk';
import type { AinekConfig } from '@ainek/proof';

export interface PublicConfig extends Omit<AinekConfig, 'acceptedTcbStatuses'> {
  /** Narrowed to the SDK's TcbStatus union by the server. */
  acceptedTcbStatuses: TcbStatus[];
}

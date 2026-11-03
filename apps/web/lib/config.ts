// Public, non-secret configuration the browser needs. Read once on the server (config.server.ts) from the root
// .env and handed to the client through <Providers>; pages call useConfig(). No NEXT_PUBLIC_* inlining needed.
import type { TcbStatus } from '@nearai/inference-sdk';
import type { AinekConfig } from '@ainek/proof';

export interface PublicConfig extends Omit<AinekConfig, 'acceptedTcbStatuses'> {
  /** Same strings as @ainek/proof's TcbStatusName, typed as the SDK's union for the verify calls. */
  acceptedTcbStatuses: TcbStatus[];
}

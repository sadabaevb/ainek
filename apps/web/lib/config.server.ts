import 'server-only';
import type { TcbStatus } from '@nearai/inference-sdk';
import { ainekConfigFromEnv } from '@ainek/proof';
import type { PublicConfig } from './config';

/** Validation (unknown statuses dropped, never empty, quorum >= 1) happens in ainekConfigFromEnv; the names are the SDK's. */
export function readPublicConfig(): PublicConfig {
  const cfg = ainekConfigFromEnv(process.env);
  return { ...cfg, acceptedTcbStatuses: cfg.acceptedTcbStatuses as TcbStatus[] };
}

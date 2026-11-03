import 'server-only';
import type { TcbStatus } from '@nearai/inference-sdk';
import { ainekConfigFromEnv } from '@ainek/proof';
import type { PublicConfig } from './config';

const TCB_STATUSES: ReadonlySet<string> = new Set<TcbStatus>(['UpToDate', 'SWHardeningNeeded', 'ConfigurationNeeded', 'ConfigurationAndSWHardeningNeeded', 'OutOfDate', 'OutOfDateConfigurationNeeded', 'TDRelaunchAdvised', 'TDRelaunchAdvisedConfigurationNeeded', 'Revoked', 'Unknown']);

export function readPublicConfig(): PublicConfig {
  const cfg = ainekConfigFromEnv(process.env);
  const accepted = cfg.acceptedTcbStatuses.filter((s): s is TcbStatus => TCB_STATUSES.has(s));
  return { ...cfg, acceptedTcbStatuses: accepted.length > 0 ? accepted : ['UpToDate'] };
}

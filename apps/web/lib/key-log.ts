// The public key log as the browser reads it (SPEC §4.1 views). The source is chosen once from config:
// live view calls to the contract (shared reader in @ainek/proof), or the recorded sample entry (offline).
import { KeyEntry, keyLogReader, resolveLogEntry as resolveFromLog, verifiersOf, type KeyLogReader, type ResolvedEntry } from '@ainek/proof';
import sample from '../../../docs/samples/key-entry.sample.json';
import type { PublicConfig } from './config';

/** The two views the pages use, with the shared reader's signatures (one source of truth), plus where they come from. */
export interface KeyLog extends Pick<KeyLogReader, 'latestKeys' | 'entry' | 'verifiers'> {
  source: 'contract' | 'sample';
}

function sampleLog(): KeyLog {
  const entries = [KeyEntry.parse(sample.entry)];
  return {
    source: 'sample',
    latestKeys: async (model) => entries.filter((e) => e.model === model), // the sample never ages out
    entry: async (index) => entries.find((e) => e.index === index) ?? null,
    verifiers: async () => verifiersOf(entries),
  };
}

export function keyLogFor(cfg: Pick<PublicConfig, 'logSource' | 'rpcUrl' | 'contract'>): KeyLog {
  return cfg.logSource === 'contract' ? { source: 'contract', ...keyLogReader(cfg.rpcUrl, cfg.contract) } : sampleLog();
}

/**
 * The entry a proof points at (resolveLogEntry in @ainek/proof) with the log source chosen by config: the contract is the
 * source of truth; the recorded sample is never passed off as the chain.
 */
export async function resolveLogEntry(cfg: PublicConfig, logIndex: number, embedded?: KeyEntry): Promise<ResolvedEntry> {
  const log = keyLogFor(cfg);
  if (log.source === 'contract') return resolveFromLog(log, logIndex, embedded, cfg.contract);
  const entry = embedded ?? (await log.entry(logIndex));
  const detail = embedded ? 'public log not consulted (AINEK_LOG_SOURCE=sample); using the embedded entry' : entry ? `entry #${logIndex} from the recorded sample log, not the chain` : `entry #${logIndex} is not in the recorded sample log`;
  return { entry, check: { id: 'log-entry', status: 'skipped', detail } };
}

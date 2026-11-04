// The public key log as the browser reads it (SPEC §4.1 views). The source is chosen once from config:
// live view calls to the contract (shared reader in @ainek/proof), or the recorded sample entry (offline).
import { KeyEntry, keyLogReader } from '@ainek/proof';
import sample from '../../../docs/samples/key-entry.sample.json';
import type { PublicConfig } from './config';
import { describeError } from './errors';
import { short } from './format';

export interface KeyLog {
  source: 'contract' | 'sample';
  latestKeys(model: string): Promise<KeyEntry[]>;
  entry(index: number): Promise<KeyEntry | null>;
}

function sampleLog(): KeyLog {
  const entries = [KeyEntry.parse(sample.entry)];
  return {
    source: 'sample',
    latestKeys: async (model) => entries.filter((e) => e.model === model),
    entry: async (index) => entries.find((e) => e.index === index) ?? null,
  };
}

export function keyLogFor(cfg: PublicConfig): KeyLog {
  return cfg.logSource === 'contract' ? { source: 'contract', ...keyLogReader(cfg.rpcUrl, cfg.contract) } : sampleLog();
}

export interface ResolvedEntry {
  /** What the proof is checked against: the chain's entry when it answered, else the embedded one, else nothing. */
  entry: KeyEntry | null;
  status: 'ok' | 'fail' | 'skipped';
  detail: string;
}

/**
 * The log entry a proof points at, with the public log as the source of truth: re-read from the chain when it answers and
 * compared with the entry embedded in the input (a disclosure file, a stored exchange). The embedded entry is used only when
 * the chain cannot be asked, and the detail says so: a reader must not mistake the sender's copy for the chain's word.
 */
export async function resolveLogEntry(cfg: PublicConfig, logIndex: unknown, embedded?: KeyEntry): Promise<ResolvedEntry> {
  if (typeof logIndex !== 'number') return { entry: embedded ?? null, status: 'skipped', detail: embedded ? 'no log index in the input; using the embedded entry' : 'no log index in the input' };
  const log = keyLogFor(cfg);
  if (log.source === 'sample') {
    const entry = embedded ?? (await log.entry(logIndex));
    const detail = embedded ? 'public log not consulted (AINEK_LOG_SOURCE=sample); using the embedded entry' : entry ? `entry #${logIndex} from the recorded sample log, not the chain` : `entry #${logIndex} is not in the recorded sample log`;
    return { entry, status: 'skipped', detail };
  }
  let fromChain: KeyEntry | null;
  try {
    fromChain = await log.entry(logIndex);
  } catch (err) {
    return { entry: embedded ?? null, status: 'skipped', detail: `public log unavailable (${describeError(err)})${embedded ? '; using the embedded entry, not re-read from the chain' : ''}` };
  }
  if (!fromChain) return { entry: embedded ?? null, status: 'fail', detail: `entry #${logIndex} is not in the public log (${cfg.contract})${embedded ? ': the embedded entry cannot be confirmed' : ''}` };
  if (embedded && embedded.entry_hash !== fromChain.entry_hash) {
    return { entry: fromChain, status: 'fail', detail: `entry #${logIndex} on ${cfg.contract} differs from the embedded entry (entry_hash ${short(fromChain.entry_hash)} vs ${short(embedded.entry_hash)})` };
  }
  return { entry: fromChain, status: 'ok', detail: `entry #${logIndex} re-read from ${cfg.contract}${embedded ? ', equal to the embedded entry' : ''}` };
}

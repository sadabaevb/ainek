// The public key log as the browser reads it (SPEC §4.1 views). The source is chosen once from config:
// live view calls to the contract (shared reader in @ainek/proof), or the recorded sample entry (offline).
import { KeyEntry, keyLogReader } from '@ainek/proof';
import sample from '../../../docs/samples/key-entry.sample.json';
import type { PublicConfig } from './config';

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

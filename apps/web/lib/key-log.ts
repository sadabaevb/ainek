// The public key log as the browser reads it (SPEC §4.1 views). The source is chosen once from config:
// live view calls to the contract, or the recorded sample entry until the contract is deployed.
import { JsonRpcProvider } from 'near-api-js';
import { KeyEntry } from '@ainek/proof';
import sample from '../../../docs/samples/key-entry.sample.json';
import type { PublicConfig } from './config';

export interface KeyLog {
  source: 'contract' | 'sample';
  /** `latest_keys(model, 24h)` */
  latestKeys(model: string): Promise<KeyEntry[]>;
  /** `entry(index)` */
  entry(index: number): Promise<KeyEntry | null>;
}

const DAY_NS = '86400000000000'; // 24 h in nanoseconds, as a U64 string

function contractLog(cfg: PublicConfig): KeyLog {
  const provider = new JsonRpcProvider({ url: cfg.rpcUrl });
  const view = (method: string, args: Record<string, unknown>) => provider.callFunction({ contractId: cfg.contract, method, args });
  return {
    source: 'contract',
    latestKeys: async (model) => KeyEntry.array().parse(await view('latest_keys', { model, max_age_ns: DAY_NS })),
    entry: async (index) => {
      const raw = await view('entry', { index });
      return raw === null ? null : KeyEntry.parse(raw);
    },
  };
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
  return cfg.logSource === 'contract' ? contractLog(cfg) : sampleLog();
}

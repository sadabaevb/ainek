// The public key log, read by the browser: live view calls to the contract (SPEC §4.1 `latest_keys`), or the
// recorded sample entry while the contract is not deployed. The trust rule itself lives in @ainek/proof.
import { JsonRpcProvider } from 'near-api-js';
import { KeyEntry } from '@ainek/proof';
import { getConfig } from './config';

export interface KeyLogSnapshot {
  entries: KeyEntry[];
  source: 'contract' | 'sample';
  fetchedAt: string;
}

const DAY_NS = '86400000000000'; // 24 h in nanoseconds, as a U64 string

export async function fetchLatestKeys(model: string): Promise<KeyLogSnapshot> {
  const cfg = await getConfig();
  if (cfg.logSource === 'contract') {
    const provider = new JsonRpcProvider({ url: cfg.rpcUrl });
    const raw = await provider.callFunction({ contractId: cfg.contract, method: 'latest_keys', args: { model, max_age_ns: DAY_NS } });
    return { entries: KeyEntry.array().parse(raw), source: 'contract', fetchedAt: new Date().toISOString() };
  }
  const res = await fetch('/api/log/sample', { cache: 'no-store' });
  if (!res.ok) throw new Error(`key log sample: HTTP ${res.status}`);
  const { entries } = (await res.json()) as { entries: unknown };
  return { entries: KeyEntry.array().parse(entries), source: 'sample', fetchedAt: new Date().toISOString() };
}

/** One entry by index, for re-verification of a pasted proof (SPEC §4.1 `entry`). */
export async function fetchEntry(index: number): Promise<KeyEntry | null> {
  const cfg = await getConfig();
  if (cfg.logSource === 'contract') {
    const provider = new JsonRpcProvider({ url: cfg.rpcUrl });
    const raw = await provider.callFunction({ contractId: cfg.contract, method: 'entry', args: { index } });
    return raw === null ? null : KeyEntry.parse(raw);
  }
  const { entries } = await fetchLatestKeys('');
  return entries.find((e) => e.index === index) ?? null;
}

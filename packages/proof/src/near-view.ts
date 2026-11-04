// Read-only NEAR view calls over plain JSON-RPC (global fetch, no SDK), enough for the key log (SPEC §4.1 views).
// Shared by the web client, the demo and the verifier so the ABI call shapes live in one place.
import { z } from 'zod';
import { bytesToBase64 } from './disclosure.ts';
import { KeyEntry, hex64 } from './schema.ts';

const TIMEOUT_MS = 10_000;
const ATTEMPTS = 3;

export async function viewFunction(rpcUrl: string, contractId: string, method: string, args: Record<string, unknown>): Promise<unknown> {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: '1',
    method: 'query',
    params: { request_type: 'call_function', finality: 'final', account_id: contractId, method_name: method, args_base64: bytesToBase64(new TextEncoder().encode(JSON.stringify(args))) },
  });
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.status === 429 || res.status >= 500) throw new Transient(`${rpcUrl}: HTTP ${res.status}`);
      if (!res.ok) throw new Error(`${rpcUrl}: HTTP ${res.status}`);
      const json = (await res.json()) as { result?: { result?: number[]; error?: string }; error?: { message?: string; data?: unknown } };
      if (json.error) throw new Error(`${contractId}.${method}: ${typeof json.error.data === 'string' ? json.error.data : json.error.message ?? JSON.stringify(json.error)}`);
      if (json.result?.error) throw new Error(`${contractId}.${method}: ${json.result.error}`);
      const bytes = json.result?.result ?? [];
      return bytes.length === 0 ? undefined : JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes)));
    } catch (err) {
      // Network failures, timeouts and 429/5xx are retried a bounded number of times; contract errors are not.
      const transient = err instanceof Transient || (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError' || /fetch failed|network/i.test(err.message)));
      if (!transient || attempt >= ATTEMPTS) throw err;
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
}

class Transient extends Error {}

const DAY_NS = '86400000000000'; // 24 h in nanoseconds, as a U64 string
const Head = z.object({ index: z.number().int().nonnegative(), entry_hash: hex64 }).nullable();

export interface KeyLogReader {
  /** `latest_keys(model, max_age_ns)`, 24 h window. */
  latestKeys(model: string): Promise<KeyEntry[]>;
  /** `entry(index)`; null when the index does not exist. */
  entry(index: number): Promise<KeyEntry | null>;
  /** `entries_since(index, limit)`. */
  entriesSince(index: number, limit: number): Promise<KeyEntry[]>;
  /** `head()`; null while the log is empty. */
  head(): Promise<{ index: number; entry_hash: string } | null>;
}

export function keyLogReader(rpcUrl: string, contractId: string): KeyLogReader {
  const view = (method: string, args: Record<string, unknown>) => viewFunction(rpcUrl, contractId, method, args);
  return {
    latestKeys: async (model) => KeyEntry.array().parse(await view('latest_keys', { model, max_age_ns: DAY_NS })),
    entry: async (index) => {
      const raw = await view('entry', { index });
      return raw == null ? null : KeyEntry.parse(raw);
    },
    entriesSince: async (index, limit) => KeyEntry.array().parse(await view('entries_since', { index, limit })),
    head: async () => Head.parse((await view('head', {})) ?? null),
  };
}

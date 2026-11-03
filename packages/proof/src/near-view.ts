// Read-only NEAR view calls over plain JSON-RPC (global fetch, no SDK), enough for the key log (SPEC §4.1 views).
// Shared by the web client, the demo and the verifier so the ABI call shapes live in one place.
import { KeyEntry } from './schema.ts';

export async function viewFunction(rpcUrl: string, contractId: string, method: string, args: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: '1',
      method: 'query',
      params: { request_type: 'call_function', finality: 'final', account_id: contractId, method_name: method, args_base64: btoa(JSON.stringify(args)) },
    }),
  });
  if (!res.ok) throw new Error(`${rpcUrl}: HTTP ${res.status}`);
  const json = (await res.json()) as { result?: { result?: number[]; error?: string }; error?: { message?: string; data?: unknown } };
  if (json.error) throw new Error(`${contractId}.${method}: ${typeof json.error.data === 'string' ? json.error.data : json.error.message ?? JSON.stringify(json.error)}`);
  if (json.result?.error) throw new Error(`${contractId}.${method}: ${json.result.error}`);
  const bytes = json.result?.result ?? [];
  return bytes.length === 0 ? undefined : JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes)));
}

const DAY_NS = '86400000000000'; // 24 h in nanoseconds, as a U64 string

export interface KeyLogReader {
  /** `latest_keys(model, max_age_ns)`, 24 h window. */
  latestKeys(model: string): Promise<KeyEntry[]>;
  /** `entry(index)`; null when the index does not exist. */
  entry(index: number): Promise<KeyEntry | null>;
  /** `head()`; null while the log is empty. */
  head(): Promise<{ index: number; entry_hash: string } | null>;
}

export function keyLogReader(rpcUrl: string, contractId: string): KeyLogReader {
  return {
    latestKeys: async (model) => KeyEntry.array().parse(await viewFunction(rpcUrl, contractId, 'latest_keys', { model, max_age_ns: DAY_NS })),
    entry: async (index) => {
      const raw = await viewFunction(rpcUrl, contractId, 'entry', { index });
      return raw == null ? null : KeyEntry.parse(raw);
    },
    head: async () => {
      const raw = await viewFunction(rpcUrl, contractId, 'head', {});
      return raw == null ? null : (raw as { index: number; entry_hash: string });
    },
  };
}

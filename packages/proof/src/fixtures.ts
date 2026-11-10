// Test-only helpers: a loader for the recorded samples in docs/samples and docs/test-vectors (repo root = ../../..), and a stand-in for the NEAR JSON-RPC.
import { readFileSync } from 'node:fs';

const root = new URL('../../../', import.meta.url);

export function readRepoFile(path: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(path, root)));
}

export function readRepoText(path: string): string {
  return new TextDecoder().decode(readRepoFile(path));
}

export function readRepoJson<T = unknown>(path: string): T {
  return JSON.parse(readRepoText(path)) as T;
}

/** The body of a `## heading` section of a markdown text, up to the next `## ` or, with `toEnd`, to the end of the file. */
export function mdSection(md: string, heading: string, toEnd = false): string | undefined {
  const rest = md.split(`\n## ${heading}\n`)[1];
  return toEnd ? rest : rest?.split('\n## ')[0];
}

export interface RpcCall {
  account: string;
  method: string;
  args: Record<string, unknown>;
}

/**
 * Installs a `fetch` that plays the NEAR JSON-RPC: every view call is answered from `answer` (undefined reads as the contract
 * returning null), every access-key list from `keys`. Returns the calls it saw, a key list as method `view_access_key_list`.
 * The caller puts the real `fetch` back (afterEach).
 */
export function fakeRpc(answer: (call: RpcCall) => unknown, keys: (account: string) => unknown[] = () => []): RpcCall[] {
  const calls: RpcCall[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const p = (JSON.parse(String(init?.body)) as { params: { request_type: string; account_id: string; method_name?: string; args_base64?: string } }).params;
    if (p.request_type === 'view_access_key_list') {
      calls.push({ account: p.account_id, method: p.request_type, args: {} });
      return new Response(JSON.stringify({ result: { keys: keys(p.account_id) } }), { status: 200 });
    }
    const call: RpcCall = { account: p.account_id, method: p.method_name ?? '', args: JSON.parse(Buffer.from(p.args_base64 ?? '', 'base64').toString()) as Record<string, unknown> };
    calls.push(call);
    return new Response(JSON.stringify({ result: { result: [...Buffer.from(JSON.stringify(answer(call) ?? null))] } }), { status: 200 });
  }) as typeof fetch;
  return calls;
}

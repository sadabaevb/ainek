// A TDX quote verified against Intel's collateral, as @ainek/proof wants it. Its own subpath, so what does not verify quotes does not load a DCAP library.
import { setTimeout as sleep } from 'node:timers/promises';
import qvl from '@phala/dcap-qvl';
import { PolicyRun, quoteVerifierOf, verifyPolicyRun, type Check } from '@ainek/proof';

export const verifyTdxQuote = quoteVerifierOf(qvl.verify);

/**
 * Fetches a run's attestation and checks it. OutLayer answers 404 until the worker has uploaded the quote, so this waits for it, within a
 * limit that covers every request here: no attestation means no way to tell which code ran.
 */
export async function verifyPolicyRunAt(attestationUrl: string, x: { output: string; input: string; freshness?: { nowSeconds: number; maxAgeSeconds: number }; wasmHash: string; project: string; apiUrl: string; rpcUrl: string; network: 'testnet' | 'mainnet'; fetch?: typeof fetch; pollMs?: number; timeoutMs?: number }): Promise<Check[]> {
  const { fetch: f = fetch, pollMs = 1000, timeoutMs = 60_000, ...rest } = x;
  const signal = AbortSignal.timeout(timeoutMs);
  for (;;) {
    const res = await f(attestationUrl, { signal, redirect: 'error' });
    if (res.ok) return verifyPolicyRun({ ...rest, run: PolicyRun.parse(await res.json()), verifyQuote: verifyTdxQuote, fetch: f, signal });
    if (res.status !== 404) throw new Error(`OutLayer attestation: HTTP ${res.status}`);
    await sleep(pollMs, undefined, { signal });
  }
}

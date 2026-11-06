// A TDX quote verified against Intel's collateral, as @ainek/proof wants it. Its own subpath, so what does not verify quotes does not load a DCAP library.
import { setTimeout as sleep } from 'node:timers/promises';
import qvl from '@phala/dcap-qvl';
import { PolicyRun, bytesToHex, verifyPolicyRun, type Check, type QuoteVerifier } from '@ainek/proof';

export const verifyTdxQuote: QuoteVerifier = (quote, collateral, atSeconds) => {
  const verified = qvl.verify(Buffer.from(quote), collateral as qvl.Collateral, atSeconds);
  const td = verified.report.asTd10();
  if (!td) throw new Error('the quote is not a TD10 report');
  return {
    tcbStatus: verified.status,
    reportData: bytesToHex(td.reportData),
    measurements: { mrtd: bytesToHex(td.mrTd), rtmr0: bytesToHex(td.rtMr0), rtmr1: bytesToHex(td.rtMr1), rtmr2: bytesToHex(td.rtMr2), rtmr3: bytesToHex(td.rtMr3) },
  };
};

/**
 * Fetches a run's attestation and checks it. OutLayer answers 404 until the worker has uploaded the quote, so this waits for it, within a
 * limit: no attestation means no way to tell which code ran.
 */
export async function verifyPolicyRunAt(attestationUrl: string, x: { output: string; wasmHash: string; project: string; apiUrl: string; rpcUrl: string; network: 'testnet' | 'mainnet'; fetch?: typeof fetch; pollMs?: number; timeoutMs?: number }): Promise<Check[]> {
  const { fetch: f = fetch, pollMs = 1000, timeoutMs = 60_000, ...rest } = x;
  const signal = AbortSignal.timeout(timeoutMs);
  for (;;) {
    const res = await f(attestationUrl, { signal, redirect: 'error' });
    if (res.ok) return verifyPolicyRun({ ...rest, run: PolicyRun.parse(await res.json()), verifyQuote: verifyTdxQuote, fetch: f });
    if (res.status !== 404) throw new Error(`OutLayer attestation: HTTP ${res.status}`);
    await sleep(pollMs, undefined, { signal });
  }
}

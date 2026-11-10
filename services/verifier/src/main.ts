#!/usr/bin/env node
// Ainek verifier daemon (SPEC §3.2). Every VERIFIER_INTERVAL_MIN minutes, for each model in VERIFIER_MODELS:
// re-attest with a fresh nonce (VERIFIER_REPORTS_PER_ROUND times, so the replicas behind the gateway's balancer all
// get seen), verify the evidence locally, and append every verified signing key of the model to the public key log
// under this verifier's account, unless the same key+deployment was logged by us within the last 6 h. Each full report
// is kept in data/reports/<report_hash>.json so `report_hash` can always be checked.
//
//   pnpm -F verifier start          loop
//   pnpm -F verifier once           one round, exit 0 if every key was logged or already current
//   npx ainek-verify [--once]       same, as a bin
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { shortHex } from '@ainek/proof';
import { attestModel, withDeadline, type AttestationRound } from './attest.ts';
import { loadConfig, type VerifierConfig } from './config.ts';
import { alreadyLogged, keyLogWriter, type KeyLogWriter } from './log.ts';

export type KeyResult =
  | { model: string; key: string; outcome: 'logged'; index: number; txHash: string }
  | { model: string; key: string; outcome: 'current'; index: number }
  | { model: string; key: string; outcome: 'failed'; error: string };

/** near-api-js puts no deadline on sending a transaction. If `log_key` still lands after we gave up, the next
 *  round finds the entry in the log and does not write it twice. */
export const LOG_KEY_TIMEOUT_MS = 60_000;
/** The first retry after a failure; every further failure of the same key in a row doubles it, up to the interval. */
export const RETRY_AFTER_FAILURE_MS = 60_000;

/** Failures in a row per model and key after this round: one that failed again counts one more, the rest is forgotten. */
export function failureStreaks(results: readonly KeyResult[], previous: ReadonlyMap<string, number>): Map<string, number> {
  const streaks = new Map<string, number>();
  for (const r of results) {
    if (r.outcome === 'failed') streaks.set(`${r.model}/${r.key}`, (previous.get(`${r.model}/${r.key}`) ?? 0) + 1);
  }
  return streaks;
}

/** A new failure is retried soon: each lost round eats into the clients' 24 h window. The newest failure sets the
 *  pace, so a failure that stays (a replica whose evidence never verifies) backs off to the normal interval on its
 *  own, without slowing the retry of a transient error on another key. */
export function nextDelayMs(streaks: ReadonlyMap<string, number>, intervalMs: number): number {
  if (streaks.size === 0) return intervalMs;
  return Math.min(RETRY_AFTER_FAILURE_MS * 2 ** (Math.min(...streaks.values()) - 1), intervalMs);
}

/** Fetches and verifies one attestation report; `attestModel` in the daemon, a stub in the tests. */
export type Attest = (model: string) => Promise<AttestationRound>;

export async function runRound(cfg: VerifierConfig, writer: KeyLogWriter, log: (line: string) => void = console.log, attest: Attest = (model) => attestModel(model, { baseUrl: cfg.nearaiBaseUrl, acceptedTcbStatuses: cfg.acceptedTcbStatuses })): Promise<KeyResult[]> {
  const results: KeyResult[] = [];
  for (const model of cfg.models) {
    const started = performance.now();
    // Each request reaches one replica behind the gateway's balancer, so several reports a round are how every
    // replica's deployment gets logged soon after it appears. A fetch that fails is one report fewer and is only said
    // here (it does not fail the round or hasten the next one); the model's round fails only when none came back, or
    // the log cannot be read (without it we cannot dedup, and writing blindly would spend gas on every round). Either
    // way the daemon keeps running and tries again next round.
    const reports: AttestationRound[] = [];
    let recent;
    try {
      for (let i = 0; i < cfg.reportsPerRound; i++) {
        try {
          reports.push(await attest(model));
        } catch (err) {
          log(`${model}: report ${i + 1} of ${cfg.reportsPerRound} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (reports.length === 0) throw new Error('no attestation report could be fetched');
      mkdirSync(cfg.reportsDir, { recursive: true });
      for (const r of reports) writeFileSync(path.join(cfg.reportsDir, `${r.reportHash}.json`), r.reportBytes);
      recent = await writer.recentByMe(model, cfg.dedupWindowNs);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log(`${model}: NOT logged: ${error}`);
      results.push({ model, key: '', outcome: 'failed', error });
      continue;
    }

    // Keys sent earlier in this same round: two reports from the same replica, or two replicas with the same key and
    // compose, count once. A key counts as sent from the moment we try: a `log_key` we stopped waiting for may still
    // land, and must not be sent twice.
    const sentNow = new Set<string>();
    const keys = reports.flatMap((r) => r.keys);
    log(`${model}: ${reports.length} report(s) with ${keys.length} attestation(s) checked in ${((performance.now() - started) / 1000).toFixed(1)} s`);
    for (const k of keys) {
      if (!k.ok) {
        // Fail closed: a replica whose evidence does not verify is simply not logged; clients then refuse that key.
        log(`${model}: key ${shortHex(k.signingAddress)} NOT logged: ${k.error}`);
        results.push({ model, key: k.signingAddress, outcome: 'failed', error: k.error });
        continue;
      }
      const { entry } = k;
      const key = shortHex(entry.signing_address);
      log(`${model}: key ${key} verified: TCB ${entry.tcb_status}, GPU ${k.verified.gpuEvidence}, compose ${shortHex(entry.compose_hash)}, ${entry.image_digests.length} image digest(s)`);
      if (cfg.dryRun) {
        log(`${model}: dry run, nothing sent. A registered verifier would log this entry with log_key:\n${JSON.stringify(entry, null, 2)}`);
        results.push({ model, key: entry.signing_address, outcome: 'current', index: -1 });
        continue;
      }
      const pair = `${entry.signing_address}/${entry.compose_hash}`;
      const seen = alreadyLogged(entry, recent);
      if (seen || sentNow.has(pair)) {
        log(`${model}: key ${key} with this compose already ${seen ? `logged by us at index ${seen.index} within 6 h` : 'sent by us in this round'}, not logging again`);
        results.push({ model, key: entry.signing_address, outcome: 'current', index: seen?.index ?? -1 });
        continue;
      }
      try {
        sentNow.add(pair);
        const { index, txHash } = await withDeadline(writer.logKey(entry), LOG_KEY_TIMEOUT_MS, 'log_key');
        log(`logged ${model} key ${key} at index ${index}, tx ${txHash}`);
        results.push({ model, key: entry.signing_address, outcome: 'logged', index, txHash });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        log(`${model}: key ${key} NOT logged: ${error}`);
        results.push({ model, key: entry.signing_address, outcome: 'failed', error });
      }
    }
  }
  return results;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const once = dryRun || process.argv.includes('--once');
  const cfg = loadConfig(process.env, { dryRun });
  console.log(`Ainek verifier ${dryRun ? '(dry run, no account)' : cfg.accountId} → ${cfg.contract} (${cfg.rpcUrl}); models: ${cfg.models.join(', ')}; TCB policy: ${cfg.acceptedTcbStatuses.join(',')}; reports: ${cfg.reportsDir}`);
  // A dry run never signs: no key is loaded and both contract calls are skipped.
  const writer: KeyLogWriter = dryRun ? { recentByMe: async () => [], logKey: async () => Promise.reject(new Error('dry run')) } : keyLogWriter(cfg);
  const stamped = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
  let streaks = new Map<string, number>();
  for (;;) {
    const results = await runRound(cfg, writer, stamped);
    if (once) process.exit(results.every((r) => r.outcome !== 'failed') ? 0 : 1);
    streaks = failureStreaks(results, streaks);
    const delayMs = nextDelayMs(streaks, cfg.intervalMs);
    stamped(`next round in ${delayMs / 60_000} min`);
    await new Promise((r) => setTimeout(r, delayMs));
  }
}

// Run only when executed directly (tests import `runRound`). realpath: the `ainek-verify` bin is a symlink to this file.
const invoked = process.argv[1] ? safeRealpath(process.argv[1]) : '';
if (invoked === safeRealpath(import.meta.filename)) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  });
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

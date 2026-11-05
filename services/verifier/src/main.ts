#!/usr/bin/env node
// Ainek verifier daemon (SPEC §3.2). Every VERIFIER_INTERVAL_MIN minutes, for each model in VERIFIER_MODELS:
// re-attest with a fresh nonce, verify the evidence locally, and append every verified signing key of the model
// to the public key log under this verifier's account, unless the same key+deployment was logged by us within
// the last 6 h. The full report is kept in data/reports/<report_hash>.json so `report_hash` can always be checked.
//
//   pnpm -F verifier start          loop
//   pnpm -F verifier once           one round, exit 0 if every key was logged or already current
//   npx ainek-verify [--once]       same, as a bin
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { shortHex } from '@ainek/proof';
import { attestModel } from './attest.ts';
import { loadConfig, type VerifierConfig } from './config.ts';
import { alreadyLogged, keyLogWriter, type KeyLogWriter } from './log.ts';

export type KeyResult =
  | { model: string; key: string; outcome: 'logged'; index: number; txHash: string }
  | { model: string; key: string; outcome: 'current'; index: number }
  | { model: string; key: string; outcome: 'failed'; error: string };

export async function runRound(cfg: VerifierConfig, writer: KeyLogWriter, log: (line: string) => void = console.log): Promise<KeyResult[]> {
  const results: KeyResult[] = [];
  for (const model of cfg.models) {
    const started = performance.now();
    // Anything that fails before the per-key loop (attestation fetch, disk, reading the log) fails this model's
    // round and nothing else: the daemon keeps running and tries again next interval.
    let round;
    let recent;
    try {
      round = await attestModel(model, { baseUrl: cfg.nearaiBaseUrl, acceptedTcbStatuses: cfg.acceptedTcbStatuses });
      mkdirSync(cfg.reportsDir, { recursive: true });
      writeFileSync(path.join(cfg.reportsDir, `${round.reportHash}.json`), round.reportBytes);
      log(`${model}: report with ${round.keys.length} attestation(s) checked in ${((performance.now() - started) / 1000).toFixed(1)} s`);
      // Without the log we cannot dedup; writing blindly would spend gas on every round, so skip this model.
      recent = await writer.recentByMe(model, cfg.dedupWindowNs);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log(`${model}: NOT logged: ${error}`);
      results.push({ model, key: '', outcome: 'failed', error });
      continue;
    }

    // Keys logged earlier in this same round: two replicas with the same key and compose count once.
    const loggedNow = new Set<string>();
    for (const k of round.keys) {
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
      if (seen || loggedNow.has(pair)) {
        log(`${model}: key ${key} with this compose already logged by us${seen ? ` at index ${seen.index} within 6 h` : ' in this round'}, not logging again`);
        results.push({ model, key: entry.signing_address, outcome: 'current', index: seen?.index ?? -1 });
        continue;
      }
      try {
        const { index, txHash } = await writer.logKey(entry);
        loggedNow.add(pair);
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
  for (;;) {
    const results = await runRound(cfg, writer, stamped);
    if (once) process.exit(results.every((r) => r.outcome !== 'failed') ? 0 : 1);
    stamped(`next round in ${cfg.intervalMs / 60_000} min`);
    await new Promise((r) => setTimeout(r, cfg.intervalMs));
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

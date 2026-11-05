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
    let round;
    try {
      round = await attestModel(model, { baseUrl: cfg.nearaiBaseUrl, acceptedTcbStatuses: cfg.acceptedTcbStatuses });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log(`${model}: NOT logged: ${error}`);
      results.push({ model, key: '', outcome: 'failed', error });
      continue;
    }
    mkdirSync(cfg.reportsDir, { recursive: true });
    writeFileSync(path.join(cfg.reportsDir, `${round.reportHash}.json`), round.reportBytes);
    const took = ((performance.now() - started) / 1000).toFixed(1);
    log(`${model}: report with ${round.keys.length} attestation(s) checked in ${took} s`);

    let recent;
    try {
      recent = await writer.recentByMe(model, cfg.dedupWindowNs);
    } catch (err) {
      // Without the log we cannot dedup; writing blindly would spend gas on every round, so skip this model.
      const error = `cannot read the key log: ${err instanceof Error ? err.message : String(err)}`;
      log(`${model}: NOT logged: ${error}`);
      results.push({ model, key: '', outcome: 'failed', error });
      continue;
    }

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
      const seen = alreadyLogged(entry, recent);
      if (seen) {
        log(`${model}: key ${key} with this compose already logged by us at index ${seen.index} within 6 h, not logging again`);
        results.push({ model, key: entry.signing_address, outcome: 'current', index: seen.index });
        continue;
      }
      try {
        const { index, txHash } = await writer.logKey(entry);
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
  const once = process.argv.includes('--once');
  const cfg = loadConfig();
  console.log(`Ainek verifier ${cfg.accountId} → ${cfg.contract} (${cfg.rpcUrl}); models: ${cfg.models.join(', ')}; TCB policy: ${cfg.acceptedTcbStatuses.join(',')}; reports: ${cfg.reportsDir}`);
  const writer = keyLogWriter(cfg);
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

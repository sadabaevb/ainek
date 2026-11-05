#!/usr/bin/env node
// Ainek verifier daemon (SPEC §3.2). Every VERIFIER_INTERVAL_MIN minutes, for each model in VERIFIER_MODELS:
// re-attest with a fresh nonce, verify the evidence locally, and append the model's signing key to the public
// key log under this verifier's account, unless the same key+deployment was logged by us within the last 6 h.
// The full report is kept in data/reports/<report_hash>.json so `report_hash` in the log can always be checked.
//
//   pnpm -F verifier start          loop
//   pnpm -F verifier once           one round, exit 0 if every model was logged or already current
//   npx ainek-verify [--once]       same, as a bin
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { shortHex } from '@ainek/proof';
import { attestModel } from './attest.ts';
import { loadConfig, type VerifierConfig } from './config.ts';
import { alreadyLogged, keyLogWriter, type KeyLogWriter } from './log.ts';

export type RoundResult = { model: string; outcome: 'logged'; index: number; txHash: string } | { model: string; outcome: 'current'; index: number } | { model: string; outcome: 'failed'; error: string };

export async function runRound(cfg: VerifierConfig, writer: KeyLogWriter, log: (line: string) => void = console.log): Promise<RoundResult[]> {
  const results: RoundResult[] = [];
  for (const model of cfg.models) {
    const started = performance.now();
    try {
      const round = await attestModel(model, { baseUrl: cfg.nearaiBaseUrl, acceptedTcbStatuses: cfg.acceptedTcbStatuses });
      const { entry } = round;
      const took = ((performance.now() - started) / 1000).toFixed(1);
      log(`${model}: attested in ${took} s: key ${shortHex(entry.signing_address)}, TCB ${entry.tcb_status}, GPU ${round.verified.gpuEvidence}, compose ${shortHex(entry.compose_hash)}, ${entry.image_digests.length} image digest(s)`);

      mkdirSync(cfg.reportsDir, { recursive: true });
      writeFileSync(path.join(cfg.reportsDir, `${entry.report_hash}.json`), round.reportBytes);

      const recent = await writer.recentByMe(model, cfg.dedupWindowNs);
      const seen = alreadyLogged(entry, recent);
      if (seen) {
        log(`${model}: key ${shortHex(entry.signing_address)} already logged by us at index ${seen.index} within 6 h, not logging again`);
        results.push({ model, outcome: 'current', index: seen.index });
        continue;
      }
      const { index, txHash } = await writer.logKey(entry);
      log(`logged ${model} key ${shortHex(entry.signing_address)} at index ${index}, tx ${txHash}`);
      results.push({ model, outcome: 'logged', index, txHash });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      // Fail closed: a model whose evidence does not verify is simply not logged; clients then refuse it.
      log(`${model}: NOT logged: ${error}`);
      results.push({ model, outcome: 'failed', error });
    }
  }
  return results;
}

async function main(): Promise<void> {
  const once = process.argv.includes('--once');
  const cfg = loadConfig();
  console.log(`Ainek verifier ${cfg.accountId} → ${cfg.contract} (${cfg.rpcUrl}); models: ${cfg.models.join(', ')}; TCB policy: ${cfg.acceptedTcbStatuses.join(',')}; reports: ${cfg.reportsDir}`);
  const writer = keyLogWriter(cfg);
  for (;;) {
    const stamp = new Date().toISOString();
    const results = await runRound(cfg, writer, (line) => console.log(`${stamp} ${line}`));
    if (once) process.exit(results.every((r) => r.outcome !== 'failed') ? 0 : 1);
    console.log(`${stamp} next round in ${cfg.intervalMs / 60_000} min`);
    await new Promise((r) => setTimeout(r, cfg.intervalMs));
  }
}

// Run only when executed directly (tests import `runRound`).
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  });
}

// `pnpm demo:metrics [--runs N] [--out <file>]`: N live Tier-1 runs for the README metrics table.
// Each run is @ainek/tier1-node, what the chat does, from Node, direct to NEAR AI, nothing cached: a cold first message. On top, the
// public-log rule is checked with a swapped key against the same log read, as the chat's tamper switch does. Per-run timings
// and outcomes go to a JSON file; a markdown table is printed for the README. The on-chain commit is not part of a run (it
// needs a wallet); its cost was measured once (docs/DEV-NOTES.md).
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { DEMO_SWAPPED_KEY, evaluateKeyLog } from '@ainek/proof';
import { contractLog, runTier1, type StepId, type Timings } from '@ainek/tier1-node';
import { loadLiveEnv } from './env.ts';
import { FAIL, OK, describe, exitFlushed, line, seconds } from './term.ts';

const flags = (() => {
  try {
    return parseArgs({ options: { runs: { type: 'string', default: '10' }, out: { type: 'string' } }, strict: true }).values;
  } catch (err) {
    return usage(describe(err));
  }
})();
const runs = Number(flags.runs);
if (!Number.isInteger(runs) || runs < 1) usage('--runs must be a positive integer');
// The default is docs/metrics.json in the repo wherever the script was started from; an explicit --out is relative to where pnpm ran
// (INIT_CWD). Checked before the first paid run: a missing directory must not throw after 50 of them.
const outFile = flags.out === undefined ? path.resolve(import.meta.dirname, '../../../docs/metrics.json') : path.resolve(process.env.INIT_CWD ?? process.cwd(), flags.out);
if (!existsSync(path.dirname(outFile))) usage(`--out: directory ${path.dirname(outFile)} does not exist`);

const env = loadLiveEnv();
const apiKey: string = env.apiKey ?? usage('NEARAI_API_KEY is not set (root .env)');
const { cfg } = env;
if (cfg.logSource !== 'contract') usage('metrics need the live log (AINEK_LOG_SOURCE=contract)');
const PROMPT = 'Reply with the single word: ok.';
const rpcHost = new URL(cfg.rpcUrl).host;
const readLog = contractLog(cfg);

/** One run. `outcome` is what the chat would have shown; timings only for the steps that ran (@ainek/tier1-node). */
interface Run {
  outcome: 'verified' | 'refused' | 'failed';
  /** Where a run that did not verify stopped. */
  step?: StepId;
  error?: string;
  /** SDK-retryable failures retried on the way, as the chat does. */
  retries: number;
  /** The chat's tamper switch against this run's log read: the swapped key must be refused. Unset when the log was never read. */
  swappedRefused?: boolean;
  timings: Timings;
  totalMs: number;
  bytesSent?: number;
  bytesReceived?: number;
}

async function runOnce(): Promise<Run> {
  const o = await runTier1({ apiKey, cfg, chat: { messages: [{ role: 'user', content: PROMPT }] }, readLog });
  const base = { retries: o.retries, timings: o.timings, totalMs: o.totalMs };
  if (o.kind === 'failed') return { outcome: 'failed', step: o.step, error: o.reason, ...base };
  const swappedRefused = evaluateKeyLog(o.entries, { model: cfg.model, signingAddress: DEMO_SWAPPED_KEY, trustedVerifiers: cfg.trustedVerifiers, quorum: cfg.quorum }).status !== 'ok';
  if (o.kind === 'refused') return { outcome: 'refused', step: o.step, error: o.reason, swappedRefused, ...base };
  return { outcome: 'verified', swappedRefused, bytesSent: o.requestBody.length, bytesReceived: o.responseBody.length, ...base };
}

console.log(`Ainek metrics: ${runs} live run(s) of ${cfg.model} via ${cfg.nearaiBaseUrl}, log ${cfg.contract} via ${rpcHost}, Node ${process.version}; direct (no relay), attestation cold every run`);
const results: Run[] = [];
const sec = (ms: number | undefined) => (ms === undefined ? '—' : seconds(ms));
for (let n = 1; n <= runs; n++) {
  const run = await runOnce();
  results.push(run);
  const t = run.timings;
  const retried = run.retries ? `, ${run.retries} retr${run.retries === 1 ? 'y' : 'ies'}` : '';
  line(run.outcome === 'verified' ? OK : FAIL, `run ${n}: ${run.outcome} in ${seconds(run.totalMs)} (attestation ${sec(t.attestation)}, log ${sec(t['key-log'])}, reply ${sec(t.send)}, signature ${sec(t.signature)}${retried}); swapped key refused: ${run.swappedRefused ?? 'not checked'}${run.error ? `; ${run.step}: ${run.error}` : ''}`);
}

// The table: counts over every run, times over the runs that reached the step (a run that failed earlier has no number for it).
const verified = results.filter((r) => r.outcome === 'verified');
const count = (keep: (r: Run) => boolean) => `${results.filter(keep).length} of ${results.length}`;
const of = (pick: (r: Run) => number | undefined, from = results) => from.map(pick).filter((x): x is number => x !== undefined);
const quantile = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.max(0, Math.ceil(p * xs.length) - 1)]; // nearest rank: the 25th and 45th of 50
const spread = (xs: number[]) => {
  const [median, p90] = [quantile(xs, 0.5), quantile(xs, 0.9)];
  return median === undefined || p90 === undefined ? 'n/a' : `median ${seconds(median)}, p90 ${seconds(p90)}`;
};
// What a second message in the same hour costs: the chat keeps the verified deployment and the metadata for 60 minutes, so it
// pays only for the steps after them. Derived from the same runs: these steps run one after another there as well.
const WARM: readonly StepId[] = ['key-log', 'encrypt', 'send', 'signature', 'sdk-check', 'proof'];
const laterMessage = (r: Run) => (r.outcome === 'verified' ? WARM.reduce((sum, id) => sum + (r.timings[id] ?? 0), 0) : undefined);

console.log(`\nFrom Node ${process.version}, direct to NEAR AI (no relay), attestation cold on every run; the browser caches it for 60 minutes after the first message.\n`);
console.log(`| Metric | Value (${results.length} runs) |\n| --- | --- |`);
console.log(`| Verified, attestation to proof (the on-chain commit is measured once, below) | ${count((r) => r.outcome === 'verified')} |`);
console.log(`| Log check refuses a swapped key (the rule behind the chat's switch, on each run's log read; nothing is sent for it) | ${count((r) => r.swappedRefused === true)} |`);
console.log(`| Honest key refused (log window empty or key unlogged) | ${count((r) => r.outcome === 'refused')} |`);
console.log(`| Runs that needed an SDK retry | ${count((r) => r.retries > 0)} |`);
console.log(`| Attestation (gateway + model, re-fetched, in Node) | ${spread(of((r) => r.timings.attestation))} |`);
console.log(`| Public log read (${1 + cfg.trustedVerifiers.length} \`latest_keys\` views at once, ${rpcHost}) | ${spread(of((r) => r.timings['key-log']))} |`);
console.log(`| E2EE round trip to the model | ${spread(of((r) => r.timings.send, verified))} |`);
console.log(`| Signature fetch | ${spread(of((r) => r.timings.signature, verified))} |`);
console.log(`| Whole run, evidence re-fetched (a real first message can be slower, see above) | ${spread(of((r) => r.totalMs, verified))} |`);
console.log(`| Later message, attestation cached (not timed: each run's steps after attestation, added up) | ${spread(of(laterMessage, verified))} |`);
console.log(`| Request and response body (encrypted fields plus plain metadata) | median ${quantile(of((r) => r.bytesSent, verified), 0.5) ?? '?'} B sent, ${quantile(of((r) => r.bytesReceived, verified), 0.5) ?? '?'} B received |`);
writeFileSync(outFile, `${JSON.stringify({ meta: { model: cfg.model, baseUrl: cfg.nearaiBaseUrl, contract: cfg.contract, rpcUrl: cfg.rpcUrl, node: process.version, measuredAt: new Date().toISOString(), prompt: PROMPT, note: 'from Node, direct to NEAR AI (no relay), evidence re-fetched on every run; connections and proxy caches may be warm; times in ms' }, runs: results }, null, 2)}\n`);
console.log(`\nwritten: ${outFile}`);
// Non-zero when any run did not verify or the swapped key got through: the two things the table must never show silently.
await exitFlushed(verified.length === results.length && results.every((r) => r.swappedRefused === true) ? 0 : 1);

function usage(reason: string): never {
  console.error(`${reason}\nusage: pnpm demo:metrics [--runs N] [--out <file>]   (default: 10 runs, docs/metrics.json)`);
  return process.exit(2);
}

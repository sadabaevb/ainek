// `pnpm demo:reply-key [--record]`: a negative control for E2EE v3, with a harmless prompt of our own.
//
// NEAR AI's E2EE route had a reply-key-substitution finding (nearai/cloud-api#1061): the key the enclave encrypts its reply
// to travels in a header, and E2EE v1/v2 did not bind it, so a hop between the client and the enclave could swap in a key
// of its own and read the reply. v3 binds the reply key into the associated data of every encrypted request field. This
// command checks that the deployed proxy enforces that, in three runs of the Tier-1 sequence the client uses:
//   1. no hop: the exchange verifies. It shows the request itself is good (one paid completion, cents);
//   2. a hop swaps the reply key for its own;
//   3. the hop also rewrites the version header from 3 to 2, asking for the protocol that bound nothing.
// Runs 2 and 3 must be refused where a reply would have been. A reply there would mean the enclave answered to a key the
// client did not send. Needs NEARAI_API_KEY. `--record` writes what came back to docs/samples/reply-key-control.json.
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { oneLine } from '@ainek/proof';
import { contractLog, readHopOutcome, runTier1, swapReplyKey, type HopResult } from '@ainek/tier1-node';
import { loadLiveEnv } from './env.ts';
import { samplesDir } from './evidence.ts';
import { FAIL, NA, OK, exitFlushed, head, line, seconds } from './term.ts';

const usage = (problem: string): never => {
  console.error(`${problem}\nusage: pnpm demo:reply-key [--record]`);
  return process.exit(2);
};
const flags = (() => {
  try {
    return parseArgs({ options: { record: { type: 'boolean', default: false } }, strict: true }).values;
  } catch (err) {
    return usage(err instanceof Error ? err.message : String(err));
  }
})();
const env = loadLiveEnv();
const apiKey: string = env.apiKey ?? usage('NEARAI_API_KEY is not set (root .env): this control sends one real request');
const { cfg } = env;
if (cfg.logSource !== 'contract') usage('pnpm demo:reply-key reads the live log (AINEK_LOG_SOURCE=contract)');

const chat = { messages: [{ role: 'user' as const, content: 'Reply with exactly three words.' }] };
async function run(hop?: (request: Request) => Request): Promise<HopResult & { ms: number }> {
  const outcome = await runTier1({ apiKey, cfg, chat, readLog: contractLog(cfg), ...(hop ? { hop } : {}) });
  return { ...readHopOutcome(outcome), ms: outcome.totalMs };
}
/** What a server wrote, on one line and without control characters, before it is printed or recorded. */
const said = (r: HopResult): string => oneLine(r.detail, 300);

console.log(`Ainek reply-key control: ${cfg.model} via ${cfg.nearaiBaseUrl}, E2EE v3`);
head('1. No hop: the exchange as the client makes it');
const honest = await run();
line(honest.kind === 'verified' ? OK : FAIL, `${said(honest)} (${seconds(honest.ms)})`);

const controls: { key: string; result: HopResult }[] = [];
if (honest.kind === 'verified') {
  for (const { title, key, downgrade } of [
    { title: '2. A hop swaps the reply key for its own', key: 'swapped', downgrade: false },
    { title: '3. The hop also rewrites the version header from 3 to 2', key: 'swappedAndDowngraded', downgrade: true },
  ]) {
    head(title);
    const result = await run(swapReplyKey({ downgrade }));
    controls.push({ key, result });
    if (result.kind === 'refused') line(OK, `refused where a reply would have been: HTTP ${result.status} ${said(result)} (${seconds(result.ms)})`);
    else if (result.kind === 'answered' || result.kind === 'verified') line(FAIL, `a reply came back although the reply key was swapped: ${said(result)}`);
    else line(NA, `says nothing about the reply key: ${result.status ? `HTTP ${result.status} ` : ''}${said(result)}`);
  }
}

const refused = controls.length === 2 && controls.every((c) => c.result.kind === 'refused');
const answered = controls.some((c) => c.result.kind === 'answered' || c.result.kind === 'verified');
console.log(
  honest.kind !== 'verified'
    ? '\nResult: NOT RUN. The unmodified exchange did not verify, so the controls would show nothing.'
    : refused
      ? '\nResult: REFUSED. A request whose reply key was swapped got no reply, with and without the downgrade.'
      : answered
        ? '\nResult: ANSWERED. The enclave replied to a key the client did not send: the reply key is not bound.'
        : '\nResult: INCONCLUSIVE. A control ended for a reason that says nothing about the reply key; run it again.',
);

if (flags.record && honest.kind === 'verified') {
  const name = 'reply-key-control.json';
  const recorded = { recordedAt: new Date().toISOString(), model: cfg.model, sdk: '@nearai/inference-sdk 0.3.0', encryptionVersion: 3, honest: { kind: honest.kind }, ...Object.fromEntries(controls.map(({ key, result }) => [key, { kind: result.kind, ...(result.status ? { status: result.status } : {}), detail: said(result) }])) };
  writeFileSync(new URL(name, samplesDir), `${JSON.stringify(recorded, null, 2)}\n`);
  console.log(`recorded: docs/samples/${name}`);
}
await exitFlushed(refused ? 0 : 1);

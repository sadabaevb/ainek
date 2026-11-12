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
// client did not send. Each run is a whole cold run of the client, so no control leans on state another one left.
// Needs NEARAI_API_KEY. `--record` writes what came back to docs/samples/reply-key-control.json.
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { oneLine } from '@ainek/proof';
import { contractLog, runTier1, type Tier1Outcome } from '@ainek/tier1-node';
import { readHopOutcome, swapReplyKey, type HopResult } from '@ainek/tier1-node/hop';
import { loadLiveEnv } from './env.ts';
import { samplesDir } from './evidence.ts';
import { FAIL, NA, OK, exitFlushed, head, line, seconds } from './term.ts';

const usage = (problem: string): never => {
  console.error(`${problem}\nusage: pnpm demo:reply-key [--record]`);
  process.exit(2);
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
const run = (controlHop?: (request: Request) => Request): Promise<Tier1Outcome> => runTier1({ apiKey, cfg, chat, readLog: contractLog(cfg), controlHop });
/** What a server wrote, on one line and without control characters, before it is printed or recorded. */
const said = (r: HopResult): string => oneLine(r.detail);
/** A reply came back: for a control, the finding. */
const replied = (r: HopResult): boolean => r.kind === 'answered' || r.kind === 'verified';

console.log(`Ainek reply-key control: ${cfg.model} via ${cfg.nearaiBaseUrl}, E2EE v3`);
head('1. No hop: the exchange as the client makes it');
const honestRun = await run();
const honest = readHopOutcome(honestRun);
line(honest.kind === 'verified' ? OK : FAIL, `${said(honest)} (${seconds(honestRun.totalMs)})`);

/** One control: the same client behind a hop that swaps the reply key. */
async function control(title: string, downgrade: boolean): Promise<HopResult> {
  head(title);
  const outcome = await run(swapReplyKey({ downgrade }));
  const result = readHopOutcome(outcome);
  if (result.kind === 'refused') line(OK, `refused where a reply would have been${result.decryptionFailed ? '' : ', though not with a word about decryption (read the answer)'}: ${said(result)} (${seconds(outcome.totalMs)})`);
  else if (replied(result)) line(FAIL, `a reply came back although the reply key was swapped: ${said(result)}`);
  else line(NA, `says nothing about the reply key: ${said(result)}`);
  return result;
}
// Without a verified exchange first, a refusal of the controls would show nothing: the request itself might be bad.
const controls = honest.kind === 'verified' ? [await control('2. A hop swaps the reply key for its own', false), await control('3. The hop also rewrites the version header from 3 to 2', true)] : [];

const verdict = honest.kind !== 'verified' ? 'NOT RUN' : controls.some(replied) ? 'ANSWERED' : controls.every((r) => r.kind === 'refused') ? 'REFUSED' : 'INCONCLUSIVE';
console.log(
  `\nResult: ${verdict}. ${
    {
      'NOT RUN': 'The unmodified exchange did not verify, so the controls would show nothing.',
      ANSWERED: 'The enclave replied to a key the client did not send: the reply key is not bound.',
      REFUSED: 'A request whose reply key was swapped got no reply, with and without the downgrade.',
      INCONCLUSIVE: 'A control ended for a reason that says nothing about the reply key; run it again.',
    }[verdict]
  }`,
);

if (flags.record && honestRun.kind === 'verified') {
  const [swapped, swappedAndDowngraded] = controls.map((r) => ({ kind: r.kind, status: r.status, decryptionFailed: r.decryptionFailed, detail: said(r) }));
  // The honest run is named by what anyone can look up: its completion id, the signing key and the log entry it was checked against.
  const honestRecord = { kind: honestRun.kind, completionId: honestRun.completion.id, signingKey: honestRun.signer.signer.signingAddress, logEntry: honestRun.logEntry.index };
  const recorded = { recordedAt: new Date().toISOString(), model: cfg.model, sdk: '@nearai/inference-sdk 0.3.0', encryptionVersion: 3, verdict, honest: honestRecord, swapped, swappedAndDowngraded };
  writeFileSync(new URL('reply-key-control.json', samplesDir), `${JSON.stringify(recorded, null, 2)}\n`);
  console.log('recorded: docs/samples/reply-key-control.json');
}
await exitFlushed(verdict === 'REFUSED' ? 0 : 1);

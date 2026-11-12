// `pnpm demo:reply-key [--record]`: a negative control for the client's E2EE version, with a harmless prompt of our own.
//
// NEAR AI's E2EE route had a reply-key-substitution finding (nearai/cloud-api#1061): the key the enclave encrypts its reply
// to travels in a header, and E2EE v1/v2 did not bind it, so a hop between the client and the enclave could swap in a key
// of its own and read the reply. v3 binds the reply key into the associated data of every encrypted request field. This
// command checks that the deployed proxy enforces that, in three runs of the Tier-1 sequence the client uses:
//   1. no hop: the exchange verifies. It shows the request itself is good (one paid completion, cents);
//   2. a hop swaps the reply key for its own;
//   3. the hop also rewrites the version header to 2, asking for the protocol that bound nothing.
// Runs 2 and 3 must be refused with "decryption failed" where a reply would have been. A reply there would mean the
// enclave answered to a key the client did not send. Each run is a whole cold run of the client, so no control leans on
// state another one left. Needs NEARAI_API_KEY. `--record` writes a conclusive result to docs/samples/reply-key-control.json.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { E2EE_VERSION, oneLine } from '@ainek/proof';
import { contractLog, runTier1, type Tier1Outcome } from '@ainek/tier1-node';
import { readHopOutcome, swapReplyKey, type HopResult } from '@ainek/tier1-node/hop';
import { loadLiveEnv } from './env.ts';
import { REPLY_KEY_CONTROL, samplesDir, type ReplyKeyControl } from './evidence.ts';
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

/** The installed version of NEAR AI's SDK, from its own package file: what encrypted these requests. */
const sdkVersion = (JSON.parse(readFileSync(new URL('../package.json', import.meta.resolve('@nearai/inference-sdk/node')), 'utf8')) as { version: string }).version;
const chat = { messages: [{ role: 'user' as const, content: 'Reply with exactly three words.' }] };
const run = (controlHop?: (request: Request) => Request): Promise<Tier1Outcome> => runTier1({ apiKey, cfg, chat, readLog: contractLog(cfg), controlHop });
/** What a server wrote, on one line and without control characters, for the terminal. */
const said = (r: HopResult): string => oneLine(r.detail);

// The runner refuses to send a request the SDK did not mark with this version, so a run that was sent was this version.
console.log(`Ainek reply-key control: ${cfg.model} via ${cfg.nearaiBaseUrl}, E2EE v${E2EE_VERSION}, SDK ${sdkVersion}`);
head('1. No hop: the exchange as the client makes it');
const honestRun = await run();
const honest = readHopOutcome(honestRun);
line(honest.kind === 'verified' ? OK : FAIL, `${said(honest)} (${seconds(honestRun.totalMs)})`);

/** One control: the same client behind a hop that swaps the reply key. */
async function control(title: string, downgrade: boolean): Promise<HopResult> {
  head(title);
  const outcome = await run(swapReplyKey({ downgrade }));
  const result = readHopOutcome(outcome);
  const status = result.status === undefined ? '' : `HTTP ${result.status} `;
  if (result.kind === 'refused') line(OK, `refused where a reply would have been: ${status}${said(result)} (${seconds(outcome.totalMs)})`);
  else if (result.kind === 'answered') line(FAIL, `a reply came back although the reply key was swapped: ${status}${said(result)}`);
  // The client read the reply with its own key, so the swapped header changed nothing: the control did not exercise the binding.
  else if (result.kind === 'verified') line(NA, 'the exchange verified although the reply key header was swapped: the swap had no effect, so this run shows nothing');
  else line(NA, `says nothing about the reply key: ${status}${said(result)}`);
  return result;
}
// Without a verified exchange first, a refusal of the controls would show nothing: the request itself might be bad.
const controls = honest.kind === 'verified' ? [await control('2. A hop swaps the reply key for its own', false), await control('3. The hop also rewrites the version header to 2', true)] : [];

const verdict = honest.kind !== 'verified' ? 'NOT RUN' : controls.some((r) => r.kind === 'answered') ? 'ANSWERED' : controls.every((r) => r.kind === 'refused') ? 'REFUSED' : 'INCONCLUSIVE';
console.log(
  `\nResult: ${verdict}. ${
    {
      'NOT RUN': 'The unmodified exchange did not verify, so the controls would show nothing.',
      ANSWERED: 'The enclave replied to a key the client did not send: the reply key is not bound.',
      REFUSED: 'A request whose reply key was swapped got "decryption failed" and no reply, with and without the downgrade.',
      INCONCLUSIVE: 'A control ended for a reason that says nothing about the reply key; run it again.',
    }[verdict]
  }`,
);

if (flags.record) {
  // Only a result that says something replaces the recording the documents cite.
  if (honestRun.kind !== 'verified' || (verdict !== 'REFUSED' && verdict !== 'ANSWERED')) console.log('nothing written: the result is not conclusive');
  else {
    const [swapped, swappedAndDowngraded] = controls; // each as it came: the kind, the HTTP status and the service's own words
    // The honest run is named by what anyone can look up: its completion id, the model's public signing key and the log entry it was checked against.
    const honestRecord = { kind: honestRun.kind, completionId: honestRun.completion.id, signingKey: honestRun.signer.signer.signingAddress, logEntry: honestRun.logEntry.index };
    const recorded: ReplyKeyControl = { recordedAt: new Date().toISOString(), model: cfg.model, sdk: `@nearai/inference-sdk ${sdkVersion}`, encryptionVersion: Number(E2EE_VERSION), verdict, honest: honestRecord, swapped, swappedAndDowngraded };
    writeFileSync(new URL(REPLY_KEY_CONTROL, samplesDir), `${JSON.stringify(recorded, null, 2)}\n`);
    console.log(`recorded: docs/samples/${REPLY_KEY_CONTROL}`);
  }
}
await exitFlushed(verdict === 'REFUSED' ? 0 : 1);

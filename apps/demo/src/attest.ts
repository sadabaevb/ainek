// `pnpm demo:attest`: the live checks up to the send, with no API key and no spend. NEAR AI serves model metadata and attestation
// reports without a key, so this verifies the gateway's and the model's evidence here (Intel TDX through Intel PCS, the GPU through
// NVIDIA NRAS), reads the public log from the NEAR contract and applies the client's fail-closed rule. Then it stops: no message
// exists, so nothing is encrypted, sent or signed. The full exchange is `pnpm demo:live` (needs NEARAI_API_KEY).
//
// It then follows the code behind the key: the action log the model's enclave attests names the release that serves the model,
// and that release is followed to a file in NEAR AI's public compose repository and to the signed build of the proxy image
// (public GitHub reads; GITHUB_TOKEN is optional and only raises GitHub's anonymous rate limit). `--history` adds, for every
// release in the log, how long its commit had existed when it first ran.
import { parseArgs } from 'node:util';
import { DEMO_SWAPPED_KEY, attestedLogsOf, composeHashOf, evaluateKeyLog, normalizeHex, shortHex as short, withReleaseRule } from '@ainek/proof';
import { contractLog, runPreflight, type StepId } from '@ainek/tier1-node';
import { inspectRelease, leadTimes, verdictOf } from '@ainek/tier1-node/release';
import { loadLiveEnv } from './env.ts';
import { printLeadTimes, printRelease } from './release-report.ts';
import { FAIL, NA, OK, exitFlushed, head, line, out, seconds } from './term.ts';

const flags = (() => {
  try {
    return parseArgs({ options: { history: { type: 'boolean', default: false } }, strict: true }).values;
  } catch (err) {
    console.error(`${err instanceof Error ? err.message : String(err)}\nusage: pnpm demo:attest [--history]`);
    return process.exit(2);
  }
})();

const { cfg } = loadLiveEnv();
// Optional and never needed: without it GitHub allows 60 anonymous requests an hour from one address, enough for a few runs.
// A token GitHub refuses (expired, revoked) is dropped after the first 401 and the public data is read anonymously.
const githubToken = process.env.GITHUB_TOKEN || undefined;
if (cfg.logSource !== 'contract') {
  console.error('pnpm demo:attest reads the live log (AINEK_LOG_SOURCE=contract); the recorded one is checked by pnpm demo');
  process.exit(2);
}
const { model } = cfg;

console.log(`Ainek live check, no API key: ${model} via ${cfg.nearaiBaseUrl}, log ${cfg.contract} on ${cfg.network}`);
const HEADS: Partial<Record<StepId, string>> = { metadata: `0. Model metadata: ${model}`, attestation: '1–2. Gateway and model attestation, verified in this process', 'key-log': '3. Public key log, read from the contract' };
const outcome = await runPreflight({
  cfg,
  readLog: contractLog(cfg),
  onStep: (e) => {
    const title = HEADS[e.id];
    if (title) head(title);
    line(e.status === 'ok' ? OK : FAIL, e.status === 'ok' ? `${e.detail} (${seconds(e.ms)})` : e.detail);
  },
});

let swappedRefused = false;
let codeFailed = false;
if (outcome.kind === 'failed') {
  console.log(`\nResult: FAILED at ${outcome.step}. Nothing was sent.`);
} else {
  // The rule the chat's first demo switch shows, applied to the same log read: a key nobody logged is refused. Only "absent"
  // shows that rule; a split view refuses every key, and says nothing about this one.
  const swapped = evaluateKeyLog(outcome.entries, { model, signingAddress: DEMO_SWAPPED_KEY, trustedVerifiers: cfg.trustedVerifiers, quorum: cfg.quorum });
  swappedRefused = swapped.status !== 'ok';
  head('4. The same log read against a swapped key');
  if (swapped.status === 'ok') line(FAIL, `the demo key ${short(DEMO_SWAPPED_KEY)} is in the log: it must not be`);
  else if (swapped.reason === 'absent') line(OK, `${short(DEMO_SWAPPED_KEY)} would be refused: ${swapped.detail}`);
  else line(NA, `not shown by this read, which refuses every key: ${swapped.detail}`);
  if (outcome.kind === 'refused') {
    console.log('\nResult: WOULD REFUSE (step 3). Nothing was sent.');
  } else if (!swappedRefused) {
    console.log('\nResult: FAILED. The log check accepted a key nobody should have logged. Nothing was sent.');
  } else {
    const { signer: m, logEntry } = outcome;
    const compose = composeHashOf(m.deployment);
    // The code behind the key. Informational for the send decision, which rests on the key and the launcher's compose hash;
    // a check here that fails still fails this command.
    const inspection = await inspectRelease({ deployment: m.deployment, report: m.report, model, githubToken });
    // The client's release rule on the log this run read (SPEC §7.5): is the action log this enclave attests one a trusted
    // verifier checked and logged? When the setting is on, the send decision above has applied it already.
    const key = m.signer.signingAddress;
    const inLog = withReleaseRule(outcome.verdict, outcome.entries, { model, signingAddress: key, trustedVerifiers: cfg.trustedVerifiers, quorum: cfg.quorum }, attestedLogsOf([m], key, cfg.requireLoggedDeployment));
    const summary = printRelease(inspection, { model, inLog, enforced: cfg.requireLoggedRelease });
    const verdict = inspection ? verdictOf(inspection) : undefined;
    codeFailed = verdict?.status === 'fail' || inLog.reason === 'rewritten-log';
    // GitHub's anonymous limit is what most often leaves a check unmade here, and here a token can be given.
    if (inspection?.retry && !githubToken) line(NA, 'GitHub or Sigstore did not answer for something above. GitHub allows 60 anonymous requests an hour from one address: GITHUB_TOKEN in .env raises that');
    const releaseFile = inspection?.file;
    if (flags.history && releaseFile && m.deployment.composeManager) printLeadTimes(releaseFile, await leadTimes(m.deployment.composeManager.actions, releaseFile, { githubToken }));
    // The card repeats names read from the log and from GitHub, so each of its lines goes through `out`.
    console.log('\n┌─ Ainek, before sending ─ live ──────────────────────────────────────');
    out(`│ ${OK} Model: ${model}, attested deployment (launcher compose ${short(compose)})`);
    out(`│ ${OK} Hardware: Intel TDX ${m.tcbStatus}, NVIDIA GPU ${m.gpuEvidence}; gateway TDX ${outcome.gateway.tcbStatus}`);
    out(`│ ${OK} Key ${short(m.signer.signingAddress)} is in the public log: entry #${logEntry.index} by ${outcome.verdict.confirmedBy.join(', ')}${normalizeHex(logEntry.compose_hash) === compose ? ", with this launcher's compose hash" : '; this entry has another compose, the attested one is not in the log window'}`);
    // A failure first, whatever else is missing; a check mark only when every check of the release was made and held.
    if (inLog.reason === 'rewritten-log') out(`│ ${FAIL} Code: the enclave's action log does not continue what a trusted verifier saw of it (step 5)`);
    else if (verdict?.status === 'fail') out(`│ ${FAIL} Code: ${verdict.failures.length === 1 ? '' : `${verdict.failures.length} checks failed, the first: `}${verdict.failures[0]} (step 5)`);
    else if (!verdict || !summary) out(`│ ${NA} Code: the release behind the key was not resolved (step 5)`);
    else out(verdict.status === 'ok' ? `│ ${OK} Code: ${summary} (step 5)` : `│ ${NA} Code: ${summary}; not checked: ${verdict.unchecked.join(', ')} (step 5)`);
    out(`│ ${NA} Not checked here: an answer. No message was written, so nothing was encrypted, sent or signed (pnpm demo:live)`);
    out(codeFailed ? `└─ Result: WOULD SEND by the client's rule, but a check of the code behind the key failed (step 5). Nothing was sent.` : `└─ Result: WOULD SEND. Hardware and log checked in ${seconds(outcome.totalMs)}; nothing was sent.`);
  }
}
// Zero only for WOULD SEND with the swapped key refused and no failed code check: a refusal of the live key means the log lacks it.
await exitFlushed(outcome.kind === 'ready' && swappedRefused && !codeFailed ? 0 : 1);

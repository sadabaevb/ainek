// `pnpm demo:attest`: the live checks up to the send, with no API key and no spend. NEAR AI serves model metadata and attestation
// reports without a key, so this verifies the gateway's and the model's evidence here (Intel TDX through Intel PCS, the GPU through
// NVIDIA NRAS), reads the public log from the NEAR contract and applies the client's fail-closed rule. Then it stops: no message
// exists, so nothing is encrypted, sent or signed. The full exchange is `pnpm demo:live` (needs NEARAI_API_KEY).
import { DEMO_SWAPPED_KEY, composeHashOf, evaluateKeyLog, normalizeHex, shortHex as short } from '@ainek/proof';
import { contractLog, runPreflight, type StepId } from '@ainek/tier1-node';
import { loadLiveEnv } from './env.ts';
import { FAIL, NA, OK, exitFlushed, head, line, seconds } from './term.ts';

const { cfg } = loadLiveEnv();
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
    console.log('\n┌─ Ainek, before sending ─ live ──────────────────────────────────────');
    console.log(`│ ${OK} Model: ${model}, attested deployment (compose ${short(compose)})`);
    console.log(`│ ${OK} Hardware: Intel TDX ${m.tcbStatus}, NVIDIA GPU ${m.gpuEvidence}; gateway TDX ${outcome.gateway.tcbStatus}`);
    console.log(`│ ${OK} Key ${short(m.signer.signingAddress)} is in the public log: entry #${logEntry.index} by ${outcome.verdict.confirmedBy.join(', ')}${normalizeHex(logEntry.compose_hash) === normalizeHex(compose) ? ', with this deployment' : '; this entry has another compose, the attested one is not in the log window'}`);
    console.log(`│ ${NA} Not checked here: an answer. No message was written, so nothing was encrypted, sent or signed (pnpm demo:live)`);
    console.log(`└─ Result: WOULD SEND. Checked in ${seconds(outcome.totalMs)}; nothing was sent.`);
  }
}
// Zero only for WOULD SEND with the swapped key refused: a refusal of the live key means the log lacks it (as `demo:live` exits).
await exitFlushed(outcome.kind === 'ready' && swappedRefused ? 0 : 1);

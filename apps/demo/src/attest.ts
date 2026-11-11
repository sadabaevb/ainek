// `pnpm demo:attest`: the live checks up to the send, with no API key and no spend. NEAR AI serves model metadata and attestation
// reports without a key, so this verifies the gateway's and the model's evidence here (Intel TDX through Intel PCS, the GPU through
// NVIDIA NRAS), reads the public log from the NEAR contract and applies the client's fail-closed rule. Then it stops: no message
// exists, so nothing is encrypted, sent or signed. The full exchange is `pnpm demo:live` (needs NEARAI_API_KEY).
import { DEMO_SWAPPED_KEY, composeHashOf, evaluateKeyLog, shortHex as short } from '@ainek/proof';
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

if (outcome.kind === 'failed') {
  console.log(`\nResult: FAILED at ${outcome.step}. Nothing was sent.`);
} else {
  // The rule the chat's first demo switch shows, applied to the same log read: a key nobody logged is refused.
  const swapped = evaluateKeyLog(outcome.entries, { model, signingAddress: DEMO_SWAPPED_KEY, trustedVerifiers: cfg.trustedVerifiers, quorum: cfg.quorum });
  head('4. The same log read against a swapped key');
  line(swapped.status === 'ok' ? FAIL : OK, swapped.status === 'ok' ? `the demo key ${short(DEMO_SWAPPED_KEY)} is in the log: it must not be` : `${short(DEMO_SWAPPED_KEY)} would be refused: ${swapped.detail}`);
  if (outcome.kind === 'ready') {
    const { modelAttestation: m, logEntry } = outcome;
    console.log('\n┌─ Ainek, before sending ─ live ──────────────────────────────────────');
    console.log(`│ ${OK} Model: ${model}, attested deployment (compose ${short(composeHashOf(m.deployment))})`);
    console.log(`│ ${OK} Hardware: Intel TDX ${m.tcbStatus}, NVIDIA GPU ${m.gpuEvidence}; gateway TDX ${outcome.gateway.tcbStatus}`);
    console.log(`│ ${OK} Key ${short(m.signer.signingAddress)} is in the public log: entry #${logEntry.index} by ${outcome.verdict.confirmedBy.join(', ')}${cfg.requireLoggedDeployment ? ', with this deployment' : ''}`);
    console.log(`│ ${NA} Not checked here: an answer. No message was written, so nothing was encrypted, sent or signed (pnpm demo:live)`);
    console.log(`└─ Result: WOULD SEND. Checked in ${seconds(outcome.totalMs)}; nothing was sent.`);
  } else {
    console.log(`\nResult: WOULD REFUSE. ${outcome.reason}. Nothing was sent.`);
  }
}
// A refusal is the rule working, not an error of this command: only a failed step exits non-zero.
await exitFlushed(outcome.kind === 'failed' ? 1 : 0);

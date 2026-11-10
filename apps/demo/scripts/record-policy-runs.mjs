// Records what `pnpm demo:policy` needs to re-check, offline, every policy run behind an action the agent service made
// on testnet: for each one the action's record from the contract (the decision and its signature), the run's attestation
// from OutLayer, Intel's collateral as OutLayer archived it for that moment, and whether the worker's measurements are on
// OutLayer's approved list. Everything is public: no key, nothing is sent.
//   pnpm -F demo record-policy-runs
// The list below is the agent's live actions (docs/DEPLOY.md); a new one is added by hand with its call id, which the
// agent service prints and keeps in the action proof (`attestationUrl`).
import { writeFileSync } from 'node:fs';
import { ainekConfigFromEnv, base64ToBytes, fmspcOf, outlayerWorkerOf, readAction, tryVerifyQuote, viewFunction } from '@ainek/proof';
import { verifyTdxQuote } from '@ainek/tier1-node/dcap';

const RUNS = [
  { actionId: 2, callId: '48c62234-033e-4441-b684-0dae271d7375', by: 'the agent from the command line' },
  { actionId: 3, callId: '6a8bf1c5-b849-4c4b-be24-692507df40ec', by: 'the Telegram bot' },
  { actionId: 4, callId: 'f64a4ac3-8df7-4cff-a851-e7fcef7102bc', by: 'the Telegram bot' },
  { actionId: 8, callId: '2c57e3c3-8659-4f4d-a265-93e0cda27301', by: 'the Telegram bot' },
  { actionId: 9, callId: '7b1ddfce-c522-4801-84a9-4095e09d1df6', by: 'the Telegram bot' },
];

const cfg = ainekConfigFromEnv({});
const api = cfg.outlayerApiUrl;
const worker = outlayerWorkerOf(cfg.network);
const getJson = async (url) => {
  const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
};

/** Everything about one run, read together; a run that would not pass the offline check is not recorded. */
async function record({ actionId, callId, by }) {
  const attestationUrl = `${api}/attestations/by-call/${callId}`;
  const [action, attestation] = await Promise.all([readAction(cfg.rpcUrl, cfg.contract, actionId), getJson(attestationUrl)]);
  if (!action) throw new Error(`action ${actionId} is not on ${cfg.contract}`);
  const quote = base64ToBytes(attestation.tdx_quote);
  const { collateral } = await getJson(`${api}/public/collateral?fmspc=${fmspcOf(quote)}&at=${attestation.timestamp}`);
  const verified = tryVerifyQuote(verifyTdxQuote, quote, JSON.parse(collateral), attestation.timestamp);
  if ('error' in verified) throw new Error(`action ${actionId}: the quote does not verify: ${verified.error}`);
  const measurementsApproved = (await viewFunction(cfg.rpcUrl, worker, 'is_measurements_approved', { measurements: verified.measurements })) === true;
  if (!measurementsApproved) throw new Error(`action ${actionId}: the worker's measurements are not on the approved list of ${worker}`);
  console.log(`action ${actionId}: ${action.decision.verdict}, ${action.status}; quote verifies, measurements approved`);
  return { collateral, run: { actionId, by, status: action.status, attestationUrl, decision: action.decision, teePubkey: action.tee_pubkey, teeSignature: action.tee_signature, attestation, measurementsApproved } };
}

const recorded = await Promise.all(RUNS.map(record));
/** Collateral repeats between runs on one platform close in time: each distinct one is stored once and named by its place. */
const collaterals = [...new Set(recorded.map((r) => r.collateral))];
const runs = recorded.map((r) => ({ ...r.run, collateral: collaterals.indexOf(r.collateral) }));
const recordedOn = new Date().toISOString().slice(0, 10);

const out = {
  _about: `The policy runs behind the agent service's live actions on ${cfg.contract} (testnet), recorded on ${recordedOn} (UTC) for the offline check in \`pnpm demo:policy\`. Per run: decision, teePubkey and teeSignature from the contract's view action(id); attestation from GET attestationUrl; collateral (an index into collaterals) from GET ${api}/public/collateral for the quote's platform and the run's time; measurementsApproved from the view is_measurements_approved on ${worker}. The job's input is not here: a run made over HTTPS does not publish it, and the check says so. Re-record with \`pnpm -F demo record-policy-runs\`.`,
  recordedOn,
  published: { wasmHash: cfg.policyWasmHash, project: cfg.policyProject, apiUrl: api, contract: cfg.contract },
  collaterals: collaterals.map((text) => JSON.parse(text)),
  runs,
};
const file = new URL('../../../docs/samples/policy-runs.sample.json', import.meta.url);
writeFileSync(file, `${JSON.stringify(out, null, 1)}\n`);
console.log(`written: ${runs.length} runs, ${collaterals.length} collateral set(s), ${file.pathname}`);

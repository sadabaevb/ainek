// `pnpm demo:policy`: which code made a policy decision? Two sets of real runs of jobs/policy on OutLayer testnet are re-checked
// offline, with no key and no network:
//   1. one run recorded with its input (docs/samples/policy-run.sample.json): every check, the input included;
//   2. the run behind each action the agent service made on testnet (docs/samples/policy-runs.sample.json, written by
//      `pnpm -F demo record-policy-runs`). Those runs went over HTTPS and do not publish their input, so that line is skipped.
// `--tamper` shows what an edited decision and another build look like. `--live` reads everything again: the attestations,
// Intel's collateral, OutLayer's list of approved workers and, for the agent's actions, their records on the contract (still no key).
import { parseArgs } from 'node:util';
import { Decision, PolicyRun, ainekConfigFromEnv, base64ToBytes, checkPolicyRun, policyOutputOf, readAction, sha256Hex, tryVerifyQuote, verifyDecisionSignature, type Check, type PolicyRunEvidence } from '@ainek/proof';
import { verifyPolicyRunAt, verifyTdxQuote } from '@ainek/tier1-node/dcap';
import { readJson } from './evidence.ts';
import { FAIL, OK, describe, exitFlushed, head, line, markOf } from './term.ts';

// ---- 1. the run recorded with its input -------------------------------------------------------------
const sample = readJson<{ attestation: unknown; input: string; output: string; collateral: unknown; published: { wasmHash: string; project: string; apiUrl: string }; measurementsApproved: boolean }>('policy-run.sample.json');
const sampleRun = PolicyRun.parse(sample.attestation);
const sampleQuote = tryVerifyQuote(verifyTdxQuote, base64ToBytes(sampleRun.tdx_quote), sample.collateral, sampleRun.timestamp);

const checkSample = (over: Partial<PolicyRunEvidence> = {}): Check[] => checkPolicyRun({ run: sampleRun, input: sample.input, output: sample.output, wasmHash: sample.published.wasmHash, project: sample.published.project, quote: sampleQuote, measurementsApproved: sample.measurementsApproved, ...over });

function checkSampleLive(): Promise<Check[]> {
  const { rpcUrl, network } = ainekConfigFromEnv({});
  const { wasmHash, project, apiUrl } = sample.published;
  return verifyPolicyRunAt(`${apiUrl}/attestations/by-request/${String(sampleRun['request_id'])}`, { input: sample.input, output: sample.output, wasmHash, project, apiUrl, rpcUrl, network });
}

/** Prints every check of one run; true when each passed. */
function report(title: string, checks: Check[]): boolean {
  head(title);
  for (const c of checks) line(markOf(c.status), c.detail);
  return checks.every((c) => c.status === 'ok');
}

// ---- 2. the agent's live actions --------------------------------------------------------------------
interface AgentAction {
  actionId: number;
  by: string;
  status: string;
  attestationUrl: string;
  decision: unknown;
  teePubkey: string;
  teeSignature: string;
  attestation: unknown;
  collateral: number;
  measurementsApproved: boolean;
}
const actions = readJson<{ recordedOn: string; published: { wasmHash: string; project: string; apiUrl: string; contract: string }; collaterals: unknown[]; runs: AgentAction[] }>('policy-runs.sample.json');

interface Checked {
  verdict: string;
  status: string;
  checks: Check[];
}

/** The decision as the contract recorded it, with its signature checked under the key recorded with it. */
function decisionCheck(decision: Decision, a: { teePubkey: string; teeSignature: string }): Check {
  const ok = verifyDecisionSignature(decision, a.teeSignature, a.teePubkey);
  return { id: 'decision-signature', status: ok ? 'ok' : 'fail', detail: ok ? 'the decision is signed by the key recorded with it' : 'the decision is not signed by the key recorded with it' };
}

/** One action from the file, offline. `edit` changes the decision's output the way someone who serves the attestation could: the record's own hash field follows it. */
function checkAction(a: AgentAction, edit?: (output: string) => string): Checked {
  const decision = Decision.parse(a.decision);
  const attested = PolicyRun.parse(a.attestation);
  const real = policyOutputOf({ decision, teePubkey: a.teePubkey, teeSignature: a.teeSignature, wasmHash: actions.published.wasmHash });
  const output = edit ? edit(real) : real;
  const run = edit ? { ...attested, output_hash: sha256Hex(output) } : attested;
  const quote = tryVerifyQuote(verifyTdxQuote, base64ToBytes(attested.tdx_quote), actions.collaterals[a.collateral], attested.timestamp);
  const checks = checkPolicyRun({ run, input: null, output, wasmHash: actions.published.wasmHash, project: actions.published.project, quote, measurementsApproved: a.measurementsApproved });
  return { verdict: decision.verdict, status: a.status, checks: [decisionCheck(decision, a), ...checks] };
}

/** The same action with only its number and the address of its attestation taken from the file: the record, the attestation, the collateral and the approved list are read again. */
async function checkActionLive(a: AgentAction): Promise<Checked> {
  const { rpcUrl, network } = ainekConfigFromEnv({});
  const { wasmHash, project, apiUrl, contract } = actions.published;
  const record = await readAction(rpcUrl, contract, a.actionId);
  if (!record) throw new Error(`action ${a.actionId} is not on ${contract}`);
  const output = policyOutputOf({ decision: record.decision, teePubkey: record.tee_pubkey, teeSignature: record.tee_signature, wasmHash });
  const checks = await verifyPolicyRunAt(a.attestationUrl, { input: null, output, wasmHash, project, apiUrl, rpcUrl, network });
  return { verdict: record.decision.verdict, status: record.status, checks: [decisionCheck(record.decision, { teePubkey: record.tee_pubkey, teeSignature: record.tee_signature }), ...checks] };
}

/** What a row vouches for, in the words the heading uses. The job's input is the one check these runs cannot have. */
const ROW_CLAIMS: ReadonlyArray<readonly [string, string]> = [
  ['decision-signature', 'the decision is signed by the key recorded with it'],
  ['run-quote', 'Intel signed the quote of its run'],
  ['run-build', 'the run is of the published build'],
  ['run-output', 'the run printed this decision'],
  ['run-binding', 'the quote commits to that build and that output, under our project'],
  ['run-worker', "the worker's measurements are on OutLayer's approved list"],
];
/** A row passes when nothing failed, every claim in the heading holds, and nothing but the input was left unchecked. */
const rowPasses = (checks: Check[]): boolean =>
  checks.every((c) => c.status === 'ok' || c.id === 'run-input') && ROW_CLAIMS.every(([id]) => checks.some((c) => c.id === id && c.status === 'ok'));

/** One row per action, read together and printed in order; the failing checks in full. True when every row passed. */
async function reportActions(checkOne: (a: AgentAction) => Checked | Promise<Checked>, source: string): Promise<boolean> {
  head(`The policy run behind each of the agent's ${actions.runs.length} live actions on ${actions.published.contract}`);
  console.log(`  ${source}`);
  console.log(`  each ${OK} row means: ${ROW_CLAIMS.map(([, claim]) => claim).join('; ')}.`);
  console.log('  not checked for these runs: the job input. They went over HTTPS, which does not publish it.');
  const results = await Promise.all(actions.runs.map(async (a) => {
    try {
      return { a, ...(await checkOne(a)) };
    } catch (err) {
      return { a, error: describe(err) };
    }
  }));
  let all = true;
  for (const r of results) {
    if ('error' in r) {
      all = false;
      line(FAIL, `#${r.a.actionId} (${r.a.by}): could not be checked: ${r.error}`);
      continue;
    }
    const ok = rowPasses(r.checks);
    all &&= ok;
    const failed = r.checks.filter((c) => c.status !== 'ok' && c.id !== 'run-input').map((c) => c.detail);
    line(ok ? OK : FAIL, `#${r.a.actionId} ${r.verdict}, ${r.status} (${r.a.by})${ok ? '' : `: ${failed.join('; ')}`}`);
  }
  return all;
}

// ---- the three modes --------------------------------------------------------------------------------
/** True when a tampered run passed anywhere: a bug. */
function tamper(): boolean {
  const editedPassed = report('An edited decision: the verdict changed from Allow to Deny', checkSample({ output: sample.output.replace('"verdict":"Allow"', '"verdict":"Deny"') }));
  const otherBuild = 'ab'.repeat(32);
  const swappedPassed = report('Another build: the run claims different code than the quote commits to', checkSample({ run: { ...sampleRun, wasm_hash: otherBuild, executed_wasm_sha256: otherBuild } }));
  // The same edit on every live action, made the way whoever serves the attestation could make it: the verdict is replaced and
  // the record's hash of the output with it. Only the quote is left to object, and it must.
  const flip = (output: string): string => output.replace(/"verdict":"(Allow|Deny|NeedsApproval)"/, (_m, v: string) => `"verdict":"${v === 'Deny' ? 'Allow' : 'Deny'}"`);
  head("The agent's live actions, each with its verdict changed and the attestation's own hash of the output changed to match");
  let batchPassed = false;
  for (const a of actions.runs) {
    const { checks } = checkAction(a, flip);
    const caught = checks.filter((c) => c.status === 'fail').map((c) => c.id);
    const byQuote = caught.includes('run-binding');
    // Anything short of the quote objecting counts as a pass of the tampered run: that is the claim this scene is for.
    batchPassed ||= !byQuote;
    line(byQuote ? OK : FAIL, `#${a.actionId}: ${byQuote ? "refused: Intel's quote does not commit to the edited decision" : caught.length > 0 ? `refused, but not by the quote (${caught.join(', ')})` : 'the edited decision passed'}`);
  }
  return editedPassed || swappedPassed || batchPassed;
}

async function verify(live: boolean): Promise<boolean> {
  const title = `Which code made this decision? Request ${String(sampleRun['request_id'])} of ${sample.published.project}, ${live ? 'fetched now' : 'recorded'}`;
  const checks = await (live ? checkSampleLive() : Promise.resolve(checkSample())).catch((err: unknown) => {
    console.log(`\n${FAIL} Could not fetch what the check needs: ${describe(err)}`);
    return null;
  });
  const first = checks !== null && report(title, checks);
  const source = live
    ? 'read now: each action from the contract, its attestation and Intel\'s collateral from OutLayer, the approved list from OutLayer\'s contract.'
    : `recorded on ${actions.recordedOn}: each decision, key and status as the contract held them then, the approved list as it answered then. \`--live\` reads them again.`;
  const rest = await reportActions(live ? checkActionLive : checkAction, source);
  return first && rest;
}

const { values } = parseArgs({ options: { tamper: { type: 'boolean', default: false }, live: { type: 'boolean', default: false } } });
if (values.tamper) {
  const leaked = tamper();
  console.log(leaked ? `\n${FAIL} Result: a tampered run passed. This is a bug.` : '\nResult: REFUSED. None of them passes: the quote, signed by Intel, commits to the real build and the real output.');
  await exitFlushed(leaked ? 1 : 0);
} else {
  const ok = await verify(values.live);
  console.log(ok ? `\nResult: VERIFIED. To compare the build yourself: scripts/wasm-hash.sh prints ${sample.published.wasmHash}` : `\n${FAIL} Result: FAILED`);
  await exitFlushed(ok ? 0 : 1);
}

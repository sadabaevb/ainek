// `pnpm demo:policy`: which code made a policy decision? A real run of jobs/policy on OutLayer testnet, recorded with Intel's
// collateral, is re-checked offline: no key and no network. `--tamper` shows what an edited decision and another build look
// like. `--live` fetches the attestation, the collateral and the list of approved workers again (still no key).
// Then every policy run behind an action the agent service made on testnet is re-checked the same way (recorded by
// `pnpm -F demo record-policy-runs`): a run made over HTTPS does not publish its input, so that one line is skipped.
import { parseArgs } from 'node:util';
import { Decision, PolicyRun, ainekConfigFromEnv, base64ToBytes, canonicalJson, checkPolicyRun, readAction, tryVerifyQuote, verifyPolicyRun, type Check, type PolicyRunEvidence } from '@ainek/proof';
import { verifyPolicyRunAt, verifyTdxQuote } from '@ainek/tier1-node/dcap';
import { readJson } from './evidence.ts';
import { FAIL, OK, describe, exitFlushed, head, line, markOf } from './term.ts';

const sample = readJson<{ attestation: unknown; input: string; output: string; collateral: unknown; published: { wasmHash: string; project: string; apiUrl: string }; measurementsApproved: boolean }>('policy-run.sample.json');
const run = PolicyRun.parse(sample.attestation);
const { wasmHash, project, apiUrl } = sample.published;

const quote = tryVerifyQuote(verifyTdxQuote, base64ToBytes(run.tdx_quote), sample.collateral, run.timestamp);
const recorded = (over: Partial<PolicyRunEvidence> = {}): Check[] => checkPolicyRun({ run, input: sample.input, output: sample.output, wasmHash, project, quote, measurementsApproved: sample.measurementsApproved, ...over });

function live(): Promise<Check[]> {
  const { rpcUrl, network } = ainekConfigFromEnv({});
  return verifyPolicyRunAt(`${apiUrl}/attestations/by-request/${String(run['request_id'])}`, { input: sample.input, output: sample.output, wasmHash, project, apiUrl, rpcUrl, network });
}

// ---- the agent's live actions ----------------------------------------------------------------------
interface AgentRun {
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
const agentRuns = readJson<{ published: { wasmHash: string; project: string; apiUrl: string; contract: string }; collaterals: unknown[]; runs: AgentRun[] }>('policy-runs.sample.json');

/** The output the job printed for this decision, rebuilt from what the contract recorded: the quote commits to its hash. */
const outputOf = (r: Pick<AgentRun, 'decision' | 'teePubkey' | 'teeSignature'>): string => canonicalJson({ decision: Decision.parse(r.decision), pubkey: r.teePubkey, sig: r.teeSignature, wasm_hash: agentRuns.published.wasmHash });

/** One recorded run, offline. `over` edits what the check is told, for the tamper scene. */
function recordedRun(r: AgentRun, over: { output?: string } = {}): Check[] {
  const attested = PolicyRun.parse(r.attestation);
  const { wasmHash: build, project: ours } = agentRuns.published;
  const verified = tryVerifyQuote(verifyTdxQuote, base64ToBytes(attested.tdx_quote), agentRuns.collaterals[r.collateral], attested.timestamp);
  return checkPolicyRun({ run: attested, input: null, output: over.output ?? outputOf(r), wasmHash: build, project: ours, quote: verified, measurementsApproved: r.measurementsApproved });
}

/** The same run with nothing taken from the file but its number and where its attestation is: the record, the attestation, the collateral and the approved list are read again. */
async function liveRun(r: AgentRun): Promise<Check[]> {
  const { rpcUrl, network } = ainekConfigFromEnv({});
  const { wasmHash: build, project: ours, apiUrl: api, contract } = agentRuns.published;
  const record = await readAction(rpcUrl, contract, r.actionId);
  if (!record) throw new Error(`action ${r.actionId} is not on ${contract}`);
  const res = await fetch(r.attestationUrl, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${r.attestationUrl}: HTTP ${res.status}`);
  const output = outputOf({ decision: record.decision, teePubkey: record.tee_pubkey, teeSignature: record.tee_signature });
  return verifyPolicyRun({ run: PolicyRun.parse(await res.json()), input: null, output, wasmHash: build, project: ours, apiUrl: api, rpcUrl, network, verifyQuote: verifyTdxQuote });
}

/** What the one-line summary says must each have passed; the input line is skipped for these runs, and nothing may fail. */
const SUMMARISED = ['run-build', 'run-output', 'run-quote', 'run-binding', 'run-worker'];
const passed = (checks: Check[]): boolean => checks.every((c) => c.status !== 'fail') && SUMMARISED.every((id) => checks.some((c) => c.id === id && c.status === 'ok'));

/** One line per run; the failing checks in full. True when every run passed. */
async function reportAgentRuns(checksOf: (r: AgentRun) => Check[] | Promise<Check[]>, how: string): Promise<boolean> {
  head(`The agent's ${agentRuns.runs.length} live actions on ${agentRuns.published.contract}: the policy run behind each, ${how}`);
  let all = true;
  for (const r of agentRuns.runs) {
    const verdict = Decision.parse(r.decision).verdict;
    const label = `action #${r.actionId} (${verdict}, ${r.status}; ${r.by})`;
    try {
      const checks = await checksOf(r);
      const ok = passed(checks);
      all &&= ok;
      line(ok ? OK : FAIL, ok ? `${label}: Intel signed the quote; it commits to the published build and to this decision; the worker's measurements are approved` : `${label}: ${checks.filter((c) => c.status === 'fail').map((c) => c.detail).join('; ') || 'the quote could not be tied to this decision'}`);
    } catch (err) {
      all = false;
      line(FAIL, `${label}: could not be checked: ${describe(err)}`);
    }
  }
  console.log('  — the job input of these runs is not public (they were made over HTTPS), so the quote is checked against the build, the output and the project, not the input.');
  return all;
}

/** Prints the checks; true when every one passed. */
function report(title: string, checks: Check[]): boolean {
  head(title);
  for (const c of checks) line(markOf(c.status), c.detail);
  return checks.every((c) => c.status === 'ok');
}

const { values } = parseArgs({ options: { tamper: { type: 'boolean', default: false }, live: { type: 'boolean', default: false } } });
if (values.tamper) {
  const editedPassed = report('An edited decision: the verdict changed from Allow to Deny', recorded({ output: sample.output.replace('"verdict":"Allow"', '"verdict":"Deny"') }));
  const otherBuild = 'ab'.repeat(32);
  const swappedPassed = report('Another build: the run claims different code than the quote commits to', recorded({ run: { ...run, wasm_hash: otherBuild, executed_wasm_sha256: otherBuild } }));
  // The same edit on every live action: each decision's verdict is replaced, and its run must stop vouching for it.
  const flip = (output: string): string => output.replace(/"verdict":"(Allow|Deny|NeedsApproval)"/, (_m, v: string) => `"verdict":"${v === 'Deny' ? 'Allow' : 'Deny'}"`);
  head("The agent's live actions with each verdict changed");
  let batchLeaked = false;
  for (const r of agentRuns.runs) {
    const ok = passed(recordedRun(r, { output: flip(outputOf(r)) }));
    batchLeaked ||= ok;
    line(ok ? FAIL : OK, `action #${r.actionId}: ${ok ? 'the edited decision passed' : 'the quote does not commit to the edited decision'}`);
  }
  const leaked = editedPassed || swappedPassed || batchLeaked;
  console.log(leaked ? `\n${FAIL} Result: a tampered run passed. This is a bug.` : '\nResult: REFUSED. Neither passes: the quote, signed by Intel, commits to the real build and the real output.');
  await exitFlushed(leaked ? 1 : 0);
}
const title = `Which code made this decision? Request ${String(run['request_id'])} of ${project}, ${values.live ? 'fetched now' : 'recorded'}`;
const checks = await (values.live ? live() : Promise.resolve(recorded())).catch((err: unknown) => {
  console.log(`\n${FAIL} Could not fetch what the check needs: ${describe(err)}`);
  return null;
});
const first = checks !== null && report(title, checks);
const rest = await reportAgentRuns(values.live ? liveRun : recordedRun, values.live ? 'fetched now' : 'recorded');
const ok = first && rest;
console.log(ok ? `\nResult: VERIFIED. To compare the build yourself: scripts/wasm-hash.sh prints ${wasmHash}` : `\n${FAIL} Result: FAILED`);
await exitFlushed(ok ? 0 : 1);

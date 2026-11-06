// `pnpm demo:policy`: which code made a policy decision? A real run of jobs/policy on OutLayer testnet, recorded with Intel's
// collateral, is re-checked offline: no key and no network. `--tamper` shows what an edited decision and another build look
// like. `--live` fetches the attestation, the collateral and the list of approved workers again (still no key).
import { readFileSync } from 'node:fs';
import { parseArgs, parseEnv } from 'node:util';
import { PolicyRun, ainekConfigFromEnv, base64ToBytes, checkPolicyRun, tryVerifyQuote, type Check, type PolicyRunEvidence } from '@ainek/proof';
import { verifyPolicyRunAt, verifyTdxQuote } from '@ainek/tier1-node/dcap';
import { readJson } from './evidence.ts';
import { FAIL, exitFlushed, head, line, markOf } from './term.ts';

const sample = readJson<{ attestation: unknown; output: string; collateral: unknown; measurementsApproved: boolean }>('policy-run.sample.json');
const run = PolicyRun.parse(sample.attestation);

// What counts as published comes from the agent's own settings, not from the recording.
const published = parseEnv(readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8'));
const need = (name: string): string => {
  const value = published[name];
  if (!value) throw new Error(`.env.example has no ${name}`);
  return value;
};
const wasmHash = need('OUTLAYER_WASM_HASH');
const project = need('OUTLAYER_PROJECT');

const quote = tryVerifyQuote(verifyTdxQuote, base64ToBytes(run.tdx_quote), sample.collateral, run.timestamp);
const recorded = (over: Partial<PolicyRunEvidence> = {}): Check[] => checkPolicyRun({ run, output: sample.output, wasmHash, project, quote, measurementsApproved: sample.measurementsApproved, ...over });

function live(): Promise<Check[]> {
  const { rpcUrl, network } = ainekConfigFromEnv({});
  return verifyPolicyRunAt(`${need('OUTLAYER_API_URL')}/attestations/by-request/${String(run['request_id'])}`, { output: sample.output, wasmHash, project, apiUrl: need('OUTLAYER_API_URL'), rpcUrl, network });
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
  const leaked = editedPassed || swappedPassed;
  console.log(leaked ? `\n${FAIL} Result: a tampered run passed. This is a bug.` : '\nResult: REFUSED. Neither passes: the quote, signed by Intel, commits to the real build and the real output.');
  await exitFlushed(leaked ? 1 : 0);
}
const ok = report(`Which code made this decision? Request ${String(run['request_id'])} of ${project}, ${values.live ? 'fetched now' : 'recorded'}`, values.live ? await live() : recorded());
console.log(ok ? `\nResult: VERIFIED. To compare the build yourself: scripts/wasm-hash.sh prints ${wasmHash}` : `\n${FAIL} Result: FAILED`);
await exitFlushed(ok ? 0 : 1);

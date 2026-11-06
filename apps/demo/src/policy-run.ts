// `pnpm demo:policy`: which code made a policy decision? A real run of jobs/policy on OutLayer testnet, recorded with Intel's
// collateral, is re-checked offline: no key and no network. `--tamper` shows what an edited decision and another build look
// like. `--live` fetches the attestation, the collateral and the list of approved workers again (still no key).
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { PolicyRun, ainekConfigFromEnv, base64ToBytes, checkPolicyRun, verifyPolicyRun, type Check, type PolicyRunEvidence } from '@ainek/proof';
import { verifyTdxQuote } from '@ainek/tier1-node/dcap';
import { FAIL, exitFlushed, head, line, markOf } from './term.ts';

const API = 'https://testnet-api.outlayer.ai';
const repoFile = (path: string): string => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
const sample = JSON.parse(repoFile('docs/samples/policy-run.sample.json')) as { attestation: unknown; output: string; collateral: unknown; measurementsApproved: boolean };
const run = PolicyRun.parse(sample.attestation);

// The published values come from the deployment table, not from the recording.
const deploy = repoFile('docs/DEPLOY.md');
const published = (label: string, pattern: string): string => {
  const value = new RegExp(`\\| ${label} \\| \`(${pattern})\``).exec(deploy)?.[1];
  if (!value) throw new Error(`docs/DEPLOY.md has no value for ${label}`);
  return value;
};
const wasmHash = published('`wasm_hash` of the deployed build', '[0-9a-f]{64}');
const project = published('OutLayer project \\(testnet\\)', '[^`]+');

function recorded(over: Partial<PolicyRunEvidence> = {}): Check[] {
  const quote = (() => {
    try {
      return verifyTdxQuote(base64ToBytes(run.tdx_quote), sample.collateral, run.timestamp);
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  })();
  return checkPolicyRun({ run, output: sample.output, wasmHash, project, quote, measurementsApproved: sample.measurementsApproved, ...over });
}

/** Prints the checks; true when every one passed. */
function report(title: string, checks: Check[]): boolean {
  head(title);
  for (const c of checks) line(markOf(c.status), c.detail);
  return checks.every((c) => c.status === 'ok');
}

const { values } = parseArgs({ options: { tamper: { type: 'boolean', default: false }, live: { type: 'boolean', default: false } } });
if (values.tamper) {
  const edited = report('An edited decision: the verdict changed from Allow to Deny', recorded({ output: sample.output.replace('"verdict":"Allow"', '"verdict":"Deny"') }));
  const otherBuild = 'ab'.repeat(32);
  const swapped = report('Another build: the run claims different code than the quote commits to', recorded({ run: { ...run, wasm_hash: otherBuild, executed_wasm_sha256: otherBuild } }));
  console.log(edited || swapped ? `\n${FAIL} Result: a tampered run passed. This is a bug.` : '\nResult: REFUSED. Neither passes: the quote, signed by Intel, commits to the real build and the real output.');
  await exitFlushed(edited || swapped ? 1 : 0);
}
const checks = values.live
  ? await (async () => {
      const res = await fetch(`${API}/attestations/by-request/${String(run['request_id'])}`);
      if (!res.ok) throw new Error(`attestation: HTTP ${res.status}`);
      const { rpcUrl, network } = ainekConfigFromEnv({});
      return verifyPolicyRun({ run: PolicyRun.parse(await res.json()), output: sample.output, wasmHash, project, apiUrl: API, rpcUrl, network, verifyQuote: verifyTdxQuote });
    })()
  : recorded();
const ok = report(`Which code made this decision? Request ${String(run['request_id'])} of ${project}, ${values.live ? 'fetched now' : 'recorded'}`, checks);
console.log(ok ? `\nResult: VERIFIED. To compare the build yourself: scripts/wasm-hash.sh prints ${wasmHash}` : `\n${FAIL} Result: FAILED`);
await exitFlushed(ok ? 0 : 1);

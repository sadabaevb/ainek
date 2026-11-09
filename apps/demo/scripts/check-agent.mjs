// What does the chain hold for the Tier 2 agent? Read-only view calls over RPC, no keys.
//   pnpm -F demo check-agent [agent] [rpcUrl]   (defaults: AGENT_ACCOUNT_ID or the deployed testnet agent / NEAR_RPC_URL)
// Re-checks every recorded decision here instead of trusting the contract's own check, and compares the registered key
// with the one in the attested run behind `pnpm demo:policy`.
import { readFileSync } from 'node:fs';
import { agentKeysOf, ainekConfigFromEnv, checkActionRecord, decidedUnderCurrentPolicy, fromMinimalUnits, readActions, readAgent, readProofCommit, readTokenBalance, readTokenInfo, shortHex, viewAccessKeys } from '@ainek/proof';

const cfg = ainekConfigFromEnv(process.env);
const [agentId = process.env.AGENT_ACCOUNT_ID ?? 'agent.ainek-dev-dastan.testnet', rpc = cfg.rpcUrl] = process.argv.slice(2);

// A read that still fails after its retries means "could not check": neither a pass nor a stack trace.
process.on('uncaughtException', (err) => {
  console.log(`Result: could not read the chain: ${err.message}`);
  process.exit(1);
});

let failures = 0;
const report = (ok, line) => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${line}`);
};
const note = (line) => console.log(`  — ${line}`);

console.log(`Agent ${agentId} on ${cfg.contract} via ${rpc}`);
const agent = await readAgent(rpc, cfg.contract, agentId);
if (!agent) {
  report(false, 'not registered on this contract');
  process.exit(1);
}
report(true, `registered: policy hash ${shortHex(agent.policy_hash)} (contents are not on chain), decision key ${shortHex(agent.tee_pubkey)}, ${agent.paused ? 'paused' : 'not paused'}`);

// The run in this file is the one `pnpm demo:policy` checks against Intel's signature.
const run = JSON.parse(JSON.parse(readFileSync(new URL('../../../docs/samples/policy-run.sample.json', import.meta.url), 'utf8')).output);
report(run.pubkey === agent.tee_pubkey, 'the same decision key is in the attested run (pnpm demo:policy)');
report(run.decision.policy_hash === agent.policy_hash, 'the same policy hash is in the attested run');

const keys = agentKeysOf(await viewAccessKeys(rpc, agentId), cfg.contract);
for (const { publicKey, methods, problem } of keys.functionCall) report(!problem, `function-call key ${publicKey.slice(0, 16)}…: ${problem ?? `${methods.join(', ')} on ${cfg.contract}`}`);
if (keys.functionCall.length === 0) report(false, 'no function-call key on the account: the agent was stopped or never set up');
note(`${keys.fullAccess} full-access key(s) on the agent account: the stop button needs one for DeleteKey. The chain cannot show who holds it; the service refuses to start with one.`);

const { token_id: token } = agent;
const { symbol, decimals } = await readTokenInfo(rpc, token);
const amount = (raw) => `${fromMinimalUnits(raw, decimals)} ${symbol}`;
const [inContract, inAgent] = await Promise.all([cfg.contract, agentId].map((account) => readTokenBalance(rpc, token, account)));
report(inAgent === '0', `funds: ${amount(inContract)} in the contract, ${amount(inAgent)} on the agent account`);

// The same re-check the /agent page runs in the browser (checkActionRecord in @ainek/proof).
const { records, more } = await readActions(rpc, cfg.contract);
for (const record of records.filter((r) => r.agent_id === agentId)) {
  const { action_id, action, decision, status } = record;
  const failed = checkActionRecord(record, await readProofCommit(rpc, cfg.contract, agentId, decision.model_proof_commit)).filter((c) => c.status !== 'ok').map((c) => c.detail);
  const earlier = decidedUnderCurrentPolicy(record, agent) ? '' : ' (under an earlier key or policy)';
  report(failed.length === 0, `#${action_id} ${decision.verdict}, ${status}${earlier}: ${amount(action.amount)} to ${action.receiver_id}; ${failed.join('; ') || 're-checked here: signature, the action hash in the decision, status; a model proof commit by the agent exists'}`);
}
if (more) report(false, `the contract holds more than ${records.length} actions: the later ones were not read`);
note('A commit is a salted hash: neither the chain nor this script opens it, so this does not show a model answer behind it. The test actions run from scripts used placeholders (docs/DEPLOY.md).');

const contractFullAccess = agentKeysOf(await viewAccessKeys(rpc, cfg.contract), cfg.contract).fullAccess;
if (contractFullAccess > 0) note(`${contractFullAccess} full-access key(s) on the contract account: whoever holds one can replace the code.`);
console.log(failures === 0 ? 'Result: OK' : `Result: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);

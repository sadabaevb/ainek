// What does the chain hold for the Tier 2 agent? Read-only view calls over RPC, no keys.
//   pnpm -F demo check-agent [agent] [rpcUrl]   (defaults: AGENT_ACCOUNT_ID or the deployed testnet agent / NEAR_RPC_URL)
// Re-checks every recorded decision here instead of trusting the contract's own check, and compares the registered key
// with the one in the attested run behind `pnpm demo:policy`.
import { readFileSync } from 'node:fs';
import { actionCommitOf, ainekConfigFromEnv, keyScopeProblem, readProofCommit, shortHex, verifyDecisionSignature, viewFunction } from '@ainek/proof';

const cfg = ainekConfigFromEnv(process.env);
const [agentId = process.env.AGENT_ACCOUNT_ID ?? 'agent.ainek-dev-dastan.testnet', rpc = cfg.rpcUrl] = process.argv.slice(2);
const view = (method, args = {}, account = cfg.contract) => viewFunction(rpc, account, method, args);

let failures = 0;
const report = (ok, line) => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${line}`);
};
const note = (line) => console.log(`  — ${line}`);

async function accessKeys(account) {
  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({ jsonrpc: '2.0', id: '1', method: 'query', params: { request_type: 'view_access_key_list', finality: 'final', account_id: account } }),
  });
  const { result, error } = await res.json();
  if (!result?.keys) throw new Error(`access keys of ${account}: ${JSON.stringify(error ?? result)}`);
  return result.keys;
}
const fullAccessCount = (keys) => keys.filter((k) => k.access_key.permission === 'FullAccess').length;

console.log(`Agent ${agentId} on ${cfg.contract} via ${rpc}`);
const agent = await view('agent', { agent_id: agentId });
if (!agent) {
  report(false, 'not registered on this contract');
  process.exit(1);
}
report(true, `registered: policy hash ${shortHex(agent.policy_hash)} (contents are not on chain), decision key ${shortHex(agent.tee_pubkey)}, ${agent.paused ? 'paused' : 'not paused'}`);

// The run in this file is the one `pnpm demo:policy` checks against Intel's signature.
const run = JSON.parse(JSON.parse(readFileSync(new URL('../../../docs/samples/policy-run.sample.json', import.meta.url), 'utf8')).output);
report(run.pubkey === agent.tee_pubkey, 'the same decision key is in the attested run (pnpm demo:policy)');
report(run.decision.policy_hash === agent.policy_hash, 'the same policy hash is in the attested run');

const keys = await accessKeys(agentId);
for (const { public_key, access_key: { permission } } of keys) {
  if (permission === 'FullAccess') continue;
  const { receiver_id, method_names } = permission.FunctionCall;
  const problem = keyScopeProblem(permission, cfg.contract);
  report(!problem, `function-call key ${public_key.slice(0, 16)}…: ${problem ?? `${method_names.join(', ')} on ${receiver_id}`}`);
}
note(`${fullAccessCount(keys)} full-access key(s) on the agent account: the stop button needs one for DeleteKey. The chain cannot show who holds it; the service refuses to start with one.`);

const { token_id: token } = agent;
const { symbol, decimals } = await view('ft_metadata', {}, token);
const amount = (raw) => `${Number(raw) / 10 ** decimals} ${symbol}`;
const [inContract, inAgent] = await Promise.all([cfg.contract, agentId].map((account_id) => view('ft_balance_of', { account_id }, token)));
report(inAgent === '0', `funds: ${amount(inContract)} in the contract, ${amount(inAgent)} on the agent account`);

for (let action_id = 0; ; action_id += 1) {
  const record = await view('action', { action_id });
  if (!record) break;
  if (record.agent_id !== agentId) continue;
  const { action, decision, tee_signature, tee_pubkey, status } = record;
  const commit = await readProofCommit(rpc, cfg.contract, agentId, decision.model_proof_commit);
  const failed = [
    !verifyDecisionSignature(decision, tee_signature, tee_pubkey) && 'the signature does not verify',
    tee_pubkey !== agent.tee_pubkey && 'signed by another key than the registered one',
    decision.action_commit !== actionCommitOf(action) && 'the decision is for another action',
    commit.status !== 'found' && 'no model proof committed by this agent',
  ].filter(Boolean);
  report(failed.length === 0, `#${action_id} ${decision.verdict}, ${status}: ${amount(action.amount)} to ${action.receiver_id}; ${failed.join('; ') || 'signature and action commit re-checked here, model proof committed by the agent'}`);
}
note('A commit is a salted hash: neither the chain nor this script opens the proof behind it.');

const contractFullAccess = fullAccessCount(await accessKeys(cfg.contract));
if (contractFullAccess > 0) note(`${contractFullAccess} full-access key(s) on the contract account: whoever holds one can replace the code.`);
console.log(failures === 0 ? 'Result: OK' : `Result: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);

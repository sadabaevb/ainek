// What does the chain hold for the Tier 2 agent? Read-only view calls over RPC, no keys.
//   pnpm -F demo check-agent [agent] [rpcUrl]   (defaults: AGENT_ACCOUNT_ID or the deployed testnet agent / NEAR_RPC_URL)
// Re-checks every recorded decision here instead of trusting the contract's own check, and compares the registered key
// with the one in the attested run behind `pnpm demo:policy`.
import { readFileSync } from 'node:fs';
import { agentKeysOf, ainekConfigFromEnv, checkActionRecord, decidedUnderCurrentPolicy, readActions, readAgentState, readModelCommits, readTokenInfo, shortHex, tokenAmountText, viewAccessKeys } from '@ainek/proof';

const cfg = ainekConfigFromEnv(process.env);
const [agentId = cfg.agentAccount, rpc = cfg.rpcUrl] = process.argv.slice(2);

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
// Everything that does not depend on another answer is asked together; the lines below print in a fixed order.
/** The whole list. The count and an action can come from two nodes a block apart, so a short list is asked again before it is called short. */
async function everyAction() {
  let list = await readActions(rpc, cfg.contract);
  for (let again = 0; list.behind > 0 && again < 3; again++) {
    await new Promise((r) => setTimeout(r, 1500));
    list = await readActions(rpc, cfg.contract);
  }
  return list;
}
const [{ info: agent, keys, funds }, { records, more, behind, count }, contractKeys] = await Promise.all([readAgentState(rpc, cfg.contract, agentId), everyAction(), viewAccessKeys(rpc, cfg.contract)]);
if (!agent) {
  report(false, 'not registered on this contract');
  process.exit(1);
}
report(true, `registered: policy hash ${shortHex(agent.policy_hash)} (contents are not on chain), decision key ${shortHex(agent.tee_pubkey)}, ${agent.paused ? 'paused' : 'not paused'}`);

// The run in this file is the one `pnpm demo:policy` checks against Intel's signature.
const run = JSON.parse(JSON.parse(readFileSync(new URL('../../../docs/samples/policy-run.sample.json', import.meta.url), 'utf8')).output);
report(run.pubkey === agent.tee_pubkey, 'the same decision key is in the attested run (pnpm demo:policy)');
report(run.decision.policy_hash === agent.policy_hash, 'the same policy hash is in the attested run');

for (const { publicKey, methods, problem } of keys.functionCall) report(!problem, `function-call key ${publicKey.slice(0, 16)}…: ${problem ?? `${methods.join(', ')} on ${cfg.contract}`}`);
if (keys.functionCall.length === 0) report(false, 'no function-call key on the account: the agent was stopped or never set up');
note(`${keys.fullAccess} full-access key(s) on the agent account: the stop button needs one for DeleteKey. The chain cannot show who holds it; the service refuses to start with one.`);

const token = await readTokenInfo(rpc, agent.token_id);
const amount = (raw) => tokenAmountText(raw, token);
report(funds.onAgent === '0', `funds: ${amount(funds.inContract)} in the contract, ${amount(funds.onAgent)} on the agent account`);

// The same lookups and the same re-check the /agent page runs in the browser (readModelCommits, checkActionRecord in @ainek/proof).
const mine = records.filter((r) => r.agent_id === agentId);
const commits = await readModelCommits(rpc, cfg.contract, mine);
for (const [i, record] of mine.entries()) {
  const { action_id, action, decision, status } = record;
  const failed = checkActionRecord(record, commits[i]).filter((c) => c.status !== 'ok').map((c) => c.detail);
  const earlier = decidedUnderCurrentPolicy(record, agent) ? '' : ' (under an earlier key or policy)';
  report(failed.length === 0, `#${action_id} ${decision.verdict}, ${status}${earlier}: ${amount(action.amount)} to ${action.receiver_id}; ${failed.join('; ') || 're-checked here: signature, the action hash in the decision, status; a model proof commit by the agent exists'}`);
}
if (more) report(false, `the contract holds more than ${records.length} actions: the later ones were not read`);
// The list is found by asking the node id by id, past what the contract counts; a count ahead of the node means it is short.
if (behind > 0) report(false, `the contract counts ${count} actions and the node returned ${records.length} after three more tries`);
else if (count === null) note(`this build of the contract has no action_count(): the end of the list was found by asking, ${records.length} actions`);
else note(`action_count() = ${count}; the node has no action past #${records.length - 1}`);
note('A commit is a salted hash: neither the chain nor this script opens it, so this does not show a model answer behind it. The test actions run from scripts used placeholders (docs/DEPLOY.md).');

if (contractKeys.length === 0) note('no access key on the contract account: nobody can sign a new deployment for it.');
else note(`${contractKeys.length} access key(s) on the contract account, ${agentKeysOf(contractKeys, cfg.contract).fullAccess} of them full-access: whoever holds a full-access one can replace the code.`);
console.log(failures === 0 ? 'Result: OK' : `Result: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);

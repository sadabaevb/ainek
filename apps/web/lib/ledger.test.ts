import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { NO_SUCH_METHOD, fakeRpc, type RpcCall } from '../../../packages/proof/src/fixtures.ts';
import { amountText, isUnsettled, ledgerMoved, loadLedger } from './ledger.ts';

const cfg = { rpcUrl: 'http://rpc.test', contract: 'ainek.testnet', agentAccount: 'agent.testnet' };
const hex = (pair: string) => pair.repeat(32);
const decision = { verdict: 'Allow', policy_hash: hex('ef'), policy_version: 1, action_commit: hex('aa'), model_proof_commit: hex('ab'), nonce: hex('12'), expires_at: '1794055393785' };
const record = (id: number, status = 'Executed', agent = cfg.agentAccount) => ({ action_id: id, agent_id: agent, action: { kind: 'ft_transfer', token_id: 'token.testnet', receiver_id: 'vendor.testnet', amount: '2000000', memo: '' }, decision, tee_signature: 'c2ln', tee_pubkey: hex('4c'), status, day: 20764, block_height: 100 + id });
const info = (agent_id: string, paused = false) => ({ agent_id, policy_hash: hex('ef'), policy_version: 1, tee_pubkey: hex('4c'), token_id: 'token.testnet', paused, spent_today: '0' });
const fcKey = { public_key: 'ed25519:fc', access_key: { permission: { FunctionCall: { receiver_id: cfg.contract, method_names: ['commit_proof', 'propose_action'], allowance: '1' } } } };
const fullKey = { public_key: 'ed25519:full', access_key: { permission: 'FullAccess' } };

/** What the fake chain holds; a test changes it between two reads to stand for the chain moving on. */
interface World {
  actions: Array<ReturnType<typeof record>>;
  agents: Record<string, ReturnType<typeof info>>;
  keys: Record<string, unknown[]>;
  metadata: unknown;
  /** What `action_count()` answers when it is not simply the number of actions the node serves: another number (two nodes a block apart), or no such view. */
  count?: number | typeof NO_SUCH_METHOD;
}
const world = (): World => ({ actions: [record(0), record(1, 'Denied')], agents: { [cfg.agentAccount]: info(cfg.agentAccount) }, keys: { [cfg.agentAccount]: [fcKey, fullKey] }, metadata: { symbol: 'AINEK', decimals: 6 } });

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** The fake RPC over `w`; returns the calls it saw. */
function chain(w: World): RpcCall[] {
  return fakeRpc(
    ({ method, args }) =>
      ({
        owner: 'owner.testnet',
        action_count: w.count ?? w.actions.length,
        action: w.actions[Number(args['action_id'])],
        agent: w.agents[String(args['agent_id'])],
        pending_actions: w.actions.filter((r) => r.agent_id === args['agent_id'] && r.status === 'Pending'),
        ft_metadata: w.metadata,
        ft_balance_of: args['account_id'] === cfg.contract ? '8794000000' : '0',
      })[method],
    (account) => w.keys[account] ?? [],
  );
}
const names = (calls: RpcCall[]): string[] => calls.map((c) => `${c.account}.${c.method}`);
const load = () => loadLedger(cfg, new AbortController().signal);
const moved = async (w: World, change: (w: World) => void): Promise<boolean> => {
  chain(w);
  const ledger = await load();
  change(w);
  return ledgerMoved(cfg, ledger, new AbortController().signal);
};

test('loadLedger: the owner, every action, the configured agent with its keys and funds, and the token', async () => {
  const calls = chain(world());
  const ledger = await load();
  assert.equal(ledger.owner, 'owner.testnet');
  assert.deepEqual(ledger.records.map((r) => [r.action_id, r.status]), [[0, 'Executed'], [1, 'Denied']]);
  assert.equal(ledger.more, false);
  assert.deepEqual(ledger.agents.map((a) => a.id), [cfg.agentAccount]);
  const [agent] = ledger.agents;
  assert.equal(agent?.info?.paused, false);
  assert.deepEqual(agent?.keys, { functionCall: [{ publicKey: 'ed25519:fc', methods: ['commit_proof', 'propose_action'], problem: null }], fullAccess: 1 });
  assert.deepEqual(agent?.funds, { inContract: '8794000000', onAgent: '0' });
  assert.deepEqual(ledger.tokens, { 'token.testnet': { decimals: 6, symbol: 'AINEK' } });
  assert.ok(names(calls).includes('token.testnet.ft_metadata') && names(calls).includes('agent.testnet.view_access_key_list'));
});

test('loadLedger: an agent that is not registered is shown as such, and another agent appears once it has proposed', async () => {
  const w = world();
  w.agents = { 'other.testnet': info('other.testnet') };
  w.actions = [record(0, 'Executed', 'other.testnet')];
  chain(w);
  const ledger = await load();
  assert.deepEqual(ledger.agents.map((a) => [a.id, a.info !== null, a.funds !== null]), [[cfg.agentAccount, false, false], ['other.testnet', true, true]]);
});

test('loadLedger: a token that does not say how to scale its amounts is left out, and amounts then read in minimal units', async () => {
  const w = world();
  w.metadata = { symbol: 'X' };
  chain(w);
  const ledger = await load();
  assert.deepEqual(ledger.tokens, {});
  assert.equal(amountText('2000000', 'token.testnet', ledger.tokens), '2000000 (minimal units of token.testnet)');
  assert.equal(amountText('2000000', 'token.testnet', { 'token.testnet': { decimals: 6, symbol: 'AINEK' } }), '2 AINEK');
});

test('loadLedger after an earlier read: settled actions and known tokens are kept, and the chain is asked from the first action that could move', async () => {
  const w = world();
  w.actions.push(record(2, 'Pending'));
  const calls = chain(w);
  const first = await load();
  calls.length = 0;
  w.actions[2] = record(2, 'Executed');
  w.actions.push(record(3));
  const next = await loadLedger(cfg, new AbortController().signal, first);
  assert.deepEqual(next.records.map((r) => [r.action_id, r.status]), [[0, 'Executed'], [1, 'Denied'], [2, 'Executed'], [3, 'Executed']]);
  assert.equal(next.records[0], first.records[0]); // the same object: a settled record is not read again
  assert.deepEqual(calls.filter((c) => c.method === 'action').map((c) => c.args['action_id']), [2, 3, 4]); // what the contract counts, and one id past it
  assert.equal(calls.some((c) => c.method === 'ft_metadata'), false);
  assert.deepEqual(next.tokens, first.tokens);
  assert.equal(calls.filter((c) => c.method === 'ft_balance_of').length, 2); // where the tokens are is always read fresh
});

test('loadLedger: an older contract without action_count() is read all the same, and a count ahead of the node is said', async () => {
  const w = world();
  w.count = NO_SUCH_METHOD;
  chain(w);
  assert.deepEqual(await load().then((l) => [l.records.length, l.more, l.behind]), [2, false, 0]);
  w.count = 3; // the contract counts an action the node does not serve yet
  assert.deepEqual(await load().then((l) => [l.records.length, l.behind]), [2, 1]);
});

test('loadLedger after an earlier read: a node that is a block behind takes nothing off the page', async () => {
  const w = world();
  w.actions.push(record(2, 'Pending'), record(3));
  chain(w);
  const first = await load();
  w.actions.length = 3; // this node has not seen action 3 yet, and neither has its count
  const next = await loadLedger(cfg, new AbortController().signal, first);
  assert.deepEqual(next.records.map((r) => r.action_id), [0, 1, 2, 3]);
  assert.equal(next.records[3], first.records[3]);
  assert.equal(next.behind, 0);
});

test('ledgerMoved: nothing new is false, and the look costs a handful of calls, not the whole ledger', async () => {
  const w = world();
  const calls = chain(w);
  const ledger = await load();
  calls.length = 0;
  assert.equal(await ledgerMoved(cfg, ledger, new AbortController().signal), false);
  assert.deepEqual(names(calls).sort(), ['agent.testnet.view_access_key_list', 'ainek.testnet.action', 'ainek.testnet.agent', 'ainek.testnet.pending_actions']);
});

test('ledgerMoved: a new action, a waiting action that was decided, a transfer that reported back, a pause, a deleted key', async () => {
  assert.equal(await moved(world(), (w) => w.actions.push(record(2, 'Pending'))), true);
  const waiting = () => {
    const w = world();
    w.actions.push(record(2, 'Pending'), record(3, 'Pending'));
    return w;
  };
  assert.equal(await moved(waiting(), () => undefined), false);
  assert.equal(await moved(waiting(), (w) => { w.actions[2] = record(2, 'Rejected'); }), true);
  const inFlight = world();
  inFlight.actions.push(record(2, 'Executing'));
  assert.equal(await moved(inFlight, (w) => { w.actions[2] = record(2, 'Executed'); }), true);
  assert.equal(await moved(world(), (w) => { w.agents[cfg.agentAccount] = info(cfg.agentAccount, true); }), true);
  assert.equal(await moved(world(), (w) => { w.keys[cfg.agentAccount] = [fullKey]; }), true); // the stop button
});

test('ledgerMoved: every agent on the page is watched, with one call for its whole waiting queue', async () => {
  const w = world();
  w.agents['other.testnet'] = info('other.testnet');
  w.keys['other.testnet'] = [fcKey];
  w.actions.push(record(2, 'Pending', 'other.testnet'), record(3, 'Pending', 'other.testnet'));
  const calls = chain(w);
  const ledger = await load();
  calls.length = 0;
  assert.equal(await ledgerMoved(cfg, ledger, new AbortController().signal), false);
  assert.equal(calls.filter((c) => c.method === 'action').length, 1); // the next id only: two waiting actions cost one pending_actions call
  assert.equal(calls.filter((c) => c.method === 'pending_actions').length, 2);
  w.agents['other.testnet'] = info('other.testnet', true);
  assert.equal(await ledgerMoved(cfg, ledger, new AbortController().signal), true); // the other agent was paused
});

test('isUnsettled: only an action that waits or whose transfer has not reported back', () => {
  assert.deepEqual(['Pending', 'Executing', 'Executed', 'Failed', 'Denied', 'Rejected'].filter((s) => isUnsettled({ ...record(0, s), action_id: 0 } as never)), ['Pending', 'Executing']);
});

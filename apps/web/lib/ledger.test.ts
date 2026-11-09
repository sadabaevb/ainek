import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
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
}
const world = (): World => ({ actions: [record(0), record(1, 'Denied')], agents: { [cfg.agentAccount]: info(cfg.agentAccount) }, keys: { [cfg.agentAccount]: [fcKey, fullKey] }, metadata: { symbol: 'AINEK', decimals: 6 } });

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Stands in for the NEAR JSON-RPC over `w`; returns the calls it saw as "account.method". */
function chain(w: World): string[] {
  const calls: string[] = [];
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    const p = (JSON.parse(String(init.body)) as { params: { request_type: string; account_id: string; method_name?: string; args_base64?: string } }).params;
    if (p.request_type === 'view_access_key_list') {
      calls.push(`${p.account_id}.keys`);
      return new Response(JSON.stringify({ result: { keys: w.keys[p.account_id] ?? [] } }), { status: 200 });
    }
    const args = JSON.parse(Buffer.from(p.args_base64 ?? '', 'base64').toString()) as { action_id?: number; agent_id?: string; account_id?: string };
    calls.push(`${p.account_id}.${p.method_name}`);
    const answers: Record<string, unknown> = {
      owner: 'owner.testnet',
      action: w.actions[args.action_id ?? -1] ?? null,
      agent: w.agents[args.agent_id ?? ''] ?? null,
      ft_metadata: w.metadata,
      ft_balance_of: args.account_id === cfg.contract ? '8794000000' : '0',
    };
    return new Response(JSON.stringify({ result: { result: [...Buffer.from(JSON.stringify(answers[p.method_name ?? ''] ?? null))] } }), { status: 200 });
  }) as typeof fetch;
  return calls;
}
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
  assert.ok(calls.includes('token.testnet.ft_metadata') && calls.includes('agent.testnet.keys'));
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

test('ledgerMoved: nothing new is false, and the look costs a handful of calls, not the whole ledger', async () => {
  const w = world();
  const calls = chain(w);
  const ledger = await load();
  calls.length = 0;
  assert.equal(await ledgerMoved(cfg, ledger, new AbortController().signal), false);
  assert.deepEqual([...calls].sort(), ['agent.testnet.keys', 'ainek.testnet.action', 'ainek.testnet.agent']);
});

test('ledgerMoved: a new action, a waiting action that moved on, a pause, a deleted key', async () => {
  assert.equal(await moved(world(), (w) => w.actions.push(record(2, 'Pending'))), true);
  const waiting = world();
  waiting.actions.push(record(2, 'Pending'));
  assert.equal(await moved(waiting, (w) => { w.actions[2] = record(2, 'Rejected'); }), true);
  assert.equal(await moved(world(), (w) => { w.agents[cfg.agentAccount] = info(cfg.agentAccount, true); }), true);
  assert.equal(await moved(world(), (w) => { w.keys[cfg.agentAccount] = [fullKey]; }), true); // the stop button
});

test('isUnsettled: only an action that waits or whose transfer has not reported back', () => {
  assert.deepEqual(['Pending', 'Executing', 'Executed', 'Failed', 'Denied', 'Rejected'].filter((s) => isUnsettled({ ...record(0, s), action_id: 0 } as never)), ['Pending', 'Executing']);
});
